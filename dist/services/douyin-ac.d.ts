/**
 * 从挑战页 HTML 里取出 VM 脚本
 * @param html 挑战页
 * @returns 脚本源码；没找到为空串
 */
export declare function extractChallengeScript(html: string): string;
/**
 * 从响应头的 Set-Cookie 里取 `__ac_nonce`
 * @param headers 响应头
 * @returns nonce；没有为空串
 */
export declare function nonceOf(headers: Headers): string;
/**
 * 跑挑战脚本，算出 `__ac_signature`
 * @param html 挑战页 HTML
 * @param nonce 响应头下发的 `__ac_nonce`
 * @param userAgent 与请求一致的 UA，脚本会读它
 * @returns 签名串
 */
export declare function solveAcChallenge(html: string, nonce: string, userAgent: string): string;
