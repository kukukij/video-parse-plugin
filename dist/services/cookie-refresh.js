import { getCorrespondPath } from "../utils/crypto.js";
import { saveCredential } from "./credential.js";
/** 检查 Cookie 是否需要续期 */
const INFO_API = "https://passport.bilibili.com/x/passport-login/web/cookie/info";
/** 拉取 refresh_csrf 的页面 */
const CORRESPOND_API = "https://www.bilibili.com/correspond/1/";
/** 续期 */
const REFRESH_API = "https://passport.bilibili.com/x/passport-login/web/cookie/refresh";
/** 确认续期（不确认的话旧令牌仍有效，等于没换） */
const CONFIRM_API = "https://passport.bilibili.com/x/passport-login/web/confirm/refresh";
/** 请求头 */
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Referer: "https://www.bilibili.com/"
};
/** 单次请求超时（毫秒） */
const TIMEOUT = 15_000;
/** Cookie 续期器 */
export class CookieKeeper {
    /** 运行期状态 */
    #app;
    /** 登录服务：续期成功后要刷新用户信息 */
    #login;
    /**
     * @param app 运行期状态
     * @param login 登录服务
     */
    constructor(app, login) {
        this.#app = app;
        this.#login = login;
    }
    /**
     * 需要时续期一次
     * @returns 是否处于可用状态（无需续期也算成功）
     */
    async refresh() {
        const credential = this.#app.credential;
        if (credential === undefined)
            return false;
        if (credential.refresh_token === undefined || credential.refresh_token === "") {
            this.#app.debug("没有 refresh_token，跳过续期");
            return true;
        }
        const info = await this.#cookieInfo(credential);
        if (info === null)
            return false;
        if (!info.refresh) {
            this.#app.debug("Cookie 仍有效，无需续期");
            return true;
        }
        this.#app.log("info", "检测到哔哩哔哩 Cookie 需要续期");
        const csrf = await this.#refreshCsrf(getCorrespondPath(info.timestamp), credential);
        if (csrf === null) {
            this.#app.log("warn", "拿不到 refresh_csrf，续期中止");
            return false;
        }
        const oldToken = credential.refresh_token;
        const refreshed = await this.#doRefresh(credential, csrf, oldToken);
        if (refreshed === null)
            return false;
        // 先用新 Cookie 确认旧令牌作废，再落盘：确认失败也保存 —— 服务端多数情况下已经换过了
        await this.#confirm(refreshed.credential, oldToken);
        await saveCredential(this.#app.ctx, refreshed.credential);
        this.#app.credential = refreshed.credential;
        this.#app.log("info", "哔哩哔哩 Cookie 续期成功");
        await this.#login.refreshUserInfo();
        this.#app.scheduleSnapshot();
        return true;
    }
    /**
     * 查 Cookie 是否需要续期
     * @param credential 凭据
     * @returns 服务端回答；失败为 null
     */
    async #cookieInfo(credential) {
        try {
            const res = await this.#fetch(`${INFO_API}?csrf=${encodeURIComponent(credential.bili_jct)}`, {
                headers: { ...HEADERS, Cookie: cookieOf(credential) }
            });
            const data = (await res.json());
            if (data.code !== 0) {
                this.#app.debug(`Cookie 状态查询失败：${data.code} ${data.message}`);
                return null;
            }
            return data.data;
        }
        catch (error) {
            this.#app.debug("Cookie 状态查询异常", error);
            return null;
        }
    }
    /**
     * 从对应页面里抠出 refresh_csrf
     * @param path correspondPath
     * @param credential 凭据
     * @returns refresh_csrf；取不到为 null
     */
    async #refreshCsrf(path, credential) {
        try {
            const res = await this.#fetch(`${CORRESPOND_API}${path}`, {
                headers: { ...HEADERS, Cookie: cookieOf(credential) }
            });
            const html = await res.text();
            // 页面里就一行 <div id="1-name">xxx</div>，正则比解析器更不容易被改版打死
            return html.match(/<div id="1-name">([^<]+)<\/div>/)?.[1] ?? null;
        }
        catch (error) {
            this.#app.debug("取 refresh_csrf 异常", error);
            return null;
        }
    }
    /**
     * 执行续期
     * @param credential 旧凭据
     * @param csrf refresh_csrf
     * @param refreshToken 旧 refresh_token
     * @returns 新凭据；失败为 null
     */
    async #doRefresh(credential, csrf, refreshToken) {
        try {
            const res = await this.#fetch(REFRESH_API, {
                method: "POST",
                headers: {
                    ...HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    Cookie: cookieOf(credential)
                },
                body: new URLSearchParams({
                    csrf: credential.bili_jct,
                    refresh_csrf: csrf,
                    source: "main_web",
                    refresh_token: refreshToken
                })
            });
            const data = (await res.json());
            if (data.code !== 0) {
                this.#app.log("warn", `Cookie 续期被拒绝：${data.message}`);
                return null;
            }
            const fresh = readCookies(res);
            if (fresh.sessdata === undefined || fresh.bili_jct === undefined) {
                this.#app.log("warn", "续期响应里没有完整 Cookie，放弃本次结果");
                return null;
            }
            return {
                credential: {
                    sessdata: fresh.sessdata,
                    bili_jct: fresh.bili_jct,
                    dedeuserid: fresh.dedeuserid ?? credential.dedeuserid,
                    refresh_token: data.data.refresh_token,
                    login_time: Date.now()
                }
            };
        }
        catch (error) {
            this.#app.debug("续期请求异常", error);
            return null;
        }
    }
    /**
     * 确认续期，让旧 refresh_token 作废
     * @param credential 新凭据
     * @param oldToken 旧 refresh_token
     */
    async #confirm(credential, oldToken) {
        try {
            await this.#fetch(CONFIRM_API, {
                method: "POST",
                headers: {
                    ...HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    Cookie: cookieOf(credential)
                },
                body: new URLSearchParams({ csrf: credential.bili_jct, refresh_token: oldToken })
            });
        }
        catch (error) {
            // 确认失败不影响新 Cookie 的可用性，下一轮还会再试
            this.#app.debug("确认续期失败", error);
        }
    }
    /**
     * 发一个带超时与卸载信号的请求
     * @param url 地址
     * @param init 请求参数
     * @returns 响应
     */
    async #fetch(url, init) {
        const timeout = AbortSignal.timeout(TIMEOUT);
        const signal = AbortSignal.any([timeout, this.#app.ctx.signal]);
        const res = await fetch(url, { ...init, signal });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return res;
    }
}
/**
 * 拼 Cookie 头
 * @param credential 凭据
 * @returns Cookie 字符串
 */
