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
const {
  BilibiliApi,
  buildMergeArgs,
  containsBilibiliLink,
  extractBvid,
  extractLinkFromSegments,
  extractLiveRoom,
  parseLivePage,
  streamUrls
} = await load("services/bilibili.js")
const { deliver, cardData } = await load("handlers/card.js")
const { sendComments } = await load("handlers/comments.js")
const { DouyinApi, parseLiveInfo, parseNoteVideo } = await load("services/douyin.js")
const { deliver: deliverDouyin } = await load("handlers/douyin.js")
const { resolveVideo, resolveDouyinVideo, videoLabel } = await load("utils/video.js")
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
  // 画质与体积上限已合并成档位
  videoMode: "off",
  douyinVideo: "off",
  douyinImagesAsForward: true,
  renderCard: false,
  cardAsForward: true,
  atSender: false,
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
  assert.equal(containsBilibiliLink("https://live.bilibili.com/1852636821"), true)
  assert.equal(containsBilibiliLink("看 BV1GJ411x7h7"), true)
  assert.equal(containsBilibiliLink("av12345"), true)
  assert.equal(containsBilibiliLink("https://example.com/video/BVabc"), false)
  assert.equal(extractBvid("https://m.bilibili.com/video/bv1GJ411x7h7"), "BV1GJ411x7h7")
})

test("直播链接：直链取房号，短链展开后也能认出来", async () => {
  assert.equal(extractLiveRoom("https://live.bilibili.com/1852636821?broadcast_type=0"), "1852636821")
  assert.equal(extractLiveRoom("https://www.bilibili.com/video/BV1GJ411x7h7"), null)

  const app = new BilibiliApp(
    fakeCtxWith(async url =>
      String(url).includes("b23.tv")
        ? { status: 302, headers: { location: "https://live.bilibili.com/1852636821?broadcast_type=0" } }
        : { status: 200, headers: {} }
    )
  )
  const api = new BilibiliApi(app)

  assert.deepEqual(await api.expandTarget("https://live.bilibili.com/42"), {
    url: "https://live.bilibili.com/42",
    liveRoomId: "42"
  })
  assert.deepEqual(await api.expandTarget("https://b23.tv/PqRhc5T"), {
    url: "https://live.bilibili.com/1852636821?broadcast_type=0",
    liveRoomId: "1852636821"
  })
})

test("图文动图：只认图片里的 video 块，普通图文返回 null", () => {
  const html =
    ',"video":{"width":720,"height":960,"ratio":"720p","duration":2883,"dataSize":831861,' +
    '"uri":"v1e00fgi","playAddr":[{"src":"https://v11-weba.douyinvod.com/a.mp4?a=1\\u0026b=2"}]}'
  assert.equal(parseNoteVideo(html), "https://v11-weba.douyinvod.com/a.mp4?a=1&b=2")
  assert.equal(parseNoteVideo("<html><img src='a.jpg'></html>"), null)
})

test("直播页解析：看过、点赞、舰长", () => {
  const html =
    '"watched_show":{"switch":true,"num":1594,"text_small":"1594"},' +
    '"like_info_v3":{"total_likes":1557,"click_block":false},' +
    '"guard_info":{"count":104,"anchor_guard_achieve_level":100}'
  assert.deepEqual(parseLivePage(html), { watched: 1594, likes: 1557, guards: 104 })
  assert.deepEqual(parseLivePage("<html>nothing</html>"), { watched: 0, likes: 0, guards: 0 })
})

test("直播录制：没有流地址时直接放弃，不会去起 ffmpeg", async () => {
  const api = new BilibiliApi(new BilibiliApp(fakeCtx()))
  assert.equal(await api.recordLive({ roomId: "1", title: "", anchor: "", anchorFace: "", cover: "", popularity: 0, attention: 0, area: "", liveTime: "", watched: 0, likes: 0, guards: 0, living: true, streamUrl: "" }, 10), null)
})

test("从小程序卡片里取出链接", () => {  const segments = [
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
      bot: { platform: "onebot11", caps: new Set(forward ? ["forward", "reaction"] : []), async setReaction() {} },
      async reply(content) {
        sent.push(content)
        return { ok: true, messageId: "x", time: Date.now() }
      }
    }
  }
}

test("开总开关时，卡片与视频装在同一条转发里", async () => {
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

test("开总开关时评论图也进同一条转发，不单独再发", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  const info = await new BilibiliApi(app).parse("BV1GJ411x7h7")

  const { e, sent } = fakeEvent({ forward: true })
  await deliver(app, e, info, "/tmp/fake.mp4", { type: "image", data: "comments.png" })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, "forward")
  // 卡片、视频、评论图各一个节点
  assert.deepEqual(
    sent[0].nodes.map(node => node.message[0].type),
    ["image", "text", "video", "image"]
  )
})

