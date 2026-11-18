/**
 * 模块职责：抖音接口调用 —— 链接/口令识别、作品信息、无水印播放地址、评论
 * 依赖方向：依赖 app（取 ctx/http/config/kv）、utils/format、types/douyin
 * 生命周期：随插件创建；ttwid 缓存在内存与 KV 里，过期或被拒时重取
 * 注意事项：抖音的取数链路是踩出来的，几个反直觉的点：
 *
 *          1) **必须用移动端 UA**。PC UA 请求分享页会拿到一个 72KB 的 JS VM 挑战页
 *             （`_$jsvmprt`），里面没有任何作品数据；
 *          2) **必须带 ttwid**。没有它，移动端 UA 只能拿到一个「空壳」SSR 页，
 *             `_ROUTER_DATA` 里只剩 itemId；
 *          3) **无水印不是"去水印"**：`play_addr.url_list[0]` 是 `playwm`（带水印），
 *             要用 `play_addr.uri`（vid）去 `/aweme/v1/play/` 换一条干净流；
 *          4) 评论要 `a_bogus` 签名，签名参数与请求 UA 绑死，两处必须一致。
 */
import { once } from "node:events"
import { createWriteStream } from "node:fs"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { BilibiliApp } from "../core/app.js"
import { nonceOf, solveAcChallenge } from "./douyin-ac.js"
import type {
  DouyinCommentImage,
  DouyinCommentItem,
  DouyinCommentResult,
  DouyinCommentSticker,
  DouyinCommentView,
  DouyinLiveInfo,
  DouyinQuality,
  DouyinReplyView,
  DouyinShareTarget,
  DouyinTextPart,
  DouyinInfo
} from "../types/douyin.js"
import { formatSize } from "../utils/format.js"
import { recordStream } from "../utils/live.js"

/** 分享页（视频） */
const SHARE_VIDEO = "https://www.iesdouyin.com/share/video/{id}/"
/** 分享页（图文） */
const SHARE_NOTE = "https://www.iesdouyin.com/share/note/{id}/"
/** 桌面作品页：动图视频只在这里的 SSR 数据里 */
const NOTE_PAGE = "https://www.douyin.com/note/{id}"
/** 直播间页：不带任何查询参数也能拿到主播、标题与流地址 */
const LIVE_REFLOW = "https://webcast.amemv.com/douyin/webcast/reflow/{id}"
/** 直播片段体积上限：10 秒 1080P 一般不到 20MB，留足余量 */
const LIVE_MAX_MB = 50
/** 匿名 ttwid 注册 */
const TTWID_REGISTER = "https://ttwid.bytedance.com/ttwid/union/register/"
/** 无水印播放地址（用 vid 换） */
const PLAY_API = "https://aweme.snssdk.com/aweme/v1/play/"
/** 评论列表 */
const COMMENT_API = "https://www.douyin.com/aweme/v1/web/comment/list/"
/** 表情表（一次拉全，缓存一天） */
const EMOJI_API = "https://www.douyin.com/aweme/v1/web/emoji/list"
/** 楼中楼接口 */
const REPLY_API = "https://www.douyin.com/aweme/v1/web/comment/list/reply/"

/** 每条评论下最多渲染几条楼中楼 */
const REPLY_LIMIT = 2

/**
 * 楼中楼接口不可用后的冷却时间
 *
 * 抖音对非登录请求的楼中楼接口返回 200 + 空体（2026-08 之后加固），属于「整类请求都
 * 不通」而不是「这条评论没回复」。失败一次后 10 分钟内不再试，避免每条评论都白等一次。
 */
const REPLY_BLOCK_TTL = 10 * 60 * 1000

/**
 * 移动端 UA
 *
 * 换成 PC 的 UA 会被抖音丢进 JS 挑战页，所以这个值不能随便改。
 */
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

/** ttwid 在 KV 里的键 */
const TTWID_KEY = "douyin-ttwid"
/** 表情表在 KV 里的键 */
const EMOJI_KEY = "douyin-emoji"

/** ttwid 缓存时长：一天。抖音侧一般更久，但换了不亏 */
const TTWID_TTL = 24 * 3600 * 1000

/** 画质由高到低，探测时按顺序试 */
const RATIOS: DouyinQuality[] = ["1080p", "720p", "540p"]

/** 分享页所有主机名，识别链接时用 */
const SHARE_HOSTS = ["v.douyin.com", "www.iesdouyin.com", "www.douyin.com", "m.douyin.com"]

/**
 * 抖音服务
 */
export class DouyinApi {
  readonly #app: BilibiliApp
  /** 内存里的 ttwid，避免每次都读 KV */
  #ttwid: string | undefined
  #ttwidAt = 0
  /** 表情表：标签 → 图片地址 */
  #emoji: Record<string, string> | undefined
  #emojiAt = 0
  /** 楼中楼接口上一次确认不可用的时刻 */
  #repliesBlockedAt = 0

  constructor(app: BilibiliApp) {
    this.#app = app
  }

  /**
   * 从一段文本里认出抖音作品 id
   *
   * 支持：`www.douyin.com/video/{id}`、`/note/{id}`、`iesdouyin.com/share/video/{id}`、
   * `v.douyin.com/{短码}`（返回短码，需再展开）、以及裸 19 位数字 id。
   * @param text 消息原文
   * @returns 作品 id 或短链；没有则 null
   */
  static extractTarget(text: string): { kind: "id" | "short"; value: string } | null {
    const short = text.match(/https?:\/\/v\.douyin\.com\/([A-Za-z0-9_-]{4,})/i)
    if (short?.[1] !== undefined) return { kind: "short", value: `https://v.douyin.com/${short[1]}` }

    const full = text.match(/(?:douyin\.com|iesdouyin\.com)\/(?:share\/)?(?:video|note|slides)\/(\d{6,})/i)
    if (full?.[1] !== undefined) return { kind: "id", value: full[1] }

    // 纯数字 id：只在消息基本就是这一串时才算，避免把普通数字当作品 id
    const bare = text.trim().match(/^(\d{17,20})$/)
    if (bare?.[1] !== undefined) return { kind: "id", value: bare[1] }

    return null
  }

  /**
   * 文本里有没有抖音链接/口令
   * @param text 消息原文
   * @returns 有则 true
   */
  static hasLink(text: string): boolean {
    if (DouyinApi.extractTarget(text) !== null) return true
    if (!SHARE_HOSTS.some(host => text.includes(host))) return false
    return /douyin\.com/i.test(text)
  }

