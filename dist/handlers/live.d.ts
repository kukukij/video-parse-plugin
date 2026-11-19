import type { MessageEvent, Segment } from "@yunzai-ng/types";
import type { BilibiliApp } from "../core/app.js";
import type { BilibiliLiveInfo } from "../types.js";
import type { DouyinLiveInfo } from "../types/douyin.js";
/**
 * 渲染直播卡片
 *
 * 从取信息到出图只依赖直播间数据，故可以比录制先跑：调用方拿到信息后立刻起这个任务，
 * 再去录片段，两秒的渲染时间就藏在录制的十几秒里。
 * @param app 运行期状态
 * @param platform 平台
 * @param info 直播间信息
 * @param shareUrl 抖音原分享链接
 * @returns 图片段；关闭渲染或渲染失败为 null
 */
export declare function buildLiveCard(app: BilibiliApp, platform: "bilibili" | "douyin", info: BilibiliLiveInfo | DouyinLiveInfo, shareUrl?: string): Promise<Segment | null>;
/**
 * 发一条直播结果
 *
 * 和作品卡片同一套投递规则：总开关开着且平台支持转发时，卡片与录制片段装进一条
 * 转发；否则先发卡片、再发视频。没有录制片段时就只发卡片。
 * @param app 运行期状态
 * @param e 消息事件
 * @param info 直播间信息
 * @param platform 平台
 * @param videoFile 录制好的片段，可无
 * @param shareUrl 抖音原分享链接
 * @param cardTask 已经起好的卡片渲染任务，可无；不传则在这里现渲染
 * @returns 是否至少成功送出一条消息
 */
export declare function deliverLive(app: BilibiliApp, e: MessageEvent, info: BilibiliLiveInfo | DouyinLiveInfo, platform: "bilibili" | "douyin", videoFile?: string, shareUrl?: string, cardTask?: Promise<Segment | null>): Promise<boolean>;
