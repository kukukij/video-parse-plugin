/**
 * 模块职责：把「画质」与「体积上限」两件事合并成一个可选档位
 * 依赖方向：只依赖 types 里的画质类型
 * 生命周期：纯函数，无状态
 * 注意事项：档位是给使用者看的一个下拉，内部仍然要拆成 `quality` + `maxMB` 两个参数
 *          交给下载逻辑 —— 合并只发生在配置层，取流与体积判断完全不变。
 */
import type { DouyinQuality } from "../types/douyin.js"
import type { VideoQuality } from "../types.js"

/** B 站的下载档位 */
export type VideoMode = "off" | "auto" | "480p" | "720p" | "1080p" | "1080p60" | "4k"

/** B 站档位 → 画质与体积上限（MB） */
export const VIDEO_PROFILE: Record<Exclude<VideoMode, "off">, { quality: VideoQuality; maxMB: number }> = {
  auto: { quality: "auto", maxMB: 250 },
  "480p": { quality: "480p", maxMB: 50 },
  "720p": { quality: "720p", maxMB: 120 },
  "1080p": { quality: "1080p", maxMB: 250 },
  "1080p60": { quality: "1080p60", maxMB: 400 },
  "4k": { quality: "4k", maxMB: 800 }
}

/** 抖音的下载档位（抖音只有三档清晰度，没有 auto） */
export type DouyinVideoMode = "off" | "540p" | "720p" | "1080p"

/** 抖音档位 → 画质与体积上限（MB） */
export const DOUYIN_VIDEO_PROFILE: Record<Exclude<DouyinVideoMode, "off">, { quality: DouyinQuality; maxMB: number }> = {
  "540p": { quality: "540p", maxMB: 100 },
  "720p": { quality: "720p", maxMB: 200 },
  "1080p": { quality: "1080p", maxMB: 400 }
}

/**
 * 档位 → 实际下载参数
 *
 * `off`、未配置、以及任何不认识的值都当作「不下载」，以免配置写错时突然开始下大文件。
 * @param mode 配置里的档位
 * @returns 画质与体积上限；不下载为 null
 */
export function resolveVideo(mode: string | undefined): { quality: VideoQuality; maxMB: number } | null {
  if (mode === undefined || mode === "off") return null
  return VIDEO_PROFILE[mode as Exclude<VideoMode, "off">] ?? null
}

/**
 * 抖音档位 → 实际下载参数
 * @param mode 配置里的档位
 * @returns 画质与体积上限；不下载为 null
 */
export function resolveDouyinVideo(mode: string | undefined): { quality: DouyinQuality; maxMB: number } | null {
  if (mode === undefined || mode === "off") return null
  return DOUYIN_VIDEO_PROFILE[mode as Exclude<DouyinVideoMode, "off">] ?? null
}

/** 档位的展示名，状态命令与面板共用 */
export const VIDEO_LABEL: Record<string, string> = {
  off: "不下载",
  auto: "自动",
  "480p": "480P",
  "720p": "720P",
  "1080p": "1080P",
  "1080p60": "1080P60",
  "4k": "4K",
  "540p": "540P"
}

/**
 * 取档位的展示名
 * @param mode 档位
 * @returns 展示名；未知值原样返回
 */
export function videoLabel(mode: string | undefined): string {
  if (mode === undefined || mode === "") return "不下载"
  return VIDEO_LABEL[mode] ?? mode
}
