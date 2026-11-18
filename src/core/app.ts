/**
 * 模块职责：插件的运行期状态 —— 配置视图、凭据、统计、解析冷却、面板快照
 * 依赖方向：依赖类型包、config、services/credential
 * 生命周期：随插件 setup 创建，卸载时 dispose
 * 注意事项：这里是**唯一**持有 `ctx` 的地方，其余模块只接收它，便于单测与阅读。
 *
 *          三件容易做错的事都在这里收口：
 *          1) 配置只经 `ctx.config.get()` 读、只经 `patch()` 写 —— 绝不缓存副本，
 *             否则面板一改配置，插件里那份就成了旧的；
 *          2) 跨重启要留的东西（统计、群名）进 `ctx.kv`，可变的东西（冷却、二维码会话）
 *             留内存 —— 后者重启后本就该失效；
 *          3) 面板页面在 iframe 里拿不到令牌，故状态要另写一份 JSON 快照给它，
 *             而不是让它去调需要鉴权的接口（见 webadapter/index.js）。
 */
import { writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import type { PluginContext } from "@yunzai-ng/types"
import type { BilibiliConfig } from "../config.js"
import type { BilibiliCredential } from "../types.js"
import { loadCredential } from "../services/credential.js"
import { formatUptime } from "../utils/format.js"

/** 统计信息的持久化形状 */
interface Stats {
  /** 累计解析成功次数 */
  total: number
  /** 今日解析成功次数 */
  today: number
  /** `today` 对应的日期（`toDateString` 形式），跨天时用来归零 */
  day: string
}

/** 群信息缓存：只记名字，够面板显示即可 */
interface GroupNote {
  /** 群名 */
  name?: string
  /** 最近一次在本群解析成功的时刻（毫秒） */
  lastAt?: number
}

/** 面板快照里的一条最近解析 */
export interface RecentParse {
  /** 视频标题 */
  title: string
  /** BV 号 */
  bvid: string
  /** 群号 */
  gid: string
  /** 群名 */
  group?: string
  /** 时刻（毫秒） */
  at: number
}

/** 面板读取的状态快照 */
export interface StatusSnapshot {
  /** 插件名 */
  name: string
  /** 插件版本 */
  version: string
  /** 生成时刻（毫秒） */
  updatedAt: number
  /** 已运行毫秒数 */
  uptimeMs: number
  /** 已运行的易读形式 */
  uptime: string
  /** 登录状态 */
  login: {
    /** 是否持有凭据 */
    loggedIn: boolean
    /** 昵称 */
    uname?: string
    /** mid */
    mid?: number
    /** 头像 */
    face?: string
    /** 登录时刻 */
    loginTime?: number
  }
  /** 统计 */
  stats: {
    /** 累计 */
    total: number
    /** 今日 */
    today: number
  }
  /** 群开关现状 */
  groups: Array<{
    gid: string
    name?: string
    /** 综合结论：这个群到底解不解析 */
    enabled: boolean
    /** 是否在黑名单里 */
    blocked: boolean
    /** 是否在白名单里 */
    whitelisted: boolean
    lastAt?: number
  }>
  /** 白名单是否生效（非空即生效：只解析名单内的群） */
  whitelistActive: boolean
  /** 关键配置的只读投影 */
  config: {
    enabled: boolean
    /** 视频下载档位：画质与体积上限已合并成一项 */
    videoMode: string
    renderCard: boolean
    cardAsForward: boolean
    parseCacheTTL: number
    parseInPrivate: boolean
    /** 直播录制时长（秒），0 表示只发直播卡片 */
    liveRecord: number
  }
  /** 抖音侧配置现状：面板按平台分区展示，B 站那几项不再和它混在一起 */
  douyin: {
    /** 是否解析抖音链接 */
    enabled: boolean
    /** 视频下载档位（画质与体积上限合并） */
    videoMode: string
    /** 图文图片是否进总转发（嵌套） */
    imagesAsForward: boolean
    /** 图文动图是否取原视频发送 */
    noteVideo: boolean
    /** 评论图是否开启 */
    commentEnabled: boolean
    /** 评论图条数，0 表示不发 */
    commentCount: number
    /** 直播录制时长（秒），0 表示只发直播卡片 */
    liveRecord: number
    /** 是否填了登录 Cookie */
    cookieSet: boolean
  }
  /** 最近解析成功记录，新的在前 */
  recent: RecentParse[]
  /** 当前冷却中的条目数 */
  cacheSize: number
}

/** 最近记录保留条数 */
const RECENT_LIMIT = 12

/** 快照落盘的最小间隔（毫秒）：一次刷屏解析不必写十次盘 */
const SNAPSHOT_THROTTLE = 2000

/**
 * 插件运行期状态
 */
export class BilibiliApp {
  /** 插件上下文 */
  readonly ctx: PluginContext<BilibiliConfig>
  /** 启动时刻 */
  readonly startedAt = Date.now()
  /** 当前凭据；未登录时 undefined */
  credential: BilibiliCredential | undefined
  /** 上一次登录校验拿到的用户信息，供快照与状态命令复用 */
  userInfo: { uname: string; mid: number; face: string } | undefined
  /** 统计 */
  stats: Stats = { total: 0, today: 0, day: new Date().toDateString() }
  /** 群名与最近解析时刻 */
  groups = new Map<string, GroupNote>()
  /** 最近解析成功记录 */
  recent: RecentParse[] = []
  /** 解析冷却：`gid:bvid` → 过期时刻 */
  private readonly cooldown = new Map<string, number>()
  /** 快照节流用的定时器 */
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined
  /** 自己开的延时任务（如延迟删临时视频），卸载时要一并清掉 */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** 快照最后一次落盘的时刻 */
  private lastSnapshotAt = 0
  /** 是否正在停机 */
  private disposed = false

  /**
   * @param ctx 插件上下文
   */
  constructor(ctx: PluginContext<BilibiliConfig>) {
    this.ctx = ctx
  }

  /** 当前配置的只读视图 */
  get config(): Readonly<BilibiliConfig> {
    return this.ctx.config.get() as Readonly<BilibiliConfig>
  }

  /** 已运行毫秒数 */
  get uptime(): number {
    return Date.now() - this.startedAt
  }

  /**
   * 从 KV 与磁盘恢复状态
   *
   * 只读不写：setup 里不做任何网络与磁盘重活，30 秒超时是硬约束。
   * @returns 恢复完成
   */
  async restore(): Promise<void> {
    this.credential = await loadCredential(this.ctx)
    const [stats, groups] = await Promise.all([
      this.ctx.kv.get<Stats>("stats"),
      this.ctx.kv.get<Record<string, GroupNote>>("groups")
    ])
    if (stats !== undefined) {
      this.stats = { total: stats.total ?? 0, today: stats.today ?? 0, day: stats.day ?? this.stats.day }
      this.rollDay()
    }
    if (groups !== undefined) {
      for (const [gid, note] of Object.entries(groups)) this.groups.set(gid, note)
    }
  }

  /**
   * 写日志
   * @param level 级别
   * @param msg 文案
   * @param extra 附加对象，会随日志一起输出
   */
  log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
    const logger = this.ctx.logger
    if (extra === undefined) logger[level](msg)
    else logger[level](`${msg} ${stringify(extra)}`)
  }

  /**
   * 写调试日志，仅在 `debug` 打开时输出
   * @param msg 文案
   * @param extra 附加对象
   */
  debug(msg: string, extra?: unknown): void {
    if (!this.config.debug) return
    this.log("info", `[debug] ${msg}`, extra)
  }

  /** 跨天时把今日计数归零 */
  private rollDay(): void {
    const today = new Date().toDateString()
    if (this.stats.day !== today) {
      this.stats.day = today
      this.stats.today = 0
    }
  }

  /**
   * 记一次成功的解析
   * @param info 视频与群信息
   */
  async markParsed(info: { bvid: string; title: string; gid: string; group?: string }): Promise<void> {
    this.rollDay()
    this.stats.total += 1
    this.stats.today += 1

    this.recent.unshift({ bvid: info.bvid, title: info.title, gid: info.gid, group: info.group, at: Date.now() })
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT

    // 私聊的 gid 形如 `private:<uid>`，不是群号：记进群列表只会让面板多出几条假群
    if (!info.gid.startsWith("private:")) {
      const note = this.groups.get(info.gid) ?? {}
      note.lastAt = Date.now()
      if (info.group !== undefined) note.name = info.group
      this.groups.set(info.gid, note)
      void this.persistGroups()
    }

    void this.ctx.kv.set("stats", this.stats).catch(() => undefined)
    this.scheduleSnapshot()
  }

  /** 把群名缓存写回 KV */
  private async persistGroups(): Promise<void> {
    const plain: Record<string, GroupNote> = {}
    for (const [gid, note] of this.groups) plain[gid] = note
    await this.ctx.kv.set("groups", plain).catch(() => undefined)
  }

  /**
   * 某个群是否启用解析
   *
   * 黑名单优先于白名单：两边都填的群按黑名单算。白名单为空表示不限群。
   * @param gid 群号
   * @returns 是否启用
   */
  isGroupEnabled(gid: string): boolean {
    if (!this.config.enabled) return false
    if (this.isGroupBlocked(gid)) return false
    const whitelist = this.config.groupWhitelist ?? []
    return whitelist.length === 0 || whitelist.includes(gid)
  }

  /**
   * 某个群是否在黑名单里
   * @param gid 群号
   * @returns 在黑名单里为 true
   */
  isGroupBlocked(gid: string): boolean {
    return (this.config.groupBlacklist ?? []).includes(gid)
  }

  /**
   * 某个群是否在白名单里
   * @param gid 群号
   * @returns 在白名单里为 true
   */
  isGroupWhitelisted(gid: string): boolean {
    return (this.config.groupWhitelist ?? []).includes(gid)
  }

  /**
   * 把群加入 / 移出黑名单并落盘
   * @param gid 群号
   * @param blocked 是否拉黑
   * @returns 落盘后的状态
   */
  async setGroupBlocked(gid: string, blocked: boolean): Promise<boolean> {
    const current = this.config.groupBlacklist ?? []
    if (current.includes(gid) === blocked) return blocked
    const next = blocked ? [...current, gid] : current.filter(item => item !== gid)
    await this.ctx.config.patch({ groupBlacklist: next })
    this.log("info", `群 ${gid} 已${blocked ? "加入黑名单，不再自动解析" : "移出黑名单"}`)
    this.scheduleSnapshot()
    return blocked
  }

  /**
   * 把群加入 / 移出白名单并落盘
   * @param gid 群号
   * @param listed 是否加入
   * @returns 落盘后的状态
   */
  async setGroupWhitelisted(gid: string, listed: boolean): Promise<boolean> {
    const current = this.config.groupWhitelist ?? []
    if (current.includes(gid) === listed) return listed
    const next = listed ? [...current, gid] : current.filter(item => item !== gid)
    await this.ctx.config.patch({ groupWhitelist: next })
    this.log("info", `群 ${gid} 已${listed ? "加入白名单" : "移出白名单"}`)
    this.scheduleSnapshot()
    return listed
  }

  /**
   * 该视频在这个群里是否处于冷却中
   * @param gid 群号
   * @param bvid BV 号
   * @returns 冷却中为 true
   */
  inCooldown(gid: string, bvid: string): boolean {
    const key = `${gid}:${bvid}`
    const until = this.cooldown.get(key)
    if (until === undefined) return false
    if (Date.now() > until) {
      this.cooldown.delete(key)
      return false
    }
    return true
  }

  /**
   * 记一次冷却
   * @param gid 群号
   * @param bvid BV 号
   */
  touchCooldown(gid: string, bvid: string): void {
    const ttl = Math.max(0, this.config.parseCacheTTL ?? 0)
    if (ttl === 0) return
    this.cooldown.set(`${gid}:${bvid}`, Date.now() + ttl * 1000)
    // 顺手清理早已过期的条目：条目数与群数同阶，每次全扫也不贵
    if (this.cooldown.size > 200) {
      const now = Date.now()
      for (const [key, until] of this.cooldown) if (now > until) this.cooldown.delete(key)
    }
  }

  /** 冷却表条目数 */
  get cacheSize(): number {
    return this.cooldown.size
  }

  /**
   * 当前状态快照
   * @returns 可直接 JSON 化的对象
   */
  snapshot(): StatusSnapshot {
    const cfg = this.config
    const whitelist = cfg.groupWhitelist ?? []
    const groupIds = new Set<string>([...this.groups.keys(), ...(cfg.groupBlacklist ?? []), ...whitelist])
    return {
      name: this.ctx.name,
      version: this.ctx.version,
      updatedAt: Date.now(),
      uptimeMs: this.uptime,
      uptime: formatUptime(this.uptime),
      login: {
        loggedIn: this.isLoggedIn(),
        uname: this.userInfo?.uname,
        mid: this.userInfo?.mid,
        face: this.userInfo?.face,
        loginTime: this.credential?.login_time
      },
      stats: { total: this.stats.total, today: this.stats.today },
      groups: [...groupIds]
        .map(gid => ({
          gid,
          name: this.groups.get(gid)?.name,
          enabled: this.isGroupEnabled(gid),
          blocked: this.isGroupBlocked(gid),
          whitelisted: whitelist.includes(gid),
          lastAt: this.groups.get(gid)?.lastAt
        }))
        .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
      // 白名单非空 = 只解析名单内的群，面板要据此说明当前的模式
      whitelistActive: whitelist.length > 0,
      config: {
        enabled: cfg.enabled,
        videoMode: cfg.videoMode,
        renderCard: cfg.renderCard,
        cardAsForward: cfg.cardAsForward,
        parseCacheTTL: cfg.parseCacheTTL,
        parseInPrivate: cfg.parseInPrivate,
        liveRecord: cfg.liveRecord ?? 0
      },
      douyin: {
        enabled: cfg.douyinEnabled === true,
        videoMode: cfg.douyinVideo ?? "off",
        imagesAsForward: cfg.douyinImagesAsForward !== false,
        noteVideo: cfg.douyinNoteVideo === true,
        commentEnabled: cfg.commentSend !== false,
        commentCount: cfg.commentCount ?? 0,
        liveRecord: cfg.douyinLiveRecord ?? 0,
        cookieSet: String(cfg.douyinCookie ?? "").trim() !== ""
      },
      recent: this.recent,
      cacheSize: this.cooldown.size
    }
  }

  /** 是否持有可用的凭据（不校验是否已过期） */
  isLoggedIn(): boolean {
    const c = this.credential
    return c !== undefined && c.sessdata !== "" && c.bili_jct !== "" && c.dedeuserid !== ""
  }

  /**
   * 安排一次快照落盘
   *
   * 节流而非防抖：连续解析十条视频时，防抖会一直不写盘，面板上就一直是空的。
   */
  scheduleSnapshot(): void {
    if (this.disposed) return
    if (this.snapshotTimer !== undefined) return
    const wait = Math.max(0, SNAPSHOT_THROTTLE - (Date.now() - this.lastSnapshotAt))
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined
      void this.writeSnapshot()
    }, wait)
    this.snapshotTimer.unref?.()
  }

  /** 快照文件路径 */
  get snapshotFile(): string {
    return join(this.ctx.dataDir, "status.json")
  }

  /** 立即落盘一次（写临时文件再改名，避免面板读到半截 JSON） */
  async writeSnapshot(): Promise<void> {
    if (this.disposed) return
    this.lastSnapshotAt = Date.now()
    const file = this.snapshotFile
    const tmp = `${file}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(this.snapshot(), null, 2), "utf8")
      await rename(tmp, file)
    } catch (error) {
      this.log("warn", "写入状态快照失败", error)
    }
  }

  /**
   * 安排一个延时任务
   *
   * 不用裸 `setTimeout`：它不在 `ctx` 的登记表里，插件卸载后仍会醒来，去动一个
   * 已经不存在的上下文。登记在这里，`dispose()` 时统一清掉。
   * @param fn 任务
   * @param ms 延时毫秒
   */
  later(fn: () => void, ms: number): void {
    if (this.disposed) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }

  /**
   * 释放资源
   *
   * 定时器必须自己收：它不在 `ctx` 的登记表里，`ctx.onDispose` 只认这里主动登记的东西。
   */
  dispose(): void {
    this.disposed = true
    if (this.snapshotTimer !== undefined) {
      clearTimeout(this.snapshotTimer)
      this.snapshotTimer = undefined
    }
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.cooldown.clear()
  }
}

/**
 * 把任意附加对象压成一行，日志里不铺开多行
 * @param value 任意值
 * @returns 可读字符串
 */
function stringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
