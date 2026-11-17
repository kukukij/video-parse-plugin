# 使用说明

## 装 ffmpeg

B 站给的是 **DASH**：画面和声音是两条独立的流，要合并成一个能播的 mp4 才能发。这一步用本机的
`ffmpeg` 完成。**不装也能跑**，只是下载的视频只有画面、没有声音。

| 系统 | 命令 |
|---|---|
| Debian / Ubuntu | `sudo apt update && sudo apt install -y ffmpeg` |
| CentOS / RHEL / Rocky | `sudo dnf install -y epel-release && sudo dnf install -y ffmpeg`（或先装 [RPM Fusion](https://rpmfusion.org/)） |
| Fedora | `sudo dnf install -y ffmpeg`（需 RPM Fusion） |
| Arch / Manjaro | `sudo pacman -S ffmpeg` |
| Alpine（Docker 常见） | `apk add --no-cache ffmpeg` |
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg`，或在 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下 zip 解压后把 `bin` 加进 `PATH` |
| Android / Termux | `pkg install ffmpeg` |

```bash
ffmpeg -version        # 能打印版本号即可
```

用 Docker 部署记得写进镜像，否则容器重建就没了：

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
```

## 扫码登录

打开面板「插件 → bilibili」（或「扩展页面 → B站解析」），账号卡片右上角点 **扫码登录**，二维码直接
出在页面里；手机 B 站客户端扫完，页面两秒内变成「已登录」。「退出登录」是两段式的，第二次点才真删凭据。

这条路径不需要配主人 —— 能打开面板的人本来就能改插件配置。

命令 `#bili登录` 是**面板打不开时**的备用通道（端口没放行、或手上只有手机 QQ）：它需要
`config/yunzai.yaml` 里配了 `bot.masterQQ`，否则不响应任何人，启动日志里会有一条 warn。

登录后能拉 1080P60 与 4K；凭据每天 4:30 检查一次，需要时自动续期，不必反复扫码。

## 命令

只有三条 —— 解析本身不需要命令，贴链接就出卡片。

| 命令 | 谁能用 | 说明 |
|---|---|---|
| `#bili状态` | 所有人 | 开关、模式、登录态、今日与累计解析数、本群是否在解析 |
| `#bili登录` | 主人、私聊 | 备用通道：发二维码 → 等扫码 → 回执，三分钟内有效 |
| `#bili登出` | 主人 | 删掉本地凭据 |

## 自动解析

默认只解析**群消息**（打开 `parseInPrivate` 后私聊也算）。判定顺序：

```
总开关 → 场景（频道跳过） → 消息前缀 → 有没有 B 站链接 → 本群不在白名单 / 已在黑名单 → 是否在冷却期
```

任何一步不过就**原样放行给后续插件**，不产生网络请求，也不拦消息。

贴链接时机器人先给消息贴一个「闪光」表情，解析成功换成「OK」——平台不支持表情回应就跳过。

同一个群里同一条视频，300 秒内不重复解析（`parseCacheTTL`，设 `0` 关掉）。

## 群白名单 / 黑名单

两者都**只填群号**，且**只决定本插件解不解析**，不影响别的插件：

```yaml
groupWhitelist:            # 留空＝不限群；填了＝只解析名单内的群
  - "609194963"
groupBlacklist:            # 填了＝这些群不解析
  - "700000"
```

优先级：**黑名单 > 白名单 > 默认全解析**，两边都填的群按黑名单算。

面板「扩展页面 → B站解析」里可以直接点选：列出账号已加入的群（头像 + 群名 + 群号），
每行两个按钮，「白名单」和「拉黑」，点一下即时生效。

## 发出去长什么样

一条链接最多回三条消息，都不附链接：

1. **卡片**（@ 你，非合并转发时）
2. **视频**（`sendMode: with-video` 才有）
3. **评论图**（`commentSend` 打开时才有，见下）

「合并转发」开关决定前两条的形态：

- **开**：一条转发，封面 → 卡片/文字 → 视频各占一个节点
- **关**：卡片一条、视频一条（一条普通消息只能带一个富媒体，图片和视频必须分开）

### 评论图

按 B 站评论区原样渲染成一张图：头像（大会员右下角带粉色「大」标）、昵称（大会员粉色、
普通用户灰色）、等级徽章（LV0-LV6）、正文（含表情与配图）、
点赞数、发布时间与 **IP 属地**，UP 主本人的评论带粉色 `UP` 标。每条主评论下最多带 **2 条**
回复，楼中楼不带头像、名字与正文同行，字号比主评论小一档；没有回复就只显示评论。

> IP 属地要登录后才拿得到：B 站接口在未登录请求里不返回这个字段，此时该位置留空。

条数由 `commentCount` 控制（默认 10，可设 1-20）；排序由 `commentSort` 控制（`hot` 按热度、
`time` 按时间）；每条评论下的回复条数看 `commentReplyCount`（默认 2，设 0 只留主评论）。
不想要评论图就把 `commentSend` 关掉，插件连评论都不会去请求。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `parseInPrivate` | `false` | 私聊也自动解析 |
| `ignorePrefixes` | `["#", "/", "！"]` | 以这些开头的消息不自动解析（留给命令） |
| `sendMode` | `info-only` | `info-only` 只发信息；`with-video` 连视频一起下 |
| `renderCard` | `true` | 渲染卡片图，失败自动回落文字 |
| `cardAsForward` | `true` | 合并转发发送；开关都不附链接，视频跟着开关走 |
| `atSender` | `false` | 直接发送时 @ 发送者 |
| `maxVideoSizeMB` | `100` | 超过就不下 |
| `commentSend` | `true` | 是否发送评论图（关掉就不请求评论） |
| `commentCount` | `10` | 一张图里放几条主评论，1-20 |
| `commentSort` | `hot` | `hot` 按热度；`time` 按时间（最新在前） |
| `commentReplyCount` | `2` | 每条主评论下带几条回复，0-3 |
| `commentMinLike` | `0` | 主评论点赞低于这个值不显示，0 不过滤水评 |
| `commentShowLevel` | `true` | 昵称后的 LV 徽章 |
| `commentShowLocation` | `true` | IP 属地（需登录） |
| `commentShowEmote` | `true` | 表情转成图片，关掉显示 `[吃瓜]` 原文 |
| `commentShowPictures` | `true` | 评论里的配图 |
| `videoQuality` | `auto` | `auto` / `4k` / `1080p60` / `1080p` / `720p` / `480p` |
| `parseCacheTTL` | `300` | 同群同视频多少秒内不重复解析，`0` 表示不去重 |
| `groupWhitelist` | `[]` | 群白名单，只填群号 |
| `groupBlacklist` | `[]` | 群黑名单，只填群号 |
| `debug` | `false` | 调试日志 |

改完即时生效，不用重启。

## 面板页面

「扩展页面 → B站解析」一页看完：登录状态、累计/今日解析数、群白名单与黑名单（可点选）、
最近解析、当前设置，以及「扫码登录 / 退出登录」。

## 常见问题

**视频发出来了，但没声音？**
本机没有 `ffmpeg`，音频轨没能并进去。按上面「装 ffmpeg」装好后重启进程。

**视频在 QQ 里显示成一个文件，不是能直接播的视频？**
已修：选流优先 H.264（AVC）+ AAC，合流后把 `moov` 前置。旧版本会把 HEVC/AV1 塞进 mp4，
很多客户端不认就退化成文件卡片。

**改了源码没生效？**
面板「重载」只换入口模块，`src/` 里其他文件必须**重启进程**；顺带先 `npm run build` 生成 `dist/`。

**`b23.tv` 短链说解析失败？**
旧版按「跟随重定向后的 `res.url`」判断，而内核给的 `res.url` 是请求地址，恒等于短链本身。
现改为自己读 3xx 的 `Location`，最多跟 5 跳。
