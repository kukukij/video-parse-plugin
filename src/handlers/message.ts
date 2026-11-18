/**
 * 模块职责：自动解析 —— 群里有人贴 B 站链接就出卡片
 * 依赖方向：依赖 app、services/bilibili、handlers/card
 * 生命周期：随插件注册，卸载时由内核回收
 * 注意事项：这里用**中间件**而不是命令，是刻意的：
 *
 *          - 命令要前缀，而贴链接的人不会先打 `#bili`；
 *          - `ctx.on("message")` 在内核里是「命令路由之后」的通知，那时别的插件已经
 *            各自处理过一轮，抢不到"先手"，也无法阻断重复解析。
 *
 *          代价是中间件挡在所有命令前面，故每一步都先做最便宜的判断（开关、场景、
 *          前缀、有没有链接），再碰网络。
 */
import type { Disposer, MessageEvent } from "@yunzai-ng/types"
import type { BilibiliApp } from "../core/app.js"
import { cleanupFile, containsBilibiliLink, extractLinkFromSegments, type BilibiliApi } from "../services/bilibili.js"
import { resolveVideo } from "../utils/video.js"
import { deliver, react } from "./card.js"
import { buildCommentsImage } from "./comments.js"
import { deliverLive } from "./live.js"

/** 自动解析的中间件优先级：比默认的 100 靠里，让改写类中间件先跑 */
const PRIORITY = 200

/**
 * 注册自动解析中间件
 * @param app 运行期状态
 * @param api B 站接口
 * @returns 注销句柄
 */
export function registerAutoParse(app: BilibiliApp, api: BilibiliApi): Disposer {
  return app.ctx.middleware(
    async (e, next) => {
      if (e.kind !== "message") return next()
      if (app.config.biliEnabled === false) return next()
      if (!shouldConsider(app, e)) return next()

      try {
        const handled = await tryParse(app, api, e)
        // 解析成功就不再往下走：同一条消息交给别的插件再解析一遍，群里会出两份。
        //
        // 这里显式 `e.stop()`，而不是「什么都不做直接 return」：两种写法效果一样，
        // 但后者内核会在 trace 里记一句「中间件未调用 next()，事件到此中断」，日志
        // 文件按设计记全量，于是每解析一条就多一行，看着像报错。`stop()` 是内核
        // 认可的「这条我收了」，不产生那行噪音，也不影响后续中间件的语义。
        if (handled) {
          e.stop()
          return
        }
      } catch (error) {
        // 中间件抛错会打断整条管线，连命令都轮不到；这里兜住，把问题留在日志里
        app.log("error", "自动解析异常", error)
      }
      return next()
    },
    { kind: "message", priority: PRIORITY }
  )
}

/**
 * 这条消息值不值得进入解析流程（纯内存判断，不碰网络）
 * @param app 运行期状态
 * @param e 消息事件
 * @returns 值得则为真
 */
function shouldConsider(app: BilibiliApp, e: MessageEvent): boolean {
  // 频道暂不支持：段模型能表达，但 B 站卡片的分页与视频上传在频道语义下对不上
  if (e.scene === "guild") return false
  if (e.scene === "private" && !app.config.parseInPrivate) return false

  const text = e.text
  for (const prefix of app.config.ignorePrefixes ?? []) {
    if (prefix !== "" && text.startsWith(prefix)) return false
  }

  // 小程序卡片正文里没有链接，只有 json 段，故两种来源都要看
  return containsBilibiliLink(text) || extractLinkFromSegments(e.message) !== null
}

/**
 * 解析并发送
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 消息事件
 * @returns 是否已处理（失败也算"处理过"，以免同一插件再试一遍）
 */
export async function tryParse(app: BilibiliApp, api: BilibiliApi, e: MessageEvent): Promise<boolean> {
  const target = extractLinkFromSegments(e.message) ?? e.text
  const gid = e.group?.gid ?? `private:${e.sender.uid}`

  // 黑名单里的群直接放行给后续插件：既不解析，也不把消息吞掉
  if (e.isGroup && e.group !== undefined && !app.isGroupEnabled(e.group.gid)) return false

  if (app.config.parseCacheTTL > 0) {
    const videoId = await api.extractVideoId(target)
    if (videoId !== null && app.inCooldown(gid, videoId)) {
      app.debug(`群 ${gid} 里 ${videoId} 还在冷却中，跳过`)
      return true
    }
  }

  return runParse(app, api, e, target, gid)
}

