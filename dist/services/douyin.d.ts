import type { BilibiliApp } from "../core/app.js";
import type { DouyinCommentResult, DouyinLiveInfo, DouyinQuality, DouyinShareTarget, DouyinInfo } from "../types/douyin.js";
/**
 * 抖音服务
 */
export declare class DouyinApi {
    #private;
    constructor(app: BilibiliApp);
    /**
     * 从一段文本里认出抖音作品 id
     *
     * 支持：`www.douyin.com/video/{id}`、`/note/{id}`、`iesdouyin.com/share/video/{id}`、
     * `v.douyin.com/{短码}`（返回短码，需再展开）、以及裸 19 位数字 id。
     * @param text 消息原文
     * @returns 作品 id 或短链；没有则 null
     */
    static extractTarget(text: string): {
        kind: "id" | "short";
        value: string;
    } | null;
    /**
     * 文本里有没有抖音链接/口令
     * @param text 消息原文
     * @returns 有则 true
     */
    static hasLink(text: string): boolean;
    /**
     * 展开短链，区分作品页与直播间
     *
     * 直播短链会落到 `webcast.amemv.com/.../reflow/{roomId}`，它不是作品，直接去抓分享页
     * 只会拿到空壳；这里先认出来，交给 `fetchLive` 单独处理。
     * @param url 短链
     * @returns 作品或直播目标；展开失败为 null
     */
    resolveShort(url: string): Promise<DouyinShareTarget | null>;
    /**
     * 取直播间的主播、标题与流地址
     *
     * 页面里的 FLV/HLS 地址带时效签名，拿到就能播。页面结构变了就返回 null，调用方
     * 静默跳过，不影响其他消息。
     * @param url 直播间页地址
     * @param roomId 直播间 id
     * @returns 直播间信息；页面里没有房间信息时为 null
     */
    fetchLive(url: string, roomId: string): Promise<DouyinLiveInfo | null>;
    /**
     * 录一小段直播
     *
     * 直播是无限流，不能整场下载；用 ffmpeg 从 FLV 直接 `-c copy` 截前 N 秒，不转码，
     * CPU 开销很小。超过时长上限或 ffmpeg 不在就返回 null，调用方只保留文字提示。
     * @param info 直播间信息
     * @param seconds 录多少秒
     * @param maxMB 体积上限
     * @returns 本地 mp4 路径；失败为 null
     */
    recordLive(info: DouyinLiveInfo, seconds: number, maxMB?: number): Promise<string | null>;
    /**
     * 取作品信息
     * @param awemeId 作品 id
     * @returns 作品信息；失败为 null
     */
    fetchInfo(awemeId: string): Promise<DouyinInfo | null>;
    /**
     * 把 vid 换成无水印播放地址
     * @param uri `play_addr.uri`
     * @param prefer 期望画质
     * @returns 地址与体积；都不可用为 null
     */
    pickPlayUrl(uri: string, prefer: DouyinQuality): Promise<{
        url: string;
        ratio: DouyinQuality;
    } | null>;
    /**
     * 下载作品视频
     * @param info 作品信息
     * @param maxMB 体积上限
     * @param quality 期望画质
     * @returns 本地路径；失败为 null
     */
    download(info: DouyinInfo, maxMB: number, quality: DouyinQuality): Promise<string | null>;
    /**
     * 取图文作品里的动图视频
     *
     * 动图信息只出现在登录后的桌面作品页 HTML 里：匿名页只有 72KB 且不含动画数据，
     * 带 Cookie 的页面会多出一个 `video.playAddr` 块。一次请求约 1–2 秒，
     * 普通图文没有这个块，直接回落静态图，不会像浏览器方案那样干等。
     * @param awemeId 作品 id
     * @returns 视频直链；没 Cookie 或不是动图为 null
     */
    fetchNoteVideo(awemeId: string): Promise<string | null>;
    /**
     * 下载动图视频
     * @param awemeId 作品 id
     * @param url 直链
     * @param maxMB 体积上限
     * @returns 本地路径；失败或超限为 null
     */
    downloadNoteVideo(awemeId: string, url: string, maxMB?: number): Promise<string | null>;
    /**
     * 把远程 mp4 落到临时目录
     * @param url 视频直链
     * @param stem 文件名前缀
     * @param maxMB 体积上限
     * @param referer 请求来源
     * @param timeout 下载超时
     * @returns 本地路径；失败或超限为 null
     */
    private saveVideo;
    /**
     * 取评论
     *
     * 评论接口要 `a_bogus`：签名内容就是查询串，且和 UA 绑定，两处不一致就会被拒。
     * `abogus` 包缺失时返回 null（评论图直接跳过，不影响卡片和视频）。
     * @param awemeId 作品 id
     * @param limit 最多几条
     * @returns 评论总数与列表；失败为 null
     */
    fetchComments(awemeId: string, limit: number, authorSecUid?: string, options?: {
        replyLimit?: number;
        minLike?: number;
        showEmote?: boolean;
        showPictures?: boolean;
    }): Promise<DouyinCommentResult | null>;
}
/**
 * 从桌面作品页里取动图视频
 *
 * 登录后的作品页会在图片对象里多带一个 `video` 块（camelCase 的 `playAddr`），
 * 普通图文没有。页面里的 JSON 是转义过的，先把 `\"` 和 `\u0026` 还原再匹配。
 * @param html 作品页 HTML
 * @returns 视频直链；不是动图或页面改版为 null
 */
export declare function parseNoteVideo(html: string): string | null;
/**
 * 从直播间页里取主播、标题、开播状态与流地址
 *
 * 页面是 SSR 出来的，主播与标题就在 `bottom-username-*` / `bottom-title-*` 这两个
 * 带哈希的 class 里；播放器节点上直接带着 FLV 地址（`url="..."`），没有时退回 HLS。
 * 哈希每次发版都会变，所以只认前缀。React 会在文本中间插 `<!-- -->`，先去掉再匹配。
 * @param html 直播间页 HTML
 * @returns 昵称、标题、封面、在线/看过/粉丝/点赞与流地址；主播和标题都没取到为 null
 */
export declare function parseLiveInfo(html: string): {
    nickname: string;
    title: string;
    cover: string;
    online: number;
    totalViewers: number;
    followers: number;
    likes: number;
    newFollowers: number;
    startedAt: number;
    finishedAt: number;
    living: boolean;
    streamUrl: string;
} | null;
