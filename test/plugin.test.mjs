/**
 * 模块职责：不依赖内核与网络的回归用例 —— 用假上下文走一遍链接识别、抓取、投递与冷却
 * 依赖方向：node:test + 构建产物；**不需要 vitest、不需要启动内核、不需要连 B 站**
 * 生命周期：`npm test` 执行一次
 * 注意事项：跑之前先 `npm run build`（用例读的是 `dist/`）。假 HTTP 返回的是 B 站
 *          `view` / `playurl` 接口的真实字段形状，接口改版时这里会先红。
 */
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"

const DIST = new URL("../dist/", import.meta.url)
const load = path => import(pathToFileURL(join(DIST.pathname, path)).href)

const { BilibiliApp } = await load("core/app.js")
const { BilibiliApi, buildMergeArgs, containsBilibiliLink, extractBvid, extractLinkFromSegments } = await load("services/bilibili.js")
const { deliver, cardData } = await load("handlers/card.js")
const { encryptString, decryptString } = await load("utils/crypto.js")
const { formatCount, formatDuration } = await load("utils/format.js")

const DATA_DIR = join(process.env.TMPDIR ?? "/tmp", "yzng-bilibili-test")
await rm(DATA_DIR, { recursive: true, force: true })
await mkdir(DATA_DIR, { recursive: true })

/** 一份 `x/web-interface/view` 的响应体 */
const VIDEO = {
  bvid: "BV1GJ411x7h7",
  aid: 123456,
  cid: 987654,
  title: "测试 <视频> & 标题",
  pic: "https://i0.hdslb.com/bfs/archive/cover.jpg",
  desc: "一段简介",
  duration: 271,
  pages: [{ cid: 987654, page: 1, part: "P1", duration: 271 }],
  owner: { mid: 42, name: "UP主", face: "https://i0.hdslb.com/face.jpg" },
  stat: { view: 1234567, danmaku: 2345, reply: 678, favorite: 4321, coin: 5678, share: 89, like: 12345 },
  pubdate: 1600000000,
  tname: "单机游戏"
}

/** 假 HTTP：只认两个接口，别的一律报错，避免用例悄悄依赖了不该发的请求 */
const http = {
  async get(url) {
    if (url.includes("/x/web-interface/view")) return { code: 0, message: "0", data: VIDEO }
    if (url.includes("/x/player/playurl")) {
      return { code: 0, message: "0", data: { dash: { video: [{ id: 80, backupUrl: "https://cdn/a.m4s" }], audio: [] } } }
    }
    throw new Error(`未预期的请求：${url}`)
  },
  async request() {
    return { url: "https://www.bilibili.com/video/BV1GJ411x7h7", status: 302, ok: true, headers: {}, data: undefined }
  },
  async download(url, dest) {
    await writeFile(dest, Buffer.alloc(64))
    return dest
  }
}

/** 默认配置 */
const config = {
  enabled: true,
  parseInPrivate: false,
  ignorePrefixes: ["#"],
  sendMode: "info-only",
  renderCard: false,
  cardAsForward: true,
  atSender: false,
  maxVideoSizeMB: 100,
  videoQuality: "auto",
  parseCacheTTL: 300,
  groupBlacklist: [],
  debug: false
}

/** 造一个够用的插件上下文 */
function fakeCtx() {
  return {
    name: "bilibili",
    version: "1.0.0",
    root: DATA_DIR,
    dataDir: DATA_DIR,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    kv: { async get() {}, async set() {} },
    config: { get: () => config, patch: async () => config, onChange: () => () => {} },
    app: { paths: { temp: DATA_DIR } },
    http,
    signal: new AbortController().signal,
    render: async () => {
      throw new Error("测试里没有渲染器")
    },
    onDispose() {}
  }
}

/** 同上，但把 `request` 换成用例自己那个（短链展开要看 3xx 的 Location） */
function fakeCtxWith(request) {
  return { ...fakeCtx(), http: { ...http, request } }
}

test("链接识别认全 BV / av / 站内链接 / 短链，且不误判别的站", () => {
  assert.equal(containsBilibiliLink("https://www.bilibili.com/video/BV1GJ411x7h7"), true)
  assert.equal(containsBilibiliLink("https://b23.tv/abcdEF"), true)
  assert.equal(containsBilibiliLink("看 BV1GJ411x7h7"), true)
  assert.equal(containsBilibiliLink("av12345"), true)
  assert.equal(containsBilibiliLink("https://example.com/video/BVabc"), false)
  assert.equal(extractBvid("https://m.bilibili.com/video/bv1GJ411x7h7"), "BV1GJ411x7h7")
})