test("转发失败时回落直发：卡片与视频各一条，视频不会重复发两遍", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()
  const info = await new BilibiliApi(app).parse("BV1GJ411x7h7")

  const { e, sent } = fakeEvent({ forward: true })
  e.reply = async content => {
    if (content?.type === "forward") throw new Error("send_group_forward_msg 超时")
    sent.push(content)
    return { ok: true, messageId: "x", time: Date.now() }
  }

  assert.equal(await deliver(app, e, info, "/tmp/fake.mp4"), true)
  assert.equal(sent.length, 2)
  assert.deepEqual(
    sent[0].map(segment => segment?.type),
    ["image", "text"]
  )
  assert.equal(sent[1].type, "video")
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

/** 造一条抖音作品信息；图片一律发（最多 9 张），进不进转发看 douyinImagesAsForward */
function douyinInfo(over = {}) {
  return {
    awemeId: "7412345678901234567",
    desc: "测试文案",
    author: { secUid: "SEC-1", name: "作者甲", avatar: "" },
    cover: "https://p3.douyinpic.com/c.jpg",
    duration: 45,
    createTime: 0,
    music: "",
    stat: { digg: 1, comment: 2, collect: 3, share: 4 },
    isImages: false,
    images: [],
    playUri: "",
    shareUrl: "https://www.douyin.com/video/7412345678901234567",
    ...over
  }
}

test("抖音视频作品：开总开关时卡片与视频在同一条转发", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  const { e, sent } = fakeEvent({ forward: true })
  await deliverDouyin(app, e, douyinInfo(), "/tmp/fake.mp4")

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, "forward")
  assert.deepEqual(
    sent[0].nodes.map(node => node.message[0].type),
    ["image", "video"]
  )
})

test("抖音关总开关：图片和视频仍单独合并转发，卡片直发", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  config.cardAsForward = false
  try {
    const { e, sent } = fakeEvent({ forward: true })
    const info = douyinInfo({
      isImages: true,
      duration: 0,
      images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
    })
    await deliverDouyin(app, e, info, "/tmp/fake.mp4")

    assert.equal(sent.length, 2)
    // 没渲染器，卡片回落成封面；直发时卡片裹在数组里（好塞 @）
    assert.deepEqual(
      sent[0].map(segment => segment?.type),
      ["image"]
    )
    // 图片合并开关独立生效：总开关关着也照样做成一条转发，图片、视频各一个节点
    assert.equal(sent[1].type, "forward")
    assert.deepEqual(
      sent[1].nodes.map(node => node.message[0].type),
      ["image", "image", "video"]
    )
  } finally {
    config.cardAsForward = true
  }
})

test("抖音两个开关都关：卡片、多图、视频逐条直发，一条转发都没有", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  config.cardAsForward = false
  config.douyinImagesAsForward = false
  try {
    const { e, sent } = fakeEvent({ forward: true })
    const info = douyinInfo({
      isImages: true,
      duration: 0,
      images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
    })
    await deliverDouyin(app, e, info, "/tmp/fake.mp4")

    assert.equal(sent.length, 3)
    assert.ok(!sent.some(item => item?.type === "forward"))
    assert.deepEqual(
      sent[0].map(segment => segment?.type),
      ["image"]
    )
    assert.deepEqual(
      sent[1].map(segment => segment?.type),
      ["image", "image"]
    )
    assert.equal(sent[2].type, "video")
  } finally {
    config.cardAsForward = true
    config.douyinImagesAsForward = true
  }
})

test("抖音动图两开关都开：一条总转发 = 卡片 → 图文转发（图片+视频）", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  const { e, sent } = fakeEvent({ forward: true })
  const info = douyinInfo({
    isImages: true,
    duration: 0,
    images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
  })
  await deliverDouyin(app, e, info, "/tmp/fake.mp4")

  assert.equal(sent.length, 1)
  assert.deepEqual(
    sent[0].nodes.map(node => node.message[0].type),
    ["image", "raw"]
  )
  // 第二个节点自己就是图文转发，内容直接是图片/视频消息，不再多套一层
  const inner = sent[0].nodes[1].message
  assert.deepEqual(
    inner.map(node => node.data.content[0].type),
    ["image", "image", "video"]
  )
  assert.equal(inner[2].data.content[0].data.file?.path ?? inner[2].data.content[0].data.file, "/tmp/fake.mp4")
})

test("抖音动图两开关都开且有评论：图文转发之外，评论图在总转发末尾", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  const { e, sent } = fakeEvent({ forward: true })
  const info = douyinInfo({
    isImages: true,
    duration: 0,
    images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
  })
  await deliverDouyin(app, e, info, "/tmp/fake.mp4", { type: "image", data: "comments.png" })

  assert.equal(sent.length, 1)
  assert.deepEqual(
    sent[0].nodes.map(node => node.message[0].type),
    ["image", "raw", "image"]
  )
  assert.deepEqual(
    sent[0].nodes[1].message.map(node => node.data.content[0].type),
    ["image", "image", "video"]
  )
})

