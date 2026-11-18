import type { BilibiliApp } from "../core/app.js";
import type { DouyinLogin } from "../services/douyin-login.js";
import type { BilibiliLogin } from "../services/login.js";
/**
 * 注册全部命令
 * @param app 运行期状态
 * @param login 哔哩哔哩登录服务
 * @param douyin 抖音登录服务
 *
 * 全部注册都经 `ctx` 完成，内核在卸载时自动回收，故这里不必返回句柄。
 */
export declare function registerCommands(app: BilibiliApp, login: BilibiliLogin, douyin: DouyinLogin): void;