test("从小程序卡片里取出链接", () => {
  const segments = [
    {
      type: "json",
      data: JSON.stringify({ app: "com.tencent.miniapp_01", meta: { detail_1: { qqdocurl: "https://b23.tv/xyz" } } })
    }
  ]
  assert.equal(extractLinkFromSegments(segments), "https://b23.tv/xyz")
})

test("抓取视频信息并按合并转发投递", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  const info = await new BilibiliApi(app).parse("https://www.bilibili.com/video/BV1GJ411x7h7")
  assert.equal(info?.bvid, "BV1GJ411x7h7")

  const sent = []
  const e = {
    isGroup: true,
    selfId: "10000",
    sender: { uid: "20000" },
    messageId: "m1",
    group: { gid: "700000", name: "测试群" },
    bot: { caps: new Set(["forward", "reaction"]), async setReaction() {} },
    async reply(content) {
      sent.push(content)
      return { ok: true, messageId: "x", time: Date.now() }
    }
  }

  await deliver(app, e, info)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, "forward")
  // 封面一个节点、文字一个节点
  assert.deepEqual(
    sent[0].nodes.map(node => node.message[0].type),
    ["image", "text"]
  )
  // 卡片/文字已经给全信息，不再额外贴链接
  assert.ok(!JSON.stringify(sent[0]).includes("bilibili.com/video"))
})

/** 造一个能收消息事件，按需带上 forward 能力 */
function fakeEvent({ forward = true } = {}) {
  const sent = []
  return {
    sent,
    e: {
      isGroup: true,
      selfId: "10000",
      sender: { uid: "20000" },
      messageId: "m1",
      group: { gid: "700000", name: "测试群" },
      bot: { caps: new Set(forward ? ["forward", "reaction"] : []), async setReaction() {} },
      async reply(content) {
        sent.push(content)
        return { ok: true, messageId: "x", time: Date.now() }
      }
    }
  }
}

test("开合并转发时，图片、文字、视频各占一个节点，且不附链接", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  const info = await new BilibiliApi(app).parse("BV1GJ411x7h7")

  const { e, sent } = fakeEvent({ forward: true })
  await deliver(app, e, info, "/tmp/fake.mp4")

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, "forward")
  assert.deepEqual(
    sent[0].nodes.map(node => node.message[0].type),
    ["image", "text", "video"]
  )
  assert.ok(!JSON.stringify(sent[0]).includes("bilibili.com/video"))
})

test("关掉合并转发时，图片与视频分成两条发，同样不附链接", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  const info = await new BilibiliApi(app).parse("BV1GJ411x7h7")

  const { e, sent } = fakeEvent({ forward: false })
  await deliver(app, e, info, "/tmp/fake.mp4")

  // 一条普通消息只能带一个富媒体：图片和视频必须分开，否则 QQ 只留视频
  assert.equal(sent.length, 2)
  assert.deepEqual(
    sent[0].map(segment => segment?.type),
    ["image", "text"]
  )
  assert.equal(sent[1].type, "video")
  assert.ok(!JSON.stringify(sent).includes("bilibili.com/video"))
})

test("视频发送失败时信息卡片仍然算送达", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  const info = await new BilibiliApi(app).parse("BV1GJ411x7h7")

  const { e } = fakeEvent({ forward: false })
  e.reply = async content => {
    if (Array.isArray(content) && content.some(segment => segment?.type === "video")) {
      throw new Error("视频被平台拒绝")
    }
    if (content?.type === "video") throw new Error("视频被平台拒绝")
    return { ok: true, messageId: "x", time: Date.now() }
  }

  assert.equal(await deliver(app, e, info, "/tmp/fake.mp4"), true)
})

test("没有渲染器时回落为封面 + 文字，而不是报错", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  const info = await new BilibiliApi(app).parse("BV1GJ411x7h7")
  const sent = []
  const e = {
    isGroup: false,
    selfId: "10000",
    sender: { uid: "20000" },
    messageId: "m2",
    bot: { caps: new Set() },
    async reply(content) {
      sent.push(content)
      return { ok: true, messageId: "y", time: Date.now() }
    }
  }
  await deliver(app, e, info)
  const types = sent[0].filter(Boolean).map(segment => segment.type)
  assert.deepEqual(types, ["image", "text"])
})

