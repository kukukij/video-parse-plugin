/**
 * 模块职责：抖音链接的自动解析 —— 识别、出卡片、可选下视频、可选评论图
 * 依赖方向：依赖 app、services/douyin、utils/format、templates/douyin-*
 * 生命周期：随插件注册中间件，卸载时由内核回收
 * 注意事项：与 B 站那条链路完全并列，互不影响：B 站中间件先跑（priority 200），
 *          这里用 190 兜在后面，命中抖音链接才收事件。评论图是锦上添花，任何一步
 *          失败都只记日志，不能让已经发出去的卡片/视频判成失败。
 */
import { setTimeout as sleep } from "node:timers/promises"
import { seg } from "@yunzai-ng/core"
import type { ForwardNode, MessageEvent, RawSegment, Segment } from "@yunzai-ng/types"
import type { BilibiliApp } from "../core/app.js"
import { DouyinApi } from "../services/douyin.js"
import type { DouyinInfo } from "../types/douyin.js"
import { formatCount, formatDuration } from "../utils/format.js"
import { resolveDouyinVideo } from "../utils/video.js"
import { type Pending, react } from "./card.js"
import { buildLiveCard, deliverLive } from "./live.js"

/** 卡片模板 */
const CARD = "douyin-card"
/** 评论模板 */
const COMMENT_CARD = "douyin-comments"

/**
 * 注册抖音的自动解析中间件
 * @param app 运行期状态
 * @returns Disposer
 */
export function registerDouyin(app: BilibiliApp): () => void {
  const api = new DouyinApi(app)

  return app.ctx.middleware(
    async (e, next) => {
      if (e.kind !== "message") return next()
      if (app.config.douyinEnabled !== true) return next()
      if (!shouldConsider(app, e)) return next()
      if (!DouyinApi.hasLink(e.text)) return next()

      const handled = await tryParse(app, api, e)
      if (handled) {
        e.stop()
        return
      }
      return next()
    },
    { priority: 190 }
  )
}

/**
 * 场景与群设置是否放行
 * @param app 运行期状态
 * @param e 消息事件
 * @returns 放行 true
 */
function shouldConsider(app: BilibiliApp, e: MessageEvent): boolean {
  if (e.isGroup) {
    const gid = e.group?.gid
    if (gid !== undefined && !app.isGroupEnabled(gid)) return false
    return true
  }
  return app.config.parseInPrivate
}

/**
 * 走一遍解析与投递
 * @param app 运行期状态
 * @param api 抖音接口
 * @param e 消息事件
 * @returns 是否已处理
 */