/**
 * 真正跑一次解析并投递
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 消息事件
 * @param target 待解析的文本或链接
 * @param gid 群号（私聊时为 `private:<uid>`）
 * @returns 是否已处理
 */
async function runParse(
  app: BilibiliApp,
  api: BilibiliApi,
  e: MessageEvent,
  target: string,
  gid: string
): Promise<boolean> {
  const startedAt = Date.now()

  // 直播间没有 BV 号，`parse` 认不出来；先把短链展开这一次，后面的 `parse` 直接用结果
  const expanded = await api.expandTarget(target)
  if (expanded.liveRoomId !== null) {
    return handleLive(app, api, e, expanded.liveRoomId, gid)
  }

  await react(e, "10024")

  const info = await api.parse(expanded.url)
  if (info === null) {
    app.debug("链接存在但解析失败，静默跳过")
    return true
  }

  app.debug(`解析成功 ${info.bvid}，耗时 ${Date.now() - startedAt}ms`)

  let videoFile: string | undefined
  // 档位里已经带上了体积上限，选「不下载」时为 null
  const profile = resolveVideo(app.config.videoMode)
  if (profile !== null) {
    const file = await api.download(info, profile.maxMB)
    if (file !== null) videoFile = file
    else app.log("warn", `视频未下载，仅发送信息：${info.bvid}`)
  }

  // 评论图先备好：转发开启时它是转发里的一个节点（聊天记录），关闭时 deliver 单独发
  const commentsImage = await buildCommentsImage(app, api, e, info)

  const sent = await deliver(app, e, info, videoFile, commentsImage)
  if (sent) {
    await app.markParsed({ bvid: info.bvid, title: info.title, gid, group: e.group?.name })
    app.touchCooldown(gid, info.bvid)
    await react(e, "124")
  }

  if (videoFile !== undefined) {
    // 发送接口返回时文件已被平台读完，但 QQ 侧可能仍在转码；留一分钟再删更稳妥
    app.later(() => void cleanupFile(app, videoFile), 60_000)
  }

  return true
}

/**
 * 处理直播间链接
 *
 * 直播没有「作品」，先按 `liveRecord` 录一小段，再把直播卡片和片段一起发出去；
 * 下播的房间只发卡片。不额外发「信息 + 链接」的文字消息。
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 消息事件
 * @param roomId 直播间号
 * @param gid 群号（私聊时为 `private:<uid>`）
 * @returns 恒为 true：直播消息由本插件收掉
 */
async function handleLive(
  app: BilibiliApp,
  api: BilibiliApi,
  e: MessageEvent,
  roomId: string,
  gid: string
): Promise<boolean> {
  const key = `live:${roomId}`
  if (app.inCooldown(gid, key)) {
    app.debug(`群 ${gid} 里直播间 ${roomId} 还在冷却中，跳过`)
    return true
  }

  const startedAt = Date.now()
  await react(e, "10024")

  const info = await api.fetchLiveInfo(roomId)
  if (info === null) {
    app.debug(`直播间 ${roomId} 信息拉取失败，静默跳过`)
    return true
  }

  const seconds = Math.max(0, Math.min(60, Number(app.config.liveRecord ?? 0)))
  let videoFile: string | undefined
  if (info.living && seconds > 0) {
    const file = await api.recordLive(info, seconds)
    if (file !== null) videoFile = file
  }

  const sent = await deliverLive(app, e, info, "bilibili", videoFile)
  if (sent) {
    app.touchCooldown(gid, key)
    await react(e, "124")
  }

  if (videoFile !== undefined) {
    app.later(() => void cleanupFile(app, videoFile), 60_000)
  }
  app.debug(`直播间 ${roomId} 已处理，耗时 ${Date.now() - startedAt}ms`)
  return true
}