test("冷却按群生效，TTL 为 0 时不去重", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  app.touchCooldown("700000", "BV1GJ411x7h7")
  assert.equal(app.inCooldown("700000", "BV1GJ411x7h7"), true)
  assert.equal(app.inCooldown("700001", "BV1GJ411x7h7"), false)
  config.parseCacheTTL = 0
  app.touchCooldown("700000", "BV2xx")
  assert.equal(app.inCooldown("700000", "BV2xx"), false)
  config.parseCacheTTL = 300
})

test("凭据加密可还原，密文里没有明文", () => {
  const secret = "SESSDATA-very-secret"
  const encrypted = encryptString(secret)
  assert.ok(encrypted.startsWith("ENC:"))
  assert.ok(!encrypted.includes(secret))
  assert.equal(decryptString(encrypted), secret)
  assert.equal(decryptString("ENC:00:00:00"), "")
})

test("卡片数据与数字格式", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  const info = await new BilibiliApi(app).parse("BV1GJ411x7h7")
  const data = cardData(info)
  assert.equal(data.view, "123.5万")
  assert.equal(data.duration, "4:31")
  assert.equal(data.pubdate, "2020-09-13")
  assert.equal(formatCount(999), "999")
  assert.equal(formatCount(234567890), "2.3亿")
  assert.equal(formatDuration(3723), "1:02:03")
})

// ── 面板扩展页的扫码接口 ──────────────────────────────────────────────────────
// webadapter 由 webui 单独加载，拿不到插件闭包，只能按 Symbol 从 globalThis 取运行时。
// 这几条钉住三件事：键对得上、二维码转成 dataURL、轮询与登出真的落到了 login 上。

const RUNTIME_KEY = Symbol.for("yunzai-ng.bilibili.runtime")
const { init: initWebAdapter } = await import(new URL("../webadapter/index.js", import.meta.url).href)

/** 造一组接口表：registerApi 的名字 → handler */
function pageContext() {
  const apis = new Map()
  initWebAdapter({
    pluginName: "bilibili",
    pluginDir: new URL("../webadapter/", import.meta.url).pathname,
    configDir: join(DATA_DIR, "config"),
    registerPage() {},
    registerApi: (path, handler) => apis.set(path, handler)
  })
  return apis
}

/** 假的登录服务，只记调用次数 */
function fakeLogin() {
  const calls = { generate: 0, poll: 0, forget: 0 }
  return {
    calls,
    remaining: 180,
    async generate() {
      calls.generate += 1
      return { url: "https://passport.bilibili.com/h5-qrcode?x=1", qrcode_key: "qk" }
    },
    async qrImage() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    },
    async poll() {
      calls.poll += 1
      return { status: 86101, message: "等待扫码" }
    },
    async forget() {
      calls.forget += 1
    }
  }
}

test("扩展页注册了扫码三条接口与口令接口", () => {
  const apis = pageContext()
  assert.deepEqual([...apis.keys()].sort(), ["login/logout", "login/poll", "login/qr", "panel", "status"])
})

test("插件没加载完成时接口给出可读的失败，而不是抛异常", async () => {
  const apis = pageContext()
  delete globalThis[RUNTIME_KEY]
  const res = await apis.get("login/qr")()
  assert.equal(res.ok, false)
  assert.match(res.error, /还没加载完成/)
})

test("扫码接口把二维码转成 dataURL，轮询与登出落到 login 上", async () => {
  const apis = pageContext()
  const login = fakeLogin()
  globalThis[RUNTIME_KEY] = { app: {}, login }

  const qr = await apis.get("login/qr")()
  assert.equal(qr.ok, true)
  assert.equal(qr.image, "data:image/png;base64,iVBORw==")
  assert.equal(qr.remaining, 180)
  assert.equal(login.calls.generate, 1)

  const poll = await apis.get("login/poll")()
  assert.equal(poll.status, 86101)
  assert.equal(poll.ok, true)
  assert.equal(login.calls.poll, 1)

  await apis.get("login/logout")()
  assert.equal(login.calls.forget, 1)

  delete globalThis[RUNTIME_KEY]
})

