import type { MessageEvent, Segment } from "@yunzai-ng/types";
import type { BilibiliApp } from "../core/app.js";
import type { BilibiliVideoInfo } from "../types.js";
/**
 * 可能已经拿到、也可能还在跑的任务
 *
 * 投递时按「卡片 → 视频 → 评论」的发送顺序逐个等，先好先发；评论图无论多早就绪都留到最后。
 */
export type Pending<T> = T | Promise<T>;
/**
 * 组装模板数据
 * @param info 视频信息
 * @returns 模板变量
 */
export declare function cardData(info: BilibiliVideoInfo): Record<string, unknown>;
/**
 * 渲染卡片图
 * @param app 运行期状态
 * @param info 视频信息
 * @returns 图片段；无渲染器或渲染失败为 null
 */
export declare function renderCard(app: BilibiliApp, info: BilibiliVideoInfo): Promise<Segment | null>;
/**
 * 组装文字版信息
 * @param info 视频信息
 * @returns 文本
 */
export declare function infoText(info: BilibiliVideoInfo): string;
/**
 * 组装"信息部分"的消息段（不含视频）
 *
 * 卡片渲染成功时就是那一张图；失败时是封面 + 文字。**不带链接**：卡片上已经有
 * 标题与 UP 主，再贴一条裸网址只是刷屏（需要链接的话消息里本来就贴着）。
 * @param app 运行期状态
 * @param info 视频信息
 * @returns 消息段
 */
export declare function buildInfoSegments(app: BilibiliApp, info: BilibiliVideoInfo): Promise<Segment[]>;
/**
 * 把信息段拆成"封面"和"文字"两段，供合并转发分节点使用
 *
 * 转发节点里图片与文字挤在一条会很难看：封面太大、文字被压到缩略图后面。
 * @param segments 由 `buildInfoSegments` 产出的段
 * @returns 封面节点内容与文字节点内容
 */
export declare function splitForForward(segments: Segment[]): {
    cover?: Segment[];
    text?: Segment[];
};
/**
 * 发送一条解析结果
 *
 * 两种投递形态，由「合并转发（总开关）」决定：
 * 1. 合并转发：卡片（或回落时的封面 + 文字）、视频、评论图各占一个节点，装在**同一条**
 *    转发里。只有一项内容时不套转发 —— 多点一层才看得到内容，不如直发；
 * 2. 直接发送：卡片（可带 @）、视频、评论图逐条发。一条普通消息只能承载一个富媒体，
 *    图片与视频必须分开，否则 QQ 只留下视频。
 *
 * 平台不支持转发或转发失败时自动回落到直接发送。
 *
 * 都不额外贴链接 —— 卡片或封面已经把信息给全了。
 * @param app 运行期状态
 * @param e 触发解析的消息事件
 * @param info 视频信息
 * @param videoFile 已下载的视频路径，也可以是仍在下载的任务：直发时卡片先走，走到视频那一步才等它
 * @param commentsImage 已渲染好的评论图，也可以是仍在渲染的任务；无论何时就绪都排在最后发
 * @param preRenderedSegments 卡片渲染得早时可直接传进来，省掉一次串行等待
 * @returns 是否至少成功送出一条消息
 */
export declare function deliver(app: BilibiliApp, e: MessageEvent, info: BilibiliVideoInfo, videoFile?: Pending<string | undefined>, commentsImage?: Pending<Segment | null>, preRenderedSegments?: Pending<Segment[]>): Promise<boolean>;
/**
 * 给消息贴一个表情，表示"在处理"
 *
 * 平台不支持 `reaction` 时静默跳过 —— 这只是锦上添花，不该因为一个表情失败而
 * 让整条解析中断。
 * @param e 消息事件
 * @param emojiId 表情 id：10024 为闪光、124 为 OK
 */
export declare function react(e: MessageEvent, emojiId: string): Promise<void>;
