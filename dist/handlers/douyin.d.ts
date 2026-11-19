import type { MessageEvent, Segment } from "@yunzai-ng/types";
import type { BilibiliApp } from "../core/app.js";
import type { DouyinInfo } from "../types/douyin.js";
import { type Pending } from "./card.js";
/**
 * 注册抖音的自动解析中间件
 * @param app 运行期状态
 * @returns Disposer
 */
export declare function registerDouyin(app: BilibiliApp): () => void;
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
export declare function deliver(app: BilibiliApp, e: MessageEvent, info: DouyinInfo, videoFile?: Pending<string | undefined>, commentsImage?: Pending<Segment | null>, preRenderedCard?: Pending<Segment>): Promise<"sent" | "late" | false>;
