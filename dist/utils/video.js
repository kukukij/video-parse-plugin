/** B 站档位 → 画质与体积上限（MB） */
export const VIDEO_PROFILE = {
    auto: { quality: "auto", maxMB: 200 },
    "480p": { quality: "480p", maxMB: 40 },
    "720p": { quality: "720p", maxMB: 80 },
    "1080p": { quality: "1080p", maxMB: 150 },
    "1080p60": { quality: "1080p60", maxMB: 300 },
    "4k": { quality: "4k", maxMB: 500 }
};
/** 抖音档位 → 画质与体积上限（MB） */
export const DOUYIN_VIDEO_PROFILE = {
    "540p": { quality: "540p", maxMB: 60 },
    "720p": { quality: "720p", maxMB: 120 },
    "1080p": { quality: "1080p", maxMB: 250 }
};
/**
 * 档位 → 实际下载参数
 *
 * `off`、未配置、以及任何不认识的值都当作「不下载」，以免配置写错时突然开始下大文件。
 * @param mode 配置里的档位
 * @returns 画质与体积上限；不下载为 null
 */
export function resolveVideo(mode) {
    if (mode === undefined || mode === "off")
        return null;
    return VIDEO_PROFILE[mode] ?? null;
}
/**
 * 抖音档位 → 实际下载参数
 * @param mode 配置里的档位
 * @returns 画质与体积上限；不下载为 null
 */
export function resolveDouyinVideo(mode) {
    if (mode === undefined || mode === "off")
        return null;
    return DOUYIN_VIDEO_PROFILE[mode] ?? null;
}
/** 档位的展示名，状态命令与面板共用 */
export const VIDEO_LABEL = {
    off: "不下载",
    auto: "自动",
    "480p": "480P",
    "720p": "720P",
    "1080p": "1080P",
    "1080p60": "1080P60",
    "4k": "4K",
    "540p": "540P"
};
/**
 * 取档位的展示名
 * @param mode 档位
 * @returns 展示名；未知值原样返回
 */
export function videoLabel(mode) {
    if (mode === undefined || mode === "")
        return "不下载";
    return VIDEO_LABEL[mode] ?? mode;
}
