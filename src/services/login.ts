/**
 * 模块职责：B 站扫码登录 —— 生成二维码、轮询结果、校验登录态、退出
 * 依赖方向：依赖 app、credential、types
 * 生命周期：二维码会话留在内存，登出即弃；凭据落盘
 * 注意事项：二维码会话**只留一份**。旧实现允许多个会话并存，结果群里两个人同时扫码时
 *          凭据互相覆盖，谁也不知道最后登进去的是谁。这里后扫的顶掉前一个，明确。
 */
import type { BilibiliApp } from "../core/app.js"
import type { BilibiliApiResponse, BilibiliCredential, BilibiliUserInfo, QrCodeGenerateResult, QrCodePollResult } from "../types.js"
import { QrCodeLoginStatus } from "../types.js"
import { clearCredential, saveCredential } from "./credential.js"

/** 生成二维码 */
const GENERATE_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
/** 轮询扫码结果 */
const POLL_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
/** 当前登录用户信息（同时用来校验 Cookie 是否还有效） */
const NAV_API = "https://api.bilibili.com/x/web-interface/nav"
/** 设备指纹：buvid3 / buvid4，扫码的三个请求要像同一个浏览器发出的 */
const SPI_API = "https://api.bilibili.com/x/frontend/finger/spi"

/** 二维码有效期（毫秒）：B 站自己是 180 秒，留同样的窗口 */
const QR_TTL = 180_000

/** 请求头 */
const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/"
}

/** 二维码会话 */
interface QrSession {
  /** 轮询密钥 */
  key: string
  /** 二维码内容 */
  url: string
  /** 生成时刻 */
  at: number
}

/** 轮询接口 `data` 的形状 */
interface QrPollPayload {
  /** 登录成功后带着凭据的回跳地址；部分账号/环境为空 */
  url: string
  /** 续期令牌 */
  refresh_token: string
  /** 服务端时间戳 */
  timestamp: number
  /** 扫码状态 */
  code: number
  /** 状态说明 */
  message: string
}

/** 扫码登录 */
export class BilibiliLogin {
  /** 运行期状态 */
  readonly #app: BilibiliApp
  /** 当前会话；同时只允许一个 */
  #session: QrSession | undefined
  /**
   * 生成二维码时 B 站下发的 Cookie（`buvid3` 之类）
   *
   * 轮询时原样带回：B 站把「这张二维码是谁要的」记在这组 Cookie 上，缺了它，
   * 部分账号在确认登录后只回一个不带凭据的 url —— 表现就是「登录成功但解析凭据失败」。
   */
  #jar = ""

  /**
   * @param app 运行期状态
   */
  constructor(app: BilibiliApp) {
    this.#app = app
  }

