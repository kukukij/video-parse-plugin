/**
 * 模块职责：插件入口 —— 声明配置 schema，装配各服务，注册命令 / 中间件 / 路由 / 定时任务
 * 依赖方向：依赖 @yunzai-ng/core、本地各模块；不反向引用内核内部路径
 * 生命周期：`setup` 随插件加载执行一次，返回的 disposer 随卸载执行
 * 注意事项：**setup 里不碰网络**。内核给 setup 30 秒，超时按加载失败处理，而登录态校验、
 *          Cookie 续期都是「网络好时 200ms、网络差时 20s」的事，一律放到 `app/ready`
 *          与 cron 里 —— 那时内核已经起完，慢也不会连累插件加载。
 *
 *          命令、中间件、路由、cron、配置订阅全部经 `ctx` 注册，内核自己记着账，卸载时
 *          逆序回收。故 `setup` 的返回值只负责**它自己的东西**：那个装着定时器与冷却表的
 *          `BilibiliApp` 实例。
 */
import { randomBytes } from "node:crypto";
import { definePlugin } from "@yunzai-ng/core";
import { configSchema } from "./config.js";
import { BilibiliApp } from "./core/app.js";
import { registerCommands } from "./handlers/commands.js";
import { registerAutoParse } from "./handlers/message.js";
import { BilibiliApi, containsBilibiliLink } from "./services/bilibili.js";
import { CookieKeeper } from "./services/cookie-refresh.js";
import { BilibiliLogin } from "./services/login.js";
/** Cookie 续期检查的时刻：每天 4:30。挑这个点是因为群里没人说话，失败也不影响谁 */
const REFRESH_CRON = "0 30 4 * * *";
/**
 * 面板扩展页跨域调插件路由时要带的响应头
 *
 * 扩展页在 `allow-scripts` 的 sandbox iframe 里，**没有 `allow-same-origin`**，因此它的
 * origin 是 `null`，发出去的请求一律算跨域。不加这个头，页面拿不到响应体。
 */
const PANEL_CORS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
/**
 * 面板扩展页与插件本体之间的接缝
 *
 * `webadapter/index.js` 由 webui 插件**单独** import，拿不到这里的 `app` / `login` 实例；
 * 而扫码登录要做的生成、轮询、登出都不是只读快照能表达的。故把两个实例挂到 globalThis，
 * 用 `Symbol.for` 取键：同一个进程里，插件目录被改名或挂载成不同路径也仍然是同一个键。
 */
