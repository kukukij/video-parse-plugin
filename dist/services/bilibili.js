/**
 * 模块职责：B 站接口调用 —— 链接识别、视频信息、播放地址、下载与合并
 * 依赖方向：依赖 app（取 ctx/http/config）、utils/format、types
 * 生命周期：随插件创建，无自有资源（临时文件在服务结束时清理）
 * 注意事项：三条与「直接照搬旧实现」不同的地方，都是踩过的坑：
 *
 *          1) **一切请求走 `ctx.http`**，它已绑上插件卸载信号 —— 关插件时在途请求会
 *             一起断，而不是留着几个 socket 慢慢超时；
 *          2) **ffmpeg 用 `spawn` 传参数组**，不是拼命令行字符串：标题、BV 号都可能
 *             出现在文件名里，拼字符串等于把 shell 注入的口子留在磁盘路径上；
 *          3) **下载先落临时文件再改名**，中途失败不会留下一个大小正确的坏 mp4，
 *             让发送端误以为拿到了完整的视频。
 */
import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { formatDate, formatSize } from "../utils/format.js";
import { recordStream } from "../utils/live.js";
import { resolveVideo } from "../utils/video.js";
/** 视频信息接口 */
const VIEW_API = "https://api.bilibili.com/x/web-interface/view";
/** 播放地址接口（DASH） */
const PLAYURL_API = "https://api.bilibili.com/x/player/playurl";
/**
 * 评论区接口
 *
 * 用 `reply/main` 而不是老的 `x/v2/reply`：后者现在**一页只给 3 条**（改版之后的行为），
 * 拿不到 10 条热评。`mode=3` 是「热门」，`next=0` 取第一页。
 */
const REPLY_API = "https://api.bilibili.com/x/v2/reply/main";
/** 直播间信息接口 */
const LIVE_INFO_API = "https://api.live.bilibili.com/room/v1/Room/get_info";
/** 直播间主播昵称接口 */
const LIVE_ANCHOR_API = "https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room";
/** 直播播放地址接口（web-room v2） */
const LIVE_PLAY_API = "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo";
/** BV 号 */
const BV_PATTERN = /\bBV[0-9A-Za-z]{10}\b/i;
/** AV 号 */
const AV_PATTERN = /\bav(\d{1,12})\b/i;
/** 站内视频链接 */
const VIDEO_URL_PATTERN = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d{1,12})/i;
/** 短链 */
const SHORT_PATTERN = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[A-Za-z\d._?%&+\-=\/#]+/i;
/** 直播间链接 */
const LIVE_URL_PATTERN = /https?:\/\/live\.bilibili\.com\/(\d{1,12})/i;
/** 直播片段体积上限：10 秒 1080P 一般 2-5MB，留足余量 */
const LIVE_MAX_MB = 50;
/** ffmpeg 失败时写进日志的 stderr 行数：真正的原因通常只在最后一行 */
const STDERR_TAIL = 5;
/** 展开短链时最多跟进几跳，防有人构造循环跳转把请求拖死 */
const MAX_SHORT_HOPS = 5;
/** 合流超时（毫秒）：正常 remux 是秒级，卡住就杀掉，别让整条管线挂死在一个进程上 */
const MERGE_TIMEOUT = 300_000;
/** B 站 codecid：7 为 AVC(H.264)，12 为 HEVC，13 为 AV1 */
const AVC_CODEC_ID = 7;
/** 画质关键词 → DASH 的 quality id */
const QUALITY_ID = {
    "4k": 120,
    "1080p60": 116,
    "1080p": 80,
    "720p": 64,
    "480p": 32
};
/** 请求 B 站时必须带的头：少了 Referer 会拿到 403 */
const BILI_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Referer: "https://www.bilibili.com/",
    Accept: "application/json, text/plain, */*"
};
/**
 * 检测文本里有没有 B 站链接或号
 * @param text 文本
 * @returns 有则为真
 */
export function containsBilibiliLink(text) {
    return (VIDEO_URL_PATTERN.test(text) ||
        SHORT_PATTERN.test(text) ||
        LIVE_URL_PATTERN.test(text) ||
        BV_PATTERN.test(text) ||
        AV_PATTERN.test(text));
}
/**
 * 从站内链接里取 BV 号
 * @param text 文本
 * @returns 规范化后的 BV 号，取不到为 null
 */
export function extractBvid(text) {
    const fromUrl = text.match(VIDEO_URL_PATTERN);
    if (fromUrl?.[1] !== undefined && fromUrl[1].toLowerCase().startsWith("bv")) {
        return `BV${fromUrl[1].slice(2)}`;
    }
    const bare = text.match(BV_PATTERN);
    return bare?.[0] === undefined ? null : `BV${bare[0].slice(2)}`;
}
/**
 * 从文本里取 AV 号
 * @param text 文本
 * @returns AV 号，取不到为 null
 */
export function extractAvid(text) {
    const fromUrl = text.match(VIDEO_URL_PATTERN);
    const raw = fromUrl?.[1]?.toLowerCase().startsWith("av") === true ? fromUrl[1].slice(2) : text.match(AV_PATTERN)?.[1];
    if (raw === undefined)
        return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
}
/**
 * 从文本里取短链
 * @param text 文本
 * @returns 短链，取不到为 null
 */
export function extractShortLink(text) {
    return text.match(SHORT_PATTERN)?.[0] ?? null;
}
/**
 * 从文本里取直播间号
 * @param text 文本
 * @returns 直播间号；不是直播链接为 null
 */
