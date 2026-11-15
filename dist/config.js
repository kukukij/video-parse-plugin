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