  /**
   * 生成登录二维码
   * @returns 二维码内容与密钥；接口失败为 null
   */
  async generate(): Promise<QrCodeGenerateResult | null> {
    await this.#ensureFingerprint()

    // 优先原生 fetch：B 站会在这一步下发 buvid3/buvid4，后面拿 crossDomain 兑换凭据
    // 时这组设备指纹要一致。`ctx.http` 丢弃 set-cookie（实测响应头里就没有），拿不到
    const viaFetch = await this.#generateViaFetch()
    if (viaFetch !== null) return viaFetch

    try {
      const res = await this.#app.ctx.http.request<BilibiliApiResponse<QrCodeGenerateResult>>(GENERATE_API, {
        headers: HEADERS,
        timeout: "10s",
        throwOnError: false
      })
      const body = res.data
      if (body === null || typeof body !== "object" || body.code !== 0) {
        this.#app.log("warn", `生成二维码失败：HTTP ${res.status}`)
        return null
      }
      // 记住这组 Cookie，轮询要带着；上一次的会话已经作废，不沿用
      this.#jar = mergeCookies(this.#jar, cookieHeaderOf(splitSetCookie(res.headers["set-cookie"])))
      this.#session = { key: body.data.qrcode_key, url: body.data.url, at: Date.now() }
      return body.data
    } catch (error) {
      this.#app.log("warn", "生成二维码异常", error)
      return null
    }
  }

  /**
   * 取一次设备指纹（buvid3 / buvid4）
   *
   * B 站把「这张二维码是谁要的」记在 buvid 上。generate 本身不下发它（实测响应头里
   * 没有 set-cookie），`ctx.http` 又不暴露 set-cookie，故显式问一次指纹接口。
   * 拿不到就继续 —— 少了它多数情况仍能登，只是少一层会话一致性，不该因此阻断登录。
   */
  async #ensureFingerprint(): Promise<void> {
    if (this.#jar !== "") return
    try {
      const res = await fetch(SPI_API, { headers: HEADERS, signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return
      const body = (await res.json()) as { code: number; data?: { b_3?: string; b_4?: string } }
      if (body === null || typeof body !== "object" || body.code !== 0 || body.data === undefined) return
      const parts: string[] = []
      if (typeof body.data.b_3 === "string" && body.data.b_3 !== "") parts.push(`buvid3=${body.data.b_3}`)
      if (typeof body.data.b_4 === "string" && body.data.b_4 !== "") parts.push(`buvid4=${body.data.b_4}`)
      this.#jar = parts.join("; ")
    } catch (error) {
      this.#app.debug("取设备指纹失败，按无指纹继续", error)
    }
  }

  /**
   * 用原生 fetch 申请二维码，顺带收下设备指纹
   * @returns 二维码内容；网络或接口不可用时 null（调用方回退 `ctx.http`）
   */
  async #generateViaFetch(): Promise<QrCodeGenerateResult | null> {
    try {
      const res = await fetch(GENERATE_API, { headers: HEADERS, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return null
      const body = (await res.json()) as BilibiliApiResponse<QrCodeGenerateResult>
      if (body === null || typeof body !== "object" || body.code !== 0) return null
      const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
      this.#jar = mergeCookies(this.#jar, cookieHeaderOf(cookies))
      this.#session = { key: body.data.qrcode_key, url: body.data.url, at: Date.now() }
      return body.data
    } catch (error) {
      this.#app.debug("原生 fetch 申请二维码失败，回退 ctx.http", error)
      return null
    }
  }

  /**
   * 把二维码内容渲染成 PNG
   *
   * `qrcode` 是可选依赖：没装（例如直接拷目录、没跑过 `npm i`）时不让登录功能把整条
   * 命令拖垮，改为把链接原样发出去，手机仍可从链接进登录页。
   * @param text 二维码内容
   * @returns PNG 字节；不可用时 null
   */
  async qrImage(text: string): Promise<Uint8Array | null> {
    try {
      const mod = (await import("qrcode")) as unknown as {
        default?: { toBuffer(text: string, opts?: Record<string, unknown>): Promise<Buffer> }
        toBuffer?: (text: string, opts?: Record<string, unknown>) => Promise<Buffer>
      }
      const encode = mod.toBuffer ?? mod.default?.toBuffer
      if (encode === undefined) return null
      const buffer = await encode(text, { type: "png", width: 360, margin: 1, errorCorrectionLevel: "M" })
      return new Uint8Array(buffer)
    } catch (error) {
      this.#app.debug("二维码渲染不可用（可能未安装 qrcode）", error)
      return null
    }
  }

  /**
   * 轮询扫码结果
   *
   * 成功时顺手落盘凭据并刷新一次用户信息：调用方拿到的就是一个**真的能用**的登录态，
   * 而不是「B 站说成功了但 Cookie 其实已过期」。
   * @param key 轮询密钥，缺省用当前会话
   * @returns 轮询结果
   */
  async poll(key?: string): Promise<QrCodePollResult> {
    const actual = key ?? this.#session?.key
    if (actual === undefined) {
      return { status: QrCodeLoginStatus.EXPIRED, message: "没有正在进行的扫码会话，请先发送「#bili登录」" }
    }
    if (this.#session !== undefined && Date.now() - this.#session.at > QR_TTL) {
      this.#session = undefined
      this.#jar = ""
      return { status: QrCodeLoginStatus.EXPIRED, message: "二维码已过期，请重新发送「#bili登录」" }
    }

    try {
      const res = await this.#app.ctx.http.request<BilibiliApiResponse<QrPollPayload>>(
        `${POLL_API}?qrcode_key=${encodeURIComponent(actual)}`,
        {
          headers: this.#jar === "" ? HEADERS : { ...HEADERS, Cookie: this.#jar },
          timeout: "10s",
          throwOnError: false
        }
      )
      const body = res.data

      if (body === null || typeof body !== "object" || body.code !== 0) {
        const message =
          body !== null && typeof body === "object" && "message" in body ? String(body.message) : `HTTP ${res.status}`
        return { status: QrCodeLoginStatus.EXPIRED, message: message || "轮询失败" }
      }

      const payload = body.data
      switch (payload.code as QrCodeLoginStatus) {
        case QrCodeLoginStatus.WAITING:
          return { status: QrCodeLoginStatus.WAITING, message: "等待扫码" }
        case QrCodeLoginStatus.SCANNED:
          return { status: QrCodeLoginStatus.SCANNED, message: "已扫码，请在手机上确认" }
        case QrCodeLoginStatus.SUCCESS: {
          // B 站 2026-08 起改了三段式：轮询只给一个带 ticket 的 crossDomain 地址，
          // 必须去访问它，Set-Cookie 才下发 SESSDATA。三种来源按代价从低到高尝试
          let credential = parseCredential(payload.url ?? "", payload.refresh_token)
          if (credential === null) {
            credential = await this.#credentialFromTicket(payload.url ?? "", payload.refresh_token)
          }
          if (credential === null) {
            credential = await this.#pollFromCookie(actual, payload.refresh_token)
          }
          if (credential === null) {
            // 只记字段名，不记值：SESSDATA 等价于密码
            this.#app.log(
              "warn",
              `登录成功但没拿到凭据：url 参数=[${queryNames(payload.url ?? "")}]，set-cookie 字段=[${cookieNames(res.headers)}]`
            )
            return { status: QrCodeLoginStatus.EXPIRED, message: "登录成功但没拿到凭据，请重新扫码" }
          }
          await this.accept(credential)
          this.#session = undefined
          this.#jar = ""
          return { status: QrCodeLoginStatus.SUCCESS, message: "登录成功", credential }
        }
        default:
          this.#session = undefined
          this.#jar = ""
          return { status: QrCodeLoginStatus.EXPIRED, message: payload.message || "二维码已过期" }
      }
    } catch (error) {
      this.#app.log("warn", "轮询扫码结果异常", error)
      return { status: QrCodeLoginStatus.EXPIRED, message: "请求异常，请稍后重试" }
    }
  }

  /**
   * 访问 crossDomain 地址，从 Set-Cookie 里取凭据
   *
   * 这是 2026-08 之后的正路：轮询返回 `https://passport.biligame.com/crossDomain?…ticket=…`，
   * 登录态不在查询串里，而在**访问它**之后的响应头上。所以：
   *
   * - 必须 `redirect: "manual"`：Set-Cookie 挂在 302 上，跟随后就被丢了；
   * - 必须用原生 fetch：`ctx.http` 不返回 set-cookie（实测）；
   * - 只认 bilibili.com / biligame.com 的地址，别让一个伪造的 url 把请求带去内网。
   * @param url 轮询给的地址
   * @param refreshToken 刷新令牌
   * @returns 凭据；地址为空或没有凭据为 null
   */
  async #credentialFromTicket(url: string, refreshToken: string): Promise<BilibiliCredential | null> {
    if (url === "") return null
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return null
    }
    if (!/(^|\.)(bilibili\.com|biligame\.com)$/.test(target.hostname)) {
      this.#app.log("warn", `登录跳转到了非 B 站域名，已忽略：${target.hostname}`)
      return null
    }

    try {
      const res = await fetch(target.href, {
        redirect: "manual",
        headers: this.#jar === "" ? HEADERS : { ...HEADERS, Cookie: this.#jar },
        signal: AbortSignal.timeout(10_000)
      })
      const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
      const credential = parseCredentialFromCookies(cookies, refreshToken)
      if (credential === null) {
        this.#app.debug(`crossDomain 未下发凭据：HTTP ${res.status}，字段=[${cookies.map(c => c.split("=")[0]).join(",")}]`)
      }
      return credential
    } catch (error) {
      this.#app.log("warn", "访问登录跳转地址失败", error)
      return null
    }
  }

  /**
   * 用原生 fetch 再问一次，只为读 Set-Cookie
   *
   * 为什么不能用 `ctx.http`：它返回的响应头里没有 `set-cookie`（实测 generate 就是这样），
   * 而 B 站在部分账号/网络下把凭据只写进 Set-Cookie、`data.url` 留空。这时唯一的读法
   * 是原生 fetch 的 `Headers.getSetCookie()`。
   *
   * 只在 url 与 crossDomain 都拿不到时才调用，正常路径不会多发请求；直连失败返回 null。
   * @param key 轮询密钥
   * @param refreshToken 刷新令牌
   * @returns 凭据；拿不到为 null
   */
  async #pollFromCookie(key: string, refreshToken: string): Promise<BilibiliCredential | null> {
    try {
      const res = await fetch(`${POLL_API}?qrcode_key=${encodeURIComponent(key)}`, {
        headers: this.#jar === "" ? HEADERS : { ...HEADERS, Cookie: this.#jar },
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) return null
      const body = (await res.json()) as BilibiliApiResponse<QrPollPayload>
      if (body.code !== 0 || body.data.code !== QrCodeLoginStatus.SUCCESS) return null
      return (
        parseCredential(body.data.url ?? "", refreshToken) ??
        parseCredentialFromCookies(
          typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [],
          refreshToken
        )
      )
    } catch (error) {
      this.#app.debug("原生 fetch 兜底失败", error)
      return null
    }
  }

  /**
   * 接受一份凭据：落盘、置入内存、拉一次用户信息
   * @param credential 凭据
   */
  async accept(credential: BilibiliCredential): Promise<void> {
    await saveCredential(this.#app.ctx, credential)
    this.#app.credential = credential
    this.#app.log("info", `B 站登录成功，DedeUserID=${credential.dedeuserid}`)
    await this.refreshUserInfo()
    this.#app.scheduleSnapshot()
  }

  /**
   * 拉当前登录用户信息，顺带校验 Cookie 是否还有效
   * @returns 用户信息；未登录或 Cookie 失效为 null
   */
  async refreshUserInfo(): Promise<BilibiliUserInfo | null> {
    const credential = this.#app.credential
    if (credential === undefined) return null

    try {
      const res = await this.#app.ctx.http.get<BilibiliApiResponse<BilibiliUserInfo>>(NAV_API, {
        headers: {
          ...HEADERS,
          Cookie: `SESSDATA=${encodeURIComponent(credential.sessdata)}; bili_jct=${credential.bili_jct}; DedeUserID=${credential.dedeuserid}`
        },
        timeout: "10s"
      })
      if (res.code === -101) {
        // Cookie 已失效：清掉，免得后续每个请求都白跑一趟还带着一个死身份
        this.#app.log("warn", "B 站凭据已失效，已按未登录处理")
        await this.forget()
        return null
      }
      if (res.code !== 0) return null
      this.#app.userInfo = { uname: res.data.uname, mid: res.data.mid, face: res.data.face }
      this.#app.scheduleSnapshot()
      return res.data
    } catch (error) {
      this.#app.debug("拉取用户信息失败", error)
      return null
    }
  }

  /** 退出登录：内存与磁盘一起清 */
  async forget(): Promise<void> {
    this.#app.credential = undefined
    this.#app.userInfo = undefined
    await clearCredential(this.#app.ctx)
    this.#app.scheduleSnapshot()
  }

  /** 当前会话还剩多少秒；没有会话为 0 */
  get remaining(): number {
    if (this.#session === undefined) return 0
    return Math.max(0, Math.floor((QR_TTL - (Date.now() - this.#session.at)) / 1000))
  }
}

/**
 * 从登录成功返回的跳转地址里抠出 Cookie
 * @param url 形如 `https://passport.biligame.com/crossDomain?SESSDATA=…&bili_jct=…&DedeUserID=…`
 * @param refreshToken 刷新令牌
 * @returns 凭据；关键字段缺失为 null
 */
function parseCredential(url: string, refreshToken: string): BilibiliCredential | null {
  if (url === "") return null
  const mark = url.indexOf("?")
  if (mark < 0) return null
  // 去掉 # 片段：B 站的回跳地址偶尔带 gourl 之外的锚点
  const params = new URLSearchParams(url.slice(mark + 1).split("#")[0])
  const sessdata = params.get("SESSDATA")
  const biliJct = params.get("bili_jct")
  const dedeuserid = params.get("DedeUserID")
  if (sessdata === null || biliJct === null || dedeuserid === null) return null
  if (sessdata === "" || biliJct === "" || dedeuserid === "") return null
  return {
    sessdata: safeDecode(sessdata),
    bili_jct: biliJct,
    dedeuserid,
    refresh_token: refreshToken,
    login_time: Date.now()
  }
}

/**
 * 从一组 Set-Cookie 原文里取凭据
 * @param cookies 每条 cookie 的原文（可带 Path/Domain 等属性）
 * @param refreshToken 刷新令牌
 * @returns 凭据；三个字段不全为 null
 */
function parseCredentialFromCookies(cookies: readonly string[], refreshToken: string): BilibiliCredential | null {
  const jar = new Map<string, string>()
  for (const part of cookies) {
    // 一条 Set-Cookie 里，分号之前才是 name=value，后面是 Path/Domain/Expires
    const pair = part.split(";")[0] ?? ""
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  const sessdata = jar.get("SESSDATA")
  const biliJct = jar.get("bili_jct")
  const dedeuserid = jar.get("DedeUserID")
  if (sessdata === undefined || biliJct === undefined || dedeuserid === undefined) return null
  if (sessdata === "" || biliJct === "" || dedeuserid === "") return null
  return {
    sessdata: safeDecode(sessdata),
    bili_jct: biliJct,
    dedeuserid,
    refresh_token: refreshToken,
    login_time: Date.now()
  }
}

/**
 * 拆出若干条 Set-Cookie
 *
 * `fetch` 那边可能给数组，也可能把多条拼成一行。拼成一行时用 `, name=` 作分隔：
 * `Expires=Wed, 21 Oct 2025 07:28:00 GMT` 里的逗号后面不是 `name=`，不会误拆。
 * @param value 头值
 * @returns 每条 cookie 的原文
 */
function splitSetCookie(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  const raw = Array.isArray(value) ? value.join("\n") : value
  return raw
    .split(/\n|,\s*(?=[A-Za-z0-9_]+=)/)
    .map(part => part.trim())
    .filter(part => part !== "")
}

/**
 * 合并两组 Cookie
 *
 * 后到的同名项覆盖先到的（B 站重新下发 buvid 时要认新的）。
 * @param base 已有
 * @param extra 新增
 * @returns `a=1; b=2`
 */
function mergeCookies(base: string, extra: string): string {
  if (base === "") return extra
  if (extra === "") return base
  const fresh = new Set(extra.split(";").map(pair => pair.split("=")[0]?.trim() ?? ""))
  const kept = base
    .split(";")
    .map(pair => pair.trim())
    .filter(pair => pair !== "" && !fresh.has(pair.split("=")[0]?.trim() ?? ""))
  return [...kept, extra].join("; ")
}

/**
 * 把 Set-Cookie 变成请求头里的 Cookie 值
 * @param cookies 每条 cookie 的原文
 * @returns `a=1; b=2`；没有 cookie 时为空串
 */
function cookieHeaderOf(cookies: readonly string[]): string {
  return cookies
    .map(part => part.split(";")[0]?.trim() ?? "")
    .filter(pair => pair.includes("="))
    .join("; ")
}

/**
 * URL 解码，失败就原样返回
 *
 * SESSDATA 在 url 里是编码过的，但偶尔含裸 `%`。`decodeURIComponent` 对那种值会抛
 * `URIError`，一旦抛出去整条登录链路就断在一个本可以忽略的字符上。
 * @param value 原值
 * @returns 解码后的值
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 取 url 里的参数名，用于日志
 *
 * 只列名字不列值：SESSDATA 等价于账号密码，写进日志等于把凭据摊在磁盘上。
 * @param url 回跳地址
 * @returns 逗号分隔的参数名
 */
function queryNames(url: string): string {
  const mark = url.indexOf("?")
  if (mark < 0) return ""
  return [...new URLSearchParams(url.slice(mark + 1).split("#")[0]).keys()].join(",")
}

/**
 * 取 Set-Cookie 里的字段名，用于日志
 * @param headers 响应头
 * @returns 逗号分隔的 cookie 名
 */
function cookieNames(headers: Record<string, string | string[] | undefined>): string {
  return splitSetCookie(headers["set-cookie"])
    .map(part => (part.split(";")[0] ?? "").split("=")[0]?.trim() ?? "")
    .filter(name => name !== "")
    .join(",")
}