export function extractLiveRoom(text) {
    return text.match(LIVE_URL_PATTERN)?.[1] ?? null;
}
/**
 * 从小程序 / 图文卡片里把 B 站链接掏出来
 *
 * QQ 分享 B 站视频时，正文里往往没有链接，只有一个 `json` 段。旧实现只认
 * `com.tencent.miniapp` 与 `com.tencent.tuwen` 两种 `app`，这里保留同样的兜底顺序，
 * 外加一条「任何字段里出现 b23.tv / bilibili.com 就采用」的宽松匹配。
 * @param segments 消息段
 * @returns 链接，取不到为 null
 */
export function extractLinkFromSegments(segments) {
    for (const segment of segments) {
        if (segment.type !== "json")
            continue;
        const parsed = parseCard(segment.data);
        if (parsed === undefined)
            continue;
        const found = findUrlInCard(parsed);
        if (found !== null)
            return found;
    }
    return null;
}
/**
 * 解析卡片 JSON
 * @param raw 卡片正文
 * @returns 解析结果，失败为 undefined
 */
function parseCard(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        // 个别客户端会把 JSON 再套一层字符串
        try {
            return JSON.parse(JSON.parse(raw));
        }
        catch {
            return undefined;
        }
    }
}
/**
 * 在卡片结构里找 B 站链接
 *
 * 用递归而非逐字段硬编码：QQ 的卡片结构换过好几版，`detail_1` / `detail_100` /
 * `news.jumpUrl` 都出现过，按字段名穷举永远差一版。
 * @param node 卡片节点
 * @param depth 当前深度，防止异常结构把递归拖死
 * @returns 链接，取不到为 null
 */
