/**
 * 模块职责：凭据落盘所需的对称加密，以及 B 站 Cookie 刷新用的 RSA 加密
 * 依赖方向：仅 node:crypto / node:os
 * 生命周期：密钥按需派生并缓存一次
 * 注意事项：这里的密钥由**本机特征**派生，不是密码学意义上的安全边界 —— 它挡的是
 *          「数据目录被顺手拷走、备份传到别处」这类事故，挡不住已经把整台机器拿下的人。
 *          真要更强，应把凭据交给系统钥匙串（各平台做法不一，本插件不引入这层依赖）。
 */
import crypto from "node:crypto";
import os from "node:os";
/* ────────────────────────────── B 站 refresh 用的 RSA ────────────────────────────── */
/** B 站 `correspondPath` 所用的公钥，取自其前端脚本 */
const CORRESPOND_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;
/**
 * 计算 Cookie 刷新所需的 `correspondPath`
 * @param timestamp 服务端返回的毫秒时间戳
 * @returns 十六进制字符串，拼进 `https://www.bilibili.com/correspond/1/<path>`
 */
export function getCorrespondPath(timestamp) {
    return crypto
        .publicEncrypt({ key: CORRESPOND_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(`refresh_${timestamp}`))
        .toString("hex");
}
/* ────────────────────────────── 凭据落盘的 AES-GCM ────────────────────────────── */
/** 对称算法 */
const ALGORITHM = "aes-256-gcm";
/** 密钥长度（字节） */
const KEY_LENGTH = 32;
/** IV 长度（字节） */
const IV_LENGTH = 12;
/** 密文前缀，用于识别「这串已经加密过」 */
const PREFIX = "ENC:";
/** 派生密钥用的固定盐；换掉它等于让所有旧凭据作废 */
const SALT = "yunzai-plugin-bilibili/credential/v1";
/** 派生过一次就记住：PBKDF2 十万轮不便宜，而它每次重启只该算一次 */
let cachedKey;
/**
 * 拼出本机特征串
 * @returns 主机名 + 平台 + 架构 + 首个非内网网卡 MAC
 */
function machineFingerprint() {
    const macs = Object.values(os.networkInterfaces())
        .flat()
        .filter(iface => iface !== undefined && !iface.internal && iface.mac !== "00:00:00:00:00:00")
        .map(iface => iface?.mac)
        .slice(0, 1);
    return [os.hostname(), os.platform(), os.arch(), ...macs].filter(Boolean).join("|");
}
/**
 * 取加密密钥（本机特征 → PBKDF2）
 * @returns 32 字节密钥
 */
function key() {
    cachedKey ??= crypto.pbkdf2Sync(machineFingerprint(), SALT, 100_000, KEY_LENGTH, "sha256");
    return cachedKey;
}
/**
 * 加密一段文本
 * @param plaintext 明文
 * @returns `ENC:` 开头的密文；空串原样返回
 */
export function encryptString(plaintext) {
    if (plaintext === "")
        return plaintext;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${PREFIX}${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${body.toString("hex")}`;
}
/**
 * 解密一段文本
 *
 * 解不开（换了机器、文件被改）时返回空串：调用方据此判断凭据不可用并提示重新登录，
 * 比抛错让整条命令失败要好。
 * @param ciphertext `ENC:` 开头的密文，或历史遗留的明文
 * @returns 明文
 */
export function decryptString(ciphertext) {
    if (ciphertext === "")
        return ciphertext;
    // 未加密的旧数据直接放行，避免升级后突然「登录失效」
    if (!ciphertext.startsWith(PREFIX))
        return ciphertext;
    const parts = ciphertext.slice(PREFIX.length).split(":");
    if (parts.length !== 3)
        return "";
    const [ivHex, tagHex, bodyHex] = parts;
    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, "hex"));
        decipher.setAuthTag(Buffer.from(tagHex, "hex"));
        return Buffer.concat([decipher.update(Buffer.from(bodyHex, "hex")), decipher.final()]).toString("utf8");
    }
    catch {
        return "";
    }
}
