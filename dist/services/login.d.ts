/**
 * 模块职责：B 站扫码登录 —— 生成二维码、轮询结果、校验登录态、退出
 * 依赖方向：依赖 app、credential、types
 * 生命周期：二维码会话留在内存，登出即弃；凭据落盘
 * 注意事项：二维码会话**只留一份**。旧实现允许多个会话并存，结果群里两个人同时扫码时
 *          凭据互相覆盖，谁也不知道最后登进去的是谁。这里后扫的顶掉前一个，明确。
 */
import type { BilibiliApp } from "../core/app.js";
import type { BilibiliCredential, BilibiliUserInfo, QrCodeGenerateResult, QrCodePollResult } from "../types.js";
/** 扫码登录 */
export declare class BilibiliLogin {
    #private;
    /**
     * @param app 运行期状态
     */
    constructor(app: BilibiliApp);
    /**
     * 生成登录二维码
     * @returns 二维码内容与密钥；接口失败为 null
     */
    generate(): Promise<QrCodeGenerateResult | null>;
    /**
     * 把二维码内容渲染成 PNG
     *
     * `qrcode` 是可选依赖：没装（例如直接拷目录、没跑过 `npm i`）时不让登录功能把整条
     * 命令拖垮，改为把链接原样发出去，手机仍可从链接进登录页。
     * @param text 二维码内容
     * @returns PNG 字节；不可用时 null
     */
    qrImage(text: string): Promise<Uint8Array | null>;
    /**
     * 轮询扫码结果
     *
     * 成功时顺手落盘凭据并刷新一次用户信息：调用方拿到的就是一个**真的能用**的登录态，
     * 而不是「B 站说成功了但 Cookie 其实已过期」。
     * @param key 轮询密钥，缺省用当前会话
     * @returns 轮询结果
     */
    poll(key?: string): Promise<QrCodePollResult>;
    /**
     * 接受一份凭据：落盘、置入内存、拉一次用户信息
     * @param credential 凭据
     */
    accept(credential: BilibiliCredential): Promise<void>;
    /**
     * 拉当前登录用户信息，顺带校验 Cookie 是否还有效
     * @returns 用户信息；未登录或 Cookie 失效为 null
     */
    refreshUserInfo(): Promise<BilibiliUserInfo | null>;
    /** 退出登录：内存与磁盘一起清 */
    forget(): Promise<void>;
    /** 当前会话还剩多少秒；没有会话为 0 */
    get remaining(): number;
}