function findUrlInCard(node, depth = 0) {
    if (depth > 6 || node === null || typeof node !== "object")
        return null;
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findUrlInCard(item, depth + 1);
            if (found !== null)
                return found;
        }
        return null;
    }
    for (const value of Object.values(node)) {
        if (typeof value === "string") {
            if (value.includes("b23.tv") || value.includes("bilibili.com")) {
                const match = value.match(/https?:\/\/[^\s"'<>]+/);
                if (match !== null)
                    return match[0];
            }
            continue;
        }
        const found = findUrlInCard(value, depth + 1);
        if (found !== null)
            return found;
    }
    return null;
}
/**
 * 从直播间页里取「看过 / 点赞 / 舰长」
 *
 * 这几个字段只有房间页的 SSR 数据里有，`get_info` 不带；页面改版取不到就返回 0，
 * 卡片上对应项会自动隐藏。
 * @param html 直播间页 HTML
 * @returns 累计看过、本场点赞、舰长数
 */
export function parseLivePage(html) {
    return {
        watched: Number(html.match(/"watched_show":\{[^}]*"num":(\d+)/)?.[1] ?? 0),
        likes: Number(html.match(/"like_info_v3":\{[^}]*"total_likes":(\d+)/)?.[1] ?? 0),
        guards: Number(html.match(/"guard_info":\{[^}]*"count":(\d+)/)?.[1] ?? 0)
    };
}
/**
 * B 站接口封装
 *
 * 持有一个 `BilibiliApp` 而非裸 `ctx`：配置、凭据、日志都在那里，且都随热重载换新。
 */
export class BilibiliApi {
    /** 运行期状态 */
    #app;
    /** ffmpeg 探测结果，`undefined` 表示还没探过 */
    #ffmpeg;
    /**
     * @param app 运行期状态
     */
    constructor(app) {
        this.#app = app;
    }
    /** 取上下文里的 HTTP 客户端 */
    get http() {
        return this.#app.ctx.http;
    }
    /**
     * 组装请求头，已登录时带上 Cookie
     * @returns 请求头
     */
    headers() {
        const credential = this.#app.credential;
        if (credential === undefined)
            return { ...BILI_HEADERS };
        return {
            ...BILI_HEADERS,
            Cookie: `SESSDATA=${encodeURIComponent(credential.sessdata)}; bili_jct=${credential.bili_jct}; DedeUserID=${credential.dedeuserid}`
        };
    }
    /**
     * 展开短链，拿到最终地址
     *
     * **不能靠「跟随重定向后的 `res.url`」**：内核的响应对象里 `url` 是**请求**地址
     * （`sanitizeUrl(req.url)`），undici 的 redirect 拦截器只换 dispatcher，不回填最终地址 ——
     * 于是 `res.url` 永远等于传进去的短链，判断 `res.url !== shortUrl` 恒假，所有 b23.tv
     * 短链都会被判成「解析失败」。
     *
     * 所以改成**不跟随**、自己读 3xx 的 `Location`，最多跳 `MAX_SHORT_HOPS` 跳。先 HEAD 再
     * GET：b23.tv 对某些 UA 只在 GET 上给 302，HEAD 会原样返回 200 的落地页。
     * @param shortUrl 短链
     * @returns 最终地址；展开失败为 null
     */
    async resolveShortUrl(shortUrl) {
        const options = {
            headers: { "User-Agent": BILI_HEADERS["User-Agent"] },
            responseType: "none",
            throwOnError: false,
            // 由我们自己读 Location，交给内核跟随反而读不到结果
            followRedirect: false,
            timeout: "10s"
        };
        for (const method of ["HEAD", "GET"]) {
            let current = shortUrl;
            for (let hop = 0; hop < MAX_SHORT_HOPS; hop++) {
                let status = 0;
                let location = "";
                try {
                    const res = await this.http.request(current, { ...options, method });
                    status = res.status;
                    const raw = res.headers["location"];
                    location = typeof raw === "string" ? raw : "";
                }
                catch (error) {
                    this.#app.debug(`短链展开失败（${method}）：${current}`, error);
                    break;
                }
                // 不是 3xx 或没给 Location：这一跳到此为止
                if (status < 300 || status >= 400 || location === "")
                    break;
                current = new URL(location, current).href;
                // 已经落到带 BV / av 的地址就没必要再跳
                if (extractBvid(current) !== null || extractAvid(current) !== null)
                    return current;
            }
            if (current !== shortUrl)
                return current;
        }
        return null;
    }
    /**
     * 提取用于去重的视频标识
     *
     * 统一返回 BV 号；短链会先展开。展开失败时返回 null —— 宁可这次不解析，
     * 也不要拿一个「未知」当 key 把后续所有短链都判成重复。
     * @param text 文本
     * @returns 标识，取不到为 null
     */
    async extractVideoId(text) {
        const bvid = extractBvid(text);
        if (bvid !== null)
            return bvid;
        const aid = extractAvid(text);
        if (aid !== null)
            return `av${aid}`;
        const short = extractShortLink(text);
        if (short !== null) {
            const real = await this.resolveShortUrl(short);
            if (real !== null) {
                return extractBvid(real) ?? (extractAvid(real) === null ? null : `av${extractAvid(real)}`);
            }
        }
        return null;
    }
    /**
     * 拉取视频信息
     * @param query BV 号或 AV 号
     * @returns 视频信息；接口报错或网络失败为 null
     */
    async fetchInfo(query) {
        const params = new URLSearchParams();
        if (query.bvid !== undefined)
            params.set("bvid", query.bvid);
        else if (query.aid !== undefined)
            params.set("aid", String(query.aid));
        else
            return null;
        try {
            const res = await this.http.get(`${VIEW_API}?${params.toString()}`, {
                headers: this.headers(),
                timeout: "15s",
                retry: 1
            });
            if (res.code !== 0) {
                this.#app.log("warn", `哔哩哔哩返回错误：code=${res.code} ${res.message}`);
                return null;
            }
            return res.data;
        }
        catch (error) {
            this.#app.log("warn", "拉取视频信息失败", error);
            return null;
        }
    }
    /**
     * 从一段文本解析出视频信息（BV / AV / 短链都认）
     * @param text 文本
     * @returns 视频信息，解析不出为 null
     */
    async parse(text) {
        const bvid = extractBvid(text);
        if (bvid !== null)
            return this.fetchInfo({ bvid });
        const aid = extractAvid(text);
        if (aid !== null)
            return this.fetchInfo({ aid });
        const short = extractShortLink(text);
        if (short !== null) {
            const real = await this.resolveShortUrl(short);
            if (real !== null) {
                const fromReal = extractBvid(real);
                if (fromReal !== null)
                    return this.fetchInfo({ bvid: fromReal });
                const aidFromReal = extractAvid(real);
                if (aidFromReal !== null)
                    return this.fetchInfo({ aid: aidFromReal });
            }
        }
        return null;
    }
    /**
     * 展开分享文本里的目标地址
     *
     * 直播间链接没有 BV 号，`parse` 认不出来，先把直播间号挑出来给调用方。短链只
     * 展开一次，展开后的地址再交给 `parse`，避免同一条短链请求两遍。
     * @param text 文本
     * @returns 解析用地址，以及直播间号（不是直播为 null）
     */
    async expandTarget(text) {
        const direct = extractLiveRoom(text);
        if (direct !== null)
            return { url: text, liveRoomId: direct };
        const short = extractShortLink(text);
        if (short !== null) {
            const real = await this.resolveShortUrl(short);
            if (real !== null)
                return { url: real, liveRoomId: extractLiveRoom(real) };
        }
        return { url: text, liveRoomId: null };
    }
    /**
     * 拉直播间信息
     * @param roomId 直播间号
     * @returns 直播间信息；接口报错或网络失败为 null（下播也能返回，`living=false`）
     */
    async fetchLiveInfo(roomId) {
        try {
            // 房间信息、主播昵称、页面统计互不依赖，三路一起要，省掉两次串行往返
            const [room, anchor, extra] = await Promise.all([
                this.http.get(`${LIVE_INFO_API}?room_id=${roomId}`, {
                    headers: this.headers(),
                    timeout: "15s",
                    retry: 1
                }),
                // 昵称与头像在另一个接口里，拿不到就留空，提示里退回「哔哩哔哩主播」
                this.http
                    .get(`${LIVE_ANCHOR_API}?roomid=${roomId}`, {
                    headers: this.headers(),
                    timeout: "15s"
                })
                    .catch(() => null),
                this.fetchLivePage(roomId)
            ]);
            if (room.code !== 0 || room.data === undefined) {
                this.#app.log("warn", `哔哩哔哩直播返回错误：code=${room.code} ${room.message}`);
                return null;
            }
            const living = room.data.live_status === 1;
            // 分区两级经常重复（比如「娱乐 · 娱乐」），去重后再拼
            const areas = [room.data.parent_area_name, room.data.area_name].filter((name) => name !== undefined && name !== "");
            return {
                roomId,
                title: room.data.title ?? "",
                anchor: anchor?.data?.info?.uname ?? "",
                anchorFace: anchor?.data?.info?.face ?? "",
                cover: room.data.user_cover ?? room.data.keyframe ?? "",
                popularity: room.data.online ?? 0,
                attention: room.data.attention ?? 0,
                area: areas.filter((name, i) => areas.indexOf(name) === i).join(" · "),
                liveTime: room.data.live_time ?? "",
                watched: extra.watched,
                likes: extra.likes,
                guards: extra.guards,
                living,
                streamUrl: living ? await this.fetchLiveStream(roomId) : ""
            };
        }
        catch (error) {
            this.#app.log("warn", "拉取直播信息失败", error);
            return null;
        }
    }
    /**
     * 拉直播间页，补「看过 / 点赞 / 舰长」
     * @param roomId 直播间号
     * @returns 三个数值；请求失败时全为 0
     */
    async fetchLivePage(roomId) {
        try {
            const res = await this.#app.ctx.http.request(`https://live.bilibili.com/${roomId}`, {
                method: "GET",
                headers: {
                    ...this.headers(),
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    Referer: `https://live.bilibili.com/${roomId}`
                },
                responseType: "text",
                throwOnError: false,
                timeout: "15s"
            });
            return parseLivePage(typeof res.data === "string" ? res.data : "");
        }
        catch (error) {
            this.#app.debug("拉取直播间页失败", error);
            return { watched: 0, likes: 0, guards: 0 };
        }
    }
    /**
     * 取直播流地址
     * @param roomId 直播间号
     * @returns FLV（优先）或 HLS 地址；取不到为空串
     */
    async fetchLiveStream(roomId) {
        const params = new URLSearchParams({
            room_id: roomId,
            protocol: "0,1",
            format: "0,1,2",
            // codec=0 只要 AVC，HEVC 录下来部分手机放不了
            codec: "0",
            qn: "10000",
            platform: "web",
            ptype: "8",
            dolby: "5",
            panorama: "1"
        });
        try {
            const res = await this.http.get(`${LIVE_PLAY_API}?${params.toString()}`, {
                headers: this.headers(),
                timeout: "15s",
                retry: 1
            });
            if (res.code !== 0)
                return "";
            for (const stream of res.data?.playurl_info?.playurl?.stream ?? []) {
                for (const format of stream.format ?? []) {
                    for (const codec of format.codec ?? []) {
                        const url = `${codec.url_info?.[0]?.host ?? ""}${codec.base_url ?? ""}${codec.url_info?.[0]?.extra ?? ""}`;
                        if (url !== "")
                            return url;
                    }
                }
            }
            return "";
        }
        catch (error) {
            this.#app.debug("拉取直播流地址失败", error);
            return "";
        }
    }
    /**
     * 录一小段直播
     *
     * 直播是无限流，只截前 N 秒；B 站 CDN 会看 Referer，所以给 ffmpeg 带上。
     * @param info 直播间信息
     * @param seconds 录多少秒
     * @param maxMB 体积上限
     * @returns 本地 mp4 路径；失败为 null
     */
    async recordLive(info, seconds, maxMB = LIVE_MAX_MB) {
        if (info.streamUrl === "") {
            this.#app.log("warn", `哔哩哔哩直播 ${info.roomId} 没有可用的播放地址`);
            return null;
        }
        const dir = join(this.#app.ctx.app.paths.temp, "bilibili");
        await mkdir(dir, { recursive: true });
        const output = join(dir, `bili-live-${info.roomId}-${Date.now()}.mp4`);
        const size = await recordStream({
            url: info.streamUrl,
            seconds,
            output,
            maxMB,
            headers: {
                Referer: `https://live.bilibili.com/${info.roomId}`,
                "User-Agent": BILI_HEADERS["User-Agent"]
            },
            log: (level, message) => this.#app.log(level, message)
        });
        if (size === null) {
            await rm(output, { force: true });
            return null;
        }
        this.#app.log("info", `哔哩哔哩直播已录制：${info.roomId} ${seconds} 秒 ${formatSize(size)}`);
        return output;
    }
    /**
     * 拉取 DASH 播放地址
     * @param query BV 号、cid
     * @returns DASH 数据；失败为 null
     */
    async fetchDash(query) {
        const logged = this.#app.isLoggedIn();
        const quality = this.#qualityId(logged);
        const params = new URLSearchParams({
            bvid: query.bvid,
            cid: String(query.cid),
            qn: String(quality),
            // 4K 与 1080P60 只对登录用户开放，未登录时声称要 4K 只会被降级
            fourk: logged ? "1" : "0",
            // 4048 = DASH(16) + HDR(64?) 等能力的合集，B 站前端用的也是这个值
            fnval: "4048",
            fnver: "0"
        });
        try {
            const res = await this.http.get(`${PLAYURL_API}?${params.toString()}`, {
                headers: this.headers(),
                timeout: "15s",
                retry: 1
            });
            if (res.code !== 0) {
                this.#app.log("warn", `取播放地址失败：code=${res.code} ${res.message}`);
                return null;
            }
            return res.data.dash ?? null;
        }
        catch (error) {
            this.#app.log("warn", "取播放地址异常", error);
            return null;
        }
    }
    /**
     * 拉取评论
     *
     * 置顶评论排在前面（B 站也这么排）。评论正文里的表情是 `[名字]` 标签，要按接口给的
     * `emote` 表替换成图片，否则会显示成一堆方括号文字；关掉表情时直接保留原文。
     * @param aid 视频 aid（`view` 接口直接给，不必另查）
     * @param limit 最多几条主评论
     * @param upMid UP 主的 mid，用来给 TA 的评论打 UP 标记
     * @param options 排序、楼中楼条数、是否转换表情
     * @returns 评论总数与列表；接口失败为 null
     */
    async fetchComments(aid, limit, upMid, options = {}) {
        if (!Number.isFinite(limit) || limit <= 0)
            return { total: 0, items: [] };
        const params = new URLSearchParams({
            type: "1",
            oid: String(aid),
            // 2 = 按时间（最新在前），3 = 按热度（B 站默认的「热门评论」）
            mode: options.sort === "time" ? "2" : "3",
            next: "0",
            ps: String(Math.min(20, limit))
        });
        try {
            const res = await this.http.get(`${REPLY_API}?${params.toString()}`, { headers: this.headers(), timeout: "15s", retry: 1 });
            if (res.code !== 0) {
                this.#app.log("warn", `取评论失败：code=${res.code} ${res.message}`);
                return null;
            }
            // 置顶在前，再补热评；同一条可能两边都出现，按 rpid 去重
            const raw = [...(res.data.top_replies ?? []), ...(res.data.replies ?? [])];
            const seen = new Set();
            const out = [];
            for (const item of raw) {
                const key = String(item.rpid ?? "");
                if (key !== "") {
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                }
                out.push(toCommentView(item, upMid, {
                    replyLimit: options.replyLimit ?? REPLY_PREVIEW,
                    emote: options.emote !== false
                }));
                if (out.length >= limit)
                    break;
            }
            this.#app.debug(`取到评论 ${out.length} 条，共 ${res.data.cursor?.all_count ?? 0} 条`);
            return { total: res.data.cursor?.all_count ?? out.length, items: out };
        }
        catch (error) {
            this.#app.log("warn", "取评论异常", error);
            return null;
        }
    }
    /**
     * 按配置换算要请求的画质 id
     * @param logged 是否已登录
     * @returns quality id
     */
    #qualityId(logged) {
        const configured = this.#expectedQuality();
        if (configured === "auto")
            return logged ? 116 : 80;
        return QUALITY_ID[configured] ?? 80;
    }
    /**
     * 配置里选中的画质
     *
     * 配置文件已经不再有单独的 `videoQuality`：画质与体积上限合成了一个档位，这里从档位
     * 反解出画质。选「不下载」时不会走到选流，故退回 auto 即可。
     * @returns 画质
     */
    #expectedQuality() {
        return resolveVideo(this.#app.config.videoMode)?.quality ?? "auto";
    }
    /**
     * 从 DASH 里挑出最合适的一路视频与一路音频
     *
     * 指定画质时向下回退而不是向上：使用者填 720P 通常是嫌文件大，给他一路 1080P
     * 等于把这个选择当成了耳边风。
     * @param dash DASH 数据
     * @returns 选中的流
     */
    pickStreams(dash) {
        const videos = dash.video ?? [];
        // 同一画质下 B 站同时给 AVC / HEVC / AV1 三路，且顺序不保证。先按「各端能直接播」
        // 筛一遍：HEVC 与 AV1 塞进 mp4 后，QQ / 微信这类客户端往往放不出来 —— 表现不是报错，
        // 而是对方收到一个「文件」。全都不满足才退回原样，宁可画质差一点也别发个文件过去。
        const playable = videos.filter(isPlayableVideo);
        const pool = playable.length > 0 ? playable : videos;
        let video;
        const configured = this.#expectedQuality();
        if (configured === "auto") {
            video = [...pool].sort((a, b) => b.id - a.id)[0];
        }
        else {
            const target = QUALITY_ID[configured] ?? 80;
            video =
                pool.find(v => v.id === target) ??
                    [...pool].filter(v => v.id <= target).sort((a, b) => b.id - a.id)[0] ??
                    [...pool].sort((a, b) => a.id - b.id)[0];
        }
        const audios = [
            ...(dash.audio ?? []),
            ...(dash.dolby?.audio ?? []),
            ...(dash.flac?.audio === undefined ? [] : [dash.flac.audio])
        ];
        // 同理优先 AAC：FLAC / 杜比（ec-3）装进 mp4 后多数客户端不认，宁可要码率高些的 AAC
        const playableAudios = audios.filter(isPlayableAudio);
        const audioPool = playableAudios.length > 0 ? playableAudios : audios;
        const audio = [...audioPool].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
        if (video !== undefined) {
            this.#app.debug(`选中视频流 id=${video.id} codecid=${video.codecid ?? "?"} ${video.codecs ?? ""}`.trim());
        }
        return { video, audio };
    }
    /**
     * 探测 ffmpeg 是否存在（结果缓存，一台机器上不会中途装上）
     * @returns 可用则为真
     */
    hasFfmpeg() {
        this.#ffmpeg ??= new Promise(resolve => {
            const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
            child.once("error", () => resolve(false));
            child.once("exit", code => resolve(code === 0));
        });
        return this.#ffmpeg;
    }
    /**
     * 下载并合并一个分 P 的视频
     *
     * DASH 的音视频是分离的，必须 ffmpeg 合流，否则群里放出来没有声音。没有 ffmpeg
     * 时退回「只要视频轨」—— 能看画面也好过什么都发不出去，并在日志里说清原因。
     * @param info 视频信息
     * @param maxMB 体积上限（MB）
     * @param prepared 已经拉过的 DASH 数据，卡片要在渲染前知道帧率时会先取一次
     * @returns 成品文件绝对路径；失败或超限为 null
     */
    async download(info, maxMB, prepared) {
        const cid = info.cid ?? info.pages?.[0]?.cid;
        if (cid === undefined) {
            this.#app.log("warn", "拿不到 cid，无法下载");
            return null;
        }
        const dash = prepared ?? (await this.fetchDash({ bvid: info.bvid, cid }));
        if (dash === null)
            return null;
        const { video, audio } = this.pickStreams(dash);
        if (video === undefined) {
            this.#app.log("warn", "DASH 里没有可用的视频流");
            return null;
        }
        const videoUrls = streamUrls(video);
        if (videoUrls.length === 0)
            return null;
        const dir = await this.#tempDir();
        const stem = `${info.bvid}-${Date.now()}`;
        const videoPart = join(dir, `${stem}.m4v`);
        const audioPart = join(dir, `${stem}.m4a`);
        const output = join(dir, `${stem}.mp4`);
        const partialOutput = `${output}.part`;
        try {
            // 先问一句多大：超过上限就别下了。100MB 的流白下一遍，带宽与磁盘都白花，
            // 最后还是会被同一道上限拒掉。HEAD 拿不到大小（少数 CDN 不给 content-length）
            // 时照旧下载，下载完仍有一次体积复核。
            const declared = await this.#probeSize(videoUrls[0]);
            if (declared !== null && declared / 1024 / 1024 > maxMB) {
                this.#app.log("warn", `视频 ${formatSize(declared)} 超过上限 ${maxMB}MB，未下载`);
                return null;
            }
            // 音轨和视频是两条独立的流，并行下载：音轨虽小，串行也要多等半秒到一秒
            const audioUrls = audio === undefined ? [] : streamUrls(audio);
            const [videoBytes, audioBytes] = await Promise.all([
                this.#downloadAny(videoUrls, videoPart),
                audioUrls.length === 0 ? null : this.#downloadAny(audioUrls, audioPart)
            ]);
            if (videoBytes === null) {
                // 失败时可能已经写了一半，留着只会在临时目录里越攒越多
                await rm(videoPart, { force: true });
                await rm(audioPart, { force: true });
                return null;
            }
            if (videoBytes / 1024 / 1024 > maxMB) {
                this.#app.log("warn", `视频 ${formatSize(videoBytes)} 超过上限 ${maxMB}MB，已放弃`);
                await rm(videoPart, { force: true });
                await rm(audioPart, { force: true });
                return null;
            }
            const hasAudio = audioBytes !== null;
            if (!hasAudio)
                await rm(audioPart, { force: true });
            if (!hasAudio) {
                // 「本来就没有音轨」和「音轨下载失败」是两回事，前者不该报警
                if (audio === undefined)
                    this.#app.debug("该视频没有音轨，直接发送画面");
                else
                    this.#app.log("warn", "音频流下载失败，将只发送画面");
                await rename(videoPart, partialOutput);
                await rename(partialOutput, output);
                return output;
            }
            if (!(await this.hasFfmpeg())) {
                this.#app.log("warn", "音频轨没能并入视频，将只发送画面");
                await rm(audioPart, { force: true });
                await rename(videoPart, partialOutput);
                await rename(partialOutput, output);
                return output;
            }
            const merged = await this.merge(videoPart, audioPart, partialOutput);
            await rm(videoPart, { force: true });
            await rm(audioPart, { force: true });
            if (!merged) {
                // 合流失败时 ffmpeg 可能已经写出了半个文件，留着只会占地方
                await rm(partialOutput, { force: true });
                return null;
            }
            const size = (await stat(partialOutput)).size;
            if (size / 1024 / 1024 > maxMB) {
                this.#app.log("warn", `合并后 ${formatSize(size)} 超过上限 ${maxMB}MB，已放弃`);
                await rm(partialOutput, { force: true });
                return null;
            }
            await rename(partialOutput, output);
            this.#app.log("info", `视频已就绪：${info.bvid} ${formatSize(size)} qn=${video.id}`);
            return output;
        }
        catch (error) {
            this.#app.log("warn", "下载视频失败", error);
            await rm(partialOutput, { force: true });
            await rm(videoPart, { force: true });
            await rm(audioPart, { force: true });
            return null;
        }
    }
    /**
     * 依次尝试多个地址下载同一路流
     *
     * B 站会把同一路流挂在多个节点上，其中个别节点会连上就断（P2P 类节点尤其常见）。
     * 一个不行就换下一个，全都不行才算失败 —— 失败时把已经写了一半的文件删掉。
     * @param urls 候选地址，按优先级排好
     * @param dest 目标路径
     * @returns 字节数；全部失败为 null
     */
    async #downloadAny(urls, dest) {
        for (let index = 0; index < urls.length; index += 1) {
            const bytes = await this.#download(urls[index], dest);
            if (bytes !== null)
                return bytes;
            await rm(dest, { force: true });
            if (index < urls.length - 1)
                this.#app.debug(`第 ${index + 1} 个地址不可用，换下一个重试`);
        }
        return null;
    }
    /**
     * 用 HEAD 预检流的大小
     *
     * 只发头部请求、不取 body，代价是几百字节。拿不到 `content-length`（部分 CDN 对
     * 分片地址不应答 HEAD）时返回 null，调用方照常下载 —— 预检失败不该让功能失效。
     * @param url 流地址
     * @returns 字节数；未知为 null
     */
    async #probeSize(url) {
        try {
            const res = await this.http.request(url, {
                method: "HEAD",
                headers: { ...BILI_HEADERS, Accept: "*/*" },
                responseType: "none",
                throwOnError: false,
                timeout: "10s"
            });
            if (res.status < 200 || res.status >= 300)
                return null;
            const raw = res.headers["content-length"];
            const bytes = Number.parseInt(typeof raw === "string" ? raw : "", 10);
            return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
        }
        catch (error) {
            this.#app.debug("预检体积失败，按未知大小继续", error);
            return null;
        }
    }
    /**
     * 下载单个流到文件
     * @param url 地址
     * @param dest 目标路径
     * @returns 字节数；失败为 null
     */
    async #download(url, dest) {
        try {
            const written = await this.http.download(url, dest, {
                headers: { ...BILI_HEADERS, Accept: "*/*" },
                timeout: "5m"
            });
            const size = (await stat(written)).size;
            return size > 0 ? size : null;
        }
        catch (error) {
            this.#app.debug(`流下载失败（${hostOf(url)}）`, error);
            return null;
        }
    }
    /**
     * 用 ffmpeg 合流
     *
     * 参数见 `buildMergeArgs`。**stderr 必须收着**：ffmpeg 的真正原因只写在 stderr 里，
     * 丢掉它就只能拿到一个退出码，排查时全靠猜（234 那次就是这么卡住的）。
     * @param video 视频轨
     * @param audio 音频轨
     * @param output 输出
     * @returns 是否成功
     */
    merge(video, audio, output) {
        return new Promise(resolve => {
            const child = spawn("ffmpeg", buildMergeArgs(video, audio, output), { stdio: ["ignore", "ignore", "pipe"] });
            // 环形缓冲：只留最后几行，长转码的日志不会把内存吃掉
            const tail = [];
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", (chunk) => {
                for (const line of chunk.split("\n")) {
                    const text = line.trim();
                    if (text === "")
                        continue;
                    tail.push(text);
                    if (tail.length > STDERR_TAIL)
                        tail.shift();
                }
            });
            // 没有超时的话，进程卡住 = 这个 Promise 永远不兑现，下载与投递跟着一起挂住
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, MERGE_TIMEOUT);
            timer.unref?.();
            const finish = (ok) => {
                clearTimeout(timer);
                resolve(ok);
            };
            child.once("error", error => {
                this.#app.log("warn", "合流进程启动失败", error);
                finish(false);
            });
            child.once("exit", code => {
                if (code !== 0) {
                    const why = timedOut ? "超时被终止" : code === null ? "被信号终止" : `退出码 ${code}`;
                    const detail = tail.length === 0 ? "" : `：${tail.join(" | ")}`;
                    this.#app.log("warn", `合流失败（${why}）${detail}`);
                }
                finish(code === 0);
            });
        });
    }
    /**
     * 取（并创建）本插件的临时目录
     * @returns 绝对路径
     */
    async #tempDir() {
        const dir = join(this.#app.ctx.app.paths.temp, "bilibili");
        await mkdir(dir, { recursive: true });
        return dir;
    }
}
/**
 * 这一路视频，QQ / 微信这类客户端能不能直接播
 *
 * 优先看 `codecid`，老接口没给时退回看 `codecs` 前缀。拿不准的一律当「不能播」，
 * 让调用方去挑确定的 AVC —— 猜错的代价是对方收到一个文件，比画质差一点严重得多。
 * @param video 视频流
 * @returns AVC 则为真
 */
