/**
 * 模块职责：把热门评论渲染成一张图，作为解析结果的第三条消息发出去
 * 依赖方向：依赖 app、services/bilibili、types
 * 生命周期：每次解析调用一次，无自有资源
 * 注意事项：评论图是**锦上添花**：取不到、渲染失败、发送失败都只记日志，不能让已经
 *          发出去的卡片与视频跟着判成失败。所以这里所有失败路径都静默返回。
 */
import type { MessageEvent, Segment } from "@yunzai-ng/types"
import type { BilibiliApp } from "../core/app.js"
import type { BilibiliApi } from "../services/bilibili.js"
import type { BilibiliVideoInfo, CommentView } from "../types.js"

/** 模板名（相对插件 `templates/`） */
const TEMPLATE = "comment-card"

/** 一条评论最多显示几张配图：多出来的不显示，避免一张图被撑得过长 */
const PICTURE_LIMIT = 3

/**
 * 取评论、渲染成图并**发送**
 *
 * 单独发送的路径（转发关闭时的兜底）。转发开启时由 `runParse` 走 `buildCommentsImage`
 * 把图塞进转发节点，不再走这里。
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 触发解析的消息事件
 * @param info 视频信息
 */
export async function sendComments(
  app: BilibiliApp,
  api: BilibiliApi,
  e: MessageEvent,
  info: BilibiliVideoInfo
): Promise<void> {
  const image = await buildCommentsImage(app, api, e, info)
  if (image === null) return

  try {
    await e.reply(image)
  } catch (error) {
    // 卡片和视频已经送到了，评论图发不出去不该让整条解析算失败
    app.log("warn", "评论图发送失败", error)
  }
}

/**
 * 取评论并渲染成图，**不发送**
 *
 * 转发开启时这张图作为转发里的一个节点（聊天记录），关闭时走 `sendComments` 单独发。
 * 所有失败路径都返回 null，静默跳过。
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 触发解析的消息事件
 * @param info 视频信息
 * @returns 评论图段；关闭、取不到或渲染失败为 null
 */
export async function buildCommentsImage(
  app: BilibiliApp,
  api: BilibiliApi,
  e: MessageEvent,
  info: BilibiliVideoInfo
): Promise<Segment | null> {
  const config = app.config
  if (config.commentSend === false) return null

  const limit = config.commentCount ?? 0
  if (limit <= 0) return null

  const minLike = config.commentMinLike ?? 0
  // 要按点赞过滤时多取一些：过滤完可能不够 limit 条，再补请求不如一次多要
  const requestLimit = minLike > 0 ? Math.min(20, limit * 3) : limit

  const data = await api.fetchComments(info.aid, requestLimit, info.owner?.mid, {
    sort: config.commentSort ?? "hot",
    replyLimit: config.commentReplyCount ?? 2,
    emote: config.commentShowEmote !== false
  })
  if (data === null) return null
  if (data.items.length === 0) {
    app.debug("这条视频还没有评论，跳过评论图")
    return null
  }

  const items = data.items.filter(item => item.like >= minLike).slice(0, limit)
  if (items.length === 0) {
    app.debug(`评论点赞数都低于 ${minLike}，跳过评论图`)
    return null
  }

  return renderComments(app, data.total, items)
}

/**
 * 渲染评论图
 * @param app 运行期状态
 * @param total 评论总数，用于标题旁的数字
 * @param items 评论列表
 * @returns 图片段；没有渲染器或渲染失败为 null
 */
export async function renderComments(
  app: BilibiliApp,
  total: number,
  items: CommentView[]
): Promise<Segment | null> {
  try {
    const config = app.config
    // 关掉的项直接从数据里抹掉，模板不用堆一堆条件判断
    const list = items.map(item => ({
      ...item,
      pictures: config.commentShowPictures === false ? [] : item.pictures.slice(0, PICTURE_LIMIT),
      location: config.commentShowLocation === false ? "" : item.location,
      level: config.commentShowLevel === false ? -1 : item.level
    }))

    const image = await app.ctx.render(
      TEMPLATE,
      { total, list },
      {
        // 模板的 `#comments` 就是这块评论区本身
        selector: "#comments",
        // 评论图动辄几百 KB，jpeg 能压到四分之一，上传更快
        type: "jpeg",
        quality: 90,
        viewport: { width: 760, scale: 2 }
      }
    )
    return Array.isArray(image) ? (image[0] ?? null) : image
  } catch (error) {
    app.debug("评论图渲染失败，已跳过", error)
    return null
  }
}
