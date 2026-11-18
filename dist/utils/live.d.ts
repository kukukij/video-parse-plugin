/** 录制参数 */
export interface RecordStreamOptions {
    /** 流地址 */
    url: string;
    /** 录多少秒 */
    seconds: number;
    /** 输出文件路径 */
    output: string;
    /** 体积上限（MB） */
    maxMB: number;
    /** 额外请求头（部分 CDN 校验 Referer） */
    headers?: Record<string, string>;
    /** 日志出口 */
    log: (level: "info" | "warn", message: string) => void;
}
/**
 * 录一小段直播
 * @param options 录制参数
 * @returns 产物字节数；失败或超限为 null
 */
export declare function recordStream(options: RecordStreamOptions): Promise<number | null>;
