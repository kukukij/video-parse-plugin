/**
 * 模块职责：B 站凭据的加密落盘
 * 依赖方向：node:fs、utils/crypto
 * 生命周期：随插件数据目录存在
 * 注意事项：**凭据不进 config.yaml。** 面板的配置接口刻意不脱敏，写进配置等于把
 *          SESSDATA 摊在任何一个能打开面板的人眼前；这里单独一个 0600 的文件，
 *          字段逐项加密，文件被拷走也读不出可用 Cookie。
 */
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptString, encryptString } from "../utils/crypto.js";
/** 凭据文件名 */
const FILE = "credential.json";
/**
 * 凭据文件路径
 * @param ctx 插件上下文
 * @returns 绝对路径
 */
export function credentialFile(ctx) {
    return join(ctx.dataDir, FILE);
}
/**
 * 读取凭据
 *
 * 解密失败的字段会变成空串，此时 `isLoggedIn()` 为假，使用者会被提示重新扫码 ——
 * 这比让请求带着半截 Cookie 去撞 B 站、再报一个看不懂的错误要好。
 * @param ctx 插件上下文
 * @returns 凭据，不存在或读不出时 undefined
 */
export async function loadCredential(ctx) {
    let raw;
    try {
        raw = await readFile(credentialFile(ctx), "utf8");
    }
    catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        const credential = {
            sessdata: decryptString(String(parsed.sessdata ?? "")),
            bili_jct: decryptString(String(parsed.bili_jct ?? "")),
            dedeuserid: decryptString(String(parsed.dedeuserid ?? "")),
            refresh_token: parsed.refresh_token === undefined ? undefined : decryptString(String(parsed.refresh_token)),
            login_time: typeof parsed.login_time === "number" ? parsed.login_time : undefined
        };
        // 三项缺一不可，缺了就当没登录：缺项的 Cookie 发出去只会得到 -101
        if (credential.sessdata === "" || credential.bili_jct === "" || credential.dedeuserid === "") {
            ctx.logger.warn("凭据文件存在但无法解密（多半换过机器），已按未登录处理");
            return undefined;
        }
        return credential;
    }
    catch (error) {
        ctx.logger.warn(`凭据文件损坏，已忽略：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
/**
 * 写入凭据
 * @param ctx 插件上下文
 * @param credential 凭据
 */
export async function saveCredential(ctx, credential) {
    const payload = {
        sessdata: encryptString(credential.sessdata),
        bili_jct: encryptString(credential.bili_jct),
        dedeuserid: encryptString(credential.dedeuserid),
        refresh_token: credential.refresh_token === undefined ? undefined : encryptString(credential.refresh_token),
        login_time: credential.login_time ?? Date.now()
    };
    const file = credentialFile(ctx);
    const tmp = `${file}.tmp`;
    // 先写临时文件再改名：写到一半断电也不会留下半个 JSON，让下次启动读到「凭据损坏」
    // mode 只在创建时生效；磁盘上已有旧文件时改名后仍需 chmod 一次
    await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, file);
    await chmod(file, 0o600).catch(() => undefined);
}
/**
 * 删除凭据
 * @param ctx 插件上下文
 */
export async function clearCredential(ctx) {
    await rm(credentialFile(ctx), { force: true });
}