test("没装 qrcode 时 image 为空串，页面仍有链接可发", async () => {
  const apis = pageContext()
  const login = fakeLogin()
  login.qrImage = async () => null
  globalThis[RUNTIME_KEY] = { app: {}, login }

  const qr = await apis.get("login/qr")()
  assert.equal(qr.ok, true)
  assert.equal(qr.image, "")
  assert.ok(qr.url.includes("passport.bilibili.com"))

  delete globalThis[RUNTIME_KEY]
})

// ── 扫码成功后的凭据来源 ──────────────────────────────────────────────────────
// B 站有两种给法：凭据塞在 data.url 的查询串里，或只写 Set-Cookie（url 为空）。
// 只认前者会稳定报「登录成功但解析凭据失败」，但登录其实已经成功。

const { BilibiliLogin } = await load("services/login.js")

/**
 * 造一个只处理 nav 与 poll 的环境
 * @param {object} response 轮询的完整响应（status / headers / data）
 * @returns {{ app: object, login: object, logs: string[] }} 环境
 */
function loginFixture(response) {
  const logs = []
  const ctx = fakeCtx()
  ctx.logger = {
    info() {},
    warn(message) {
      logs.push(String(message))
    },
    error() {},
    debug() {}
  }
  ctx.http = {
    async request() {
      return response
    },
    async get(url) {
      if (url.includes("/x/web-interface/nav")) {
        return { code: 0, message: "0", data: { uname: "测试账号", mid: 42, face: "" } }
      }
      throw new Error(`未预期的请求：${url}`)
    },
    async download() {}
  }
  const app = new BilibiliApp(ctx)
  return { app, login: new BilibiliLogin(app), logs }
}

test("扫码成功：从回跳地址的查询串里取凭据", async () => {
  const url =
    "https://passport.biligame.com/crossDomain?DedeUserID=42&DedeUserID__ckMd5=abc&Expires=1&SESSDATA=abc%2Cdef&bili_jct=xyz&gourl=https%3A%2F%2Fwww.bilibili.com"
  const { app, login } = loginFixture({
    status: 200,
    headers: {},
    data: { code: 0, message: "0", data: { code: 0, message: "", url, refresh_token: "rt", timestamp: 1 } }
  })

  const result = await login.poll("qk")
  assert.equal(result.status, 0)
  assert.equal(result.credential.sessdata, "abc,def")
  assert.equal(result.credential.bili_jct, "xyz")
  assert.equal(app.isLoggedIn(), true)
  app.dispose()
})

test("扫码成功但 url 不带凭据：访问 crossDomain 从 Set-Cookie 取", async () => {
  const original = globalThis.fetch
  let visited = ""
  globalThis.fetch = async url => {
    visited = String(url)
    return {
      status: 302,
      ok: false,
      headers: {
        getSetCookie: () => [
          "SESSDATA=s%2Cv%2C1; Path=/; Domain=.bilibili.com; HttpOnly",
          "bili_jct=jj; Path=/",
          "DedeUserID=42; Path=/"
        ]
      }
    }
  }
  const { app, login, logs } = loginFixture({
    status: 200,
    headers: {},
    data: {
      code: 0,
      message: "0",
      data: {
        code: 0,
        message: "",
        url: "https://passport.biligame.com/crossDomain?ticket=abc&gourl=https%3A%2F%2Fwww.bilibili.com",
        refresh_token: "rt",
        timestamp: 1
      }
    }
  })

  const result = await login.poll("qk")
  globalThis.fetch = original
  assert.equal(result.status, 0)
  assert.equal(result.credential.sessdata, "s,v,1")
  assert.equal(result.credential.dedeuserid, "42")
  assert.ok(visited.startsWith("https://passport.biligame.com/crossDomain"))
  assert.equal(logs.some(line => line.includes("没拿到凭据")), false)
  app.dispose()
})

test("跳转地址指向非 B 站域名时拒绝访问", async () => {
  const original = globalThis.fetch
  const visited = []
  globalThis.fetch = async url => {
    visited.push(String(url))
    return { status: 200, headers: { getSetCookie: () => [] }, json: async () => ({}) }
  }
  const { app, login, logs } = loginFixture({
    status: 200,
    headers: {},
    data: {
      code: 0,
      message: "0",
      data: { code: 0, message: "", url: "http://127.0.0.1:8080/admin", refresh_token: "rt", timestamp: 1 }
    }
  })

  const result = await login.poll("qk")
  globalThis.fetch = original
  assert.equal(visited.some(url => url.includes("127.0.0.1")), false)
  assert.equal(result.status, 86038)
  assert.ok(logs.some(line => line.includes("非 B 站域名")))
  app.dispose()
})

