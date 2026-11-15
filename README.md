# yunzai-plugin-bilibili

[Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的 B 站链接解析插件：群里贴 B 站链接，回一张视频卡片，
想连视频一起发也行。

<p align="center">
  <img src="docs/preview-card.png" width="210" alt="视频卡片" />
  &nbsp;&nbsp;
  <img src="docs/preview-login.png" width="330" alt="网页扫码登录" />
  &nbsp;&nbsp;
  <img src="docs/preview-panel.png" width="480" alt="面板看板" />
</p>

## 功能

- **认得**：站内链接、`b23.tv` / `bili2233.cn` 短链、裸 `BV` / `av` 号、QQ 分享的小程序卡片
- **卡片**：封面、标题、UP 主、分区、时长、发布日期，播放 / 弹幕 / 点赞 / 投币 / 收藏 / 分享
- **视频**：可选下载，优先 H.264 + AAC，发出去能直接播
- **登录**：网页扫码，登录后支持 1080P60 与 4K，凭据自动续期
- **群白名单 / 黑名单**：只填群号，面板里点选即可；只影响本插件，不拦别的插件

## 安装

```bash
cd <主目录>/plugins
git clone https://github.com/kukukij/yunzai-plugin-bilibili bilibili
cd bilibili && npm install --omit=dev
```

想要带声音的视频，再装 ffmpeg（按系统挑一行）：

```bash
sudo apt install -y ffmpeg        # Debian / Ubuntu
brew install ffmpeg               # macOS
```

其他系统（dnf / pacman / apk / winget / Termux）见 [USAGE.md](USAGE.md#装-ffmpeg)。

可选：装 [renderer-puppeteer](https://github.com/Yunzai-NG/renderer-puppeteer) 出卡片图，不装回落成
「封面 + 文字」。

装完重启一次，看到 `config/bilibili.yaml` 生成、面板「扩展页面」多一项「B站解析」就对了。

## 配置

面板「插件 → bilibili → 配置」里改，或直接编辑 `config/bilibili.yaml`，**改完即时生效，不用重启**。

| 项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `sendMode` | `info-only` | `with-video` 连视频一起下 |
| `parseInPrivate` | `false` | 私聊也解析 |
| `cardAsForward` | `true` | 合并转发发送，群里不刷屏 |
| `videoQuality` | `auto` | `auto` / `4k` / `1080p60` / `1080p` / `720p` / `480p` |
| `maxVideoSizeMB` | `100` | 超过就不下 |
| `parseCacheTTL` | `300` | 同群同视频多少秒内不重复解析，`0` 为不去重 |
| `groupWhitelist` | `[]` | 群白名单，只填群号；留空＝不限群 |
| `groupBlacklist` | `[]` | 群黑名单，只填群号 |

其余配置项见 [USAGE.md](USAGE.md#配置)。

## 使用

**见 [USAGE.md](USAGE.md)**：扫码登录、命令、自动解析规则、群名单、常见问题。

## 许可

MIT。

本插件借鉴自 [napcat-plugin-bilibili](https://github.com/AQiaoYo/napcat-plugin-bilibili)。
