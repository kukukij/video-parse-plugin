# 使用说明

## 快速开始

1. 装好插件并构建（见 [README](README.md)）。
2. 确认 `enabled` 为开、机器人账号在目标群里。
3. 群里直接贴链接即可，不用任何命令。

## 运行依赖

### ffmpeg（可选）

| 功能 | 是否需要 ffmpeg | 没装时的表现 |
| --- | --- | --- |
| 卡片、图片转发、评论图 | 否 | 正常 |
| 抖音视频下载 | 否 | 正常（单文件 mp4，不用合流） |
| 哔哩哔哩视频下载 | 是 | 音视频无法合流，只发画面（没有声音） |
| 直播录制（B 站 / 抖音） | 是 | 录制失败，只发直播卡片 |

安装：

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y ffmpeg
# CentOS / Rocky / AlmaLinux
sudo dnf install -y epel-release && sudo dnf install -y ffmpeg
# Arch
sudo pacman -S ffmpeg
# macOS
brew install ffmpeg
# Windows（PowerShell）
winget install Gyan.FFmpeg
```

Windows 手动装的话把 `bin` 目录加进 `PATH`。装完 `ffmpeg -version` 有输出就行；插件用的是 `PATH` 里的 `ffmpeg`，没有单独的路径配置。

### 渲染器（推荐）

卡片是 HTML 模板，需要渲染器插件（如 `renderer-puppeteer`）。没装或渲染失败时自动回落为「封面图 + 文字」，不影响解析。

## 认哪些链接

| 平台 | 例子 | 说明 |
| --- | --- | --- |
| 哔哩哔哩 | `BV1GJ411x7h7`、`av170001`、`https://b23.tv/xxxx`、`https://www.bilibili.com/video/BV...` | 短链会先展开 |
| 哔哩哔哩直播 | `https://live.bilibili.com/21452505`、`https://b23.tv/xxxx`（直播短链） | 出直播卡片 |
| 抖音 | `https://v.douyin.com/xxxx/`、`https://www.douyin.com/video/7...`、`https://www.douyin.com/note/7...` | 支持整段分享口令 |
| 抖音直播 | `https://live.douyin.com/123456`、直播短链 | 出直播卡片 |

## 发什么

### 哔哩哔哩视频

- 卡片：封面、时长、标题、UP 主、分区、发布时间、简介、播放 / 点赞 / 投币 / 收藏、链接与 BV 号。
- 视频：按 `videoMode` 下载对应画质，超过体积上限只发卡片。
- 评论图：按评论配置生成，可单独发也可进转发。

### 哔哩哔哩直播

- 卡片：封面、标题、主播、直播状态、分区、简介、**人气 / 看过 / 点赞 / 关注 / 舰长**、链接与房间号。
- 录制：直播中且 `liveRecord > 0` 时录一段发视频；`0` 只发卡片，下播的房间也只发卡片。

### 抖音视频 / 图文 / 动图

- 卡片：封面（横图限宽、竖图限高，按原图比例自适应不裁切）、时长、文案、作者、背景音乐、点赞 / 评论 / 收藏 / 转发；图文作品额外标图片张数。
- 视频：按 `douyinVideo` 下载档位。
- 图文：图片最多 9 张，可做成合并转发（一条消息一张）。
- 动图作品：`douyinNoteVideo` 打开且填了 Cookie 时，额外取原视频一起发；取不到仍发静态图。

### 抖音直播

- 卡片：封面、标题、开播时间 / 已播时长、主播、**在线 / 看过 / 粉丝 / 点赞 / 涨粉**、链接与房间号。
- 录制：直播中且 `douyinLiveRecord > 0` 时录一段发视频；`0` 只发卡片。

### 评论图

- 哔哩哔哩与抖音共用同一套配置。
- 每条主评论可带楼中楼；支持等级徽章（B 站）、IP 属地、表情、配图（最多 3 张）。
- 关掉 `commentSend` 或把 `commentCount` 设为 `0` 就完全不请求评论接口。

## 合并转发规则

由 `cardAsForward`（总开关）和 `douyinImagesAsForward`（图片合并，仅抖音）两个开关决定：

| 总开关 | 图片合并 | 效果 |
| --- | --- | --- |
| 开 | 开 | 一条总转发：**卡片 → 图文转发（图片/视频，一条消息一张）→ 评论图**；哔哩哔哩是 卡片 → 视频 → 评论图 |
| 开 | 关 | 一条总转发：卡片 → 视频 → 评论图；抖音图片另发一条多图消息 |
| 关 | 开 | 卡片直发；图片和视频单独一条合并转发；评论图直发 |
| 关 | 关 | 卡片、图片、视频、评论图逐条直发 |

说明：

- 图片合并开关独立生效，不依赖总开关。
- 抖音两个都开时，图文转发只嵌套一层，不会出现「转发里再套空转发」。
- 平台不接受嵌套结构时自动退回平铺，仍是一条总转发。
- 合并转发超时（账号接口超时偏短）时按已送达处理，不会再补发一条。
- 解析中的表情在收到链接时回，完成表情等消息落地后再回。
- `atSender` 只对逐条直发生效，合并转发里 @ 不出来。

## 命令

| 命令 | 场景 | 说明 |
| --- | --- | --- |
| `#bili登录` | 私聊、仅主人 | 发二维码扫码登录哔哩哔哩，三分钟有效 |
| `#bili登出` | 仅主人 | 退出登录并删除本地凭据 |
| `#dy登录` | 私聊、仅主人 | 发二维码扫码登录抖音，三分钟有效 |
| `#dy登出` | 仅主人 | 清掉配置里的抖音 Cookie |
| `#bili状态` | 任意 | 解析统计、登录状态、冷却数量 |