test("两路都缺字段时明确失败，日志只记字段名不记值", async () => {
  const original = globalThis.fetch
  // 兜底会再发一次原生请求；这里让它直接失败，避免用例打到外网
  globalThis.fetch = async () => {
    throw new Error("测试里不联网")
  }
  const { app, login, logs } = loginFixture({
    status: 200,
    headers: { "set-cookie": "buvid3=abc; Path=/, SESSDATA=; Path=/" },
    data: { code: 0, message: "0", data: { code: 0, message: "", url: "https://www.bilibili.com", refresh_token: "rt", timestamp: 1 } }
  })

  const result = await login.poll("qk")
  globalThis.fetch = original
  assert.equal(result.status, 86038)
  const warn = logs.find(line => line.includes("没拿到凭据"))
  assert.ok(warn !== undefined)
  assert.ok(warn.includes("url 参数=[") && warn.includes("set-cookie 字段=["))
  // 值不该出现在日志里
  assert.equal(warn.includes("buvid3"), true) // 字段名可以出现
  assert.equal(warn.includes("abc"), false) // 值不行
  app.dispose()
})

test("url 与 ctx.http 都拿不到时，用原生 fetch 读 Set-Cookie", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    headers: {
      getSetCookie: () => [
        "buvid3=b3; Path=/",
        "SESSDATA=raw%2Cvalue; Path=/; HttpOnly",
        "bili_jct=jj; Path=/",
        "DedeUserID=42; Path=/"
      ]
    },
    json: async () => ({
      code: 0,
      message: "0",
      data: { code: 0, message: "", url: "https://www.bilibili.com", refresh_token: "rt2", timestamp: 1 }
    })
  })
  const { app, login } = loginFixture({
    status: 200,
    headers: {},
    data: { code: 0, message: "0", data: { code: 0, message: "", url: "", refresh_token: "rt", timestamp: 1 } }
  })

  const result = await login.poll("qk")
  globalThis.fetch = original
  assert.equal(result.status, 0)
  assert.equal(result.credential.sessdata, "raw,value")
  assert.equal(result.credential.dedeuserid, "42")
  app.dispose()
})

test("SESSDATA 里带裸 % 时不会抛 URIError", async () => {
  const url = "https://passport.biligame.com/crossDomain?DedeUserID=42&SESSDATA=ab%zz&bili_jct=xyz"
  const { app, login } = loginFixture({
    status: 200,
    headers: {},
    data: { code: 0, message: "0", data: { code: 0, message: "", url, refresh_token: "rt", timestamp: 1 } }
  })

  const result = await login.poll("qk")
  assert.equal(result.status, 0)
  assert.equal(result.credential.sessdata, "ab%zz")
  app.dispose()
})

test("生成二维码时记住 B 站下发的 Cookie，轮询原样带回", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    headers: {
      getSetCookie: () => ["buvid3=b3; Path=/; Domain=.bilibili.com", "buvid4=b4; Path=/; Max-Age=999"]
    },
    json: async () => ({ code: 0, message: "0", data: { url: "https://qr.example/x", qrcode_key: "k" } })
  })

  const seen = []
  const ctx = fakeCtx()
  ctx.http = {
    async request(url, opts) {
      seen.push({ url, cookie: opts?.headers?.Cookie })
      return {
        status: 200,
        headers: {},
        data: { code: 0, message: "0", data: { code: 86101, message: "", url: "", refresh_token: "", timestamp: 1 } }
      }
    },
    async get() {
      throw new Error("不该走 get")
    }
  }
  const app = new BilibiliApp(ctx)
  const login = new BilibiliLogin(app)

  const generated = await login.generate()
  assert.equal(generated?.qrcode_key, "k")
  await login.poll()
  globalThis.fetch = original

  // 二维码走原生 fetch（为了拿设备指纹），轮询走 ctx.http 并带上这组 Cookie
  assert.equal(seen.length, 1)
  assert.ok(seen[0].url.includes("qrcode/poll"))
  assert.equal(seen[0].cookie, "buvid3=b3; buvid4=b4")
  app.dispose()
})