async function tryParse(app: BilibiliApp, api: DouyinApi, e: MessageEvent): Promise<boolean> {
  const target = DouyinApi.extractTarget(e.text)
  if (target === null) return false

  const gid = e.group?.gid ?? `private:${e.sender.uid}`

  let awemeId: string
  if (target.kind === "id") {
    awemeId = target.value
  } else {
    const resolved = await api.resolveShort(target.value)
    if (resolved === null) {
      app.debug("抖音短链展开失败，静默跳过")
      return true
    }
    // 直播没有可下载的作品，取主播与标题回一条提示就结束
    if (resolved.kind === "live") {
      await replyLive(app, api, e, resolved.roomId, resolved.url, target.value)
      return true
    }
    awemeId = resolved.id
  }

  if (app.inCooldown(gid, awemeId)) {
    app.debug(`群 ${gid} 里抖音 ${awemeId} 还在冷却中，跳过`)
    return true
  }

  // 表情只是「在处理」的提示，不必占住解析的起跑线
  void react(e, "10024")
  const info = await api.fetchInfo(awemeId)
  if (info === null) {
    app.debug("抖音作品解析失败，静默跳过")
    return true
  }

  /**
   * 取视频文件
   *
   * 图文里的动图可以当视频发，取不到就继续走静态图，不额外打扰；普通作品按档位下载。
   * 这一步通常是整条链路里最慢的，故与卡片、评论图的渲染并行。
   * @returns 视频路径；不下载或失败为 undefined
   */
  const loadVideo = async (): Promise<string | undefined> => {
    if (info.isImages) {
      if (app.config.douyinNoteVideo !== true) return undefined
      const url = await api.fetchNoteVideo(info.awemeId)
      return url === null ? undefined : (await api.downloadNoteVideo(info.awemeId, url)) ?? undefined
    }
    // 档位里带着画质与体积上限，选「不下载」时为 undefined
    const profile = resolveDouyinVideo(app.config.douyinVideo)
    return profile === null ? undefined : (await api.download(info, profile.maxMB, profile.quality)) ?? undefined
  }

  // 评论图要先渲染好，才能和卡片、视频、图片一起装进同一条转发
  const limit = app.config.commentSend === false ? 0 : app.config.commentCount ?? 0
  // 三件事同时起跑；卡片一好就先直发，视频与评论图交给 deliver 按序等
  const videoTask = loadVideo()
  const commentsTask = limit > 0 ? buildComments(app, api, info, limit) : Promise.resolve(null)
  const card = await renderCard(app, info)

  const sent = await deliver(app, e, info, videoTask, commentsTask, card)
  if (sent !== false) {
    await app.markParsed({ bvid: `DY-${info.awemeId}`, title: info.desc.slice(0, 40), gid, group: e.group?.name })
    app.touchCooldown(gid, info.awemeId)
    // 转发超时时消息会晚一两秒才到，等它落地再回「完成」，否则表情会抢在消息前面
    if (sent === "late") await sleep(3000)
    await react(e, "124")
  }
  return true
}

/**
 * 直播间发一张卡片，再按配置附上录制片段
 *
 * 直播流没法当整条视频发；`douyinLiveRecord` 大于 0 时先录这么多秒，再和卡片一起
 * 发出去。页面结构变了、取不到信息就静默跳过，不打扰群聊。冷却沿用
 * 「同群同一个直播间」那一套。
 * @param app 运行期状态
 * @param api 抖音接口
 * @param e 消息事件
 * @param roomId 直播间 id
 * @param pageUrl 直播间页地址
 * @param shareUrl 用户发的那条分享链接
 */
async function replyLive(
  app: BilibiliApp,
  api: DouyinApi,
  e: MessageEvent,
  roomId: string,
  pageUrl: string,
  shareUrl: string
): Promise<void> {
  const gid = e.group?.gid ?? `private:${e.sender.uid}`
  const key = `live:${roomId}`
  if (app.inCooldown(gid, key)) {
    app.debug(`群 ${gid} 里抖音直播 ${roomId} 还在冷却中，跳过`)
    return
  }

  void react(e, "10024")

  const info = await api.fetchLive(pageUrl, roomId)
  if (info === null) return

  // 卡片只要信息，与录制互不依赖：先起渲染，让它的两秒藏在录制里
  const cardTask = buildLiveCard(app, "douyin", info, shareUrl)
  const seconds = Math.max(0, Math.min(60, Number(app.config.douyinLiveRecord ?? 0)))
  let videoFile: string | undefined
  if (info.living && seconds > 0) {
    const file = await api.recordLive(info, seconds)
    if (file !== null) videoFile = file
  }

  const sent = await deliverLive(app, e, info, "douyin", videoFile, shareUrl, cardTask)
  if (!sent) return
  app.touchCooldown(gid, key)
  await react(e, "124")
}

/**
 * 投递卡片、视频、图文与评论图
 *
 * 形态由两个开关决定：
 * - 两个都开：一条总转发 = 卡片 → 图文转发（图片/视频，一条消息一张）→ 评论图；
 * - 只开总开关：卡片、视频、评论图进同一条转发，图片直发一条多图；
 * - 只开图片转发：卡片直发，图片单独一条合并转发，视频与评论图直发；
 * - 都关：卡片、视频、图片、评论图逐条直发；
 * - 平台不支持转发或转发失败时，回落为平铺 / 逐条直发。
 * @param app 运行期状态
 * @param e 消息事件
 * @param info 作品信息
 * @param videoFile 已下载的视频路径，也可以是仍在下载的任务：直发时卡片先走，走到视频那一步才等它
 * @param commentsImage 已渲染好的评论图，也可以是仍在渲染的任务；无论何时就绪都排在最后发
 * @param preRenderedCard 卡片渲染得早时可直接传进来，省掉一次串行等待
 * @returns false 卡片没送出去；sent 已送达；late 转发超时但消息已在路上
 */