  /**
   * 展开短链，区分作品页与直播间
   *
   * 直播短链会落到 `webcast.amemv.com/.../reflow/{roomId}`，它不是作品，直接去抓分享页
   * 只会拿到空壳；这里先认出来，交给 `fetchLive` 单独处理。
   * @param url 短链
   * @returns 作品或直播目标；展开失败为 null
   */
  async resolveShort(url: string): Promise<DouyinShareTarget | null> {
    try {
      const res = await this.#app.ctx.http.request(url, {
        method: "GET",
        headers: { "User-Agent": MOBILE_UA },
        responseType: "none",
        throwOnError: false,
        followRedirect: false,
        timeout: "10s"
      })
      const location = res.headers["location"]
      const target = typeof location === "string" ? location : ""

      const live = target.match(/(?:webcast\.amemv\.com\/douyin\/webcast\/reflow|live\.douyin\.com)\/(\d{6,})/i)
      if (live?.[1] !== undefined) {
        return { kind: "live", roomId: live[1], url: LIVE_REFLOW.replace("{id}", live[1]) }
      }

      const hit = target.match(/(?:video|note|slides)\/(\d{6,})/)
      if (hit?.[1] !== undefined) return { kind: "aweme", id: hit[1] }
      return null
    } catch (error) {
      this.#app.debug("抖音短链展开失败", error)
      return null
    }
  }

  /**
   * 取直播间的主播、标题与流地址
   *
   * 页面里的 FLV/HLS 地址带时效签名，拿到就能播。页面结构变了就返回 null，调用方
   * 静默跳过，不影响其他消息。
   * @param url 直播间页地址
   * @param roomId 直播间 id
   * @returns 直播间信息；页面里没有房间信息时为 null
   */
  async fetchLive(url: string, roomId: string): Promise<DouyinLiveInfo | null> {
    try {
      const res = await this.#app.ctx.http.request<string>(url, {
        method: "GET",
        headers: {
          "User-Agent": MOBILE_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Referer: "https://www.douyin.com/"
        },
        responseType: "text",
        throwOnError: false,
        timeout: "15s"
      })
      const html = typeof res.data === "string" ? res.data : ""
      const info = parseLiveInfo(html)
      if (info === null) {
        this.#app.debug(`抖音直播间 ${roomId} 页面里没有房间信息`)
        return null
      }
      return { roomId, ...info }
    } catch (error) {
      this.#app.debug("抖音直播页请求失败", error)
      return null
    }
  }

  /**
   * 录一小段直播
   *
   * 直播是无限流，不能整场下载；用 ffmpeg 从 FLV 直接 `-c copy` 截前 N 秒，不转码，
   * CPU 开销很小。超过时长上限或 ffmpeg 不在就返回 null，调用方只保留文字提示。
   * @param info 直播间信息
   * @param seconds 录多少秒
   * @param maxMB 体积上限
   * @returns 本地 mp4 路径；失败为 null
   */
  async recordLive(info: DouyinLiveInfo, seconds: number, maxMB = LIVE_MAX_MB): Promise<string | null> {
    if (info.streamUrl === "") {
      this.#app.log("warn", `抖音直播 ${info.roomId} 没有可用的播放地址`)
      return null
    }

    const dir = join(this.#app.ctx.app.paths.temp, "douyin")
    await mkdir(dir, { recursive: true })
    const output = join(dir, `dy-live-${info.roomId}-${Date.now()}.mp4`)

    const size = await recordStream({
      url: info.streamUrl,
      seconds,
      output,
      maxMB,
      log: (level, message) => this.#app.log(level, message)
    })
    if (size === null) {
      await rm(output, { force: true })
      return null
    }
    this.#app.log("info", `抖音直播已录制：${info.roomId} ${seconds} 秒 ${formatSize(size)}`)
    return output
  }

  /**
   * 取作品信息
   * @param awemeId 作品 id
   * @returns 作品信息；失败为 null
   */
  async fetchInfo(awemeId: string): Promise<DouyinInfo | null> {
    const ttwid = await this.#ensureTtwid()

    for (const template of [SHARE_VIDEO, SHARE_NOTE]) {
      const url = template.replace("{id}", awemeId)
      try {
        const res = await this.#app.ctx.http.request<string>(url, {
          method: "GET",
          headers: {
            "User-Agent": MOBILE_UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Referer: "https://www.douyin.com/",
            ...(ttwid === "" ? {} : { Cookie: `ttwid=${ttwid}` })
          },
          responseType: "text",
          throwOnError: false,
          timeout: "20s"
        })
        const html = typeof res.data === "string" ? res.data : ""
        const aweme = findAweme(extractRouterData(html))
        if (aweme === null) continue
        const info = toInfo(aweme, awemeId)
        if (info !== null) return info
      } catch (error) {
        this.#app.debug(`抖音分享页请求失败（${template.includes("note") ? "图文" : "视频"}）`, error)
      }
    }

    this.#app.log("warn", `抖音作品 ${awemeId} 解析失败`)
    return null
  }

  /**
   * 把 vid 换成无水印播放地址
   * @param uri `play_addr.uri`
   * @param prefer 期望画质
   * @returns 地址与体积；都不可用为 null
   */
  async pickPlayUrl(uri: string, prefer: DouyinQuality): Promise<{ url: string; ratio: DouyinQuality } | null> {
    const order = [prefer, ...RATIOS.filter(item => item !== prefer)]
    for (const ratio of order) {
      const url = `${PLAY_API}?video_id=${encodeURIComponent(uri)}&ratio=${ratio}&line=0`
      try {
        const res = await this.#app.ctx.http.request(url, {
          method: "HEAD",
          headers: { "User-Agent": MOBILE_UA, Referer: "https://www.douyin.com/" },
          responseType: "none",
          throwOnError: false,
          timeout: "15s"
        })
        if (res.status >= 200 && res.status < 300) {
          const length = Number.parseInt(String(res.headers["content-length"] ?? ""), 10)
          if (Number.isFinite(length) && length > 1024) return { url, ratio }
        }
      } catch (error) {
        this.#app.debug(`抖音 ${ratio} 探测失败，换下一档`, error)
      }
    }
    return null
  }

  /**
   * 下载作品视频
   * @param info 作品信息
   * @param maxMB 体积上限
   * @param quality 期望画质
   * @returns 本地路径；失败为 null
   */
  async download(info: DouyinInfo, maxMB: number, quality: DouyinQuality): Promise<string | null> {
    if (info.playUri === "") {
      this.#app.log("warn", "这条抖音没有视频流（可能是图文）")
      return null
    }

    const picked = await this.pickPlayUrl(info.playUri, quality)
    if (picked === null) {
      this.#app.log("warn", "抖音没有探测到可用的播放地址")
      return null
    }

    const file = await this.saveVideo(
      picked.url,
      `dy-${info.awemeId}-${Date.now()}`,
      maxMB,
      "https://www.douyin.com/",
      "10m"
    )
    if (file !== null) this.#app.log("info", `抖音视频已就绪：${info.awemeId} ${picked.ratio}`)
    return file
  }

  /**
   * 取图文作品里的动图视频
   *
   * 动图作品是「一张图 + 一段 mp4」，mp4 在桌面作品页的 SSR 数据里，形如
   * `"video":{"width":1440,..."playAddr":[{"src":"https://v26-web.douyinvod.com/..."`。
   * 但桌面页现在会先返回 `_$jsvmprt` 挑战页，要算出 `__ac_signature` 再请求一次；
   * 这段交给 `fetchNoteHtml` 处理，普通图文没有 playAddr，直接回落静态图。
   * @param awemeId 作品 id
   * @returns 视频直链；没 Cookie 或不是动图为 null
   */
  async fetchNoteVideo(awemeId: string): Promise<string | null> {
    const cookie = this.#userCookie()
    if (cookie === "") {
      this.#app.log("warn", "抖音动图发视频需要先填 Cookie")
      return null
    }

    try {
      const ttwid = await this.#ensureTtwid()
      const html = await fetchNoteHtml(NOTE_PAGE.replace("{id}", awemeId), this.#cookieHeader(ttwid))
      // 分享页形态的 _ROUTER_DATA 里也可能带 images[].video，先按结构取，再走 SSR 正则
      const fromData = noteVideoOf(findAweme(extractRouterData(html)))
      if (fromData !== "") return fromData
      const fromHtml = parseNoteVideo(html)
      if (fromHtml === null) this.#app.debug(`抖音图文 ${awemeId} 页面里没有动图视频，按静态图发送`)
      return fromHtml
    } catch (error) {
      this.#app.debug(`抖音图文 ${awemeId} 取动图失败`, error)
      return null
    }
  }

  /**
   * 下载动图视频
   * @param awemeId 作品 id
   * @param url 直链
   * @param maxMB 体积上限
   * @returns 本地路径；失败或超限为 null
   */
  async downloadNoteVideo(awemeId: string, url: string, maxMB = 50): Promise<string | null> {
    const file = await this.saveVideo(
      url,
      `dy-note-${awemeId}-${Date.now()}`,
      maxMB,
      `https://www.douyin.com/note/${awemeId}`,
      "2m"
    )
    if (file !== null) this.#app.log("info", `抖音动图视频已就绪：${awemeId}`)
    return file
  }

  /**
   * 把远程 mp4 落到临时目录
   * @param url 视频直链
   * @param stem 文件名前缀
   * @param maxMB 体积上限
   * @param referer 请求来源
   * @param timeout 下载超时
   * @returns 本地路径；失败或超限为 null
   */
  private async saveVideo(
    url: string,
    stem: string,
    maxMB: number,
    referer: string,
    timeout: "2m" | "10m"
  ): Promise<string | null> {
    const dir = join(this.#app.ctx.app.paths.temp, "douyin")
    await mkdir(dir, { recursive: true })
    const part = join(dir, `${stem}.mp4.part`)
    const output = join(dir, `${stem}.mp4`)
    const limit = maxMB * 1024 * 1024

    // 抖音 CDN 会主动断掉框架 undici 连接池里复用的空闲连接，走 ctx.http.download 会拿到
    // SocketError: other side closed。这里用 fetch 自己建连接、边下边写盘，顺便按体积上限提前中断
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout === "2m" ? 120_000 : 600_000)

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": MOBILE_UA, Referer: referer },
        signal: controller.signal
      })
      if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`)

      const stream = createWriteStream(part)
      const finished = new Promise<void>((resolve, reject) => {
        stream.on("finish", () => resolve())
        stream.on("error", reject)
      })
      let written = 0
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        written += chunk.byteLength
        if (written > limit) {
          stream.destroy()
          await finished.catch(() => undefined)
          await rm(part, { force: true })
          this.#app.log("warn", `抖音视频超过上限 ${maxMB}MB，已放弃`)
          return null
        }
        if (!stream.write(chunk)) await once(stream, "drain")
      }
      stream.end()
      await finished

      const size = (await stat(part)).size
      if (size === 0) {
        await rm(part, { force: true })
        return null
      }
      await rename(part, output)
      return output
    } catch (error) {
      this.#app.log("warn", "抖音视频下载失败", error)
      await rm(part, { force: true })
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 取评论
   *
   * 评论接口要 `a_bogus`：签名内容就是查询串，且和 UA 绑定，两处不一致就会被拒。
   * `abogus` 包缺失时返回 null（评论图直接跳过，不影响卡片和视频）。
   * @param awemeId 作品 id
   * @param limit 最多几条
   * @returns 评论总数与列表；失败为 null
   */
  async fetchComments(
    awemeId: string,
    limit: number,
    authorSecUid = "",
    options: { replyLimit?: number; minLike?: number; showEmote?: boolean; showPictures?: boolean } = {}
  ): Promise<DouyinCommentResult | null> {
    if (limit <= 0) return { total: 0, items: [] }
    const replyLimit = Math.max(0, Math.min(3, options.replyLimit ?? REPLY_LIMIT))
    const minLike = Math.max(0, options.minLike ?? 0)
    const showPictures = options.showPictures !== false
    const signer = await loadSigner()
    if (signer === null) {
      this.#app.log("warn", "缺少 abogus 包，抖音评论图不可用（npm i abogus 即可）")
      return null
    }

    const ttwid = await this.#ensureTtwid()
    const cookie = this.#cookieHeader(ttwid)
    const params = new URLSearchParams({
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      aweme_id: awemeId,
      cursor: "0",
      // 多取一页再筛：抖音热点评论里偶尔夹着空正文/不可见项，先取 limit 条再过滤
      // 会导致每次显示 6/7/8 条乱跳；取满 20 条、过滤后再截到 limit，条数才稳定。
      count: "20",
      item_type: "0",
      ...BASE_PARAMS
    })

    const query = params.toString()
    try {
      const signature = await signer(query, PC_UA)
      const url = `${COMMENT_API}?${query}&a_bogus=${encodeURIComponent(signature)}`
      const res = await this.#app.ctx.http.request<{ comments?: DouyinCommentItem[]; total?: number; status_code?: number }>(
        url,
        {
          method: "GET",
          headers: {
            "User-Agent": PC_UA,
            Referer: `https://www.douyin.com/video/${awemeId}`,
            Accept: "application/json",
            ...(cookie === "" ? {} : { Cookie: cookie })
          },
          responseType: "json",
          throwOnError: false,
          timeout: "20s"
        }
      )
      const data = res.data ?? {}
      const raw = Array.isArray(data.comments) ? data.comments : []
      const emoji = options.showEmote === false ? {} : await this.#emojiMap()
      const views = raw
        .map((item: DouyinCommentItem) => ({
          raw: item,
          view: toCommentView(item, emoji, authorSecUid, replyLimit, showPictures)
        }))
        .filter(
          (entry): entry is { raw: DouyinCommentItem; view: DouyinCommentView } =>
            entry.view !== null && entry.view.like >= minLike
        )
        .slice(0, limit)

      // 内嵌回复通常只有 0-1 条，回复总数却有几十条时，单独去拉楼中楼。
      // 接口不通时会进入冷却，后面的评论不再重试，整体只多一次几百毫秒的等待。
      if (replyLimit > 0) await this.#fillReplies(awemeId, views, emoji, authorSecUid, replyLimit, showPictures)

      // 作者本人的评论排到最前（抖音评论区里也是这个观感），用稳定排序保留其余原顺序
      const items = views
        .map(entry => entry.view)
        .sort((a, b) => Number(b.isAuthor) - Number(a.isAuthor))
      this.#app.debug(
        `抖音取到评论 ${items.length} 条（原始 ${raw.length} 条），其中 ${items.filter(item => item.replies.length > 0).length} 条带回复`
      )
      const total = Number(data.total) > 0 ? Number(data.total) : items.length
      return { total, items }
    } catch (error) {
      this.#app.log("warn", "抖音取评论失败", error)
      return null
    }
  }

  /**
   * 给评论补上楼中楼
   *
   * 主列表里内嵌的回复通常只有 0-1 条，够不上「每条带 2 条」；有更多回复时单独请求
   * 楼中楼接口补上。
   *
   * 两个坑：
   * 1) 接口只对登录态开放，只有 ttwid 的匿名请求固定返回 200 + 空体，故没配登录
   *    Cookie 时直接跳过，不去白等；
   * 2) 这个路径对 `a_bogus` 的校验与评论列表不同 —— `abogus` 生成的完整签名会被判成
   *    无效并返回空体，反而短值能通（实测 2026-11）。这里固定传短值，接口改回严格
   *    校验时只是拿不到楼中楼，自动退回内嵌回复。
   *
   * 失败一次后 10 分钟内不再尝试，否则每条评论都要白等一次超时。
   * @param awemeId 作品 id
   * @param views 已映射好的评论（就地补 `replies`）
   * @param emoji 表情表
   * @param authorSecUid 作品作者的 sec_uid
   * @param replyLimit 每条最多补几条回复
   */
  async #fillReplies(
    awemeId: string,
    views: Array<{ raw: DouyinCommentItem; view: DouyinCommentView }>,
    emoji: Record<string, string>,
    authorSecUid: string,
    replyLimit: number,
    showPictures: boolean
  ): Promise<void> {
    if (Date.now() - this.#repliesBlockedAt < REPLY_BLOCK_TTL) return

    // 没登录（只有 ttwid）时接口固定返回空体，跳过以免白等
    const user = this.#userCookie()
    if (!/(^|;\s*)sessionid=/.test(user)) {
      this.#app.debug("抖音未配置登录 Cookie，跳过楼中楼")
      return
    }

    const targets = views
      .filter(entry => entry.view.replyTotal > entry.view.replies.length)
      .slice(0, 6)
    if (targets.length === 0) return

    const ttwid = await this.#ensureTtwid()
    const cookie = this.#cookieHeader(ttwid)

    for (const entry of targets) {
      const cid = entry.raw.cid
      if (cid === undefined || cid === "") continue
      try {
        const params = new URLSearchParams({
          device_platform: "webapp",
          aid: "6383",
          channel: "channel_pc_web",
          item_id: awemeId,
          comment_id: cid,
          cursor: "0",
          count: String(replyLimit),
          item_type: "0",
          ...BASE_PARAMS
        })
        const query = params.toString()
        const res = await this.#app.ctx.http.request<{ comments?: DouyinCommentItem[]; status_code?: number }>(
          `${REPLY_API}?${query}&a_bogus=1`,
          {
            method: "GET",
            headers: {
              "User-Agent": PC_UA,
              Referer: `https://www.douyin.com/video/${awemeId}`,
              Accept: "application/json",
              ...(cookie === "" ? {} : { Cookie: cookie })
            },
            responseType: "json",
            throwOnError: false,
            timeout: "10s"
          }
        )
        const list = Array.isArray(res.data?.comments) ? res.data.comments : []
        if (list.length === 0) {
          // 空体就是「整类请求被挡」，不是这条评论没回复
          this.#repliesBlockedAt = Date.now()
          this.#app.debug("抖音楼中楼接口返回空，10 分钟内不再尝试")
          return
        }
        entry.view.replies = list
          .slice(0, replyLimit)
          .map(item => toReplyView(item, emoji, authorSecUid, entry.view.nickname, showPictures))
      } catch (error) {
        this.#repliesBlockedAt = Date.now()
        this.#app.debug("抖音楼中楼请求失败，改用内嵌回复", error)
        return
      }
    }
  }

  /**
   * 表情表
   *
   * 抖音评论里的表情是 `[鲸鱼点赞]` 这样的文字标签，要靠这张表换成图。整表 371 项，
   * 拉一次缓存一天，避免每条评论都请求。
   * @returns 标签 → 图片地址；失败为空对象
   */
  async #emojiMap(): Promise<Record<string, string>> {
    const now = Date.now()
    if (this.#emoji !== undefined && now - this.#emojiAt < TTWID_TTL) return this.#emoji

    try {
      const cached = await this.#app.ctx.kv.get<{ map: Record<string, string>; at: number }>(EMOJI_KEY)
      if (cached !== undefined && now - cached.at < TTWID_TTL) {
        this.#emoji = cached.map
        this.#emojiAt = cached.at
        return cached.map
      }
    } catch {
      /* KV 不可用就继续走网络 */
    }

    const signer = await loadSigner()
    if (signer === null) return {}

    const params = new URLSearchParams({
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      publish_video_strategy_type: "2",
      need_all: "true",
      update_version_code: "170400",
      ...BASE_PARAMS
    })
    const query = params.toString()
    try {
      const ttwid = await this.#ensureTtwid()
      const cookie = this.#cookieHeader(ttwid)
      const signature = await signer(query, PC_UA)
      const res = await this.#app.ctx.http.request<{ emoji_list?: Array<{ display_name?: string; emoji_url?: { url_list?: string[] } }> }>(
        `${EMOJI_API}?${query}&a_bogus=${encodeURIComponent(signature)}`,
        {
          method: "GET",
          headers: {
            "User-Agent": PC_UA,
            Referer: "https://www.douyin.com/",
            Accept: "application/json",
            ...(cookie === "" ? {} : { Cookie: cookie })
          },
          responseType: "json",
          throwOnError: false,
          timeout: "20s"
        }
      )
      const map: Record<string, string> = {}
      for (const item of res.data?.emoji_list ?? []) {
        const key = item.display_name ?? ""
        const url = normalizeUrl(item.emoji_url?.url_list?.[0] ?? "")
        if (key !== "" && url !== "") map[key] = url
      }
      this.#emoji = map
      this.#emojiAt = now
      await this.#app.ctx.kv.set(EMOJI_KEY, { map, at: now }).catch(() => undefined)
      this.#app.debug(`抖音表情表已加载：${Object.keys(map).length} 个`)
      return map
    } catch (error) {
      this.#app.debug("抖音表情表拉取失败，评论里的表情会显示成文字", error)
      return {}
    }
  }

  /**
   * 用户自己填的 Cookie，清洗成一行
   *
   * 浏览器里复制出来的整段常带换行，直接塞进请求头会变成非法头值。
   * @returns 形如 `a=1; b=2`；没配置为空串
   */
  #userCookie(): string {
    return String(this.#app.config.douyinCookie ?? "")
      .replace(/\s*[\r\n]+\s*/g, "; ")
      .replace(/;\s*;/g, ";")
      .trim()
  }

  /**
   * 拼出请求要用的 Cookie
   *
   * 登录 Cookie 里通常已经带了 ttwid，这时以它为准；没配 Cookie 就只用匿名 ttwid。
   * @param ttwid 匿名访客标识
   * @returns Cookie 头；都没有为空串
   */
  #cookieHeader(ttwid: string): string {
    const user = this.#userCookie()
    if (user === "") return ttwid === "" ? "" : `ttwid=${ttwid}`
    if (/(^|;\s*)ttwid=/.test(user)) return user
    return ttwid === "" ? user : `ttwid=${ttwid}; ${user}`
  }

  /**
   * 拿 ttwid，带内存与 KV 两级缓存
   * @returns ttwid；失败为空串
   */
  async #ensureTtwid(): Promise<string> {
    const now = Date.now()
    if (this.#ttwid !== undefined && now - this.#ttwidAt < TTWID_TTL) return this.#ttwid

    try {
      const cached = await this.#app.ctx.kv.get<{ value: string; at: number }>(TTWID_KEY)
      if (cached !== undefined && now - cached.at < TTWID_TTL) {
        this.#ttwid = cached.value
        this.#ttwidAt = cached.at
        return cached.value
      }
    } catch {
      /* KV 不可用时忽略，直接去注册 */
    }

    try {
      const res = await this.#app.ctx.http.request(TTWID_REGISTER, {
        method: "POST",
        headers: {
          "User-Agent": MOBILE_UA,
          Referer: "https://www.douyin.com/",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          aid: 1768,
          union: true,
          needFid: false,
          region: "cn",
          cbUrlProtocol: "https",
          service: "www.ixigua.com",
          migrate_info: { ticket: "", source: "node" }
        }),
        responseType: "none",
        throwOnError: false,
        timeout: "15s"
      })
      const setCookie = res.headers["set-cookie"]
      const lines = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [String(setCookie)]
      const value = lines
        .map(line => line.match(/(?:^|;\s*)ttwid=([^;]+)/)?.[1] ?? "")
        .find(item => item !== "") ?? ""
      if (value === "") {
        this.#app.log("warn", "抖音匿名 ttwid 获取失败")
        return ""
      }
      this.#ttwid = value
      this.#ttwidAt = now
      await this.#app.ctx.kv.set(TTWID_KEY, { value, at: now }).catch(() => undefined)
      return value
    } catch (error) {
      this.#app.log("warn", "抖音 ttwid 注册失败", error)
      return ""
    }
  }
}