test("抖音图文两开关都开且没视频：一条总转发 = 卡片 → 图文转发（图片）→ 评论图", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  const { e, sent } = fakeEvent({ forward: true })
  const info = douyinInfo({
    isImages: true,
    duration: 0,
    images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
  })
  await deliverDouyin(app, e, info, undefined, { type: "image", data: "comments.png" })

  assert.equal(sent.length, 1)
  assert.deepEqual(
    sent[0].nodes.map(node => node.message[0].type),
    ["image", "raw", "image"]
  )
  assert.deepEqual(
    sent[0].nodes[1].message.map(node => node.data.content[0].type),
    ["image", "image"]
  )
})

test("嵌套结构被平台拒绝时退回平铺，仍是一条总转发", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  const { e, sent } = fakeEvent({ forward: true })
  let attempts = 0
  e.reply = async content => {
    if (content?.type === "forward") {
      attempts++
      if (attempts === 1) throw new Error("嵌套结构不支持")
    }
    sent.push(content)
    return { ok: true, messageId: "x", time: Date.now() }
  }
  const info = douyinInfo({
    isImages: true,
    duration: 0,
    images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
  })
  await deliverDouyin(app, e, info, "/tmp/fake.mp4", { type: "image", data: "comments.png" })

  assert.equal(attempts, 2)
  assert.equal(sent.length, 1)
  assert.deepEqual(
    sent[0].nodes.map(node => node.message[0].type),
    ["image", "image", "image", "video", "image"]
  )
})

test("合并转发超时视为已送达，不再逐条补发", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  const { e, sent } = fakeEvent({ forward: true })
  let attempts = 0
  e.reply = async content => {
    if (content?.type === "forward") {
      attempts++
      throw new Error("调用 send_group_forward_msg 在 15000ms 内未收到响应")
    }
    sent.push(content)
    return { ok: true, messageId: "x", time: Date.now() }
  }
  const info = douyinInfo({
    isImages: true,
    duration: 0,
    images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
  })
  await deliverDouyin(app, e, info, "/tmp/fake.mp4")

  // 只发一条总转发；超时后不再平铺、也不再逐条直发
  assert.equal(attempts, 1)
  assert.equal(sent.length, 0)
})

test("转发被平台拒绝时降级为逐条直发", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  const { e, sent } = fakeEvent({ forward: true })
  e.reply = async content => {
    if (content?.type === "forward") throw new Error("转发不支持")
    sent.push(content)
    return { ok: true, messageId: "x", time: Date.now() }
  }
  const info = douyinInfo({
    isImages: true,
    duration: 0,
    images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
  })
  await deliverDouyin(app, e, info, "/tmp/fake.mp4")

  // 卡片、图片、视频各一条，没有转发
  assert.equal(sent.length, 3)
  assert.deepEqual(
    sent[0].map(segment => segment?.type),
    ["image"]
  )
  assert.deepEqual(
    sent[1].map(segment => segment?.type),
    ["image", "image"]
  )
  assert.equal(sent[2].type, "video")
})

test("抖音图片转发开关关掉：图片不进转发，单独发一条多图", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  config.douyinImagesAsForward = false
  try {
    const { e, sent } = fakeEvent({ forward: true })
    const info = douyinInfo({
      isImages: true,
      duration: 0,
      images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
    })
    await deliverDouyin(app, e, info, undefined, { type: "image", data: "comments.png" })

    // 外层转发只剩卡片与评论图，图片另起一条多图
    assert.equal(sent.length, 2)
    assert.equal(sent[0].type, "forward")
    assert.deepEqual(
      sent[0].nodes.map(node => node.message[0].type),
      ["image", "image"]
    )
    assert.deepEqual(
      sent[1].map(segment => segment?.type),
      ["image", "image"]
    )
  } finally {
    config.douyinImagesAsForward = true
  }
})