test("合流参数显式指定容器：输出是 .part，不写 -f mp4 时 ffmpeg 会以 EINVAL 退出（234）", () => {
  const args = buildMergeArgs("/tmp/a.m4v", "/tmp/b.m4a", "/tmp/out.mp4.part")

  // 两条输入，各自紧跟在自己的 -i 后面
  const inputs = args.filter((_, index) => args[index - 1] === "-i")
  assert.deepEqual(inputs, ["/tmp/a.m4v", "/tmp/b.m4a"])

  // 流拷贝（不重新编码）与显式容器，缺一个就会失败或白白转一遍
  assert.equal(args[args.indexOf("-c") + 1], "copy")
  assert.equal(args[args.indexOf("-f") + 1], "mp4")

  // 输出的扩展名是 .part，故 -f 必须在它前面；输出必须是最后一个参数
  assert.equal(args.at(-1), "/tmp/out.mp4.part")
  assert.ok(args.indexOf("-f") < args.length - 1)
  assert.ok(args.includes("-y"))
  // moov 前置：否则客户端要下完整个文件才播，QQ 常直接当文件给
  assert.equal(args[args.indexOf("-movflags") + 1], "+faststart")
})

test("同一画质优先挑 AVC，音频优先 AAC：HEVC/AV1 与 FLAC 会让 QQ 收成一个文件", () => {
  const api = new BilibiliApi(new BilibiliApp(fakeCtx()))
  const dash = {
    video: [
      { id: 116, codecid: 12, codecs: "hvc1.1.6.L120.90", bandwidth: 3000000, backupUrl: "https://cdn/hevc.m4s" },
      { id: 116, codecid: 13, codecs: "av01.0.08M.08", bandwidth: 2000000, backupUrl: "https://cdn/av1.m4s" },
      { id: 116, codecid: 7, codecs: "avc1.640033", bandwidth: 1000000, backupUrl: "https://cdn/avc.m4s" }
    ],
    audio: [
      { id: 30251, codecs: "fLaC", bandwidth: 999999, backupUrl: "https://cdn/flac.m4a" },
      { id: 30280, codecs: "mp4a.40.2", bandwidth: 203730, backupUrl: "https://cdn/aac.m4a" }
    ]
  }

  const picked = api.pickStreams(dash)
  assert.equal(picked.video.codecs, "avc1.640033")
  assert.equal(picked.audio.codecs, "mp4a.40.2")
})

test("只有 HEVC 时才退回原始候选，不会一路都挑不到", () => {
  const api = new BilibiliApi(new BilibiliApp(fakeCtx()))
  const { video } = api.pickStreams({
    video: [{ id: 80, codecid: 12, codecs: "hvc1.1.6.L120.90", backupUrl: "https://cdn/hevc.m4s" }]
  })
  assert.equal(video.codecs, "hvc1.1.6.L120.90")
})

test("自动解析收下事件时调 e.stop()，不留下「未调用 next()」的 trace 噪音", async () => {
  const ctx = fakeCtx()
  let middleware
  ctx.middleware = fn => {
    middleware = fn
    return () => {}
  }
  const app = new BilibiliApp(ctx)
  await app.restore()
  const { registerAutoParse } = await load("handlers/message.js")
  registerAutoParse(app, new BilibiliApi(app))

  let stopped = false
  let nexted = false
  const e = {
    kind: "message",
    scene: "group",
    isGroup: true,
    selfId: "10000",
    text: "https://www.bilibili.com/video/BV1GJ411x7h7",
    message: [{ type: "text", data: { text: "https://www.bilibili.com/video/BV1GJ411x7h7" } }],
    sender: { uid: "20000" },
    group: { gid: "700000", name: "测试群" },
    bot: { caps: new Set(), async setReaction() {} },
    async reply() {
      return { ok: true, messageId: "x", time: Date.now() }
    },
    stop() {
      stopped = true
    }
  }

  await middleware(e, async () => {
    nexted = true
  })

  // 收下事件：管线停在这里，且不是靠「不调 next()」实现的
  assert.equal(stopped, true)
  assert.equal(nexted, false)
})

