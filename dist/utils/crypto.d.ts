/**
 * 计算 Cookie 刷新所需的 `correspondPath`
 * @param timestamp 服务端返回的毫秒时间戳
 * @returns 十六进制字符串，拼进 `https://www.bilibili.com/correspond/1/<path>`
 */
export declare function getCorrespondPath(timestamp: number): string;
/**
 * 加密一段文本
 * @param plaintext 明文
 * @returns `ENC:` 开头的密文；空串原样返回
 */
export declare function encryptString(plaintext: string): string;
/**
 * 解密一段文本
 *
 * 解不开（换了机器、文件被改）时返回空串：调用方据此判断凭据不可用并提示重新登录，
 * 比抛错让整条命令失败要好。
 * @param ciphertext `ENC:` 开头的密文，或历史遗留的明文
 * @returns 明文
 */
export declare function decryptString(ciphertext: string): string;
