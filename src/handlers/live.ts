/**
 * 模块职责：直播卡片 —— 把直播间信息渲染成一张卡，并决定怎么发（转发 / 直发）
 * 依赖方向：依赖 app、types、utils/format，消息段来自内核的 `seg`
 * 生命周期：纯函数 + 一次渲染调用
 * 注意事项：直播没有「作品」可贴，卡片就是全部信息；不额外发「信息 + 链接」的
 *          文字消息。渲染器不可用时只发封面，标题等信息宁缺毋滥。
 */
import { seg } from "@yunzai-ng/core"
import type { ForwardNode, MessageEvent, Segment } from "@yunzai-ng/types"
import type { BilibiliApp } from "../core/app.js"
import type { BilibiliLiveInfo } from "../types.js"
import type { DouyinLiveInfo } from "../types/douyin.js"
import { formatCount } from "../utils/format.js"
import { splitForForward } from "./card.js"

/** 直播卡片渲染结果 */
interface LiveCardView {
  /** 模板名 */
  template: string
  /** 模板变量 */
  data: Record<string, unknown>
  /** 渲染失败时的文字说明（不含链接） */
  fallbackText: string
  /** 合并转发的摘要 */
  summary: string
}

/**
 * 取开播时刻
 * @param raw 接口返回的 `live_time`，形如 `2026-11-18 15:11:12`
 * @returns `15:11`；取不到为空串
 */
function clockOf(raw: string): string {
  return raw.match(/\d{2}:\d{2}/)?.[0] ?? ""
}

/**
 * 分钟数转中文时长
 * @param minutes 分钟数
 * @returns 形如 `1 小时 5 分`
 */
function humanizeMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
}

/**
 * 算已播时长
 * @param raw 接口返回的 `live_time`
 * @returns 形如 `1 小时 5 分`；时间不合法为空串
 */
function elapsedOf(raw: string): string {
  const started = Date.parse(raw.replace(" ", "T") + "+08:00")
  if (!Number.isFinite(started)) return ""
  return humanizeMinutes(Math.max(0, Math.floor((Date.now() - started) / 60_000)))
}

/**
 * 秒级时间戳转 `HH:MM`
 * @param seconds 秒级时间戳
 * @returns 形如 `15:11`；时间不合法为空串
 */
function clockOfUnix(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  const date = new Date(seconds * 1000)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/**
 * 用开播/下播时间算已播时长
 * @param startedAt 开播时间戳（秒）
 * @param finishedAt 下播时间戳（秒），还在播传 0
 * @returns 形如 `1 小时 5 分`；没有开播时间为空串
 */
function lengthOf(startedAt: number, finishedAt: number): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return ""
  const ended = finishedAt > 0 ? finishedAt * 1000 : Date.now()
  return humanizeMinutes(Math.max(0, Math.floor((ended - startedAt * 1000) / 60_000)))
}

/**
 * 组装 B 站直播卡片数据
 * @param info 直播间信息
 * @returns 模板名、变量与回落文案
 */
function bilibiliView(info: BilibiliLiveInfo): LiveCardView {
  const who = info.anchor === "" ? "哔哩哔哩主播" : info.anchor
  const title = info.title === "" ? `${who}的直播间` : info.title
  const started = clockOf(info.liveTime)
  const elapsed = info.living ? elapsedOf(info.liveTime) : ""
  const desc = [
    started === "" ? "" : `开播于 ${started}`,
    elapsed === "" ? "" : `已播 ${elapsed}`
  ].filter(part => part !== "").join(" · ")
  return {
    template: "bilibili-live-card",
    data: {
      cover: info.cover,
      status: info.living ? "直播中" : "已下播",
      title,
      desc,
      ownerName: who,
      ownerFace: info.anchorFace,
      area: info.area,
      popularity: formatCount(info.popularity),
      watched: info.watched === 0 ? "" : formatCount(info.watched),
      likes: info.likes === 0 ? "" : formatCount(info.likes),
      attention: info.attention === 0 ? "" : formatCount(info.attention),
      guards: info.guards === 0 ? "" : formatCount(info.guards),
      roomId: info.roomId,
      url: `https://live.bilibili.com/${info.roomId}`
    },
    fallbackText: `${title}\n${who}`,
    summary: `直播：${title}`
  }
}

/**
 * 组装抖音直播卡片数据
 * @param info 直播间信息
 * @param shareUrl 用户发的那条分享链接
 * @returns 模板名、变量与回落文案
 */
function douyinView(info: DouyinLiveInfo, shareUrl: string): LiveCardView {
  const who = info.nickname === "" ? "抖音主播" : info.nickname
  const title = info.title === "" ? `${who}的直播间` : info.title
  const started = clockOfUnix(info.startedAt)
  const elapsed = lengthOf(info.startedAt, info.finishedAt)
  const timeDesc = [
    started === "" ? "" : `开播于 ${started}`,
    elapsed === "" ? "" : `已播 ${elapsed}`
  ].filter(part => part !== "").join(" · ")
  return {
    template: "douyin-live-card",
    data: {
      cover: info.cover,
      status: info.living ? "直播中" : "已下播",
      desc: title,
      timeDesc,
      author: who,
      avatar: info.cover,
      online: info.online === 0 ? "" : formatCount(info.online),
      totalViewers: info.totalViewers === 0 ? "" : formatCount(info.totalViewers),
      followers: info.followers === 0 ? "" : formatCount(info.followers),
      likes: info.likes === 0 ? "" : formatCount(info.likes),
      newFollowers: info.newFollowers === 0 ? "" : formatCount(info.newFollowers),
      roomId: info.roomId,
      url: shareUrl === "" ? `https://live.douyin.com/${info.roomId}` : shareUrl
    },
    fallbackText: `${title}\n${who}`,
    summary: `直播：${title}`
  }
}

