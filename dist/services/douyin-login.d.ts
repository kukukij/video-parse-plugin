import type { BilibiliApp } from "../core/app.js";
/** 扫码状态；`error` 是本服务加的，用于接口异常 */
export type DouyinLoginStatus = "waiting" | "scanned" | "confirmed" | "expired" | "error";
/** 生成二维码的结果 */
export interface DouyinQr {
    /** PNG 的 base64（不带 data: 前缀） */
    image: string;
    /** 剩余有效秒数 */
    remaining: number;
}
/** 一次轮询的结果 */
export interface DouyinPollResult {
    /** 当前状态 */
    status: DouyinLoginStatus;
    /** 给人看的说明 */
    message: string;
}
/**
 * 抖音扫码登录
 */
export declare class DouyinLogin {
    #private;
    /**
     * @param app 运行期状态
     */
    constructor(app: BilibiliApp);
    /** 当前二维码剩余秒数；没有会话为 0 */
    get remaining(): number;
    /**
     * 生成登录二维码
     * @returns 二维码图片与剩余秒数；失败为 null
     */
    generate(): Promise<DouyinQr | null>;
    /**
     * 轮询扫码结果
     *
     * 成功时把整串 Cookie 写回配置 `douyinCookie`：解析侧读的就是这一项，写完立刻生效。
     * @returns 轮询结果
     */
    poll(): Promise<DouyinPollResult>;
    /** 退出登录：清掉配置里的 Cookie */
    forget(): Promise<void>;
}
