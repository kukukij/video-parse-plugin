import type { MessageEvent } from "@yunzai-ng/types";
import type { BilibiliApp } from "../core/app.js";
import type { BilibiliLiveInfo } from "../types.js";
import type { DouyinLiveInfo } from "../types/douyin.js";
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
 * @returns 是否至少成功送出一条消息
 */
export declare function deliverLive(app: BilibiliApp, e: MessageEvent, info: BilibiliLiveInfo | DouyinLiveInfo, platform: "bilibili" | "douyin", videoFile?: string, shareUrl?: string): Promise<boolean>;
