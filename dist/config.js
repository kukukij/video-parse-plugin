/**
 * 模块职责：配置 schema —— 一份声明同时产出校验、`config/bilibili.yaml` 与面板表单
 * 依赖方向：依赖 @yunzai-ng/core 的 `s`（schema 工厂）与本地类型
 * 生命周期：模块加载期构造一次，之后不可变
 * 注意事项：**凭据不在这里**。面板的 `GET /api/config/:name` 刻意不脱敏，任何写进
 *          config.yaml 的东西都等于摊在面板上；SESSDATA 一旦泄漏等同于把账号交出去，
 *          故凭据单独加密存于插件数据目录（见 services/credential.ts）。
 */
import { s } from "@yunzai-ng/core";
/** 插件配置的 schema；`ctx.config.get()` 的类型由它推导 */
export const configSchema = s.object({
    enabled: s
        .boolean()
        .default(true)
        .title("总开关")
        .desc("关掉之后任何消息都不再自动解析")
        .group("基础"),
    parseInPrivate: s
        .boolean()
        .default(false)
        .title("私聊也解析")
        .desc("默认只解析群消息；打开后私聊里的 B 站链接也会出卡片")
        .group("基础")
        .order(10),
    ignorePrefixes: s
        .tags()
        .default(["#", "/", "！"])
        .title("跳过的消息前缀")
        .desc("以这些字符开头的消息不自动解析，留着给命令用")
        .group("基础")
        .order(20),
    sendMode: s
        .enum(["info-only", "with-video"], {
        "info-only": "只发信息卡片",
        "with-video": "信息卡片 + 视频文件"
    })
        .default("info-only")
        .title("发送模式")
        .desc("下载视频很吃带宽与磁盘，大文件建议只发信息")
        .group("发送")
        .order(10),
    renderCard: s
        .boolean()
        .default(true)
        .title("渲染卡片图片")
        .desc("需要装渲染器插件（如 renderer-puppeteer）；渲染失败自动回落为封面 + 文字")
        .group("发送")
        .order(20),
    cardAsForward: s
        .boolean()
        .default(true)
        .title("用合并转发发送")
        .desc("把封面、信息、视频装进一条合并转发，不在群里刷屏。平台不支持时自动改为直接发送")
        .group("发送")
        .order(30),
    atSender: s
        .boolean()
        .default(false)
        .title("解析后 @ 发送者")
        .desc("仅在直接发送（非合并转发）时生效")
        .group("发送")
        .order(40),
    maxVideoSizeMB: s
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(100)
        .title("视频大小上限（MB）")
        .desc("超过这个大小就不下载了。QQ 群视频消息的上限通常在 100MB 上下")
        .group("视频")
        .order(20),
    videoQuality: s
        .enum(["auto", "4k", "1080p60", "1080p", "720p", "480p"], {
        auto: "自动（登录则最高，未登录 1080P）",
        "4k": "4K",
        "1080p60": "1080P 60 帧",
        "1080p": "1080P",
        "720p": "720P",
        "480p": "480P"
    })
        .default("auto")
        .title("期望画质")
        .desc("4K / 1080P60 需要登录；未登录时 B 站只给到 1080P")
        .group("视频")
        .order(30),
    parseCacheTTL: s
        .number()
        .int()
        .min(0)
        .max(86400)
        .default(300)
        .title("同群重复解析冷却（秒）")
        .desc("同一群里同一条视频多久内不再重复解析。0 表示不去重")
        .group("视频")
        .order(40),
    commentSend: s
        .boolean()
        .default(true)
        .title("发送评论图")
        .desc("解析后额外发一张评论区的图。关掉就完全不请求评论，也不发图")
        .group("评论")
        .order(10),
    commentCount: s
        .number()
        .int()
        .min(0)
        .max(20)
        .default(10)
        .title("显示条数")
        .desc("一张图里最多放几条主评论（1-20）。条数越多图越长；填 0 等于不发评论图，和关掉「发送评论图」一个效果")
        .group("评论")
        .order(20),
    commentSort: s
        .enum(["hot", "time"], { hot: "按热度", time: "按时间" })
        .default("hot")
        .title("排序方式")
        .desc("按热度＝B 站默认的「热门评论」；按时间＝最新的在最前面")
        .group("评论")
        .order(30),
    commentReplyCount: s
        .number()
        .int()
        .min(0)
        .max(3)
        .default(2)
        .title("楼中楼条数")
        .desc("每条主评论下带几条回复（0-3）。0 表示只显示主评论")
        .group("评论")
        .order(40),
    commentMinLike: s
        .number()
        .int()
        .min(0)
        .max(10000)
        .default(0)
        .title("最低点赞数")
        .desc("主评论点赞数低于这个值就不显示，用来过滤「第一」「111」这类水评。0 表示不过滤")
        .group("评论")
        .order(50),
    commentShowLevel: s
        .boolean()
        .default(true)
        .title("显示等级")
        .desc("昵称后面的 LV 徽章")
        .group("评论")
        .order(60),
    commentShowLocation: s
        .boolean()
        .default(true)
        .title("显示 IP 属地")
        .desc("「广东」这类归属地，需要登录 B 站账号才会返回")
        .group("评论")
        .order(70),
    commentShowEmote: s
        .boolean()
        .default(true)
        .title("显示表情图")
        .desc("把 [吃瓜] 这类表情换成 B 站的表情图；关掉就显示成文字标签")
        .group("评论")
        .order(80),
    commentShowPictures: s
        .boolean()
        .default(true)
        .title("显示评论配图")
        .desc("评论里带的图片，最多 3 张")
        .group("评论")
        .order(90),
    groupWhitelist: s
        .tags()
        .default([])
        .title("群白名单")
        .desc("留空表示所有群都解析；填了群号，就只解析名单内的群。黑名单优先于白名单 —— 两边都填的群按黑名单算")
        .group("群")
        .order(10),
    groupBlacklist: s
        .tags()
        .default([])
        .title("群黑名单")
        .desc("只填群号，填进去的群不自动解析；没填的群按上一条白名单的规则来。面板「B站解析」页里可直接勾选账号已加入的群")
        .group("群")
        .order(20),
    debug: s
        .boolean()
        .default(false)
        .title("调试日志")
        .desc("把每一步解析的细节写进日志，排障时开")
        .group("高级")
        .order(10)
});
