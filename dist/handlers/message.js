import { cleanupFile, containsBilibiliLink, extractLinkFromSegments } from "../services/bilibili.js";
import { resolveVideo } from "../utils/video.js";
import { buildInfoSegments, deliver, react } from "./card.js";
import { buildCommentsImage } from "./comments.js";
import { buildLiveCard, deliverLive } from "./live.js";
/** 自动解析的中间件优先级：比默认的 100 靠里，让改写类中间件先跑 */
const PRIORITY = 200;
/**
 * 注册自动解析中间件
 * @param app 运行期状态
 * @param api B 站接口
 * @returns 注销句柄
 */
export function registerAutoParse(app, api) {
    return app.ctx.middleware(async (e, next) => {
        if (e.kind !== "message")
            return next();
        if (app.config.biliEnabled === false)
            return next();
        if (!shouldConsider(app, e))
            return next();
        try {
            const handled = await tryParse(app, api, e);
            // 解析成功就不再往下走：同一条消息交给别的插件再解析一遍，群里会出两份。
            //
            // 这里显式 `e.stop()`，而不是「什么都不做直接 return」：两种写法效果一样，
            // 但后者内核会在 trace 里记一句「中间件未调用 next()，事件到此中断」，日志
            // 文件按设计记全量，于是每解析一条就多一行，看着像报错。`stop()` 是内核
            // 认可的「这条我收了」，不产生那行噪音，也不影响后续中间件的语义。
            if (handled) {
                e.stop();
                return;
            }
        }
        catch (error) {
            // 中间件抛错会打断整条管线，连命令都轮不到；这里兜住，把问题留在日志里
            app.log("error", "自动解析异常", error);
        }
        return next();
    }, { kind: "message", priority: PRIORITY });
}
/**
 * 这条消息值不值得进入解析流程（纯内存判断，不碰网络）
 * @param app 运行期状态
 * @param e 消息事件
 * @returns 值得则为真
 */
function shouldConsider(app, e) {
    // 频道暂不支持：段模型能表达，但 B 站卡片的分页与视频上传在频道语义下对不上
    if (e.scene === "guild")
        return false;
    if (e.scene === "private" && !app.config.parseInPrivate)
        return false;
    const text = e.text;
    for (const prefix of app.config.ignorePrefixes ?? []) {
        if (prefix !== "" && text.startsWith(prefix))
            return false;
    }
    // 小程序卡片正文里没有链接，只有 json 段，故两种来源都要看
    return containsBilibiliLink(text) || extractLinkFromSegments(e.message) !== null;
}
/**
 * 解析并发送
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 消息事件
 * @returns 是否已处理（失败也算"处理过"，以免同一插件再试一遍）
 */
export async function tryParse(app, api, e) {
    const target = extractLinkFromSegments(e.message) ?? e.text;
    const gid = e.group?.gid ?? `private:${e.sender.uid}`;
    // 黑名单里的群直接放行给后续插件：既不解析，也不把消息吞掉
    if (e.isGroup && e.group !== undefined && !app.isGroupEnabled(e.group.gid))
        return false;
    return runParse(app, api, e, target, gid);
}
/**
 * 真正跑一次解析并投递
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 消息事件
 * @param target 待解析的文本或链接
 * @param gid 群号（私聊时为 `private:<uid>`）
 * @returns 是否已处理
 */
async function runParse(app, api, e, target, gid) {
    const startedAt = Date.now();
    // 直播间没有 BV 号，`parse` 认不出来；先把短链展开这一次，后面的 `parse` 直接用结果
    const expanded = await api.expandTarget(target);
    if (expanded.liveRoomId !== null) {
        return handleLive(app, api, e, expanded.liveRoomId, gid);
    }
    // 冷却判断放在短链展开之后：展开后的地址里已经有 BV 号，不会再走一次跳转
    if (app.config.parseCacheTTL > 0) {
        const videoId = await api.extractVideoId(expanded.url);
        if (videoId !== null && app.inCooldown(gid, videoId)) {
            app.debug(`群 ${gid} 里 ${videoId} 还在冷却中，跳过`);
            return true;
        }
    }
    // 表情只是「在处理」的提示，不必占住解析的起跑线
    void react(e, "10024");
    const info = await api.parse(expanded.url);
    if (info === null) {
        app.debug("链接存在但解析失败，静默跳过");
        return true;
    }
    app.debug(`解析成功 ${info.bvid}，耗时 ${Date.now() - startedAt}ms`);
    // 下载、评论图、卡片三者互不依赖，同时起跑：卡片一出图就先直发，视频下载完跟着发，
    // 评论图无论多早就绪都留到最后
    const profile = resolveVideo(app.config.videoMode);
    const videoTask = (async () => {
        if (profile === null)
            return undefined;
        const file = await api.download(info, profile.maxMB);
        if (file === null)
            app.log("warn", `视频未下载，仅发送信息：${info.bvid}`);
        return file ?? undefined;
    })();
    // 评论图先备好：转发开启时它是转发里的一个节点（聊天记录），关闭时 deliver 单独发
    const commentsTask = buildCommentsImage(app, api, e, info);
    const sent = await deliver(app, e, info, videoTask, commentsTask, await buildInfoSegments(app, info));
    if (sent) {
        await app.markParsed({ bvid: info.bvid, title: info.title, gid, group: e.group?.name });
        app.touchCooldown(gid, info.bvid);
        await react(e, "124");
    }
    // deliver 已经等过下载，这里拿到的必然是最终结果
    const videoFile = await videoTask;
    if (videoFile !== undefined) {
        // 发送接口返回时文件已被平台读完，但 QQ 侧可能仍在转码；留一分钟再删更稳妥
        app.later(() => void cleanupFile(app, videoFile), 60_000);
    }
    return true;
}
/**
 * 处理直播间链接
 *
 * 直播没有「作品」，先按 `liveRecord` 录一小段，再把直播卡片和片段一起发出去；
 * 下播的房间只发卡片。不额外发「信息 + 链接」的文字消息。
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 消息事件
 * @param roomId 直播间号
 * @param gid 群号（私聊时为 `private:<uid>`）
 * @returns 恒为 true：直播消息由本插件收掉
 */
async function handleLive(app, api, e, roomId, gid) {
    const key = `live:${roomId}`;
    if (app.inCooldown(gid, key)) {
        app.debug(`群 ${gid} 里直播间 ${roomId} 还在冷却中，跳过`);
        return true;
    }
    const startedAt = Date.now();
    void react(e, "10024");
    const info = await api.fetchLiveInfo(roomId);
    if (info === null) {
        app.debug(`直播间 ${roomId} 信息拉取失败，静默跳过`);
        return true;
    }
    // 卡片只要信息，与录制互不依赖：先起渲染，让它的两秒藏在录制里
    const cardTask = buildLiveCard(app, "bilibili", info);
    const seconds = Math.max(0, Math.min(60, Number(app.config.liveRecord ?? 0)));
    let videoFile;
    if (info.living && seconds > 0) {
        const file = await api.recordLive(info, seconds);
        if (file !== null)
            videoFile = file;
    }
    const sent = await deliverLive(app, e, info, "bilibili", videoFile, "", cardTask);
    if (sent) {
        app.touchCooldown(gid, key);
        await react(e, "124");
    }
    if (videoFile !== undefined) {
        app.later(() => void cleanupFile(app, videoFile), 60_000);
    }
    app.debug(`直播间 ${roomId} 已处理，耗时 ${Date.now() - startedAt}ms`);
    return true;
}