const RUNTIME_KEY = Symbol.for("yunzai-ng.bilibili.runtime");
export default definePlugin({
    // 省了 version / description / author，内核从 package.json 补齐；显式写 name 是为了
    // 让配置文件名、URL 前缀、KV 命名空间都有一个短而稳的标识，不随仓库改名而变
    name: "bilibili",
    configSchema,
    async setup(ctx) {
        const app = new BilibiliApp(ctx);
        const api = new BilibiliApi(app);
        const login = new BilibiliLogin(app);
        const keeper = new CookieKeeper(app, login);
        // 给面板扩展页留一个口子。它在 iframe 里拿不到令牌，只能由面板带令牌转调
        // `registerApi`，而那条通道只能读到快照；扫码需要真调接口，故实例挂在这里
        const runtime = { app, login, panelKey: randomBytes(16).toString("hex") };
        globalThis[RUNTIME_KEY] = runtime;
        // 凭据、统计、群名都要从磁盘与 KV 里捞回来，才能正确应答第一条消息
        await app.restore();
        await app.writeSnapshot();
        // 自动解析：中间件而非命令，见 handlers/message.ts 文件头
        registerAutoParse(app, api);
        registerCommands(app, login);
        // 面板页面在 iframe 里，拿不到令牌，故它读的是 status.json 快照（见 webadapter/）。
        // 这里的接口是给**带令牌**的外部调用方（脚本、接口调试）用的
        ctx.route("GET", "/status", () => app.snapshot());
        ctx.route("GET", "/groups", () => app.snapshot().groups);
        /*
         * 面板扩展页用的两条接口
         *
         * `registerApi` 由面板带令牌转发，但它只支持固定路径、GET、且不许带查询串
         * （面板前端的闸门只放行 `[A-Za-z0-9._/-]`），所以「点一个群直接拉黑」这种带参数的
         * 写操作走不过去。改成插件自己的路由 + `auth: false` + 一次性口令：口令只经面板
         * 转发的那条带鉴权通道下发（见 webadapter 的 `panel` 接口），页面拿它来调这里的
         * `/panel/*`，同时靠 CORS 头把响应读出来。
         */
        const panelDenied = { status: 403, headers: PANEL_CORS, body: { ok: false, error: "口令不对，刷新页面重试" } };
        /** 该请求带的口令对不对 */
        const keyOk = (req) => typeof req.query.k === "string" && req.query.k === runtime.panelKey;
        ctx.route("GET", "/panel/groups", async (req) => {
            if (!keyOk(req))
                return panelDenied;
            const bot = ctx.pickBot();
            if (bot === undefined)
                return { headers: PANEL_CORS, body: { ok: true, groups: [] } };
            try {
                const list = await bot.getGroupList();
                return {
                    headers: PANEL_CORS,
                    body: {
                        ok: true,
                        groups: list.map(group => ({
                            gid: group.gid,
                            name: group.name ?? "",
                            // 多数适配器不给群头像，用 QQ 的群头像地址兜底
                            avatar: group.avatar ?? `https://p.qlogo.cn/gh/${group.gid}/${group.gid}/100/`
                        }))
                    }
                };
            }
            catch (error) {
                app.log("warn", "读取账号已加入的群失败", error);
                return { status: 500, headers: PANEL_CORS, body: { ok: false, error: "读取群列表失败，看日志" } };
            }
        }, { auth: false });
        ctx.route("GET", "/panel/list", async (req) => {
            if (!keyOk(req))
                return panelDenied;
            const gid = typeof req.query.gid === "string" ? req.query.gid : "";
            if (!/^\d{4,12}$/.test(gid))
                return { status: 400, headers: PANEL_CORS, body: { ok: false, error: "群号不合法" } };
            const on = req.query.on === "1";
            const kind = req.query.list === "white" ? "white" : "black";
            if (kind === "white")
                await app.setGroupWhitelisted(gid, on);
            else
                await app.setGroupBlocked(gid, on);
            return {
                headers: PANEL_CORS,
                body: {
                    ok: true,
                    list: kind,
                    on,
                    groupWhitelist: app.config.groupWhitelist ?? [],
                    groupBlacklist: app.config.groupBlacklist ?? []
                }
            };
        }, { auth: false });
        // 给别的插件留一个口子：不想自己写一遍 BV 解析的，直接 inject("bilibili.api")
        ctx.provide("bilibili.api", {
            /**
             * 解析一段文本里的 B 站视频
             * @param text 文本或链接
             * @returns 视频信息，解析不出为 null
             */
            parse: (text) => api.parse(text),
            /**
             * 判断一段文本里有没有 B 站链接
             * @param text 文本
             * @returns 有则为真
             */
            match: (text) => containsBilibiliLink(text)
        });
        // 配置一改（面板表单、YAML 手改、命令），面板页面的数字都要跟上
        ctx.config.onChange(() => app.scheduleSnapshot());
        // 启动后校验一次登录态：Cookie 过期就清掉并记日志，而不是等第一个链接解析失败
        ctx.on("app/ready", () => {
            if (ctx.app.policy.masters.length === 0) {
                app.log("warn", "没有配置主人（bot.masterQQ），私聊「#bili登录 / #bili登出」不会响应；面板里的扫码登录不受影响");
            }
            void login.refreshUserInfo();
        });
        // 停机前把最后的状态写盘，面板刷新时看到的是停机前的数字，而不是十分钟前的
        ctx.on("app/stopping", () => app.writeSnapshot());
        // 每天检查一次 Cookie 是否需要续期；overlap 用 skip，上一轮没跑完就跳过本轮
        ctx.cron(REFRESH_CRON, async () => {
            if (!app.isLoggedIn())
                return;
            await keeper.refresh().catch((error) => app.log("warn", "Cookie 续期任务异常", error));
        }, { name: "B站 Cookie 续期", overlap: "skip", timeout: "2m" });
        app.log("info", `已加载，解析开关=${app.config.enabled ? "开" : "关"}`);
        // 定时器、冷却表不归 ctx 管，必须自己收；globalThis 上那份也要摘掉，
        // 否则热重载后面板页会拿到一个已经被 dispose 的旧实例
        return () => {
            delete globalThis[RUNTIME_KEY];
            app.dispose();
        };
    }
});