export async function deliver(
  app: BilibiliApp,
  e: MessageEvent,
  info: DouyinInfo,
  videoFile?: Pending<string | undefined>,
  commentsImage?: Pending<Segment | null>,
  preRenderedCard?: Pending<Segment>
): Promise<"sent" | "late" | false> {
  const config = app.config
  const card = await (preRenderedCard ?? renderCard(app, info))
  const images = info.isImages ? info.images.slice(0, 9) : []
  const canForward = e.isGroup && config.cardAsForward && e.bot.caps.has("forward")
  // 图片合并开关独立生效：总开关关着时，图片自己也能单独做成一条转发
  const canImageForward =
    e.isGroup && config.douyinImagesAsForward !== false && e.bot.caps.has("forward")
  const imageMerge = images.length > 0 && canImageForward
  let cardDelivered = false
  /** 是否出现过「超时但消息已在路上」的转发 */
  let lateDelivery = false

  /**
   * 发一条合并转发
   *
   * 超时与失败要分开：NapCat 处理带视频/图片的转发常常超过 15 秒的接口超时，
   * 但消息往往在超时后一两秒就真的发出去了。此时若再补发一条，群里就会收到两遍，
   * 所以超时按「已送达」处理，只有明确的失败才降级。
   * @param nodes 节点
   * @param summary 外显摘要
   * @param allowSingle 是否允许只含一个节点的转发
   * @returns ok 已发出；timeout 超时但很可能已送达；fail 明确失败
   */
  const sendForward = async (
    nodes: ForwardNode[],
    summary: string,
    allowSingle = false
  ): Promise<"ok" | "timeout" | "fail"> => {
    // 只有一个节点的转发要多点一层才看得到内容，默认还不如直发
    if (nodes.length === 0 || (nodes.length === 1 && !allowSingle)) return "fail"
    try {
      await e.reply(seg.forward(nodes, { summary }))
      return "ok"
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (/未收到响应|TimeoutError|timed? ?out/i.test(text)) {
        app.log("warn", "抖音合并转发超时，消息可能稍后到达，不再补发", error)
        return "timeout"
      }
      app.log("warn", "抖音合并转发失败，改为直发", error)
      return "fail"
    }
  }

  /** 图片节点，一张图一条消息；动图作品的视频排在图片之后（没下载完就在这里等） */
  const imageNodes = async (): Promise<ForwardNode[]> => {
    const nodes = images.map(url => seg.node([seg.image(url)], { name: "抖音图文", uid: e.selfId }))
    const file = await videoFile
    if (file !== undefined) {
      nodes.push(seg.node([seg.video(file)], { name: "抖音视频", uid: e.selfId }))
    }
    return nodes
  }

  /**
   * 图片单独送达（总开关关着时）
   * 合并开关开着时做成一条转发（图片/视频，一条消息一张）；否则直发多图
   * @returns sent 已进转发；late 转发超时但已送达；none 退回直发（视频还没发）
   */
  const sendImagesAlone = async (): Promise<"sent" | "late" | "none"> => {
    if (imageMerge) {
      const result = await sendForward(await imageNodes(), `抖音图文 · ${images.length} 张`, true)
      if (result !== "fail") return result === "timeout" ? "late" : "sent"
    }
    try {
      await e.reply(images.map(url => seg.image(url)))
    } catch (error) {
      app.log("warn", "抖音图文发送失败", error)
    }
    return "none"
  }

  /** 视频单独直发（下载还没完就在这里等） */
  const sendVideoAlone = async (): Promise<void> => {
    const file = await videoFile
    if (file === undefined) return
    try {
      await e.reply(seg.video(file))
    } catch (error) {
      app.log("warn", "抖音视频发送失败（卡片已送达）", error)
    }
  }

  /** 评论图单独直发；它是最后一条，渲染没完就在这里等 */
  const sendCommentsAlone = async (): Promise<void> => {
    const comments = await commentsImage
    if (comments === undefined || comments === null) return
    try {
      await e.reply(comments)
    } catch (error) {
      app.log("warn", "抖音评论图发送失败（卡片已送达）", error)
    }
  }

  if (canForward) {
    // 转发是一条消息，三项都得齐了才能发
    const [file, comments] = await Promise.all([videoFile, commentsImage])
    const cardNode = seg.node([card], { name: "抖音解析", uid: e.selfId })
    const videoNode =
      file === undefined ? undefined : seg.node([seg.video(file)], { name: "抖音视频", uid: e.selfId })
    const commentNode =
      comments === undefined || comments === null
        ? undefined
        : seg.node([comments], { name: "抖音评论", uid: e.selfId })

    if (imageMerge) {
      // 两个开关都开：一条总转发 = 卡片 → 图文转发（图片/视频，一条消息一张）→ 评论图
      const inner = nestedMedia(e, images, file)
      if (inner !== undefined) {
        const result = await sendForward(
          [cardNode, seg.node(inner, { name: "抖音图文", uid: e.selfId }), ...(commentNode === undefined ? [] : [commentNode])],
          `抖音：${info.desc.slice(0, 30)}`
        )
        if (result === "timeout") lateDelivery = true
        cardDelivered = result !== "fail"
      }
      // 平台不接受嵌套：退回平铺，图片仍是总转发里的一条一张
      if (!cardDelivered) {
        const result = await sendForward(
          [
            cardNode,
            ...images.map(url => seg.node([seg.image(url)], { name: "抖音图文", uid: e.selfId })),
            ...(videoNode === undefined ? [] : [videoNode]),
            ...(commentNode === undefined ? [] : [commentNode])
          ],
          `抖音：${info.desc.slice(0, 30)}`
        )
        if (result === "timeout") lateDelivery = true
        cardDelivered = result !== "fail"
      }
    } else {
      // 只开总开关：卡片、视频、评论图放同一条转发
      const result = await sendForward(
        [
          cardNode,
          ...(videoNode === undefined ? [] : [videoNode]),
          ...(commentNode === undefined ? [] : [commentNode])
        ],
        `抖音：${info.desc.slice(0, 30)}`
      )
      if (result === "timeout") lateDelivery = true
      cardDelivered = result !== "fail"
    }
  }

  // 没有转发，或转发失败：逐条直发
  if (!cardDelivered) {
    const at = config.atSender ? [seg.at(e.sender.uid), seg.text(" ")] : []
    try {
      await e.reply([...at, card])
    } catch (error) {
      app.log("error", "抖音卡片发送失败", error)
      return false
    }

    const imageState = images.length > 0 ? await sendImagesAlone() : "none"
    if (imageState === "late") lateDelivery = true
    // 视频已经跟着图片进转发就不再单发
    if (imageState !== "sent" && imageState !== "late") await sendVideoAlone()
    await sendCommentsAlone()
  } else if (images.length > 0 && !imageMerge) {
    // 总转发已送达，但图片合并关着：图片单独直发一条多图
    try {
      await e.reply(images.map(url => seg.image(url)))
    } catch (error) {
      app.log("warn", "抖音图文发送失败（转发已送达）", error)
    }
  }
  return lateDelivery ? "late" : "sent"
}

