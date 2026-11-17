/**
 * 模块职责：配置 schema —— 一份声明同时产出校验、`config/bilibili.yaml` 与面板表单
 * 依赖方向：依赖 @yunzai-ng/core 的 `s`（schema 工厂）与本地类型
 * 生命周期：模块加载期构造一次，之后不可变
 * 注意事项：**凭据不在这里**。面板的 `GET /api/config/:name` 刻意不脱敏，任何写进
 *          config.yaml 的东西都等于摊在面板上；SESSDATA 一旦泄漏等同于把账号交出去，
 *          故凭据单独加密存于插件数据目录（见 services/credential.ts）。
 */
import { type Infer } from "@yunzai-ng/core";
/** 插件配置的 schema；`ctx.config.get()` 的类型由它推导 */
export declare const configSchema: import("@yunzai-ng/core").Schema<{
    enabled: boolean;
    parseInPrivate: boolean;
    ignorePrefixes: string[];
    sendMode: "info-only" | "with-video";
    renderCard: boolean;
    cardAsForward: boolean;
    atSender: boolean;
    maxVideoSizeMB: number;
    videoQuality: "auto" | "4k" | "1080p60" | "1080p" | "720p" | "480p";
    parseCacheTTL: number;
    commentSend: boolean;
    commentCount: number;
    commentSort: "hot" | "time";
    commentReplyCount: number;
    commentMinLike: number;
    commentShowLevel: boolean;
    commentShowLocation: boolean;
    commentShowEmote: boolean;
    commentShowPictures: boolean;
    groupWhitelist: string[];
    groupBlacklist: string[];
    debug: boolean;
}>;
/** 配置类型，由 schema 推导 */
export type BilibiliConfig = Infer<typeof configSchema>;
