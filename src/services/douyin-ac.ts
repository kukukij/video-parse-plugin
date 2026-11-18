/**
 * 抖音网页的 acrawler 挑战
 *
 * `www.douyin.com/note/{id}` 现在对无浏览器指纹的请求返回 72KB 的 JS VM 挑战页
 * （`_$jsvmprt`）：页面里没有作品数据，脚本要先算出 `__ac_signature`，带着
 * `__ac_nonce` 组成的 Cookie 重新请求，服务端才会吐 SSR 页。
 *
 * 这里不引入浏览器，直接在 `node:vm` 里跑那段脚本。沙箱只提供 cookie、location、
 * storage、performance 这些它用得到的对象，不给 fetch、process、require，也不放
 * 登录 Cookie —— 即使脚本被替换，也拿不到凭据、发不出请求。
 */
import { createContext, runInContext } from "node:vm"

/** 脚本执行上限，实测 60–120ms，留足余量 */
const SCRIPT_TIMEOUT = 5_000

/**
 * 从挑战页 HTML 里取出 VM 脚本
 * @param html 挑战页
 * @returns 脚本源码；没找到为空串
 */
export function extractChallengeScript(html: string): string {
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const code = match[1]
    if (code !== undefined && code.includes("_$jsvmprt")) return code
  }
  return ""
}

/**
 * 从响应头的 Set-Cookie 里取 `__ac_nonce`
 * @param headers 响应头
 * @returns nonce；没有为空串
 */
export function nonceOf(headers: Headers): string {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : []
  for (const item of list) {
    const match = /(?:^|[,\s])__ac_nonce=([^;,\s]+)/.exec(item)
    if (match !== null && match[1] !== undefined) return match[1]
  }
  return ""
}

/**
 * 跑挑战脚本，算出 `__ac_signature`
 * @param html 挑战页 HTML
 * @param nonce 响应头下发的 `__ac_nonce`
 * @param userAgent 与请求一致的 UA，脚本会读它
 * @returns 签名串
 */
export function solveAcChallenge(html: string, nonce: string, userAgent: string): string {
  const script = extractChallengeScript(html)
  if (script === "") throw new Error("挑战页里没有 _$jsvmprt 脚本")

  // 定时器给空实现：sign 是同步的，实测脚本不会真的等回调，避免留下悬挂的定时器
  const context = createContext({ setTimeout: () => 0, clearTimeout: () => undefined })
  runInContext(bootstrap(nonce, userAgent), context, { timeout: SCRIPT_TIMEOUT })
  runInContext(script, context, { timeout: SCRIPT_TIMEOUT })

  const acrawler = (context as { byted_acrawler?: Acrawler }).byted_acrawler
  if (acrawler === undefined) throw new Error("挑战脚本没有产出 byted_acrawler")

  acrawler.init({ aid: 99999999, dfp: 0 })
  const signature = acrawler.sign("", nonce)
  if (signature === "") throw new Error("挑战脚本算出空签名")
  return signature
}

interface Acrawler {
  init(options: Record<string, unknown>): void
  sign(key: string, nonce: string): string
}

/**
 * 沙箱里需要的最小浏览器环境
 * @param nonce 响应头下发的 nonce
 * @param userAgent 请求用的 UA
 * @returns 注入脚本
 */
function bootstrap(nonce: string, userAgent: string): string {
  return `
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = {
  referrer: "",
  cookie: "__ac_nonce=" + ${JSON.stringify(nonce)},
  querySelector: function () { return null; },
  createElement: function () { return {}; },
  getElementsByTagName: function () { return []; },
  addEventListener: function () {}
};
globalThis.location = {
  protocol: "https:",
  href: "https://www.douyin.com/",
  hostname: "www.douyin.com",
  reload: function () {}
};
globalThis.navigator = {
  userAgent: ${JSON.stringify(userAgent)},
  platform: "Win32",
  language: "zh-CN",
  languages: ["zh-CN", "zh"],
  webdriver: false
};
globalThis.sessionStorage = {
  _m: {},
  getItem: function (key) { return Object.prototype.hasOwnProperty.call(this._m, key) ? this._m[key] : null; },
  setItem: function (key, value) { this._m[key] = String(value); },
  removeItem: function (key) { delete this._m[key]; }
};
globalThis.localStorage = globalThis.sessionStorage;
globalThis.performance = {
  timing: { navigationStart: Date.now() },
  now: function () { return Date.now(); }
};
`
}