/**
 * 把图片/视频包成「图文转发」里的消息节点
 *
 * 这些 node 段要直接作为总转发第二个节点的 content 交给 NapCat：它会把这些
 * 子节点递归成一条二级转发（图文转发）。外面再套一层 node 就会多出一层空转发。
 * 只有 onebot11 适配器认这个结构，其他平台返回 undefined，由调用方平铺。
 * @param e 消息事件
 * @param images 图片地址
 * @param videoFile 动图作品的原视频路径（可选）
 * @returns node 段数组；平台不支持时为 undefined
 */
function nestedMedia(e: MessageEvent, images: string[], videoFile?: string): Segment[] | undefined {
  if (e.bot.platform !== "onebot11") return undefined
  const self = Number(e.selfId)
  const user = Number.isFinite(self) ? self : e.selfId
  const nodes: RawSegment[] = images.map(url => ({
    type: "raw",
    platform: "onebot11",
    platformType: "node",
    data: {
      user_id: user,
      nickname: "抖音图文",
      content: [{ type: "image", data: { file: url } }]
    }
  }))
  if (videoFile !== undefined) {
    nodes.push({
      type: "raw",
      platform: "onebot11",
      platformType: "node",
      data: {
        user_id: user,
        nickname: "抖音视频",
        content: [{ type: "video", data: { file: videoFile } }]
      }
    })
  }
  return nodes
}