function isPlayableVideo(video) {
    if (video.codecid !== undefined)
        return video.codecid === AVC_CODEC_ID;
    return /^avc1/i.test(video.codecs ?? "");
}
/**
 * 这一路音频能不能装进 mp4 并被各端认出来
 *
 * FLAC（`fLaC`）与杜比（`ec-3`）音质更好，但装进 mp4 后多数客户端只当数据不认，
 * 所以只认 AAC（`mp4a`）。
 * @param audio 音频流
 * @returns AAC 则为真
 */
function isPlayableAudio(audio) {
    return /^mp4a/i.test(audio.codecs ?? "");
}
/**
 * 组装合流的 ffmpeg 参数
 *
 * 参数一律走数组：ffmpeg 的命令行本身足够复杂，再加上拼字符串就是在自找注入。
 *
 * **`-f mp4` 不能省。** 输出路径带 `.part` 后缀（写完再 rename 成 `.mp4`，中途失败不会
 * 留下一个大小看着对的坏成品），而 ffmpeg 靠**扩展名**猜容器格式，`.part` 猜不出来会直接
 * 报 `Unable to choose an output format` 并以 EINVAL 退出 —— 到 shell 那边就是一个
 * 莫名其妙的「退出码 234」。显式指定容器即可，输出仍落在 `.part` 上，原子替换的语义不变。
 * @param video 视频轨（临时文件）
 * @param audio 音频轨（临时文件）
 * @param output 输出（`.part` 后缀）
 * @returns ffmpeg 参数数组
 */
