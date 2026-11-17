/**
 * 模块职责：B 站视频解析的全部数据契约（配置、视频信息、登录凭据）
 * 依赖方向：仅依赖 node 内置类型；不 import 内核，故可被任何一层引用
 * 生命周期：纯类型 + 一处运行期枚举
 * 注意事项：`QrCodeLoginStatus` 的取值是 B 站自己定的，**不能改**，它不是我们的枚举
 */

/**
 * 期望画质
 *
 * `auto` 表示「已登录取最高、未登录取 1080P」；其余为硬性上限，取不到时向下回退。
 */
export type VideoQuality = "auto" | "4k" | "1080p60" | "1080p" | "720p" | "480p"

/** 群黑名单：键是群号 */
export interface GroupBilibiliConfig {
  /** 本群是否解析；缺省视为启用 */
  enabled?: boolean
}

/**
 * B 站视频信息
 *
 * 只保留展示与下载真正用到的字段：B 站 `view` 接口返回两百多个键，原样保存只会
 * 让缓存与快照文件白白膨胀。
 */
export interface BilibiliVideoInfo {
  /** BV 号 */
  bvid: string
  /** AV 号 */
  aid: number
  /** 默认分 P 的 cid */
  cid: number
  /** 标题 */
  title: string
  /** 封面地址 */
  pic: string
  /** 简介 */
  desc: string
  /** 时长（秒） */
  duration: number
  /** 分 P 列表 */
  pages?: Array<{
    /** 该 P 的 cid */
    cid: number
    /** 第几 P，从 1 开始 */
    page: number
    /** 该 P 的标题 */
    part: string
    /** 该 P 的时长（秒） */
    duration: number
  }>
  /** UP 主 */
  owner: {
    /** UP 主 mid */
    mid: number
    /** UP 主昵称 */
    name: string
    /** UP 主头像 */
    face: string
  }
  /** 统计数据 */
  stat: {
    /** 播放量 */
    view: number
    /** 弹幕数 */
    danmaku: number
    /** 评论数 */
    reply: number
    /** 收藏数 */
    favorite: number
    /** 投币数 */
    coin: number
    /** 分享数 */
    share: number
    /** 点赞数 */
    like: number
  }
  /** 发布时间（秒级时间戳） */
  pubdate: number
  /** 分区名 */
  tname: string
}

/** B 站接口的统一响应外壳 */
export interface BilibiliApiResponse<T = unknown> {
  /** 0 表示成功，其余为 B 站的错误码 */
  code: number
  /** 错误信息 */
  message: string
  /** 缓存时长（秒） */
  ttl?: number
  /** 业务数据 */
  data: T
}

/**
 * B 站登录凭据
 *
 * 三个 Cookie 缺一不可：`sessdata` 是身份，`bili_jct` 是 CSRF 令牌（刷新 Cookie
 * 时 `csrf` 参数取它），`dedeuserid` 决定「以谁的身份」。
 */
export interface BilibiliCredential {
  /** SESSDATA Cookie */
  sessdata: string
  /** bili_jct Cookie（CSRF 令牌） */
  bili_jct: string
  /** DedeUserID Cookie */
  dedeuserid: string
  /** 刷新令牌，用于免扫码续期 */
  refresh_token?: string
  /** 登录时刻（毫秒时间戳） */
  login_time?: number
}

/** 二维码登录状态（取值来自 B 站，勿改） */
export enum QrCodeLoginStatus {
  /** 等待扫码 */
  WAITING = 86101,
  /** 已扫码，等待手机确认 */
  SCANNED = 86090,
  /** 二维码过期 */
  EXPIRED = 86038,
  /** 登录成功 */
  SUCCESS = 0
}

/** 一次二维码轮询的结果 */
export interface QrCodePollResult {
  /** 当前状态 */
  status: QrCodeLoginStatus
  /** 给人看的状态说明 */
  message: string
  /** 登录成功时携带的凭据 */
  credential?: BilibiliCredential
}

/** 生成二维码的结果 */
export interface QrCodeGenerateResult {
  /** 二维码内容（一个短链，手机扫它） */
  url: string
  /** 轮询用的密钥 */
  qrcode_key: string
}

/** 登录后的用户信息（只取展示所需的字段） */
export interface BilibiliUserInfo {
  /** 用户 mid */
  mid: number
  /** 昵称 */
  uname: string
  /** 头像 */
  face: string
  /** 是否真的处于登录态 */
  isLogin: boolean
  /** 等级 */
  level_info?: {
    /** 当前等级 */
    current_level: number
  }
  /** 会员状态 */
  vip?: {
    /** 会员类型，0 为无 */
    type: number
    /** 会员状态，1 为有效 */
    status: number
  }
  /** 硬币数 */
  money?: number
}

/* ─────────────────────────────── 评论 ─────────────────────────────── */

/** 评论正文里的一段：文字，或一个表情图 */
export interface CommentPart {
  /** 文字内容 */
  text?: string
  /** 表情图；与 text 二者必有其一 */
  emote?: {
    /** 图片地址 */
    url: string
  }
}

/** 评论里的配图 */
export interface CommentPicture {
  /** 地址 */
  url: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
}

/** 一条楼中楼回复 */
export interface CommentReplyView {
  /** 用户名 */
  uname: string
  /** 头像 */
  avatar: string
  /** 正文（文字与表情分段） */
  parts: CommentPart[]
  /** 点赞数 */
  like: number
  /** 展示用的时间文案 */
  time: string
  /** 等级 0-6，用来画 LV 徽章 */
  level: number
  /** IP 属地（省/地区名，已去掉「IP属地：」前缀）；关闭公开时为空 */
  location: string
  /** 是否是 UP 主本人（UP 回复别人时也要带标记） */
  isUp: boolean
  /** 是否大会员：决定昵称颜色与头像右下角的小「大」标 */
  isVip: boolean
}

/** 渲染评论图片用的一条主评论 */
export interface CommentView {
  /** 用户名 */
  uname: string
  /** 头像 */
  avatar: string
  /** 正文（文字与表情分段） */
  parts: CommentPart[]
  /** 配图 */
  pictures: CommentPicture[]
  /** 点赞数 */
  like: number
  /** 展示用的时间文案 */
  time: string
  /** 是否是 UP 主本人 */
  isUp: boolean
  /** 等级 0-6，用来画 LV 徽章 */
  level: number
  /** IP 属地（省/地区名，已去掉「IP属地：」前缀）；关闭公开时为空 */
  location: string
  /** 是否大会员：决定昵称颜色与头像右下角的小「大」标 */
  isVip: boolean
  /** 楼中楼，已按上限截好 */
  replies: CommentReplyView[]
}