/** 签名接口的公共查询参数：评论、表情表都要带这一套，少一个就可能被拒 */
const BASE_PARAMS = {
  pc_client_type: "1",
  version_code: "190500",
  version_name: "19.5.0",
  cookie_enabled: "true",
  screen_width: "1920",
  screen_height: "1080",
  browser_language: "zh-CN",
  browser_platform: "Win32",
  browser_name: "Chrome",
  browser_version: "134.0.0.0",
  browser_online: "true",
  engine_name: "Blink",
  engine_version: "134.0.0.0",
  os_name: "Windows",
  os_version: "10",
  cpu_core_num: "8",
  device_memory: "8",
  platform: "PC",
  downlink: "10",
  effective_type: "4g",
  round_trip_time: "50"
} as const

/** 评论接口用的 PC UA（与签名绑定） */
const PC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"

/** acrawler 签名缓存：nonce 与签名成对出现，过期或被拒时重算 */
let acCache: { nonce: string; signature: string; at: number } | null = null
/** 签名有效期：拿不到权威值，按 10 分钟保守复用，被拒会立即重算 */
const AC_TTL = 10 * 60_000

/** 清掉签名缓存（测试用） */
export function resetAcCache(): void {
  acCache = null
}

/**
 * 取作品页 HTML，遇到 acrawler 挑战时算签名重试
 *
 * 必须用原生 fetch：`ctx.http` 会丢掉 set-cookie，而 `__ac_nonce` 只在
 * Set-Cookie 里，没有它就拼不出签名。
 * @param url 作品页地址
 * @param cookie 登录 Cookie（已含 ttwid）
 * @returns HTML
 */