export function buildMergeArgs(video, audio, output) {
    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video,
        "-i",
        audio,
        "-c",
        "copy",
        // moov 前置：不写的话索引在文件尾部，客户端得下完整个文件才能播，
        // QQ 这类「边下边播」的实现常常因此当成普通文件给你。
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "-y",
        output
    ];
}
/** 每条主评论下最多带几条楼中楼 */
const REPLY_PREVIEW = 2;
/**
 * 把接口返回的一条评论转成可渲染的形状
 * @param raw 原始评论
 * @param upMid UP 主 mid，用于打 UP 标记
 * @returns 评论视图
 */
function toCommentView(raw, upMid, options) {
    const partsOf = (item) => {
        const message = item.content?.message ?? "";
        return options.emote ? splitCommentParts(message, item.content?.emote) : message === "" ? [] : [{ text: message }];
    };
    const reply = (item) => ({
        uname: item.member?.uname ?? "",
        avatar: normalizeUrl(item.member?.avatar ?? ""),
        parts: partsOf(item),
        like: item.like ?? 0,
        time: timeText(item),
        level: levelOf(item),
        location: locationOf(item),
        isUp: upMid !== undefined && String(item.member?.mid ?? "") === String(upMid),
        isVip: isVipOf(item)
    });
    return {
        uname: raw.member?.uname ?? "",
        avatar: normalizeUrl(raw.member?.avatar ?? ""),
        parts: partsOf(raw),
        // 配图：接口给的是 http 直链，统一换成 https，免得渲染时被当成混合内容拦掉
        pictures: (raw.content?.pictures ?? [])
            .map(pic => ({ url: normalizeUrl(pic.img_src ?? ""), width: pic.img_width ?? 0, height: pic.img_height ?? 0 }))
            .filter(pic => pic.url !== ""),
        like: raw.like ?? 0,
        time: timeText(raw),
        level: levelOf(raw),
        location: locationOf(raw),
        isVip: isVipOf(raw),
        isUp: upMid !== undefined && String(raw.member?.mid ?? "") === String(upMid),
        replies: (raw.replies ?? []).slice(0, Math.max(0, options.replyLimit)).map(reply)
    };
}
/**
 * 把评论正文切成「文字 / 表情图」两种段
 *
 * 接口给的是 `[吃瓜]` 这样的标签加一张 `emote` 表；不替换的话，图片区的评论会变成一堆
 * 方括号文字，和 B 站原样差得远。长标签优先匹配，避免 `[大笑]` 被 `[大]` 抢先切走。
 * @param message 正文
 * @param emote 标签 → 表情图
 * @returns 分段
 */
