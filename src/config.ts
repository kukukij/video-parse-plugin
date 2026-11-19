/**
 * 模块职责：配置 schema —— 一份声明同时产出校验、`config/video-parse.yaml` 与面板表单
 * 依赖方向：依赖 @yunzai-ng/core 的 `s`（schema 工厂）与本地类型
 * 生命周期：模块加载期构造一次，之后不可变
 * 注意事项：**凭据不在这里**。面板的 `GET /api/config/:name` 刻意不脱敏，任何写进
 *          config.yaml 的东西都等于摊在面板上；SESSDATA 一旦泄漏等同于把账号交出去，
 *          故凭据单独加密存于插件数据目录（见 services/credential.ts）。
 *          分组按首次出现排序：平台组在前，`设置` 放最后。
 */
import { s, type Infer } from "@yunzai-ng/core"

/** 插件配置的 schema；`ctx.config.get()` 的类型由它推导 */
export const configSchema = s.object({
  biliEnabled: s
    .boolean()
    .default(true)
    .title("解析开关")
    .desc("关掉后不响应哔哩哔哩链接")
    .group("哔哩哔哩")
    .order(10),

  videoMode: s
    .enum(["off", "auto", "480p", "720p", "1080p", "1080p60", "4k"], {
      off: "不下载（只发卡片）",
      auto: "自动（最高画质，≤200MB）",
      "480p": "480P（≤40MB）",
      "720p": "720P（≤80MB）",
      "1080p": "1080P（≤150MB）",
      "1080p60": "1080P60（≤300MB）",
      "4k": "4K（≤500MB）"
    })
    .default("off")
    .title("视频下载")
    .desc("画质与体积上限合并为一档，超出上限只发卡片")
    .group("哔哩哔哩")
    .order(20),

  liveRecord: s
    .number()
    .int()
    .min(0)
    .max(60)
    .default(10)
    .title("直播录制时长（秒）")
    .desc("直播链接录这么久再发视频；0 = 只发直播卡片")
    .group("哔哩哔哩")
    .order(30),

  douyinEnabled: s
    .boolean()
    .default(true)
    .title("解析开关")
    .desc("关掉后不响应抖音链接")
    .group("抖音")
    .order(10),

  douyinVideo: s
    .enum(["off", "540p", "720p", "1080p"], {
      off: "不下载（只发卡片）",
      "540p": "540P（≤60MB）",
      "720p": "720P（≤120MB）",
      "1080p": "1080P（≤250MB）"
    })
    .default("off")
    .title("视频下载")
    .desc("画质与体积上限合并为一档，超出上限只发卡片")
    .group("抖音")
    .order(20),

  douyinImagesAsForward: s
    .boolean()
    .default(true)
    .title("图文图片合并转发")
    .desc("开：图片做成合并转发（一条消息一张图）；合并转发也开时，图片/视频做成总转发里的图文转发")
    .group("抖音")
    .order(40),

  douyinNoteVideo: s
    .boolean()
    .default(false)
    .title("图文动图发视频")
    .desc("用 Cookie 取动图原视频，约 1–2 秒；失败仍发静态图")
    .group("抖音")
    .order(42),

  douyinLiveRecord: s
    .number()
    .int()
    .min(0)
    .max(60)
    .default(10)
    .title("直播录制时长（秒）")
    .desc("直播链接录这么久再发视频；0 = 只发直播卡片")
    .group("抖音")
    .order(45),

  douyinCookie: s
    .string()
    .default("")
    .widget("textarea")
    .title("抖音 Cookie（可选）")
    .desc("可选，不填也能解析；面板扫码或 #dy登录 会自动填写，填了才能出楼中楼、取动图原视频")
    .group("抖音")
    .order(50),

  commentSend: s
    .boolean()
    .default(true)
    .title("发送评论图")
    .desc("两个平台共用；关掉后完全不请求评论")
    .group("评论")
    .order(10),

  commentCount: s
    .number()
    .int()
    .min(0)
    .max(20)
    .default(10)
    .title("显示条数")
    .desc("每张评论图最多几条主评论，0 = 不发")
    .group("评论")
    .order(20),

  commentReplyCount: s
    .number()
    .int()
    .min(0)
    .max(3)
    .default(2)
    .title("楼中楼条数")
    .desc("每条评论下带几条回复，0 = 不带")
    .group("评论")
    .order(30),

  commentMinLike: s
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(0)
    .title("最低点赞")
    .desc("低于该点赞数的评论不显示，0 = 不过滤")
    .group("评论")
    .order(40),

  commentShowLocation: s
    .boolean()
    .default(true)
    .title("显示 IP 属地")
    .desc("两个平台共用")
    .group("评论")
    .order(50),

  commentShowEmote: s
    .boolean()
    .default(true)
    .title("显示表情")
    .desc("两个平台共用，关掉显示文字标签")
    .group("评论")
    .order(60),

  commentSort: s
    .enum(["hot", "time"], { hot: "按热度", time: "按时间" })
    .default("hot")
    .title("排序方式（仅哔哩哔哩）")
    .desc("按热度或按时间")
    .group("评论")
    .order(70),

  commentShowLevel: s
    .boolean()
    .default(true)
    .title("显示等级（仅哔哩哔哩）")
    .desc("昵称后的 LV 徽章")
    .group("评论")
    .order(80),

  commentShowPictures: s
    .boolean()
    .default(true)
    .title("显示配图与表情包")
    .desc("哔哩哔哩配图、抖音照片与大表情，最多 3 张")
    .group("评论")
    .order(90),

  groupWhitelist: s
    .tags()
    .default([])
    .title("群白名单")
    .desc("留空 = 全部群；黑名单优先")
    .group("设置")
    .order(10),

  groupBlacklist: s
    .tags()
    .default([])
    .title("群黑名单")
    .desc("这些群不解析")
    .group("设置")
    .order(20),

  parseInPrivate: s
    .boolean()
    .default(false)
    .title("私聊也解析")
    .desc("默认只解析群聊，打开后私聊也解析")
    .group("设置")
    .order(30),

  ignorePrefixes: s
    .tags()
    .default(["#", "/", "！"])
    .title("跳过的消息前缀")
    .desc("以此开头的消息不自动解析")
    .group("设置")
    .order(40),

  cardAsForward: s
    .boolean()
    .default(true)
    .title("合并转发（总开关）")
    .desc("卡片、视频、评论图（含抖音图片）装进一条转发；关掉则逐条直发")
    .group("设置")
    .order(50),

  renderCard: s
    .boolean()
    .default(true)
    .title("渲染卡片图片")
    .desc("需要渲染器插件；失败自动回落为封面 + 文字")
    .group("设置")
    .order(60),

  parseCacheTTL: s
    .number()
    .int()
    .min(0)
    .max(86400)
    .default(300)
    .title("重复解析冷却（秒）")
    .desc("同群同视频的间隔，0 = 不去重")
    .group("设置")
    .order(70),

  atSender: s
    .boolean()
    .default(false)
    .title("解析后 @ 发送者")
    .desc("两个平台共用；仅直发生效，合并转发里 @ 不出来")
    .group("设置")
    .order(80),

  debug: s
    .boolean()
    .default(false)
    .title("调试日志")
    .desc("输出解析细节到日志")
    .group("设置")
    .order(90)
}).deprecated("enabled", "douyinCommentCount", "douyinSendImages")

/** 配置类型，由 schema 推导 */
export type BilibiliConfig = Infer<typeof configSchema>