test("抖音图片转发关掉且没有评论：只剩卡片一个节点，不套转发，图片单独一条", async () => {
  const app = new BilibiliApp(fakeCtx())
  await app.restore()

  config.douyinImagesAsForward = false
  try {
    const { e, sent } = fakeEvent({ forward: true })
    const info = douyinInfo({
      isImages: true,
      duration: 0,
      images: ["https://p3.douyinpic.com/a.jpg", "https://p3.douyinpic.com/b.jpg"]
    })
    await deliverDouyin(app, e, info)

    assert.equal(sent.length, 2)
    assert.ok(!sent.some(item => item?.type === "forward"))
    assert.deepEqual(
      sent[0].map(segment => segment?.type),
      ["image"]
    )
    assert.deepEqual(
      sent[1].map(segment => segment?.type),
      ["image", "image"]
    )
  } finally {
    config.douyinImagesAsForward = true
  }
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

test("卡片封面按横竖比例自适应：横图限宽、竖图限高", async () => {
  const landscape = []
  const portrait = []
  for (const [bucket, width, height] of [
    [landscape, 1920, 1080],
    [portrait, 720, 1280]
  ]) {
    const ctx = fakeCtx()
    ctx.render = async (_name, data) => {
      bucket.push(data)
      throw new Error("渲染结果不重要")
    }
    const app = new BilibiliApp(ctx)
    await app.restore()
    config.renderCard = true
    try {
      const { e } = fakeEvent({ forward: false })
      await deliverDouyin(app, e, douyinInfo({ coverWidth: width, coverHeight: height }))
    } finally {
      config.renderCard = false
    }
  }

  assert.deepEqual([landscape[0].coverWidth, landscape[0].coverHeight], [320, 180])
  assert.deepEqual([portrait[0].coverWidth, portrait[0].coverHeight], [203, 360])
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

const RUNTIME_KEY = Symbol.for("yunzai-ng.video-parse.runtime")
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
  assert.ok(logs.some(line => line.includes("非哔哩哔哩域名")))
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

test("下载前预检体积：超过上限直接跳过，不会真的去下", async () => {
  const ctx = fakeCtx()
  let downloads = 0
  ctx.http = {
    ...http,
    async get(url) {
      if (url.includes("/x/player/playurl")) {
        return {
          code: 0,
          message: "0",
          data: { dash: { video: [{ id: 80, codecid: 7, codecs: "avc1.640033", backupUrl: "https://cdn/v.m4v" }], audio: [] } }
        }
      }
      throw new Error(`未预期的请求：${url}`)
    },
    async request() {
      // HEAD 说这流有 500MB，远超上限
      return { status: 200, ok: true, url: "", headers: { "content-length": String(500 * 1024 * 1024) }, data: undefined }
    },
    async download() {
      downloads++
      return "/tmp/never.mp4"
    }
  }

  const api = new BilibiliApi(new BilibiliApp(ctx))
  const file = await api.download({ bvid: "BV1GJ411x7h7", cid: 987654 }, 10)

  assert.equal(file, null)
  assert.equal(downloads, 0)
})

test("评论映射：置顶去重、表情分段、图片转 https、楼中楼只留 2 条", async () => {
  const ctx = fakeCtx()
  ctx.http = {
    ...http,
    async get(url) {
      assert.match(url, /\/x\/v2\/reply\/main/)
      assert.match(url, /mode=3/)
      assert.match(url, /oid=123/)
      const now = Math.floor(Date.now() / 1000)
      const shared = {
        rpid: 1,
        member: {
          uname: "置顶的人",
          avatar: "//i1.hdslb.com/top.jpg",
          mid: 7,
          level_info: { current_level: 6 },
          vip: { vipType: 2, vipStatus: 1 }
        },
        content: { message: "置顶评论" },
        like: 10,
        ctime: now - 61 * 86400,
        reply_control: { time_desc: "61天前发布", location: "IP属地：广东" }
      }
      return {
        code: 0,
        message: "0",
        data: {
          cursor: { all_count: 88 },
          top_replies: [shared],
          replies: [
            shared,
            {
              rpid: 2,
              member: {
                uname: "老咸鱼",
                avatar: "http://i1.hdslb.com/face.jpg",
                mid: 42,
                level_info: { current_level: 0 },
                // 开通过大会员但已过期：vipType 还在，vipStatus 为 0
                vip: { vipType: 1, vipStatus: 0 }
              },
              content: {
                message: "好耶[吃瓜]就这样",
                emote: { "[吃瓜]": { url: "http://i0.hdslb.com/e.png" } },
                pictures: [{ img_src: "http://i0.hdslb.com/p.jpg", img_width: 100, img_height: 200 }]
              },
              like: 7,
              ctime: now - 3 * 86400,
              reply_control: { time_desc: "3天前发布", location: "IP属地：四川" },
              replies: [
                {
                  rpid: 21,
                  member: { uname: "甲", avatar: "//i1.hdslb.com/a.jpg", level_info: { current_level: 3 } },
                  content: { message: "一" },
                  like: 1,
                  reply_control: { location: "IP属地：北京" }
                },
                { rpid: 22, member: { uname: "乙", avatar: "//i1.hdslb.com/b.jpg" }, content: { message: "二" }, like: 2 },
                { rpid: 23, member: { uname: "丙", avatar: "//i1.hdslb.com/c.jpg" }, content: { message: "三" }, like: 3 }
              ]
            }
          ]
        }
      }
    }
  }

  const api = new BilibiliApi(new BilibiliApp(ctx))
  const data = await api.fetchComments(123, 10, 42)

  assert.equal(data.total, 88)
  // 置顶与热评里的同一条按 rpid 去重
  assert.equal(data.items.length, 2)
  assert.equal(data.items[0].uname, "置顶的人")
  // 超过一个月的评论按 B 站的样子显示日期（如「9月17日」），不是「61天前」
  const older = new Date((Math.floor(Date.now() / 1000) - 61 * 86400) * 1000)
  assert.equal(data.items[0].time, `${older.getMonth() + 1}月${older.getDate()}日`)
  assert.equal(data.items[0].level, 6)
  // 「IP属地：」前缀要去掉，只留省份
  assert.equal(data.items[0].location, "广东")
  // 置顶这位就是 UP（mid 与传入的 42 不同，故不是）
  assert.equal(data.items[0].isUp, false)
  // 有效期内的会员才算是大会员，昵称才挂粉色、头像才有「大」标
  assert.equal(data.items[0].isVip, true)

  const second = data.items[1]
  // 表情被切成独立段，图片地址补成 https
  assert.deepEqual(second.parts, [
    { text: "好耶" },
    { emote: { url: "https://i0.hdslb.com/e.png" } },
    { text: "就这样" }
  ])
  assert.equal(second.pictures[0].url, "https://i0.hdslb.com/p.jpg")
  assert.equal(second.avatar, "https://i1.hdslb.com/face.jpg")
  // UP 主本人的评论打标
  assert.equal(second.isUp, true)
  assert.equal(second.time, "3天前")
  assert.equal(second.location, "四川")
  // 楼中楼只留 2 条
  assert.equal(second.replies.length, 2)
  assert.equal(second.replies[0].avatar, "https://i1.hdslb.com/a.jpg")
  assert.equal(second.replies[0].level, 3)
  assert.equal(second.replies[0].location, "北京")
  // 接口没给等级时为 -1（模板据此跳过徽章），不能冒充 LV0
  assert.equal(second.replies[0].isUp, false)
  assert.equal(data.items[1].level, 0)
  // vipType 还在但 vipStatus=0（已过期），不能当成会员
  assert.equal(data.items[1].isVip, false)
})

test("流地址优先用 baseUrl，备选按原顺序跟上、不重复", () => {
  // B 站给的 baseUrl 通常最稳；backupUrl 里可能有连上就断的 P2P 节点
  assert.deepEqual(streamUrls({ baseUrl: "https://a/1.m4s", backupUrl: ["https://b/1.m4s", "https://a/1.m4s"] }), [
    "https://a/1.m4s",
    "https://b/1.m4s"
  ])
  // 没有 baseUrl 时退回备选
  assert.deepEqual(streamUrls({ backupUrl: "https://b/1.m4s" }), ["https://b/1.m4s"])
  // 都没有就是空
  assert.deepEqual(streamUrls({}), [])
})

test("评论时间：昨天带时刻、两三天用「N天前」、更早给日期", async () => {
  const ctx = fakeCtx()
  // 按日历取中午 12 点，避免测试恰好在凌晨跑时「N 天前」被算成 N+1
  const at = (daysAgo, hour = 12) => {
    const d = new Date()
    d.setHours(hour, 5, 0, 0)
    d.setDate(d.getDate() - daysAgo)
    return Math.floor(d.getTime() / 1000)
  }
  const stamp = daysAgo => at(daysAgo)
  const itemsOf = async ctimes => {
    ctx.http = {
      ...http,
      async get() {
        return {
          code: 0,
          message: "0",
          data: {
            cursor: { all_count: ctimes.length },
            replies: ctimes.map((ctime, index) => ({
              rpid: index + 1,
              member: { uname: `u${index}`, mid: index + 1 },
              content: { message: "x" },
              ctime
            }))
          }
        }
      }
    }
    return (await new BilibiliApi(new BilibiliApp(ctx)).fetchComments(1, 10)).items
  }

  const items = await itemsOf([at(1), at(2), at(3), at(4), at(400), Math.floor(Date.now() / 1000) - 120])

  // 没有「1天前」：昨天要把时刻带上
  assert.equal(items[0].time, "昨天 12:05")
  assert.equal(items[1].time, "2天前")
  assert.equal(items[2].time, "3天前")
  // 超过三天换成「M月D日」
  const d = new Date(stamp(4) * 1000)
  assert.equal(items[3].time, `${d.getMonth() + 1}月${d.getDate()}日`)
  // 跨年给完整日期，不出现「400天前」
  assert.match(items[4].time, /^\d{4}-\d{2}-\d{2}$/)
  // 当天按小时
  assert.equal(items[5].time, "2分钟前")
})

test("评论参数：按时间传 mode=2、楼中楼条数可配、关掉表情就保留原文", async () => {
  const ctx = fakeCtx()
  const urls = []
  const build = options => {
    ctx.http = {
      ...http,
      async get(url) {
        urls.push(url)
        return {
          code: 0,
          message: "0",
          data: {
            cursor: { all_count: 1 },
            replies: [
              {
                rpid: 1,
                member: { uname: "甲", mid: 1 },
                content: { message: "好耶[吃瓜]就这样", emote: { "[吃瓜]": { url: "//i0.hdslb.com/e.png" } } },
                like: 5,
                ctime: Math.floor(Date.now() / 1000),
                replies: [
                  { rpid: 11, member: { uname: "乙", mid: 2 }, content: { message: "一" } },
                  { rpid: 12, member: { uname: "丙", mid: 3 }, content: { message: "二" } }
                ]
              }
            ]
          }
        }
      }
    }
    return new BilibiliApi(new BilibiliApp(ctx))
  }

  const hot = await build().fetchComments(1, 5, undefined, { sort: "hot" })
  assert.match(urls.at(-1), /mode=3/)
  const time = await build().fetchComments(1, 5, undefined, { sort: "time", replyLimit: 0, emote: false })
  assert.match(urls.at(-1), /mode=2/)

  // 排序不影响内容解析，这里用 time 那次的结果看条数与表情
  assert.equal(time.items[0].replies.length, 0)
  assert.deepEqual(time.items[0].parts, [{ text: "好耶[吃瓜]就这样" }])
  assert.equal(hot.items[0].replies.length, 2)
  assert.deepEqual(hot.items[0].parts, [
    { text: "好耶" },
    { emote: { url: "https://i0.hdslb.com/e.png" } },
    { text: "就这样" }
  ])
})

test("点赞门槛把评论全过滤掉时不发图", async () => {
  const ctx = fakeCtx()
  ctx.config.get = () => ({ ...config, commentMinLike: 999 })
  ctx.http = {
    ...http,
    async get() {
      return {
        code: 0,
        message: "0",
        data: {
          cursor: { all_count: 1 },
          replies: [{ rpid: 1, member: { uname: "甲", mid: 1 }, content: { message: "低赞" }, like: 1, ctime: 1700000000 }]
        }
      }
    }
  }

  const app = new BilibiliApp(ctx)
  const replies = []
  let rendered = 0
  ctx.render = async () => {
    rendered += 1
    throw new Error("不该渲染")
  }
  const e = { async reply(content) { replies.push(content) } }

  await sendComments(app, new BilibiliApi(app), e, { aid: 1, owner: { mid: 2 } })
  assert.equal(rendered, 0)
  assert.equal(replies.length, 0)
})

test("视频档位：画质与体积上限合成一项，不下载/未知值都不下视频", () => {
  // 每档都自带画质与上限，下游拿到的仍是两个参数
  assert.deepEqual(resolveVideo("1080p"), { quality: "1080p", maxMB: 250 })
  assert.deepEqual(resolveVideo("4k"), { quality: "4k", maxMB: 800 })
  assert.deepEqual(resolveVideo("auto"), { quality: "auto", maxMB: 250 })
  // 不下载、没配、写错的值都当「不下载」，免得配置写错时突然开始下大文件
  assert.equal(resolveVideo("off"), null)
  assert.equal(resolveVideo(undefined), null)
  assert.equal(resolveVideo("1080P"), null)

  assert.deepEqual(resolveDouyinVideo("720p"), { quality: "720p", maxMB: 200 })
  assert.equal(resolveDouyinVideo("4k"), null)
  assert.equal(resolveDouyinVideo("off"), null)

  assert.equal(videoLabel("1080p60"), "1080P60")
  assert.equal(videoLabel(undefined), "不下载")
})

test("抖音链接识别：短链、作品页、分享口令、裸 id 都要认，B 站链接不能误判", () => {
  assert.deepEqual(DouyinApi.extractTarget("https://v.douyin.com/iRNBho6u/"), {
    kind: "short",
    value: "https://v.douyin.com/iRNBho6u"
  })
  assert.deepEqual(DouyinApi.extractTarget("https://www.douyin.com/video/7675505205047348543"), {
    kind: "id",
    value: "7675505205047348543"
  })
  // 分享口令：正文里夹着短链
  const command = "7.43 复制打开抖音，看看【某某的作品】 https://v.douyin.com/abcDEF/ 挺好玩"
  assert.equal(DouyinApi.extractTarget(command)?.kind, "short")
  assert.equal(DouyinApi.extractTarget("7675505205047348543")?.value, "7675505205047348543")
  // B 站链接与普通数字都不能误判
  assert.equal(DouyinApi.extractTarget("https://www.bilibili.com/video/BV1xx"), null)
  assert.equal(DouyinApi.extractTarget("今天花了 1234 块钱"), null)
})

test("抖音短链展开：直播间要认成 live，作品仍认成 aweme", async () => {
  const app = new BilibiliApp(
    fakeCtxWith(async url => ({
      status: 302,
      headers: {
        location: String(url).includes("QYOfTf0fCkY")
          ? "https://webcast.amemv.com/douyin/webcast/reflow/7709358600975665955?from=share"
          : "https://www.iesdouyin.com/share/video/7675505205047348543/"
      }
    }))
  )
  const api = new DouyinApi(app)

  assert.deepEqual(await api.resolveShort("https://v.douyin.com/QYOfTf0fCkY"), {
    kind: "live",
    roomId: "7709358600975665955",
    url: "https://webcast.amemv.com/douyin/webcast/reflow/7709358600975665955"
  })
  assert.deepEqual(await api.resolveShort("https://v.douyin.com/iRNBho6u"), {
    kind: "aweme",
    id: "7675505205047348543"
  })
})

test("直播页解析：取主播、标题、开播状态与流地址，页面改版时返回 null", () => {
  const html =
    '<div class="living-kRK7Xz">直播中</div>' +
    '<div class="bottom-username-Z2X5NY">@<!-- -->未婉呀<!-- --> </div>' +
    '<div class="bottom-title-GnuDoj">颜值直播 &amp; 画画</div>' +
    '<script>{"stats":{"totalUser":592,"userCountStr":"88","likeCount":0,"followCount":4},"owner":{"followInfo":{"followerCount":345}},"likeCount":768,"createTime":1794974942,"finishTime":1794985027,"roomViewStats":{"displayValue":1023}}</script>' +
    '<webcast-reflow-player cover="https://p11-webcast.douyinpic.com/cover.jpg?x=1&amp;y=2" url="http://pull-hs-f5.flive.douyincdn.com/stage/stream-1_or4.flv?expire=1&amp;sign=abc"></webcast-reflow-player>'
  assert.deepEqual(parseLiveInfo(html), {
    nickname: "未婉呀",
    title: "颜值直播 & 画画",
    cover: "https://p11-webcast.douyinpic.com/cover.jpg?x=1&y=2",
    online: 88,
    totalViewers: 1023,
    followers: 345,
    likes: 768,
    newFollowers: 4,
    startedAt: 1794974942,
    finishedAt: 1794985027,
    living: true,
    streamUrl: "http://pull-hs-f5.flive.douyincdn.com/stage/stream-1_or4.flv?expire=1&sign=abc"
  })
  assert.equal(parseLiveInfo("<html>nothing</html>"), null)
})

test("直播录制：没有流地址时直接放弃，不会去起 ffmpeg", async () => {
  const api = new DouyinApi(new BilibiliApp(fakeCtx()))
  assert.equal(await api.recordLive({ roomId: "1", nickname: "", title: "", cover: "", online: 0, totalViewers: 0, followers: 0, likes: 0, newFollowers: 0, startedAt: 0, finishedAt: 0, living: true, streamUrl: "" }, 10), null)
})

test("抖音解析：从分享页的 _ROUTER_DATA 里取作品信息", async () => {
  const ctx = fakeCtx()
  const aweme = {
    aweme_id: "7675505205047348543",
    desc: "测试文案",
    create_time: 1763000000,
    author: { nickname: "作者甲", avatar_thumb: { url_list: ["//p3.douyinpic.com/a.jpg"] } },
    video: {
      duration: 1502000,
      cover: { url_list: ["http://p9.douyinpic.com/c.jpg"] },
      play_addr: { uri: "v0300fg10000da2dm17og65slqbqs490" }
    },
    statistics: { digg_count: 63806, comment_count: 2070, collect_count: 18334, share_count: 5868 },
    music: { title: "原声" }
  }
  // 两种形态都覆盖：这里用 JSON.parse("...") 包一层的那种
  const html = `<script>window._ROUTER_DATA = JSON.parse(${JSON.stringify(JSON.stringify({ loaderData: { page: { data: aweme } } }))})</script>`

  ctx.http = {
    async request(url) {
      if (url.includes("ttwid")) {
        return { status: 200, headers: { "set-cookie": ["ttwid=abc123; Path=/"] }, data: null }
      }
      return { status: 200, headers: {}, data: html }
    },
    async download() {
      throw new Error("不该下载")
    }
  }

  const info = await new DouyinApi(new BilibiliApp(ctx)).fetchInfo("7675505205047348543")
  assert.equal(info?.awemeId, "7675505205047348543")
  assert.equal(info?.desc, "测试文案")
  assert.equal(info?.author.name, "作者甲")
  assert.equal(info?.author.avatar, "https://p3.douyinpic.com/a.jpg")
  assert.equal(info?.cover, "https://p9.douyinpic.com/c.jpg")
  assert.equal(info?.duration, 1502)
  assert.equal(info?.stat.digg, 63806)
  assert.equal(info?.playUri, "v0300fg10000da2dm17og65slqbqs490")
  assert.equal(info?.isImages, false)
})

test("抖音评论：内嵌回复取多条、作者标命中且排最前、楼中楼接口空体不拖慢", async () => {
  const ctx = fakeCtx()
  const now = Math.floor(Date.now() / 1000)
  const comments = [
    {
      cid: "111",
      text: "普通人的评论[看]",
      digg_count: 5,
      create_time: now - 120,
      ip_label: "广东",
      user: { sec_uid: "SEC-OTHER", nickname: "路人", avatar_thumb: { url_list: ["//p3.douyinpic.com/a.jpg"] } },
      reply_comment_total: 30,
      // 主列表里内嵌了 2 条：以前只取第 1 条，现在两条都要
      reply_comment: [
        {
          text: "第一条回复",
          digg_count: 2,
          create_time: now - 60,
          ip_label: "四川",
          // 直接回复主评论：抖音原版不画箭头
          reply_to_username: "路人",
          user: { sec_uid: "SEC-A", nickname: "回复甲" }
        },
        {
          text: "第二条回复",
          digg_count: 0,
          create_time: now - 30,
          ip_label: "北京",
          // 回复的是楼中楼里的另一个人：带箭头
          reply_to_username: "回复甲",
          reply_to_reply_id: "999",
          user: { sec_uid: "SEC-B", nickname: "回复乙" }
        }
      ]
    },
    {
      cid: "222",
      text: "作者的话",
      digg_count: 99,
      create_time: now - 300,
      ip_label: "浙江",
      user: { sec_uid: "SEC-AUTHOR", nickname: "作者甲", avatar_thumb: { url_list: ["//p3.douyinpic.com/b.jpg"] } },
      reply_comment_total: 0
    }
  ]

  let replyCalls = 0
  ctx.http = {
    async request(url) {
      if (url.includes("ttwid")) return { status: 200, headers: { "set-cookie": ["ttwid=abc; Path=/"] }, data: null }
      if (url.includes("emoji/list")) {
        return { status: 200, headers: {}, data: { emoji_list: [{ display_name: "[看]", emoji_url: { url_list: ["//p3.douyinpic.com/e.png"] } }] } }
      }
      if (url.includes("comment/list/reply")) {
        // 抖音对非登录请求的楼中楼接口就是 200 + 空体
        replyCalls += 1
        return { status: 200, headers: {}, data: {} }
      }
      if (url.includes("comment/list")) return { status: 200, headers: {}, data: { comments, total: 2 } }
      return { status: 200, headers: {}, data: {} }
    },
    async download() {
      throw new Error("不该下载")
    }
  }

  const data = await new DouyinApi(new BilibiliApp(ctx)).fetchComments("7675505205047348543", 10, "SEC-AUTHOR")
  assert.equal(data.items.length, 2)

  // 作者本人的评论排最前，并带「作者」标
  assert.equal(data.items[0].nickname, "作者甲")
  assert.equal(data.items[0].isAuthor, true)
  assert.equal(data.items[1].isAuthor, false)

  const plain = data.items[1]
  // 内嵌回复两条都要
  assert.equal(plain.replies.length, 2)
  assert.equal(plain.replies[0].nickname, "回复甲")
  // 直接回复主评论：不带「▶ 某人」
  assert.equal(plain.replies[0].replyTo, "")
  // 回复楼中楼里的另一个人：才带
  assert.equal(plain.replies[1].replyTo, "回复甲")
  assert.equal(plain.replies[1].location, "北京")
  // 回复总数用于「展开 N 条回复」
  assert.equal(plain.replyTotal, 30)
  // 表情按标签换成图
  assert.deepEqual(plain.parts, [{ text: "普通人的评论" }, { emote: { url: "https://p3.douyinpic.com/e.png" } }])

  // 楼中楼接口返回空体后应立刻放弃，不逐条重试
  assert.equal(replyCalls, 1)
})

test("填了抖音 Cookie 就带上，换行会被清洗成一行", async () => {
  const ctx = fakeCtx()
  const seen = []
  // 浏览器里复制出来的整段常带换行
  ctx.config.get = () => ({ ...config, douyinCookie: "sessionid=abc123;\n  uid_tt=xyz;\n odin_tt=q" })
  ctx.http = {
    async request(url, options) {
      seen.push({ url, cookie: options?.headers?.Cookie ?? "" })
      if (url.includes("ttwid")) return { status: 200, headers: { "set-cookie": ["ttwid=anon; Path=/"] }, data: null }
      if (url.includes("comment/list")) return { status: 200, headers: {}, data: { comments: [], total: 0 } }
      return { status: 200, headers: {}, data: {} }
    },
    async download() {
      throw new Error("不该下载")
    }
  }

  await new DouyinApi(new BilibiliApp(ctx)).fetchComments("7675505205047348543", 5)

  const comment = seen.find(item => item.url.includes("comment/list"))
  assert.ok(comment !== undefined)
  // 一行，没有换行；匿名 ttwid 排在前面垫底
  assert.ok(!comment.cookie.includes("\n"))
  assert.match(comment.cookie, /sessionid=abc123/)
  assert.match(comment.cookie, /uid_tt=xyz/)
  assert.match(comment.cookie, /^ttwid=anon;/)
})

test("条数设成 0 时不请求评论，也不发评论图", async () => {
  const ctx = fakeCtx()
  ctx.config.get = () => ({ ...config, commentCount: 0 })
  let requests = 0
  ctx.http = {
    ...http,
    async get() {
      requests++
      throw new Error("不该请求评论")
    }
  }

  const app = new BilibiliApp(ctx)
  const api = new BilibiliApi(app)
  const replies = []
  const e = { async reply(content) { replies.push(content) } }

  await sendComments(app, api, e, { aid: 1, owner: { mid: 2 } })
  assert.equal(requests, 0)
  assert.equal(replies.length, 0)
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
