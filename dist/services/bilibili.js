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
import { formatSize } from "../utils/format.js";
/** 视频信息接口 */
const VIEW_API = "https://api.bilibili.com/x/web-interface/view";
/** 播放地址接口（DASH） */
const PLAYURL_API = "https://api.bilibili.com/x/player/playurl";
/** BV 号 */
const BV_PATTERN = /\bBV[0-9A-Za-z]{10}\b/i;
/** AV 号 */
const AV_PATTERN = /\bav(\d{1,12})\b/i;
/** 站内视频链接 */
const VIDEO_URL_PATTERN = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d{1,12})/i;
/** 短链 */
const SHORT_PATTERN = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[A-Za-z\d._?%&+\-=\/#]+/i;
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
    return (VIDEO_URL_PATTERN.test(text) || SHORT_PATTERN.test(text) || BV_PATTERN.test(text) || AV_PATTERN.test(text));
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
                this.#app.log("warn", `B 站返回错误：code=${res.code} ${res.message}`);
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
     * 按配置换算要请求的画质 id
     * @param logged 是否已登录
     * @returns quality id
     */
    #qualityId(logged) {
        const configured = this.#app.config.videoQuality;
        if (configured === "auto")
            return logged ? 116 : 80;
        return QUALITY_ID[configured] ?? 80;
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
        const configured = this.#app.config.videoQuality;
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
     * @returns 成品文件绝对路径；失败或超限为 null
     */
    async download(info, maxMB) {
        const cid = info.cid ?? info.pages?.[0]?.cid;
        if (cid === undefined) {
            this.#app.log("warn", "拿不到 cid，无法下载");
            return null;
        }
        const dash = await this.fetchDash({ bvid: info.bvid, cid });
        if (dash === null)
            return null;
        const { video, audio } = this.pickStreams(dash);
        if (video === undefined) {
            this.#app.log("warn", "DASH 里没有可用的视频流");
            return null;
        }
        const videoUrl = firstUrl(video.backupUrl);
        if (videoUrl === null)
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
            const declared = await this.#probeSize(videoUrl);
            if (declared !== null && declared / 1024 / 1024 > maxMB) {
                this.#app.log("warn", `视频 ${formatSize(declared)} 超过上限 ${maxMB}MB，未下载`);
                return null;
            }
            const videoBytes = await this.#download(videoUrl, videoPart);
            if (videoBytes === null) {
                // 失败时可能已经写了一半，留着只会在临时目录里越攒越多
                await rm(videoPart, { force: true });
                return null;
            }
            if (videoBytes / 1024 / 1024 > maxMB) {
                this.#app.log("warn", `视频 ${formatSize(videoBytes)} 超过上限 ${maxMB}MB，已放弃`);
                await rm(videoPart, { force: true });
                return null;
            }
            const audioUrl = audio === undefined ? null : firstUrl(audio.backupUrl);
            const hasAudio = audioUrl === null ? false : (await this.#download(audioUrl, audioPart)) !== null;
            if (!hasAudio)
                await rm(audioPart, { force: true });
            if (!hasAudio) {
                this.#app.log("warn", "没有可用的音频流，将只发送视频轨");
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
            if (!merged)
                return null;
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
            this.#app.debug("流下载失败", error);
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
/**
 * 取流地址
 * @param backup `backupUrl` 字段，可能是字符串或数组
 * @returns 首个地址；没有则 null
 */
function firstUrl(backup) {
    if (typeof backup === "string")
        return backup === "" ? null : backup;
    if (Array.isArray(backup))
        return backup.find(item => item !== "") ?? null;
    return null;
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
