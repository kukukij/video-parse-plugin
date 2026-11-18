/**
 * 模块职责：直播流录制 —— 用 ffmpeg 从 FLV/HLS 截前 N 秒
 * 依赖方向：node:child_process、node:fs/promises、utils/format
 * 生命周期：一次调用一个进程，结束即回收
 * 注意事项：直播是无限流，必须用 `-t` 限长并加超时强杀；`-c copy` 不转码，
 *          10 秒 1080P 一般 2-5MB，比转码省太多 CPU。
 */
import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { formatSize } from "./format.js"

/** 录制参数 */
export interface RecordStreamOptions {
  /** 流地址 */
  url: string
  /** 录多少秒 */
  seconds: number
  /** 输出文件路径 */
  output: string
  /** 体积上限（MB） */
  maxMB: number
  /** 额外请求头（部分 CDN 校验 Referer） */
  headers?: Record<string, string>
  /** 日志出口 */
  log: (level: "info" | "warn", message: string) => void
}

/**
 * 录一小段直播
 * @param options 录制参数
 * @returns 产物字节数；失败或超限为 null
 */
export async function recordStream(options: RecordStreamOptions): Promise<number | null> {
  const { url, seconds, output, maxMB, headers, log } = options

  const args = ["-hide_banner", "-loglevel", "error", "-y"]
  if (headers !== undefined) {
    const raw = Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")
    args.push("-headers", `${raw}\r\n`)
  }
  args.push("-i", url, "-t", String(seconds), "-c", "copy", "-movflags", "+faststart", output)

  const ok = await new Promise<boolean>(resolve => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", chunk => {
      stderr = (stderr + String(chunk)).slice(-400)
    })
    // 卡在等流上时强杀，避免一条直播把发送队列拖死
    const timer = setTimeout(() => child.kill("SIGKILL"), (seconds + 20) * 1000)

    child.once("error", error => {
      clearTimeout(timer)
      log("warn", `录制启动失败（需要安装 ffmpeg）：${error.message}`)
      resolve(false)
    })
    child.once("close", code => {
      clearTimeout(timer)
      if (code !== 0) log("warn", `录制失败（ffmpeg 退出码 ${code}）${stderr === "" ? "" : `：${stderr.trim()}`}`)
      resolve(code === 0)
    })
  })
  if (!ok) return null

  try {
    const size = (await stat(output)).size
    if (size === 0) {
      log("warn", "录制产物为空，已放弃")
      return null
    }
    if (size / 1024 / 1024 > maxMB) {
      log("warn", `录制片段 ${formatSize(size)} 超过上限 ${maxMB}MB，已放弃`)
      return null
    }
    return size
  } catch (error) {
    log("warn", `录制产物读取失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
