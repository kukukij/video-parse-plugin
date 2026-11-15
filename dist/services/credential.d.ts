import type { PluginContext } from "@yunzai-ng/types";
import type { BilibiliCredential } from "../types.js";
/**
 * 凭据文件路径
 * @param ctx 插件上下文
 * @returns 绝对路径
 */
export declare function credentialFile(ctx: PluginContext): string;
/**
 * 读取凭据
 *
 * 解密失败的字段会变成空串，此时 `isLoggedIn()` 为假，使用者会被提示重新扫码 ——
 * 这比让请求带着半截 Cookie 去撞 B 站、再报一个看不懂的错误要好。
 * @param ctx 插件上下文
 * @returns 凭据，不存在或读不出时 undefined
 */
export declare function loadCredential(ctx: PluginContext): Promise<BilibiliCredential | undefined>;
/**
 * 写入凭据
 * @param ctx 插件上下文
 * @param credential 凭据
 */
export declare function saveCredential(ctx: PluginContext, credential: BilibiliCredential): Promise<void>;
/**
 * 删除凭据
 * @param ctx 插件上下文
 */
export declare function clearCredential(ctx: PluginContext): Promise<void>;
