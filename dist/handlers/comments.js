/** 模板名（相对插件 `templates/`） */
const TEMPLATE = "comment-card";
/** 一条评论最多显示几张配图：多出来的不显示，避免一张图被撑得过长 */
const PICTURE_LIMIT = 3;
/**
 * 取评论、渲染成图并发送
 *
 * 顺序上它是第三条消息（第一条卡片、第二条视频），由 `runParse` 在投递之后调用。
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 触发解析的消息事件
 * @param info 视频信息
 */
export async function sendComments(app, api, e, info) {
    const config = app.config;
    if (config.commentSend === false)
        return;
    const limit = config.commentCount ?? 0;
    if (limit <= 0)
        return;
    const minLike = config.commentMinLike ?? 0;
    // 要按点赞过滤时多取一些：过滤完可能不够 limit 条，再补请求不如一次多要
    const requestLimit = minLike > 0 ? Math.min(20, limit * 3) : limit;
    const data = await api.fetchComments(info.aid, requestLimit, info.owner?.mid, {
        sort: config.commentSort ?? "hot",
        replyLimit: config.commentReplyCount ?? 2,
        emote: config.commentShowEmote !== false
    });
    if (data === null)
        return;
    if (data.items.length === 0) {
        app.debug("这条视频还没有评论，跳过评论图");
        return;
    }
    const items = data.items.filter(item => item.like >= minLike).slice(0, limit);
    if (items.length === 0) {
        app.debug(`评论点赞数都低于 ${minLike}，跳过评论图`);
        return;
    }
    const image = await renderComments(app, data.total, items);
    if (image === null)
        return;
    try {
        await e.reply(image);
    }
    catch (error) {
        // 卡片和视频已经送到了，评论图发不出去不该让整条解析算失败
        app.log("warn", "评论图发送失败", error);
    }
}
/**
 * 渲染评论图
 * @param app 运行期状态
 * @param total 评论总数，用于标题旁的数字
 * @param items 评论列表
 * @returns 图片段；没有渲染器或渲染失败为 null
 */
export async function renderComments(app, total, items) {
    try {
        const config = app.config;
        // 关掉的项直接从数据里抹掉，模板不用堆一堆条件判断
        const list = items.map(item => ({
            ...item,
            pictures: config.commentShowPictures === false ? [] : item.pictures.slice(0, PICTURE_LIMIT),
            location: config.commentShowLocation === false ? "" : item.location,
            level: config.commentShowLevel === false ? -1 : item.level
        }));
        const image = await app.ctx.render(TEMPLATE, { total, list }, {
            // 模板的 `#comments` 就是这块评论区本身
            selector: "#comments",
            type: "png",
            viewport: { width: 760, scale: 2 }
        });
        return Array.isArray(image) ? (image[0] ?? null) : image;
    }
    catch (error) {
        app.debug("评论图渲染失败，已跳过", error);
        return null;
    }
}