test("黑名单里的群：不解析、也不吞消息，直接放行给后续插件", async () => {
  const ctx = fakeCtx()
  ctx.config.get = () => ({ ...config, groupBlacklist: ["700000"] })
  let middleware
  ctx.middleware = fn => {
    middleware = fn
    return () => {}
  }
  const app = new BilibiliApp(ctx)
  await app.restore()
  const { registerAutoParse } = await load("handlers/message.js")
  registerAutoParse(app, new BilibiliApi(app))

  let stopped = false
  let nexted = false
  let replied = 0
  const e = {
    kind: "message",
    scene: "group",
    isGroup: true,
    selfId: "10000",
    text: "https://www.bilibili.com/video/BV1GJ411x7h7",
    message: [{ type: "text", data: { text: "https://www.bilibili.com/video/BV1GJ411x7h7" } }],
    sender: { uid: "20000" },
    group: { gid: "700000", name: "测试群" },
    bot: { caps: new Set(), async setReaction() {} },
    async reply() {
      replied++
      return { ok: true, messageId: "x" }
    },
    stop() {
      stopped = true
    }
  }

  await middleware(e, async () => {
    nexted = true
  })

  assert.equal(app.isGroupEnabled("700000"), false)
  assert.equal(nexted, true)
  assert.equal(stopped, false)
  assert.equal(replied, 0)
})

test("私聊解析不进群列表：`private:<uid>` 不是群号", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  await app.markParsed({ bvid: "BV1GJ411x7h7", title: "私聊里的视频", gid: "private:20000" })
  await app.markParsed({ bvid: "BV1GJ411x7h7", title: "群里的视频", gid: "700000", group: "测试群" })

  const groups = app.snapshot().groups.map(group => group.gid)
  assert.deepEqual(groups, ["700000"])
  // 统计照记，只是不往群列表里塞
  assert.equal(app.snapshot().stats.total, 2)
})

test("白名单非空时只解析名单内的群，两边都填按黑名单算", () => {
  const ctx = fakeCtx()
  ctx.config.get = () => ({ ...config, groupWhitelist: ["111"], groupBlacklist: ["222"] })
  const app = new BilibiliApp(ctx)
  assert.equal(app.isGroupEnabled("111"), true)
  assert.equal(app.isGroupEnabled("333"), false)
  assert.equal(app.isGroupWhitelisted("111"), true)

  // 同时出现在两个名单里：黑名单优先
  ctx.config.get = () => ({ ...config, groupWhitelist: ["111", "222"], groupBlacklist: ["222"] })
  assert.equal(app.isGroupEnabled("222"), false)

  // 白名单为空：除黑名单外都解析
  ctx.config.get = () => ({ ...config, groupWhitelist: [], groupBlacklist: ["222"] })
  assert.equal(app.isGroupEnabled("333"), true)
})

test("短链靠 3xx 的 Location 展开：内核的 res.url 是请求地址，读它永远是短链本身", async () => {
  const seen = []
  const api = new BilibiliApi(
    new BilibiliApp(
      fakeCtxWith(async (url, options) => {
        seen.push({ url, method: options.method, followRedirect: options.followRedirect })
        return {
          status: 302,
          ok: false,
          url, // 内核填的是请求地址，不是跳转目标
          headers: { location: "https://www.bilibili.com/video/BV1GJ411x7h7?share_source=COPY" },
          data: undefined
        }
      })
    )
  )

  const real = await api.resolveShortUrl("https://b23.tv/jZI6nz3")
  assert.equal(real, "https://www.bilibili.com/video/BV1GJ411x7h7?share_source=COPY")
  assert.equal(seen.length, 1)
  // 自己读 Location，所以必须关掉内核的自动跟随
  assert.equal(seen[0].followRedirect, false)
  assert.equal(seen[0].method, "HEAD")
})

test("HEAD 只回 200 时改用 GET，Location 是相对地址也认", async () => {
  let head = 0
  let get = 0
  const api = new BilibiliApi(
    new BilibiliApp(
      fakeCtxWith(async (url, options) => {
        if (options.method === "HEAD") {
          head++
          return { status: 200, ok: true, url, headers: {}, data: undefined }
        }
        get++
        return { status: 302, ok: false, url, headers: { location: "/video/BV1GJ411x7h7" }, data: undefined }
      })
    )
  )

  assert.equal(await api.resolveShortUrl("https://b23.tv/x"), "https://b23.tv/video/BV1GJ411x7h7")
  assert.equal(head, 1)
  assert.equal(get, 1)
})

test("两跳都拿不到 Location 时返回 null，不会把短链本身当结果交出去", async () => {
  const api = new BilibiliApi(
    new BilibiliApp(
      fakeCtxWith(async url => ({ status: 200, ok: true, url, headers: {}, data: undefined }))
    )
  )
  assert.equal(await api.resolveShortUrl("https://b23.tv/x"), null)
})