/**
 * 渲染直播卡片
 * @param app 运行期状态
 * @param view 卡片数据
 * @returns 图片段；渲染器不可用或模板出错为 null
 */
async function renderLiveCard(app: BilibiliApp, view: LiveCardView): Promise<Segment | null> {
  try {
    const image = await app.ctx.render(view.template, view.data, {
      selector: "#card",
      // 与作品卡片一致：纯色背景用 jpeg，体积小、编码快
      type: "jpeg",
      quality: 90,
      viewport: { width: 760, scale: 2 }
    })
    return Array.isArray(image) ? (image[0] ?? null) : image
  } catch (error) {
    app.debug("直播卡片渲染失败，回落为封面", error)
    return null
  }
}

/**
 * 渲染直播卡片
 *
 * 从取信息到出图只依赖直播间数据，故可以比录制先跑：调用方拿到信息后立刻起这个任务，
 * 再去录片段，两秒的渲染时间就藏在录制的十几秒里。
 * @param app 运行期状态
 * @param platform 平台
 * @param info 直播间信息
 * @param shareUrl 抖音原分享链接
 * @returns 图片段；关闭渲染或渲染失败为 null
 */
export async function buildLiveCard(
  app: BilibiliApp,
  platform: "bilibili" | "douyin",
  info: BilibiliLiveInfo | DouyinLiveInfo,
  shareUrl = ""
): Promise<Segment | null> {
  const view = platform === "bilibili" ? bilibiliView(info as BilibiliLiveInfo) : douyinView(info as DouyinLiveInfo, shareUrl)
  // 抖音没有「渲染卡片」开关，始终出卡；B 站跟随该开关，关掉时只发封面
  if (platform !== "douyin" && !app.config.renderCard) return null
  return renderLiveCard(app, view)
}

/**
 * 发一条直播结果
 *
 * 和作品卡片同一套投递规则：总开关开着且平台支持转发时，卡片与录制片段装进一条
 * 转发；否则先发卡片、再发视频。没有录制片段时就只发卡片。
 * @param app 运行期状态
 * @param e 消息事件
 * @param info 直播间信息
 * @param platform 平台
 * @param videoFile 录制好的片段，可无
 * @param shareUrl 抖音原分享链接
 * @param cardTask 已经起好的卡片渲染任务，可无；不传则在这里现渲染
 * @returns 是否至少成功送出一条消息
 */
export async function deliverLive(
  app: BilibiliApp,
  e: MessageEvent,
  info: BilibiliLiveInfo | DouyinLiveInfo,
  platform: "bilibili" | "douyin",
  videoFile?: string,
  shareUrl = "",
  cardTask?: Promise<Segment | null>
): Promise<boolean> {
  const view = platform === "bilibili" ? bilibiliView(info as BilibiliLiveInfo) : douyinView(info as DouyinLiveInfo, shareUrl)
  const card = cardTask === undefined ? await buildLiveCard(app, platform, info, shareUrl) : await cardTask
  const infoSegments: Segment[] =
    card !== null ? [card] : info.cover === "" ? [seg.text(view.fallbackText)] : [seg.image(info.cover), seg.text(view.fallbackText)]

  const canForward = e.isGroup && app.config.cardAsForward && e.bot.caps.has("forward")
  if (canForward && videoFile !== undefined) {
    const split = splitForForward(infoSegments)
    const nodes: ForwardNode[] = []
    if (split.cover !== undefined) nodes.push(seg.node(split.cover, { name: "直播", uid: e.selfId }))
    if (split.text !== undefined) nodes.push(seg.node(split.text, { name: "直播", uid: e.selfId }))
    nodes.push(seg.node([seg.video(videoFile)], { name: "直播", uid: e.selfId }))
    try {
      await e.reply(seg.forward(nodes, { summary: view.summary.slice(0, 48) }))
      return true
    } catch (error) {
      app.log("warn", "直播合并转发发送失败，改为直接发送", error)
    }
  }

  // @ 只在直发时贴：和作品卡片一致，转发节点里 @ 不出来
  const at = app.config.atSender ? [seg.at(e.sender.uid), seg.text(" ")] : []
  try {
    await e.reply([...at, ...infoSegments])
  } catch (error) {
    app.log("error", "直播卡片发送失败", error)
    return false
  }

  if (videoFile !== undefined) {
    try {
      await e.reply(seg.video(videoFile))
    } catch (error) {
      app.log("warn", "直播片段发送失败", error)
    }
  }
  return true
}
