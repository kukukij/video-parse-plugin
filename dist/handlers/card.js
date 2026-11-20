/**
 * 模块职责：把视频信息变成一条可发送的消息 —— 优先渲染成卡片图，失败回落封面 + 文字
 * 依赖方向：依赖 app、types、utils/format，消息段来自内核的 `seg`
 * 生命周期：纯函数 + 一次渲染调用
 * 注意事项：渲染器是**可选插件**（renderer-puppeteer），没装、没配好、模板写错都会抛错。
 *          这里一律 catch 住回落为文字：一条链接解析不出来就是一次打扰，不该让群里
 *          看到「渲染失败」这种内部错误。
 */
import { seg } from "@yunzai-ng/core";
import { formatCount, formatDate, formatDuration } from "../utils/format.js";
/** 卡片模板名（相对插件 `templates/`） */
const TEMPLATE = "video-card";
/**
 * 组装模板数据
 * @param info 视频信息
 * @param fps 实际选中的流帧率；拿不到时不显示
 * @returns 模板变量
 */
export function cardData(info, fps) {
    return {
        title: info.title,
        cover: info.pic,
        bvid: info.bvid,
        url: `https://www.bilibili.com/video/${info.bvid}`,
        duration: formatDuration(info.duration),
        view: formatCount(info.stat.view),
        danmaku: formatCount(info.stat.danmaku),
        reply: formatCount(info.stat.reply),
        like: formatCount(info.stat.like),
        coin: formatCount(info.stat.coin),
        favorite: formatCount(info.stat.favorite),
        share: formatCount(info.stat.share),
        ownerName: info.owner.name,
        ownerFace: info.owner.face,
        tname: info.tname || "综合",
        desc: info.desc === "" ? "UP 主没有写简介" : info.desc,
        pubdate: formatDate(info.pubdate),
        pages: info.pages?.length ?? 1,
        fps: Number.isFinite(fps) && (fps ?? 0) > 0 ? String(Math.round(fps)) : ""
    };
}
/**
 * 渲染卡片图
 * @param app 运行期状态
 * @param info 视频信息
 * @param fps 实际选中的流帧率
 * @returns 图片段；无渲染器或渲染失败为 null
 */
export async function renderCard(app, info, fps) {
    try {
        const image = await app.ctx.render(TEMPLATE, cardData(info, fps), {
            // 模板的 `#card` 就是那张卡片本身，截它而不是整页，省得一页空白也算进图里
            selector: "#card",
            // 卡片是纯色背景，jpeg 体积约为 png 的四分之一，编码与上传都更快；
            // 2 倍缩放下 90 质量的文字边缘看不出差别
            type: "jpeg",
            quality: 90,
            viewport: { width: 760, scale: 2 }
        });
        return Array.isArray(image) ? (image[0] ?? null) : image;
    }
    catch (error) {
        app.debug("卡片渲染失败，回落为封面 + 文字", error);
        return null;
    }
}
/**
 * 组装文字版信息
 * @param info 视频信息
 * @returns 文本
 */
export function infoText(info) {
    const lines = [
        `🎬 ${info.title}`,
        `👤 ${info.owner.name} · 📁 ${info.tname || "综合"} · ⏱ ${formatDuration(info.duration)}${info.pubdate ? ` · ${formatDate(info.pubdate)}` : ""}`,
        `▶️ ${formatCount(info.stat.view)} 播放 · 💬 ${formatCount(info.stat.danmaku)} 弹幕 · 👍 ${formatCount(info.stat.like)}`,
        `🪙 ${formatCount(info.stat.coin)} 投币 · ⭐ ${formatCount(info.stat.favorite)} 收藏 · 🔁 ${formatCount(info.stat.share)} 分享`
    ];
    return lines.join("\n");
}
/**
 * 组装"信息部分"的消息段（不含视频）
 *
 * 卡片渲染成功时就是那一张图；失败时是封面 + 文字。**不带链接**：卡片上已经有
 * 标题与 UP 主，再贴一条裸网址只是刷屏（需要链接的话消息里本来就贴着）。
 * @param app 运行期状态
 * @param info 视频信息
 * @param fps 实际选中的流帧率
 * @returns 消息段
 */
export async function buildInfoSegments(app, info, fps) {
    if (app.config.renderCard) {
        const card = await renderCard(app, info, fps);
        if (card !== null)
            return [card];
    }
    return [seg.image(info.pic), seg.text(infoText(info))];
}
/**
 * 把信息段拆成"封面"和"文字"两段，供合并转发分节点使用
 *
 * 转发节点里图片与文字挤在一条会很难看：封面太大、文字被压到缩略图后面。
 * @param segments 由 `buildInfoSegments` 产出的段
 * @returns 封面节点内容与文字节点内容
 */
