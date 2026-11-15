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
export function formatCount(num: number): string {
  if (!Number.isFinite(num)) return "0"
  if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(1)}亿`
  if (num >= 10_000) return `${(num / 10_000).toFixed(1)}万`
  return String(num)
}

/**
 * 格式化时长
 * @param seconds 秒数
 * @returns 如 `4:31`、`1:02:33`
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0")
  return hours > 0 ? `${hours}:${mm}:${String(secs).padStart(2, "0")}` : `${mm}:${String(secs).padStart(2, "0")}`
}

/**
 * 格式化日期
 * @param timestamp 秒级时间戳
 * @returns `YYYY-MM-DD`；时间戳缺失时返回空串
 */
export function formatDate(timestamp: number): string {
  if (!timestamp) return ""
  const date = new Date(timestamp * 1000)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 把字节数说成人话
 * @param bytes 字节数
 * @returns 如 `86.3MB`
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0MB"
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`
}

/**
 * 把毫秒时长说成人话
 * @param ms 毫秒
 * @returns 如 `3天2小时`
 */
export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天${hours}小时`
  if (hours > 0) return `${hours}小时${minutes}分钟`
  if (minutes > 0) return `${minutes}分钟${seconds % 60}秒`
  return `${seconds}秒`
}
