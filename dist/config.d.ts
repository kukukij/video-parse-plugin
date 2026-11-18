/**
 * 模块职责：配置 schema —— 一份声明同时产出校验、`config/video-parse.yaml` 与面板表单
 * 依赖方向：依赖 @yunzai-ng/core 的 `s`（schema 工厂）与本地类型
 * 生命周期：模块加载期构造一次，之后不可变
 * 注意事项：**凭据不在这里**。面板的 `GET /api/config/:name` 刻意不脱敏，任何写进
 *          config.yaml 的东西都等于摊在面板上；SESSDATA 一旦泄漏等同于把账号交出去，
 *          故凭据单独加密存于插件数据目录（见 services/credential.ts）。
 *          分组按首次出现排序：平台组在前，`设置` 放最后。
 */
import { type Infer } from "@yunzai-ng/core";
/** 插件配置的 schema；`ctx.config.get()` 的类型由它推导 */
export declare const configSchema: import("@yunzai-ng/core").Schema<{
    biliEnabled: boolean;
    videoMode: "off" | "auto" | "480p" | "720p" | "1080p" | "1080p60" | "4k";
    liveRecord: number;
    douyinEnabled: boolean;
    douyinVideo: "off" | "720p" | "1080p" | "540p";
    douyinImagesAsForward: boolean;
    douyinNoteVideo: boolean;
    douyinLiveRecord: number;
    douyinCookie: string;
    commentSend: boolean;
    commentCount: number;
    commentReplyCount: number;
    commentMinLike: number;
    commentShowLocation: boolean;
    commentShowEmote: boolean;
    commentSort: "hot" | "time";
    commentShowLevel: boolean;
    commentShowPictures: boolean;
    groupWhitelist: string[];
    groupBlacklist: string[];
    parseInPrivate: boolean;
    ignorePrefixes: string[];
    cardAsForward: boolean;
    renderCard: boolean;
    parseCacheTTL: number;
    atSender: boolean;
    debug: boolean;
}>;
/** 配置类型，由 schema 推导 */
export type BilibiliConfig = Infer<typeof configSchema>;