function cookieOf(credential) {
    return `SESSDATA=${encodeURIComponent(credential.sessdata)}; bili_jct=${credential.bili_jct}; DedeUserID=${credential.dedeuserid}`;
}
/**
 * URL 解码，失败就原样返回
 *
 * SESSDATA 偶尔含裸 `%`，`decodeURIComponent` 对那种值会抛 `URIError`；
 * 一抛出去整轮续期就白跑了，而它本可以忽略那个字符。
 * @param value 原值
 * @returns 解码后的值
 */
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
/**
 * 从响应头里读 Set-Cookie
 * @param res 响应
 * @returns 三个关键 Cookie 的值
 */
function readCookies(res) {
    // `getSetCookie()` 是 Node 20 才有的；退化到合并字符串时仍能按前缀劈开
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const raw = list.length > 0 ? list : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z_]+=)/);
    const out = {};
    for (const item of raw) {
        const sessdata = item.match(/SESSDATA=([^;]+)/)?.[1];
        if (sessdata !== undefined)
            out.sessdata = safeDecode(sessdata);
        const jct = item.match(/bili_jct=([^;]+)/)?.[1];
        if (jct !== undefined)
            out.bili_jct = jct;
        const uid = item.match(/DedeUserID=([^;]+)/)?.[1];
        if (uid !== undefined)
            out.dedeuserid = uid;
    }
    return out;
}
