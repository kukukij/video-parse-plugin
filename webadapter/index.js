/**
 * 模块职责：面板「扩展页面」的 node 侧入口 —— 注册一个页面与一条只读接口
 * 依赖方向：只依赖 node 内置模块；**不 import 插件本体**
 * 生命周期：webui 插件的 setup 时被加载一次
 * 注意事项：状态接口读的是插件自己定时写下的 `status.json` 快照。位置按内核的目录约定推导：
 *
 *            <home>/config            ← 面板给的就是这个
 *            <home>/data/plugin/<名>/ ← 插件的 dataDir
 *
 *          插件名取内核给的 `pluginName`（`video-parse`），而目录名是
 *          `video-parse-plugin`，两者不一定相同，故两个都试一遍再报错。
 *
 *          `login/*` 三条不是只读的：扫码要真调哔哩哔哩接口、登出要删凭据文件。它们仍走
 *          `registerApi`，因为 iframe 不透明、拿不到访问令牌，直连插件路由必 401；
 *          面板转发是唯一通道（理由见 init 里那段注释）。
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * 快照文件名，与插件侧 `BilibiliApp#snapshotFile` 必须一致
 */
const SNAPSHOT = "status.json"

/**
 * 运行期句柄的键
 *
 * 与插件 `src/index.ts` 的 `RUNTIME_KEY` 必须一致。webui 是**单独** import 本文件的，
 * 这里拿不到插件 setup 里的闭包，故插件把 `{ app, login }` 挂在 globalThis 上，
 * 由这里按 Symbol 取回 —— 两条注册路径因此仍只有一份实例。
 */
const RUNTIME_KEY = Symbol.for("yunzai-ng.video-parse.runtime")

/**
 * 取插件运行时
 * @returns {{ app: object, login: object } | null} 插件尚未加载完成时为 null
 */
function runtime() {
  const handle = globalThis[RUNTIME_KEY]
  return handle !== undefined && handle !== null && typeof handle.login === "object" ? handle : null
}

/**
 * 列出所有可能的快照路径
 * @param {{ configDir: string, pluginName: string }} ctx 面板给的上下文
 * @returns {string[]} 候选路径，按可信度排序
 */
function candidates(ctx) {
  // 内核给的 pluginName 正常一定有；万一没给，别让 join(undefined) 抛错把整个页面带挂
  const names = ["video-parse", ctx.pluginName].filter(name => typeof name === "string" && name !== "")
  const homes = [join(ctx.configDir, "..")]
  if (process.env.YZNG_HOME) homes.push(process.env.YZNG_HOME)

  const out = []
  for (const home of homes) {
    for (const name of names) out.push(join(home, "data", "plugin", name, SNAPSHOT))
  }
  return out
}

/**
 * 读一份快照
 * @param {{ configDir: string, pluginName: string }} ctx 面板给的上下文
 * @returns {Promise<object>} 快照，或带 `missing` 的说明
 */
async function readSnapshot(ctx) {
  for (const file of candidates(ctx)) {
    try {
      return JSON.parse(await readFile(file, "utf8"))
    } catch {
      // 换下一条候选
    }
  }
  return {
    missing: true,
    hint: "还没读到插件写下的状态快照。插件刚装好时先在群里发一条视频链接（哔哩哔哩或抖音），或重载一次插件。"
  }
}

/**
 * 注册页面
 * @param {object} ctx 面板给的上下文
 */
export function init(ctx) {
  ctx.registerPage({
    title: "视频解析",
    sub: "由插件「video-parse」提供 · 数据只读",
    // 一台显示器 + 播放键：线条图标，颜色由面板按主题给
    icon: "M3 7h18v11H3zM8 21h8M12 18v3M10 10.5l4 2.5-4 2.5z"
  })

  ctx.registerApi("status", () => readSnapshot(ctx))

  /*
   * 面板转发只认固定路径的 GET，且不许带查询串，所以「点一个群直接拉黑」这种带参数的
   * 写操作走不过这道闸。折中：口令经这条**带鉴权**的转发通道下发，页面再拿它去调插件
   * 自己的 `/plugin/video-parse/panel/*`（`auth: false` + CORS）。口令每次加载重新生成、
   * 不落盘，只在内存与页面之间活着。
   */
  ctx.registerApi("panel", () => {
    const rt = runtime()
    if (rt === null) return { ok: false, error: "插件还没加载完成，稍等几秒再试" }
    return { ok: true, key: rt.panelKey ?? "" }
  })

  /*
   * 扫码登录的三条接口
   *
   * 面板只让扩展页注册 GET，写操作原则上该走插件自己的 `ctx.route()`。这里仍然走
   * `registerApi`，因为 iframe 里拿不到访问令牌：插件路由默认 `auth: true`，页面直连
   * 会 401；而 `registerApi` 由面板带着令牌转发，页面只认识 postMessage 这一条通道。
   * 代价是三条都表现为 GET —— 都是「操作一个只存在于本进程的扫码会话」，不写配置、
   * 不落盘敏感状态，登出也只是清掉本插件的凭据文件。
   */

  ctx.registerApi("login/qr", async () => {
    const rt = runtime()
    if (rt === null) return { ok: false, error: "插件还没加载完成，稍等几秒再试" }

    const generated = await rt.login.generate()
    if (generated === null) {
      return { ok: false, error: "哔哩哔哩没给回二维码（接口风控或网络不通），稍后重试" }
    }
    const png = await rt.login.qrImage(generated.url)
    return {
      ok: true,
      url: generated.url,
      // 没装 qrcode 时给空串，页面改为显示链接，手机上点链接一样能登
      image: png === null ? "" : `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
      remaining: rt.login.remaining
    }
  })

  ctx.registerApi("login/poll", async () => {
    const rt = runtime()
    if (rt === null) return { ok: false, error: "插件还没加载完成，稍等几秒再试" }

    const result = await rt.login.poll()
    return {
      ok: true,
      status: result.status,
      message: result.message,
      remaining: rt.login.remaining
    }
  })

  ctx.registerApi("login/logout", async () => {
    const rt = runtime()
    if (rt === null) return { ok: false, error: "插件还没加载完成，稍等几秒再试" }

    await rt.login.forget()
    return { ok: true }
  })
}
