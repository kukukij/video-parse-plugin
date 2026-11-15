/**
 * 模块职责：聊天侧命令 —— 扫码登录、登出、状态
 * 依赖方向：依赖 app、login
 * 生命周期：随插件注册，卸载时由内核回收
 * 注意事项：只留三条，且都带 `sub` 前缀，前缀之间互不为前缀，不必再靠优先级分派。
 *          解析本身走中间件自动完成（见 message.ts），根目录不提供手动解析命令。
 */
import { seg } from "@yunzai-ng/core"
import type { MessageEvent } from "@yunzai-ng/types"
import type { BilibiliApp } from "../core/app.js"
import type { BilibiliLogin } from "../services/login.js"
import { QrCodeLoginStatus } from "../types.js"

/** 扫码轮询间隔（毫秒） */
const POLL_INTERVAL = 2000

/** 扫码总等待时长（毫秒） */
const POLL_TIMEOUT = 180_000

/**
 * 注册全部命令
 * @param app 运行期状态
 * @param login 登录服务
 *
 * 全部注册都经 `ctx` 完成，内核在卸载时自动回收，故这里不必返回句柄。
 */
export function registerCommands(app: BilibiliApp, login: BilibiliLogin): void {
  const { ctx } = app

  ctx
    .command("#bili登录", {
      desc: "扫码登录 B 站（私聊，仅主人）",
      usage: "#bili登录",
      group: "B站解析",
      master: true,
      scene: "private",
      cooldown: "30s",
      cooldownTip: "扫码还没结束，稍等一下"
    })
    .action(async e => {
      await runLogin(app, login, e)
    })

  ctx
    .command("#bili登出", {
      desc: "退出 B 站登录",
      group: "B站解析",
      master: true
    })
    .action(async e => {
      if (!app.isLoggedIn()) {
        await e.reply("本来就没有登录")
        return
      }
      await login.forget()
      await e.reply("已退出 B 站登录，凭据已删除")
    })

  ctx
    .command("#bili状态", { desc: "查看解析统计与登录状态", group: "B站解析" })
    .action(async e => {
      await e.reply(await statusText(app, e))
    })
}

/**
 * 走一遍扫码流程：发二维码 → 轮询 → 回执
 * @param app 运行期状态
 * @param login 登录服务
 * @param e 消息事件
 */
async function runLogin(app: BilibiliApp, login: BilibiliLogin, e: MessageEvent): Promise<void> {
  const generated = await login.generate()
  if (generated === null) {
    await e.reply("向 B 站申请二维码失败，稍后再试")
    return
  }

  const image = await login.qrImage(generated.url)
  if (image !== null) {
    await e.reply([seg.image(image), "\n用 B 站手机客户端扫码登录，三分钟内有效"])
  } else {
    await e.reply([`用 B 站 App 打开这个链接登录（三分钟内有效）：\n${generated.url}`])
  }

  let scannedNotified = false
  const deadline = Date.now() + POLL_TIMEOUT
  while (Date.now() < deadline && !app.ctx.signal.aborted) {
    await sleep(POLL_INTERVAL, app.ctx.signal)
    if (app.ctx.signal.aborted) return

    const result = await login.poll(generated.qrcode_key)
    if (result.status === QrCodeLoginStatus.SUCCESS) {
      const name = app.userInfo?.uname ?? result.credential?.dedeuserid ?? "未知账号"
      await e.reply(`登录成功：${name}。现在可以拉 1080P60 与 4K 了`)
      return
    }
    if (result.status === QrCodeLoginStatus.SCANNED && !scannedNotified) {
      scannedNotified = true
      await e.reply("已扫码，请在手机上点确认")
      continue
    }
    if (result.status === QrCodeLoginStatus.EXPIRED) {
      await e.reply(`登录未完成：${result.message}`)
      return
    }
  }

  if (!app.ctx.signal.aborted) await e.reply("二维码超时了，需要的话再发一次「#bili登录」")
}

/**
 * 组装状态文案
 * @param app 运行期状态
 * @param e 消息事件
 * @returns 文本
 */
async function statusText(app: BilibiliApp, e: MessageEvent): Promise<string> {
  const config = app.config
  const snapshot = app.snapshot()
  const lines = [
    "【B站解析】",
    `开关：${config.enabled ? "开" : "关"} · 模式：${config.sendMode === "with-video" ? "信息 + 视频" : "仅信息"}`,
    `渲染卡片：${config.renderCard ? "开" : "关"} · 合并转发：${config.cardAsForward ? "开" : "关"}`,
    `登录：${app.isLoggedIn() ? `${snapshot.login.uname ?? "已登录"}（${snapshot.login.mid ?? "?"}）` : "未登录"}`,
    `累计解析：${snapshot.stats.total} 次 · 今日 ${snapshot.stats.today} 次 · 冷却中 ${snapshot.cacheSize} 条`,
    `已运行：${snapshot.uptime}`
  ]
  if (e.isGroup && e.group !== undefined) {
    const gid = e.group.gid
    const state = app.isGroupBlocked(gid)
      ? "已拉黑（不解析）"
      : app.isGroupEnabled(gid)
        ? "正常解析"
        : "不在白名单（不解析）"
    lines.push(`本群：${state}`)
  }
  return lines.join("\n")
}

/**
 * 可被卸载打断的等待
 * @param ms 毫秒
 * @param signal 卸载信号
 * @returns 到点或被打断时兑现
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