function splitCommentParts(message, emote) {
    const parts = [];
    if (message === "")
        return parts;
    const table = emote ?? {};
    const keys = Object.keys(table)
        .filter(key => key !== "" && (table[key]?.url ?? "") !== "")
        .sort((a, b) => b.length - a.length);
    let buffer = "";
    let index = 0;
    while (index < message.length) {
        const hit = keys.find(key => message.startsWith(key, index));
        if (hit === undefined) {
            buffer += message[index];
            index += 1;
            continue;
        }
        if (buffer !== "") {
            parts.push({ text: buffer });
            buffer = "";
        }
        parts.push({ emote: { url: normalizeUrl(table[hit]?.url ?? "") } });
        index += hit.length;
    }
    if (buffer !== "")
        parts.push({ text: buffer });
    return parts;
}
/**
 * 把 B 站图床地址补成 https 绝对地址
 *
 * 接口里有三种形态：`http://`、`//`、以及完整 https。前两种在渲染时容易被当成混合
 * 内容或相对路径。
 * @param url 原地址
 * @returns 规范化后的地址；空串原样返回
 */
function normalizeUrl(url) {
    const text = url.trim();
    if (text === "")
        return "";
    if (text.startsWith("//"))
        return `https:${text}`;
    if (text.startsWith("http://"))
        return `https://${text.slice("http://".length)}`;
    return text;
}
/**
 * 评论的展示时间
 *
 * 不直接用 `time_desc`（接口会给「2178天前发布」）。规则按日历天算：
 * 当天 → 刚刚 / N分钟前 / N小时前；昨天 → `昨天 HH:mm`；前天到三天前 → `N天前`；
 * 再早的直接给日期。
 *
 * 用日历天而不是「除以 86400」：晚上 23 点看前天 23 点的评论，按小时算才 38 小时，
 * 会被误判成「昨天」；按日历就是实打实的前天。
 * @param raw 原始评论
 * @returns 时间文案
 */
