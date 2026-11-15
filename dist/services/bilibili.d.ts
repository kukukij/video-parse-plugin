import type { HttpClient, Segment } from "@yunzai-ng/types";
import type { BilibiliApp } from "../core/app.js";
import type { BilibiliVideoInfo } from "../types.js";
/** DASH 中的一路视频流 */
interface DashVideo {
    /** 画质 id */
    id: number;
    /** 主地址的主机可能限速，备用地址常能救回来 */
    backupUrl?: string | string[];
    /** 码率 */
    bandwidth?: number;
    /** 宽 */
    width?: number;
    /** 高 */
    height?: number;
    /** 帧率，形如 `60` */
    frameRate?: string;
    /** 编码 id：7=AVC(H.264)、12=HEVC(H.265)、13=AV1 */
    codecid?: number;
    /** 编码串，形如 `avc1.640033` / `hvc1.1.6.L120.90` / `av01.0.08M.08` */
    codecs?: string;
}
/** DASH 中的一路音频流 */
interface DashAudio {
    /** 音质 id：30251 为 FLAC、30250 为杜比 */
    id: number;
    /** 地址 */
    backupUrl?: string | string[];
    /** 码率 */
    bandwidth?: number;
    /** 编码串，形如 `mp4a.40.2`（AAC） / `fLaC` / `ec-3` */
    codecs?: string;
}
/** 播放地址接口返回的 DASH 部分 */
interface DashPayload {
    /** 视频流 */
    video?: DashVideo[];
    /** 音频流 */
    audio?: DashAudio[];
    /** 杜比音频 */
    dolby?: {
        audio?: DashAudio[];
    };
    /** 无损音频 */
    flac?: {
        audio?: DashAudio;
    };
}
/**
 * 检测文本里有没有 B 站链接或号
 * @param text 文本
 * @returns 有则为真
 */
export declare function containsBilibiliLink(text: string): boolean;
/**
 * 从站内链接里取 BV 号
 * @param text 文本
 * @returns 规范化后的 BV 号，取不到为 null
 */
export declare function extractBvid(text: string): string | null;
/**
 * 从文本里取 AV 号
 * @param text 文本
 * @returns AV 号，取不到为 null
 */
export declare function extractAvid(text: string): number | null;
/**
 * 从文本里取短链
 * @param text 文本
 * @returns 短链，取不到为 null
 */
export declare function extractShortLink(text: string): string | null;
/**
 * 从小程序 / 图文卡片里把 B 站链接掏出来
 *
 * QQ 分享 B 站视频时，正文里往往没有链接，只有一个 `json` 段。旧实现只认
 * `com.tencent.miniapp` 与 `com.tencent.tuwen` 两种 `app`，这里保留同样的兜底顺序，
 * 外加一条「任何字段里出现 b23.tv / bilibili.com 就采用」的宽松匹配。
 * @param segments 消息段
 * @returns 链接，取不到为 null
 */
export declare function extractLinkFromSegments(segments: readonly Segment[]): string | null;
/**
 * B 站接口封装
 *
 * 持有一个 `BilibiliApp` 而非裸 `ctx`：配置、凭据、日志都在那里，且都随热重载换新。
 */
export declare class BilibiliApi {
    #private;
    /**
     * @param app 运行期状态
     */
    constructor(app: BilibiliApp);
    /** 取上下文里的 HTTP 客户端 */
    get http(): HttpClient;
    /**
     * 组装请求头，已登录时带上 Cookie
     * @returns 请求头
     */
    headers(): Record<string, string>;
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
    resolveShortUrl(shortUrl: string): Promise<string | null>;
    /**
     * 提取用于去重的视频标识
     *
     * 统一返回 BV 号；短链会先展开。展开失败时返回 null —— 宁可这次不解析，
     * 也不要拿一个「未知」当 key 把后续所有短链都判成重复。
     * @param text 文本
     * @returns 标识，取不到为 null
     */
    extractVideoId(text: string): Promise<string | null>;
    /**
     * 拉取视频信息
     * @param query BV 号或 AV 号
     * @returns 视频信息；接口报错或网络失败为 null
     */
    fetchInfo(query: {
        bvid?: string;
        aid?: number;
    }): Promise<BilibiliVideoInfo | null>;
    /**
     * 从一段文本解析出视频信息（BV / AV / 短链都认）
     * @param text 文本
     * @returns 视频信息，解析不出为 null
     */
    parse(text: string): Promise<BilibiliVideoInfo | null>;
    /**
     * 拉取 DASH 播放地址
     * @param query BV 号、cid
     * @returns DASH 数据；失败为 null
     */
    fetchDash(query: {
        bvid: string;
        cid: number;
    }): Promise<DashPayload | null>;
    /**
     * 从 DASH 里挑出最合适的一路视频与一路音频
     *
     * 指定画质时向下回退而不是向上：使用者填 720P 通常是嫌文件大，给他一路 1080P
     * 等于把这个选择当成了耳边风。
     * @param dash DASH 数据
     * @returns 选中的流
     */
    pickStreams(dash: DashPayload): {
        video?: DashVideo;
        audio?: DashAudio;
    };
    /**
     * 探测 ffmpeg 是否存在（结果缓存，一台机器上不会中途装上）
     * @returns 可用则为真
     */
    hasFfmpeg(): Promise<boolean>;
    /**
     * 下载并合并一个分 P 的视频
     *
     * DASH 的音视频是分离的，必须 ffmpeg 合流，否则群里放出来没有声音。没有 ffmpeg
     * 时退回「只要视频轨」—— 能看画面也好过什么都发不出去，并在日志里说清原因。
     * @param info 视频信息
     * @param maxMB 体积上限（MB）
     * @returns 成品文件绝对路径；失败或超限为 null
     */
    download(info: BilibiliVideoInfo, maxMB: number): Promise<string | null>;
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
    merge(video: string, audio: string, output: string): Promise<boolean>;
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
export declare function buildMergeArgs(video: string, audio: string, output: string): string[];
/**
 * 删除一个临时文件，失败只记日志
 * @param app 运行期状态
 * @param file 路径
 */
export declare function cleanupFile(app: BilibiliApp, file: string | undefined): Promise<void>;
export {};
