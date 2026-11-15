/**
 * 模块职责：B 站 Cookie 的到期检测与自动续期
 * 依赖方向：依赖 app、login、utils/crypto
 * 生命周期：由插件每天跑一次，随插件卸载自然停止
 * 注意事项：这一处**故意不用 `ctx.http`** —— 续期要从响应头里读 `Set-Cookie`，而
 *          `response.headers` 这个形态在多数封装里只保留一个合并后的值，拿不到
 *          B 站分开发的几条 Cookie。这里用原生 fetch 并配合 `getSetCookie()`，
 *          并要求调用方把 `ctx.signal` 传进来，卸载时照样会中止。
 */
import type { BilibiliApp } from "../core/app.js";
import type { BilibiliLogin } from "./login.js";
/** Cookie 续期器 */
export declare class CookieKeeper {
    #private;
    /**
     * @param app 运行期状态
     * @param login 登录服务
     */
    constructor(app: BilibiliApp, login: BilibiliLogin);
    /**
     * 需要时续期一次
     * @returns 是否处于可用状态（无需续期也算成功）
     */
    refresh(): Promise<boolean>;
}