export function splitForForward(segments) {
    const cover = [];
    const text = [];
    for (const segment of segments) {
        if (segment.type === "image" && cover.length === 0)
            cover.push(segment);
        else
            text.push(segment);
    }
    return {
        cover: cover.length === 0 ? undefined : cover,
        text: text.length === 0 ? undefined : text
    };
}
/**
 * 发送一条解析结果
 *
 * 两种投递形态，由「合并转发（总开关）」决定：
 * 1. 合并转发：卡片（或回落时的封面 + 文字）、视频、评论图各占一个节点，装在**同一条**
 *    转发里。只有一项内容时不套转发 —— 多点一层才看得到内容，不如直发；
 * 2. 直接发送：卡片（可带 @）、视频、评论图逐条发。一条普通消息只能承载一个富媒体，
 *    图片与视频必须分开，否则 QQ 只留下视频。
 *
 * 平台不支持转发或转发失败时自动回落到直接发送。
 *
 * 都不额外贴链接 —— 卡片或封面已经把信息给全了。
 * @param app 运行期状态
 * @param e 触发解析的消息事件
 * @param info 视频信息
 * @param videoFile 已下载的视频路径，也可以是仍在下载的任务：直发时卡片先走，走到视频那一步才等它
 * @param commentsImage 已渲染好的评论图，也可以是仍在渲染的任务；无论何时就绪都排在最后发
 * @param preRenderedSegments 卡片渲染得早时可直接传进来，省掉一次串行等待
 * @returns 是否至少成功送出一条消息
 */
export async function deliver(app, e, info, videoFile, commentsImage, preRenderedSegments) {
    const config = app.config;
    const infoSegments = await (preRenderedSegments ?? buildInfoSegments(app, info));
    const canForward = e.isGroup && config.cardAsForward && e.bot.caps.has("forward");
    let forwarded = false;
    if (canForward) {
        // 转发是一条消息，卡片、视频、评论图都得齐了才能发
        const [video, comments] = await Promise.all([videoFile, commentsImage]);
        const split = splitForForward(infoSegments);
        const nodes = [];
        if (split.cover !== undefined)
            nodes.push(seg.node(split.cover, { name: "视频解析", uid: e.selfId }));
        if (split.text !== undefined)
            nodes.push(seg.node(split.text, { name: "视频解析", uid: e.selfId }));
        if (video !== undefined)
            nodes.push(seg.node([seg.video(video)], { name: "视频解析", uid: e.selfId }));
        if (comments !== undefined && comments !== null) {
            nodes.push(seg.node([comments], { name: "视频解析", uid: e.selfId }));
        }
        // 只有一个节点的转发要多点一层才看得到内容，还不如直发一张卡片
        if (nodes.length > 1) {
            try {
                await e.reply(seg.forward(nodes, { summary: `视频：${info.title}`.slice(0, 48) }));
                forwarded = true;
            }
            catch (error) {
                // 与抖音同一条判定：带视频的转发常常超时后一两秒才真正送达，此时再补发就是两份
                const text = error instanceof Error ? error.message : String(error);
                if (/未收到响应|TimeoutError|超时|timed? ?out/i.test(text)) {
                    app.log("warn", "合并转发超时，消息可能稍后到达，不再补发", error);
                    forwarded = true;
                }
                else {
                    app.log("warn", "合并转发发送失败，改为直接发送", error);
                }
            }
        }
    }
    if (!forwarded) {
        // 直发：卡片一出图就发，不等视频下载；视频下载完跟着发，评论图最后
        const at = config.atSender ? [seg.at(e.sender.uid), seg.text(" ")] : [];
        try {
            await e.reply([...at, ...infoSegments]);
        }
        catch (error) {
            app.log("error", "发送解析结果失败", error);
            return false;
        }
        const video = await videoFile;
        if (video !== undefined) {
            try {
                await e.reply(seg.video(video));
            }
            catch (error) {
                // 信息卡片已经送到了，视频失败不该把整条解析判成失败
                app.log("warn", "视频发送失败，只留信息卡片", error);
            }
        }
        // 没进转发（没开开关、平台不支持、转发失败）时评论图单独发一条
        const comments = await commentsImage;
        if (comments !== undefined && comments !== null) {
            try {
                await e.reply(comments);
            }
            catch (error) {
                app.log("warn", "评论图发送失败", error);
            }
        }
    }
    return true;
}
/**
 * 给消息贴一个表情，表示"在处理"
 *
 * 平台不支持 `reaction` 时静默跳过 —— 这只是锦上添花，不该因为一个表情失败而
 * 让整条解析中断。
 * @param e 消息事件
 * @param emojiId 表情 id：10024 为闪光、124 为 OK
 */
export async function react(e, emojiId) {
    if (!e.bot.caps.has("reaction"))
        return;
    try {
        await e.bot.setReaction?.(e.messageId, emojiId);
    }
    catch {
        // 被风控或平台不支持，忽略
    }
}
