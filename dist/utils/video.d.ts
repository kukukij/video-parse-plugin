/**
 * 模块职责：把「画质」与「体积上限」两件事合并成一个可选档位
 * 依赖方向：只依赖 types 里的画质类型
 * 生命周期：纯函数，无状态
 * 注意事项：档位是给使用者看的一个下拉，内部仍然要拆成 `quality` + `maxMB` 两个参数
 *          交给下载逻辑 —— 合并只发生在配置层，取流与体积判断完全不变。
 */
import type { DouyinQuality } from "../types/douyin.js";
import type { VideoQuality } from "../types.js";
/** B 站的下载档位 */
export type VideoMode = "off" | "auto" | "480p" | "720p" | "1080p" | "1080p60" | "4k";
/** B 站档位 → 画质与体积上限（MB） */
export declare const VIDEO_PROFILE: Record<Exclude<VideoMode, "off">, {
    quality: VideoQuality;
    maxMB: number;
}>;
/** 抖音的下载档位（抖音只有三档清晰度，没有 auto） */
export type DouyinVideoMode = "off" | "540p" | "720p" | "1080p";
/** 抖音档位 → 画质与体积上限（MB） */
export declare const DOUYIN_VIDEO_PROFILE: Record<Exclude<DouyinVideoMode, "off">, {
    quality: DouyinQuality;
    maxMB: number;
}>;
/**
 * 档位 → 实际下载参数
 *
 * `off`、未配置、以及任何不认识的值都当作「不下载」，以免配置写错时突然开始下大文件。
 * @param mode 配置里的档位
 * @returns 画质与体积上限；不下载为 null
 */
export declare function resolveVideo(mode: string | undefined): {
    quality: VideoQuality;
    maxMB: number;
} | null;
/**
 * 抖音档位 → 实际下载参数
 * @param mode 配置里的档位
 * @returns 画质与体积上限；不下载为 null
 */
export declare function resolveDouyinVideo(mode: string | undefined): {
    quality: DouyinQuality;
    maxMB: number;
} | null;
/** 档位的展示名，状态命令与面板共用 */
export declare const VIDEO_LABEL: Record<string, string>;
/**
 * 取档位的展示名
 * @param mode 档位
 * @returns 展示名；未知值原样返回
 */
export declare function videoLabel(mode: string | undefined): string;