function timeText(raw) {
    const ctime = raw.ctime;
    if (ctime === undefined || ctime <= 0) {
        const desc = raw.reply_control?.time_desc;
        return typeof desc === "string" ? desc.replace(/发布$/, "") : "";
    }
    const then = new Date(ctime * 1000);
    const now = new Date();
    const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
    if (dayDiff <= 0) {
        const seconds = Math.max(0, Math.floor(now.getTime() / 1000) - ctime);
        if (seconds < 60)
            return "刚刚";
        if (seconds < 3600)
            return `${Math.floor(seconds / 60)}分钟前`;
        return `${Math.floor(seconds / 3600)}小时前`;
    }
    // 昨天带时刻：B 站没有「1天前」这种说法
    if (dayDiff === 1) {
        const hh = String(then.getHours()).padStart(2, "0");
        const mm = String(then.getMinutes()).padStart(2, "0");
        return `昨天 ${hh}:${mm}`;
    }
    // 「N天前」最多到三天，再早给日期
    if (dayDiff <= 3)
        return `${dayDiff}天前`;
    if (then.getFullYear() === now.getFullYear()) {
        return `${then.getMonth() + 1}月${then.getDate()}日`;
    }
    return formatDate(ctime);
}
/**
 * 评论作者的等级
 *
 * 0 是真实存在的等级（没答过题的新号），不能拿它兼作「未知」；接口没给时返回 -1，
 * 模板据此跳过徽章。
 * @param raw 原始评论
 * @returns 0-6；未知为 -1
 */