async function fetchNoteHtml(url: string, cookie: string): Promise<string> {
  const read = async (pair: { nonce: string; signature: string } | null): Promise<{ html: string; nonce: string }> => {
    const ac = pair === null ? "" : `; __ac_nonce=${pair.nonce}; __ac_signature=${pair.signature}; __ac_referer=__ac_blank`
    const res = await fetch(url, {
      headers: {
        "User-Agent": PC_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: "https://www.douyin.com/",
        Cookie: `${cookie}${ac}`
      },
      signal: AbortSignal.timeout(20_000)
    })
    return { html: await res.text(), nonce: nonceOf(res.headers) }
  }

  const fresh = acCache !== null && Date.now() - acCache.at < AC_TTL ? acCache : null
  const first = await read(fresh)
  if (!first.html.includes("_$jsvmprt")) return first.html

  // 挑战页没有作品数据，用它的 nonce 算签名后再要一次
  if (first.nonce === "") return first.html
  const signature = solveAcChallenge(first.html, first.nonce, PC_UA)
  acCache = { nonce: first.nonce, signature, at: Date.now() }
  const second = await read(acCache)
  return second.html
}

/** 签名函数形状 */
type Signer = (query: string, userAgent: string) => Promise<string>

/**
 * 动态加载 `abogus`
 *
 * 做成动态导入而不是顶层 import：这个包缺失时只让评论图不可用，不该把整个插件带崩。
 * @returns 签名函数；没装为 null
 */
