/**
 * 模块职责：抖音相关的数据结构
 * 依赖方向：无（纯类型）
 * 生命周期：编译期
 * 注意事项：与 B 站的类型分开，两边的字段差异太大（抖音没有分区/弹幕，
 *          但有音乐、图文、收藏与转发数）。
 */

/** 画质档位，抖音只认这几档 */
export type DouyinQuality = "1080p" | "720p" | "540p"

/** 作品作者 */
export interface DouyinAuthor {
  /** 用户 sec_uid：SSR 里作者没有数字 uid，只有这个，评论作者标就靠它比对 */
  secUid: string
  /** 昵称 */
  name: string
  /** 头像 */
  avatar: string
}

/** 互动数据 */
export interface DouyinStat {
  /** 点赞 */
  digg: number
  /** 评论 */
  comment: number
  /** 收藏 */
  collect: number
  /** 转发 */
  share: number
}

/** 一条抖音作品 */
export interface DouyinInfo {
  /** 作品 id */
  awemeId: string
  /** 文案（抖音没有标题，只有文案） */
  desc: string
  /** 作者 */
  author: DouyinAuthor
  /** 封面 */
  cover: string
  /** 封面原始宽度（像素），取不到为 0 */
  coverWidth?: number
  /** 封面原始高度（像素），取不到为 0 */
  coverHeight?: number
  /** 时长（秒） */
  duration: number
  /** 发布时间（秒） */
  createTime: number
  /** 背景音乐标题 */
  music: string
  /** 互动数据 */
  stat: DouyinStat
  /** 是否图文作品 */
  isImages: boolean
  /** 图文里的图片 */
  images: string[]
  /** 视频流 id（`play_addr.uri`），用来换无水印地址 */
  playUri: string
  /** 网页地址 */
  shareUrl: string
}

/** 短链展开后的目标：作品页或直播间 */
export type DouyinShareTarget =
  | { kind: "aweme"; id: string }
  | { kind: "live"; roomId: string; url: string }

/** 直播间信息（只用来拼提示、录一小段，不跟着播完整场） */
export interface DouyinLiveInfo {
  /** 直播间 id */
  roomId: string
  /** 主播昵称 */
  nickname: string
  /** 直播标题 */
  title: string
  /** 封面（直播间页的 `cover`） */
  cover: string
  /** 当前在线人数（页面 `userCountStr`），拿不到为 0 */
  online: number
  /** 累计观看人次（页面 `totalUser`） */
  totalViewers: number
  /** 主播粉丝数 */
  followers: number
  /** 本场点赞数 */
  likes: number
  /** 本场新增粉丝 */
  newFollowers: number
  /** 开播时间（秒级时间戳），拿不到为 0 */
  startedAt: number
  /** 下播时间（秒级时间戳），还在播为 0 */
  finishedAt: number
  /** 是否正在直播 */
  living: boolean
  /** 直播流地址（FLV），页面没给时为空串 */
  streamUrl: string
}

/** 评论正文的一段：文字，或一个表情图 */
export interface DouyinTextPart {
  /** 文字 */
  text?: string
  /** 表情图，与 text 二选一 */
  emote?: { url: string }
}

/** 评论带的图片（照片和图表情都可能走 image_list） */
export interface DouyinCommentImage {
  origin_url?: { url_list?: string[] }
  medium_url?: { url_list?: string[] }
  thumb_url?: { url_list?: string[] }
}

/** 评论里的大表情（表情包），和正文里的小表情不是一回事 */
export interface DouyinCommentSticker {
  width?: number
  height?: number
  static_url?: { url_list?: string[] }
  animated_url?: { url_list?: string[] }
}

/** 评论里的一条回复 */
export interface DouyinReplyView {
  /** 昵称 */
  nickname: string
  /** 头像 */
  avatar: string
  /** 正文（文字与表情分段） */
  parts: DouyinTextPart[]
  /** 评论附带的图片 */
  images: string[]
  /** 大表情地址，没有为空串 */
  sticker: string
  /** 点赞 */
  like: number
  /** 相对时间 */
  time: string
  /** IP 属地 */
  location: string
  /**
   * 被回复的人
   *
   * 只有「回复楼中楼里的另一个人」时才有值（渲染成 `名字 ▶ 某人`）；直接回复主评论时为空，
   * 和抖音原版一致 —— 那种情况只显示回复者的名字。
   */
  replyTo: string
  /** 回复者是不是作品作者（作者亲自下场回复时也带「作者」标） */
  isAuthor: boolean
}

/** 渲染评论图用的一条评论 */
export interface DouyinCommentView {
  /** 昵称 */
  nickname: string
  /** 头像 */
  avatar: string
  /** 正文分段（文字 + 表情图） */
  parts: DouyinTextPart[]
  /** 评论附带的图片 */
  images: string[]
  /** 大表情地址，没有为空串 */
  sticker: string
  /** 点赞 */
  like: number
  /** IP 属地 */
  location: string
  /** 相对时间 */
  time: string
  /** 是否作品作者本人（渲染「作者」标） */
  isAuthor: boolean
  /** 楼中楼回复（最多 2 条） */
  replies: DouyinReplyView[]
  /** 这条评论一共有多少条回复：多于已渲染的条数时，图里会写「共 N 条回复」 */
  replyTotal: number
}

/** 评论结果 */
export interface DouyinCommentResult {
  /** 评论总数 */
  total: number
  /** 取到的评论 */
  items: DouyinCommentView[]
}

/** 原始评论结构（只声明用到的字段） */
export interface DouyinCommentItem {
  /** 正文 */
  text?: string
  /** 评论带的图片（照片、部分图表情） */
  image_list?: DouyinCommentImage[] | null
  /** 大表情（表情包） */
  sticker?: DouyinCommentSticker | null
  /** 点赞数 */
  digg_count?: number
  /** IP 属地 */
  ip_label?: string
  /** 发布时间（秒） */
  create_time?: number
  /** 作者 */
  user?: { uid?: string; sec_uid?: string; nickname?: string; avatar_thumb?: { url_list?: string[] } }
  /** 评论 id，拉楼中楼要用 */
  cid?: string
  /** 楼中楼：主列表里最多内嵌一条，多数情况为空 */
  reply_comment?: DouyinCommentItem | DouyinCommentItem[]
  /** 回复总数 */
  reply_comment_total?: number
  /** 回复的对象昵称（回复楼中楼时才有） */
  reply_to_username?: string
  /** 回复的对象 id：非空表示这条是对某条回复的回复 */
  reply_to_reply_id?: string | number
}
