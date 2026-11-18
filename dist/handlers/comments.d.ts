/**
 * 模块职责：把热门评论渲染成一张图，作为解析结果的第三条消息发出去
 * 依赖方向：依赖 app、services/bilibili、types
 * 生命周期：每次解析调用一次，无自有资源
 * 注意事项：评论图是**锦上添花**：取不到、渲染失败、发送失败都只记日志，不能让已经
 *          发出去的卡片与视频跟着判成失败。所以这里所有失败路径都静默返回。
 */
import type { MessageEvent, Segment } from "@yunzai-ng/types";
import type { BilibiliApp } from "../core/app.js";
import type { BilibiliApi } from "../services/bilibili.js";
import type { BilibiliVideoInfo, CommentView } from "../types.js";
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
export declare function sendComments(app: BilibiliApp, api: BilibiliApi, e: MessageEvent, info: BilibiliVideoInfo): Promise<void>;
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
export declare function buildCommentsImage(app: BilibiliApp, api: BilibiliApi, e: MessageEvent, info: BilibiliVideoInfo): Promise<Segment | null>;
/**
 * 渲染评论图
 * @param app 运行期状态
 * @param total 评论总数，用于标题旁的数字
 * @param items 评论列表
 * @returns 图片段；没有渲染器或渲染失败为 null
 */
export declare function renderComments(app: BilibiliApp, total: number, items: CommentView[]): Promise<Segment | null>;