async function loadSigner(): Promise<Signer | null> {
  try {
    const mod = (await import("abogus")) as { abogus?: (query: string, body: string) => string }
    const fn = mod.abogus
    if (typeof fn !== "function") return null
    return async (query: string) => fn(query, "")
  } catch {
    return null
  }
}

/**
 * 从 HTML 里取 `window._ROUTER_DATA`
 *
 * 两种形态都要处理：直接是对象，或 `JSON.parse("…")` 包一层。取不到返回 null。
 * @param html 页面 HTML
 * @returns 解析后的对象
 */
function extractRouterData(html: string): unknown {
  const marker = html.indexOf("window._ROUTER_DATA")
  if (marker === -1) return null
  const eq = html.indexOf("=", marker)
  if (eq === -1) return null
  const rest = html.slice(eq + 1).trimStart()

  if (rest.startsWith("JSON.parse(")) {
    const quote = rest.indexOf('"')
    if (quote === -1) return null
    let escaped = false
    for (let i = quote + 1; i < rest.length; i += 1) {
      if (escaped) {
        escaped = false
        continue
      }
      if (rest[i] === "\\") {
        escaped = true
        continue
      }
      if (rest[i] === '"') {
        try {
          const literal = rest.slice(quote, i + 1)
          return JSON.parse(JSON.parse(literal) as string)
        } catch {
          return null
        }
      }
    }
    return null
  }

  const start = rest.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < rest.length; i += 1) {
    const char = rest[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(rest.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * 从桌面作品页里取动图视频
 *
 * 登录后的作品页会在图片对象里多带一个 `video` 块（camelCase 的 `playAddr`），
 * 普通图文没有。页面里的 JSON 是转义过的，先把 `\"` 和 `\u0026` 还原再匹配。
 * @param html 作品页 HTML
 * @returns 视频直链；不是动图或页面改版为 null
 */
export function parseNoteVideo(html: string): string | null {
  const text = html.replace(/\\"/g, '"').replace(/\\u0026/g, "&")
  const match = text.match(
    /"video":\{"width":\d+,"height":\d+,"ratio":"[^"]+","duration":\d+,"dataSize":\d+,"uri":"[^"]+","playAddr":\[\{"src":"([^"]+)"/
  )
  return match?.[1] ?? null
}

/**
 * 从直播间页里取主播、标题、开播状态与流地址
 *
 * 页面是 SSR 出来的，主播与标题就在 `bottom-username-*` / `bottom-title-*` 这两个
 * 带哈希的 class 里；播放器节点上直接带着 FLV 地址（`url="..."`），没有时退回 HLS。
 * 哈希每次发版都会变，所以只认前缀。React 会在文本中间插 `<!-- -->`，先去掉再匹配。
 * @param html 直播间页 HTML
 * @returns 昵称、标题、封面、在线/看过/粉丝/点赞与流地址；主播和标题都没取到为 null
 */
export function parseLiveInfo(html: string): {
  nickname: string
  title: string
  cover: string
  online: number
  totalViewers: number
  followers: number
  likes: number
  newFollowers: number
  startedAt: number
  finishedAt: number
  living: boolean
  streamUrl: string
} | null {
  if (html === "") return null
  const text = html.replace(/<!-- -->/g, "")
  const nickname = decodeEntities(text.match(/bottom-username-[A-Za-z0-9_-]+">@?([^<]+)</)?.[1] ?? "").trim()
  const title = decodeEntities(text.match(/bottom-title-[A-Za-z0-9_-]+">([^<]+)</)?.[1] ?? "").trim()
  if (nickname === "" && title === "") return null

  const streamUrl = decodeEntities(
    text.match(/url="(https?:\/\/[^"]+?\.(?:flv|m3u8)[^"]*)"/)?.[1] ??
      text.match(/backupUrl="(https?:\/\/[^"]+?\.m3u8[^"]*)"/)?.[1] ??
      ""
  )
  const cover = decodeEntities(text.match(/<webcast-reflow-player[^>]*\scover="([^"]+)"/)?.[1] ?? "")
  // 页面里的房间数据是转义过的 JSON：userCountStr 才是当前在线，totalUser 是累计看过
  const online = Number(
    text.match(/userCountStr\\?":\s*\\?"(\d+)\\?"/)?.[1] ?? text.match(/userCount\\?":\s*(\d+)/)?.[1] ?? 0
  )
  const totalViewers = Number(text.match(/totalUser\\?":\s*(\d+)/)?.[1] ?? 0)
  const followers = Number(text.match(/followerCount\\?":\s*(\d+)/)?.[1] ?? 0)
  // `likeCount` 在页面里出现两次：stats 里常是 0，房间顶层的才是真实点赞数，取最大
  let likes = 0
  for (const match of text.matchAll(/likeCount\\?":\s*\\?"?(\d+)/g)) {
    likes = Math.max(likes, Number(match[1]))
  }
  // `createTime` 有多个，房间本身那个才是开播时间
  let startedAt = 0
  for (const match of text.matchAll(/createTime\\?":\s*\\?"?(\d+)/g)) {
    startedAt = Math.max(startedAt, Number(match[1]))
  }
  const finishedAt = Number(text.match(/finishTime\\?":\s*\\?"?(\d+)/)?.[1] ?? 0)
  const newFollowers = Number(text.match(/followCount\\?":\s*(\d+)/)?.[1] ?? 0)
  // `roomViewStats.displayValue` 是页面展示的「看过」，比 totalUser 更准
  const watched = Number(text.match(/displayValue\\?":\s*(\d+)/)?.[1] ?? totalViewers)
  return {
    nickname,
    title,
    cover,
    online,
    totalViewers: watched,
    followers,
    likes,
    newFollowers,
    startedAt,
    finishedAt,
    living: /living-[A-Za-z0-9_-]+">直播中</.test(text),
    streamUrl
  }
}

/**
 * 解几个页面里常见的 HTML 实体
 * @param text 原文
 * @returns 解码后的文本
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** 原始作品结构（只声明用到的字段） */
interface RawAweme {
  aweme_id?: string
  desc?: string
  create_time?: number
  author?: { sec_uid?: string; nickname?: string; avatar_thumb?: { url_list?: string[] } }
  video?: {
    duration?: number
    width?: number
    height?: number
    cover?: { url_list?: string[] }
    play_addr?: { uri?: string }
  }
  images?: Array<{
    url_list?: string[]
    width?: number
    height?: number
    /** 动图作品里每张图还带一段 mp4，普通图文没有 */
    video?: {
      play_addr?: { uri?: string; url_list?: string[] }
      download_addr?: { url_list?: string[] }
    }
  }>
  /** 部分版本的动图码率信息放在这里，同样指向那段 mp4 */
  img_bitrate?: Array<{ play_addr?: { url_list?: string[] } }>
  statistics?: { digg_count?: number; comment_count?: number; collect_count?: number; share_count?: number }
  music?: { title?: string; author?: string }
}

/**
 * 在 `_ROUTER_DATA` 里找作品对象
 * @param node 任意节点
 * @param depth 递归深度
 * @returns 作品对象；没有为 null
 */
function findAweme(node: unknown, depth = 0): RawAweme | null {
  if (depth > 8 || node === null || typeof node !== "object") return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findAweme(item, depth + 1)
      if (hit !== null) return hit
    }
    return null
  }
  const record = node as Record<string, unknown>
  if (typeof record.aweme_id === "string" && (record.video !== undefined || record.images !== undefined || record.desc !== undefined)) {
    return record as RawAweme
  }
  for (const value of Object.values(record)) {
    const hit = findAweme(value, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

/**
 * 从作品对象里取动图视频直链
 *
 * 动图作品是「一张 WebP + 一段 mp4」，mp4 就挂在图片对象的 `video.play_addr` 上；
 * 普通图文没有这个字段，返回空串让调用方回落静态图。
 * @param aweme 作品对象
 * @returns 视频直链；不是动图为空串
 */
export function noteVideoOf(aweme: RawAweme | null): string {
  if (aweme === null) return ""

  const candidates: Array<string | undefined> = []
  for (const image of aweme.images ?? []) {
    candidates.push(image.video?.play_addr?.url_list?.[0], image.video?.download_addr?.url_list?.[0])
    // `uri` 有的版本是直链，有的只是视频 id，只认带协议的
    const uri = image.video?.play_addr?.uri
    if (uri !== undefined && /^https?:\/\//.test(uri)) candidates.push(uri)
  }
  for (const item of aweme.img_bitrate ?? []) candidates.push(item.play_addr?.url_list?.[0])

  for (const candidate of candidates) {
    const url = normalizeUrl(candidate ?? "")
    if (url !== "") return url
  }
  return ""
}

/**
 * 原始作品 → 展示用结构
 * @param raw 原始作品
 * @param fallbackId 兜底 id
 * @returns 作品信息；缺关键字段为 null
 */
function toInfo(raw: RawAweme, fallbackId: string): DouyinInfo | null {
  const id = raw.aweme_id ?? fallbackId
  if (id === "") return null
  const images = (raw.images ?? [])
    .map(item => normalizeUrl(item.url_list?.[0] ?? ""))
    .filter(item => item !== "")
  const cover = normalizeUrl(raw.video?.cover?.url_list?.[0] ?? images[0] ?? "")
  const isImages = images.length > 0
  // 图文封面来自第一张图，视频封面来自 video；尺寸按封面所属的那一份取
  const coverWidth = isImages ? raw.images?.[0]?.width ?? 0 : raw.video?.width ?? 0
  const coverHeight = isImages ? raw.images?.[0]?.height ?? 0 : raw.video?.height ?? 0

  return {
    awemeId: id,
    desc: raw.desc ?? "",
    author: {
      secUid: raw.author?.sec_uid ?? "",
      name: raw.author?.nickname ?? "抖音用户",
      avatar: normalizeUrl(raw.author?.avatar_thumb?.url_list?.[0] ?? "")
    },
    cover,
    coverWidth,
    coverHeight,
    duration: Math.round((raw.video?.duration ?? 0) / 1000),
    createTime: raw.create_time ?? 0,
    music: raw.music?.title ?? "",
    stat: {
      digg: raw.statistics?.digg_count ?? 0,
      comment: raw.statistics?.comment_count ?? 0,
      collect: raw.statistics?.collect_count ?? 0,
      share: raw.statistics?.share_count ?? 0
    },
    isImages,
    images,
    playUri: raw.video?.play_addr?.uri ?? "",
    shareUrl: isImages ? `https://www.douyin.com/note/${id}` : `https://www.douyin.com/video/${id}`
  }
}

/**
 * 原始评论 → 展示用结构
 * @param raw 原始评论
 * @param emoji 表情表：标签 → 图片地址
 * @param authorUid 作品作者的 uid，用来给 TA 的评论打「作者」标
 * @param replyLimit 内嵌回复最多保留几条
 * @param showPictures 是否渲染评论里的配图与大表情
 * @returns 评论视图；正文、图片、表情都为空为 null
 */
function toCommentView(
  raw: DouyinCommentItem,
  emoji: Record<string, string>,
  authorSecUid: string,
  replyLimit = REPLY_LIMIT,
  showPictures = true
): DouyinCommentView | null {
  const text = String(raw.text ?? "").trim()
  const images = showPictures ? commentImages(raw.image_list) : []
  const sticker = showPictures ? commentSticker(raw.sticker) : ""
  if (text === "" && images.length === 0 && sticker === "") return null

  // 主列表里偶尔会内嵌回复，可能是单个对象，也可能是数组
  const inline = raw.reply_comment === undefined || raw.reply_comment === null
    ? []
    : Array.isArray(raw.reply_comment)
      ? raw.reply_comment
      : [raw.reply_comment]

  return {
    nickname: raw.user?.nickname ?? "抖音用户",
    avatar: normalizeUrl(raw.user?.avatar_thumb?.url_list?.[0] ?? ""),
    parts: splitEmote(text, emoji),
    images,
    sticker,
    like: raw.digg_count ?? 0,
    location: raw.ip_label ?? "",
    time: raw.create_time === undefined ? "" : formatRelative(raw.create_time),
    isAuthor: authorSecUid !== "" && String(raw.user?.sec_uid ?? "") === authorSecUid,
    replies: inline
      .slice(0, replyLimit)
      .map(item => toReplyView(item, emoji, authorSecUid, raw.user?.nickname ?? "", showPictures)),
    replyTotal: Math.max(raw.reply_comment_total ?? 0, inline.length)
  }
}

/**
 * 评论配图
 *
 * 优先缩略图：评论图里最多展示 120px，原图动辄 3000px，直接塞进 Chromium 会拖慢渲染。
 * @param list 接口里的 image_list
 * @returns 图片地址，最多 3 张
 */
function commentImages(list: DouyinCommentImage[] | null | undefined): string[] {
  return (list ?? [])
    .map(item =>
      normalizeUrl(
        item.thumb_url?.url_list?.[0] ?? item.origin_url?.url_list?.[0] ?? item.medium_url?.url_list?.[0] ?? ""
      )
    )
    .filter(url => url !== "")
    .slice(0, 3)
}

/**
 * 评论里的大表情
 *
 * 静态图优先；没有静态图才退回动图，避免渲染器等到动图解码完。
 * @param sticker 接口里的 sticker
 * @returns 图片地址；没有为空串
 */
function commentSticker(sticker: DouyinCommentSticker | null | undefined): string {
  return normalizeUrl(sticker?.static_url?.url_list?.[0] ?? sticker?.animated_url?.url_list?.[0] ?? "")
}

/**
 * 原始楼中楼 → 展示用结构
 *
 * 「▶ 某人」只在**回复楼中楼里的另一个人**时才有，直接回复主评论时和抖音原版一样只显示
 * 回复者的名字。判定靠 `reply_to_username`：它等于主评论昵称（或为空）就是直接回复主评论。
 * @param raw 原始回复
 * @param emoji 表情表
 * @param authorSecUid 作品作者的 sec_uid
 * @param parentNickname 主评论的昵称，用来识别「这条回复回复的是主评论本身」
 * @returns 回复视图
 */
function toReplyView(
  raw: DouyinCommentItem,
  emoji: Record<string, string>,
  authorSecUid = "",
  parentNickname = "",
  showPictures = true
): DouyinReplyView {
  const to = String(raw.reply_to_username ?? "").trim()
  const isReplyToReply = raw.reply_to_reply_id !== undefined && String(raw.reply_to_reply_id) !== "" && String(raw.reply_to_reply_id) !== "0"
  // 指向主评论、或压根没给对象时都不画箭头
  const replyTo = to !== "" && (to !== parentNickname || isReplyToReply) ? to : ""

  return {
    nickname: raw.user?.nickname ?? "抖音用户",
    avatar: normalizeUrl(raw.user?.avatar_thumb?.url_list?.[0] ?? ""),
    parts: splitEmote(String(raw.text ?? "").trim(), emoji),
    images: showPictures ? commentImages(raw.image_list) : [],
    sticker: showPictures ? commentSticker(raw.sticker) : "",
    like: raw.digg_count ?? 0,
    time: raw.create_time === undefined ? "" : formatRelative(raw.create_time),
    location: raw.ip_label ?? "",
    replyTo,
    isAuthor: authorSecUid !== "" && String(raw.user?.sec_uid ?? "") === authorSecUid
  }
}

/**
 * 把正文切成「文字 / 表情图」两种段
 *
 * 抖音的表情在正文里是 `[鲸鱼点赞]` 这样的标签，标签本身带着方括号，所以直接拿整表
 * 的键去匹配；按长度从长到短试，避免短标签抢先切走长标签的前缀。
 * @param text 正文
 * @param emoji 表情表
 * @returns 分段
 */
function splitEmote(text: string, emoji: Record<string, string>): DouyinTextPart[] {
  const parts: DouyinTextPart[] = []
  if (text === "") return parts

  const keys = Object.keys(emoji).sort((a, b) => b.length - a.length)
  if (keys.length === 0) return [{ text }]

  let buffer = ""
  let index = 0
  while (index < text.length) {
    const hit = keys.find(key => text.startsWith(key, index))
    if (hit === undefined) {
      buffer += text[index]
      index += 1
      continue
    }
    if (buffer !== "") {
      parts.push({ text: buffer })
      buffer = ""
    }
    parts.push({ emote: { url: emoji[hit]! } })
    index += hit.length
  }
  if (buffer !== "") parts.push({ text: buffer })
  return parts
}

/**
 * 相对时间文案（与 B 站那边保持同一套规则）
 * @param seconds 秒级时间戳
 * @returns 文案
 */
function formatRelative(seconds: number): string {
  const then = new Date(seconds * 1000)
  const now = new Date()
  const dayStart = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diffDays = Math.round((dayStart(now) - dayStart(then)) / 86_400_000)

  if (diffDays <= 0) {
    const elapsed = Math.max(0, Math.floor(now.getTime() / 1000) - seconds)
    if (elapsed < 60) return "刚刚"
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}分钟前`
    return `${Math.floor(elapsed / 3600)}小时前`
  }
  if (diffDays === 1) {
    const hh = String(then.getHours()).padStart(2, "0")
    const mm = String(then.getMinutes()).padStart(2, "0")
    return `昨天 ${hh}:${mm}`
  }
  if (diffDays <= 3) return `${diffDays}天前`
  if (then.getFullYear() === now.getFullYear()) return `${then.getMonth() + 1}月${then.getDate()}日`
  return `${then.getFullYear()}-${String(then.getMonth() + 1).padStart(2, "0")}-${String(then.getDate()).padStart(2, "0")}`
}

/**
 * 抖音图床地址规范化
 * @param url 原地址
 * @returns https 绝对地址
 */
function normalizeUrl(url: string): string {
  const text = url.trim()
  if (text === "") return ""
  if (text.startsWith("//")) return `https:${text}`
  if (text.startsWith("http://")) return `https://${text.slice("http://".length)}`
  return text
}