/**
 * 卡片里封面的展示尺寸：横图限宽 320，竖图限高 360，等比缩放不裁切；
 * 尺寸未知时退回 3:2 的 320×213
 * @param width 封面原宽
 * @param height 封面原高
 * @returns 展示宽高（像素）
 */
function coverBox(width?: number, height?: number): { width: number; height: number } {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return { width: 320, height: 213 }
  }
  const scale = Math.min(320 / width, 360 / height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * 渲染卡片；渲染失败退回一张封面 + 纯文字
 * @param app 运行期状态
 * @param info 作品信息
 * @returns 消息段
 */
async function renderCard(app: BilibiliApp, info: DouyinInfo): Promise<Segment> {
  const box = coverBox(info.coverWidth, info.coverHeight)
  try {
    const image = await app.ctx.render(
      CARD,
      {
        cover: info.cover,
        coverWidth: box.width,
        coverHeight: box.height,
        desc: info.desc === "" ? "（没有文案）" : info.desc,
        author: info.author.name,
        avatar: info.author.avatar,
        duration: info.isImages ? "" : formatDuration(info.duration),
        music: info.music,
        digg: formatCount(info.stat.digg),
        comment: formatCount(info.stat.comment),
        collect: formatCount(info.stat.collect),
        share: formatCount(info.stat.share),
        images: info.images.length,
        url: info.shareUrl
      },
      // jpeg 体积约为 png 的四分之一，合并转发要在接口超时内传完
      { selector: "#card", type: "jpeg", quality: 90, viewport: { width: 760, scale: 2 } }
    )
    const first = Array.isArray(image) ? image[0] : image
    if (first !== undefined && first !== null) return first
  } catch (error) {
    app.debug("抖音卡片渲染失败，退回封面 + 文字", error)
  }

  return seg.image(info.cover)
}

/**
 * 取评论并渲染成图；失败只记日志，返回 null 让投递继续
 * @param app 运行期状态
 * @param api 抖音接口
 * @param info 作品信息
 * @param limit 最多几条
 * @returns 评论图，取不到或渲染失败时为 null
 */
async function buildComments(
  app: BilibiliApp,
  api: DouyinApi,
  info: DouyinInfo,
  limit: number
): Promise<Segment | null> {
  try {
    const data = await api.fetchComments(info.awemeId, limit, info.author.secUid, {
      replyLimit: app.config.commentReplyCount ?? 2,
      minLike: app.config.commentMinLike ?? 0,
      showEmote: app.config.commentShowEmote !== false,
      showPictures: app.config.commentShowPictures !== false
    })
    if (data === null || data.items.length === 0) return null

    const image = await app.ctx.render(
      COMMENT_CARD,
      {
        total: data.total,
        list: data.items,
        author: info.author.name,
        showLocation: app.config.commentShowLocation !== false
      },
      { selector: "#comments", type: "jpeg", quality: 90, viewport: { width: 720, scale: 2 } }
    )
    const first = Array.isArray(image) ? image[0] : image
    return first === undefined || first === null ? null : first
  } catch (error) {
    app.log("warn", "抖音评论图生成失败", error)
    return null
  }
}