function levelOf(raw) {
    const level = raw.member?.level_info?.current_level;
    return typeof level === "number" && level >= 0 && level <= 6 ? level : -1;
}
/**
 * 评论作者是不是大会员
 *
 * `vipType` 只表示「有没有开通过」（1 大会员 / 2 年度），过期的也会带着；真正有效
 * 要看 `vipStatus === 1`，否则过期用户的昵称也会一路挂粉色。
 * @param raw 原始评论
 * @returns 是否处于大会员有效期
 */
function isVipOf(raw) {
    const vip = raw.member?.vip;
    return vip?.vipStatus === 1 && (vip.vipType ?? 0) > 0;
}
/**
 * 评论的 IP 属地
 *
 * 接口给的是「IP属地：广东」，只留省份；未登录请求时接口完全不返回这个字段，
 * 此时退回空串，模板会跳过这一项。
 * @param raw 原始评论
 * @returns 省份名；没有为空串
 */
function locationOf(raw) {
    const rawLocation = raw.reply_control?.location;
    if (typeof rawLocation !== "string")
        return "";
    return rawLocation.replace(/^IP属地[:：]\s*/, "").trim();
}
/**
 * 取流地址
 * @param backup `backupUrl` 字段，可能是字符串或数组
 * @returns 首个地址；没有则 null
 */
/**
 * 取地址里的主机名，只用于日志
 * @param url 地址
 * @returns 主机名；解析失败给原串前缀
 */
function hostOf(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return url.slice(0, 40);
    }
}
/**
 * 把一路流的候选地址按优先级排好
 *
 * `baseUrl` 是主地址，`backupUrl` 是 CDN 给的备选（1-3 个，分散在不同节点）。**不能只用
 * backupUrl**：某些视频的备选里有一台 P2P 节点（`solseed.cn` 之类）连上就被对端掐断，
 * 而主地址是完全正常的，只用备选会整个下载失败。
 * @param stream 带地址的流
 * @returns 去重后的地址列表，主地址在前
 */
export function streamUrls(stream) {
    const backup = Array.isArray(stream.backupUrl)
        ? stream.backupUrl
        : stream.backupUrl === undefined
            ? []
            : [stream.backupUrl];
    const urls = [];
    for (const item of [stream.baseUrl, ...backup]) {
        if (typeof item !== "string" || item === "")
            continue;
        if (!urls.includes(item))
            urls.push(item);
    }
    return urls;
}
/**
 * 删除一个临时文件，失败只记日志
 * @param app 运行期状态
 * @param file 路径
 */
export async function cleanupFile(app, file) {
    if (file === undefined)
        return;
    await rm(file, { force: true }).catch(() => undefined);
    app.debug(`已清理临时文件 ${file}`);
}
