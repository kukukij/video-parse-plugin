/**
 * 模块职责：给人看的格式化 —— 播放量、时长、日期
 * 依赖方向：无
 * 生命周期：纯函数
 * 注意事项：中文数字习惯（万 / 亿）与「不到一万就原样」是刻意的：群里看播放量要的是
 *          量级，`12345` 不如 `1.2万` 一眼可读，而 `999` 加个「万」只会更糊
 */
/**
 * 格式化计数
 * @param num 原始数值
 * @returns 如 `1.2万`、`3.4亿`、`999`
 */
export declare function formatCount(num: number): string;
/**
 * 格式化时长
 * @param seconds 秒数
 * @returns 如 `4:31`、`1:02:33`
 */
export declare function formatDuration(seconds: number): string;
/**
 * 格式化日期
 * @param timestamp 秒级时间戳
 * @returns `YYYY-MM-DD`；时间戳缺失时返回空串
 */
export declare function formatDate(timestamp: number): string;
/**
 * 把字节数说成人话
 * @param bytes 字节数
 * @returns 如 `86.3MB`
 */
export declare function formatSize(bytes: number): string;
/**
 * 把毫秒时长说成人话
 * @param ms 毫秒
 * @returns 如 `3天2小时`
 */
export declare function formatUptime(ms: number): string;