## 登录与凭据

### 哔哩哔哩（推荐）

扫码登录后凭据加密保存在插件数据目录，过期前自动续期。不登录也能解析，只是高画质与部分评论受限。

### 抖音 Cookie（可选）

`douyinCookie` 默认留空，**不填也能正常用**。想开楼中楼就扫码登录：面板「抖音」卡片点「扫码登录」，或私聊发 `#dy登录`，登录成功后整串 Cookie 会自动写进 `douyinCookie`。

| 能力 | 不填 Cookie | 填了 Cookie |
| --- | --- | --- |
| 解析视频 / 图文、出卡片 | 可以 | 可以 |
| 下载无水印视频 | 可以 | 可以 |
| 主评论图 | 可以（匿名接口） | 可以 |
| 楼中楼（评论的回复） | 出不来（接口返回空） | 可以 |
| 动图作品的原视频 | 取不到，只发静态图 | 可以（配合 `douyinNoteVideo`） |

也可以手动填：浏览器打开 `douyin.com` 并登录 → 开发者工具 → 网络 → 随便点一个请求 → 复制请求头里 `Cookie` 的整行，粘贴到配置 `douyinCookie`。

- 抖音 Cookie 存在 `config/video-parse.yaml` 里，是明文，面板也能看到；只在自己的机器上使用，别把配置文件发出去。
- 哔哩哔哩的 SESSDATA 不走配置，单独加密存放。
- 抖音扫码依赖 `@alemonjs/douyin`（已列为依赖），设备身份存在插件数据目录的 `douyin-device.json`，删掉它等于换一台新设备。

## 配置项

### 哔哩哔哩

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关，关掉后不解析任何链接（两个平台都停） |
| `parseInPrivate` | `false` | 私聊也解析 |
| `ignorePrefixes` | `["#", "/", "！"]` | 以此开头的消息不自动解析 |
| `renderCard` | `true` | 渲染卡片图片；失败回落为封面 + 文字 |
| `videoMode` | `off` | `off` / `auto`(≤250MB) / `480p`(≤50MB) / `720p`(≤120MB) / `1080p`(≤250MB) / `1080p60`(≤400MB) / `4k`(≤800MB) |
| `parseCacheTTL` | `300` | 同群同作品冷却秒数，`0` = 不去重 |
| `liveRecord` | `10` | 直播录制秒数（0–60），`0` = 只发卡片 |

### 抖音

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `douyinEnabled` | `true` | 是否解析抖音链接 |
| `douyinVideo` | `off` | `off` / `540p`(≤100MB) / `720p`(≤200MB) / `1080p`(≤400MB) |
| `douyinImagesAsForward` | `true` | 图文图片合并转发（一条消息一张）；总开关也开时做成总转发里的图文转发 |
| `douyinNoteVideo` | `false` | 动图作品用 Cookie 取原视频一起发，约 1–2 秒；失败仍发静态图 |
| `douyinLiveRecord` | `10` | 直播录制秒数（0–60），`0` = 只发卡片 |
| `douyinCookie` | 空 | 抖音 Cookie，可选；不填也能解析，填了才能出楼中楼、取动图原视频 |

### 评论图

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `commentSend` | `true` | 是否发评论图；关掉后完全不请求评论 |
| `commentCount` | `10` | 每张图最多几条主评论（0–20），`0` = 不发 |
| `commentReplyCount` | `2` | 每条评论带几条楼中楼（0–3） |
| `commentMinLike` | `0` | 低于该点赞数的评论不显示，`0` = 不过滤 |
| `commentShowLocation` | `true` | 显示 IP 属地 |
| `commentShowEmote` | `true` | 显示表情；关掉显示文字标签 |
| `commentSort` | `hot` | 排序：`hot` 热度 / `time` 时间（仅 B 站） |
| `commentShowLevel` | `true` | 昵称后的 LV 徽章（仅 B 站） |
| `commentShowPictures` | `true` | 显示配图与表情包，最多 3 张 |

### 通用

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `cardAsForward` | `true` | 合并转发总开关；关掉逐条直发 |
| `atSender` | `false` | 解析后 @ 发送者，仅直发生效 |
| `groupWhitelist` | `[]` | 群白名单，留空 = 全部群 |
| `groupBlacklist` | `[]` | 群黑名单，优先于白名单 |
| `debug` | `false` | 输出解析细节到日志 |

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 贴链接没反应 | 总开关 / 抖音开关是否打开；群是否在黑名单；消息是否以 `#` 等前缀开头；是否还在冷却时间内；私聊是否允许 |
| 卡片变成封面 + 文字 | 没装渲染器或渲染失败，看日志里的渲染错误 |
| 群里出现两条不同形态的消息 | 账号「接口调用超时」太短，转发其实已发出又被判失败。把面板 → 账号 → napcat → 传输 → 接口调用超时调到 60 秒 |
| 动图没有视频 | 需要 `douyinNoteVideo` 打开且填了 `douyinCookie` |
| 抖音评论没有楼中楼 | 没填 `douyinCookie` 时匿名接口不返回回复，属正常现象 |
| B 站视频发出来没有声音 | 没装 ffmpeg，音视频无法合流；装上并重启 |
| 直播没有录制片段 | `liveRecord` / `douyinLiveRecord` 为 0，或房间已下播 |
| 评论图没出来 | `commentSend` 关着、`commentCount` 为 0，或评论接口失败（只记日志不影响卡片） |

## 开发

```bash
npm run build     # 编译 src -> dist
npm run typecheck # 类型检查
npm test          # 单元测试
```

- 改了 `src/` 必须重新 `npm run build`，机器人加载的是 `dist/`。
- 卡片模板在 `templates/`，改完直接重启即可生效。
