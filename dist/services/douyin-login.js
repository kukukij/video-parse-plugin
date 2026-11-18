/**
 * 模块职责：抖音扫码登录 —— 生成二维码、轮询结果、把 Cookie 写回配置、退出
 * 依赖方向：依赖 app；SDK（`@alemonjs/douyin`）用动态 import，缺依赖时只禁用登录，不影响解析
 * 生命周期：二维码会话与设备身份留内存，设备身份另落盘；登出即清 Cookie
 * 注意事项：
 *          1) 二维码生成与轮询必须用**同一个 DouyinHttp 实例**。抖音把「这张码是谁要的」
 *             记在这台客户端的设备身份与 guard 密钥上，拆成两次进程（或重建实例）必然失败；
 *          2) 缺 `bd-ticket-guard` 设备认证时，`check_qrconnect` 会回 `2156 系统繁忙` /
 *             `7 访问太频繁`，看着像限流，其实缺的是 guard 头；
 *          3) 设备身份要落盘：服务端按硬件映射 device_id，换硬件就等于换一台新设备，容易触发风控。
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
/**
 * 桌面客户端 UA
 *
 * 登录全程不能换：抖音把设备指纹、guard 密钥与 UA 绑在一起，中途换一个就查不到这张码了。
 */
const LOGIN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) douyinim/1.2.1 Chrome/130.0.6723.58 Electron/33.2.0-rs.21.release.main.1 Safari/537.36";
/** ttwid 联合注册 */
const TTWID_REGISTER = "https://ttwid.bytedance.com/ttwid/union/register/";
/** 设备身份文件名：机器级，跨重启复用 */
const DEVICE_FILE = "douyin-device.json";
/** 二维码有效期兜底（毫秒）：接口没给 expire_time 时按三分钟算 */
const QR_TTL = 180_000;
/**
 * 抖音扫码登录
 */
export class DouyinLogin {
    /** 运行期状态 */
    #app;
    /** SDK 模块缓存 */
    #sdk;
    /** 当前会话的 HTTP 客户端：必须与二维码一起活着 */
    #http;
    /** 当前二维码的轮询 token */
    #token;
    /** 二维码过期时刻（毫秒） */
    #expireAt = 0;
    /** 设备身份缓存，避免每次生成二维码都读盘 */
    #stored;
    /** 正在生成：两个入口同时点只放一个进去 */
    #busy = false;
    /**
     * @param app 运行期状态
     */
    constructor(app) {
        this.#app = app;
    }
    /** 当前二维码剩余秒数；没有会话为 0 */
    get remaining() {
        if (this.#token === undefined)
            return 0;
        return Math.max(0, Math.floor((this.#expireAt - Date.now()) / 1000));
    }
    /**
     * 生成登录二维码
     * @returns 二维码图片与剩余秒数；失败为 null
     */
    async generate() {
        if (this.#busy)
            return null;
        this.#busy = true;
        try {
            return await this.#generate();
        }
        catch (error) {
            this.#app.log("warn", "抖音扫码登录：生成二维码失败", error);
            return null;
        }
        finally {
            this.#busy = false;
        }
    }
    /**
     * 轮询扫码结果
     *
     * 成功时把整串 Cookie 写回配置 `douyinCookie`：解析侧读的就是这一项，写完立刻生效。
     * @returns 轮询结果
     */
    async poll() {
        const http = this.#http;
        const token = this.#token;
        if (http === undefined || token === undefined) {
            return { status: "expired", message: "没有正在进行的扫码会话，请重新点一次「扫码登录」" };
        }
        if (Date.now() > this.#expireAt) {
            this.#resetSession();
            return { status: "expired", message: "二维码已过期，请重新生成" };
        }
        try {
            const sdk = await this.#load();
            if (sdk === null)
                return { status: "error", message: "缺少 @alemonjs/douyin 依赖，扫码登录不可用" };
            const data = await sdk.checkQrconnect(http, token);
            switch (data.status) {
                case "new":
                    return { status: "waiting", message: "等待扫码" };
                case "scanned":
                    return { status: "scanned", message: "已扫码，请在手机上确认" };
                case "confirmed":
                    return await this.#accept();
                case "expired":
                    this.#resetSession();
                    return { status: "expired", message: "二维码已过期，请重新生成" };
                default:
                    // 非零 error_code 多是缺 guard 头或命中风控，重试没有意义，直接让用户重来
                    if (data.error_code !== 0) {
                        this.#resetSession();
                        return {
                            status: "error",
                            message: `抖音返回 ${data.error_code}：${data.description ?? "请稍后重试"}`
                        };
                    }
                    return { status: "waiting", message: "等待扫码" };
            }
        }
        catch (error) {
            this.#app.log("warn", "抖音扫码轮询异常", error);
            return { status: "error", message: "请求异常，请稍后重试" };
        }
    }
    /** 退出登录：清掉配置里的 Cookie */
    async forget() {
        this.#resetSession();
        await this.#app.ctx.config.patch({ douyinCookie: "" });
        this.#app.scheduleSnapshot();
        this.#app.log("info", "抖音登录 Cookie 已清除");
    }
    /**
     * 真正生成二维码
     * @returns 二维码图片与剩余秒数；失败为 null
     */
    async #generate() {
        const sdk = await this.#load();
        if (sdk === null)
            return null;
        // 新的二维码一律作废旧的：同时只留一张，免得两次扫码的 Cookie 互相覆盖
        this.#resetSession();
        // guard 密钥：公钥随 Cookie 与请求头一起下发，服务端据此给 check_qrconnect 放行
        const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const spki = keys.publicKey.export({ type: "spki", format: "der" });
        // SPKI DER 的最后 65 字节就是未压缩的 P-256 公钥点
        const publicKey = spki.subarray(spki.length - 65).toString("base64");
        const clientData = Buffer.from(JSON.stringify({
            "bd-ticket-guard-version": 2,
            "bd-ticket-guard-iteration-version": 1,
            "bd-ticket-guard-ree-public-key": publicKey,
            "bd-ticket-guard-web-version": 1
        })).toString("base64");
        const stored = await this.#device(sdk);
        if (stored === null)
            return null;
        const ttwid = await this.#ttwid();
        if (ttwid === "")
            this.#app.log("warn", "抖音 ttwid 获取失败，仍尝试申请二维码");
        const initialCookies = [ttwid, `bd_ticket_guard_client_data=${encodeURIComponent(clientData)}`]
            .filter(item => item !== "")
            .join("; ");
        const http = new sdk.DouyinHttp({
            userAgent: LOGIN_UA,
            initialCookies,
            fetch: guardFetch(clientData, publicKey),
            requestTimeoutMs: 15_000
        });
        http.setDevice(stored.device);
        // 失败不阻断：这一步只是让 ttwid 在桌面域也生效
        await sdk.desktopTtwidCheck(http).catch((error) => this.#app.debug("抖音 ttwid 校验失败", error));
        const qr = await sdk.getQrcode(http);
        this.#http = http;
        this.#token = qr.token;
        this.#expireAt = normalizeExpire(qr.expireTime);
        this.#app.log("info", "抖音登录二维码已生成");
        return { image: qr.qrcodeBase64, remaining: this.remaining };
    }
    /**
     * 扫码确认后收尾：取 Cookie、写配置
     * @returns 轮询结果
     */
    async #accept() {
        const cookies = this.#http?.getCookies() ?? "";
        this.#resetSession();
        if (!/(^|;\s*)sessionid=/.test(cookies)) {
            // 只记字段名不记值：Cookie 等价于账号
            this.#app.log("warn", `抖音登录已确认但 Cookie 里没有 sessionid：字段=[${cookieNames(cookies)}]`);
            return { status: "error", message: "登录已确认，但没拿到 Cookie，请重试" };
        }
        await this.#app.ctx.config.patch({ douyinCookie: cookies });
        this.#app.scheduleSnapshot();
        this.#app.log("info", "抖音登录成功，Cookie 已写入配置");
        return { status: "confirmed", message: "登录成功" };
    }
    /**
     * 加载 SDK
     *
     * 单独 import 而不是顶层的静态依赖：这个包会连带 protobufjs 与 ws，插件加载期不该为
     * 「可能永远用不到的登录」付这份开销。没装时只让登录不可用，解析照旧。
     * @returns SDK 模块；不可用时 null
     */
    async #load() {
        if (this.#sdk !== undefined)
            return this.#sdk;
        try {
            this.#sdk = await import("@alemonjs/douyin/sdk");
            return this.#sdk;
        }
        catch (error) {
            this.#app.log("warn", "抖音扫码登录不可用：缺少 @alemonjs/douyin，请先 npm install", error);
            return null;
        }
    }
    /**
     * 取设备身份：优先读盘，没有就注册一台并落盘
     * @param sdk SDK 模块
     * @returns 设备身份；注册失败为 null
     */
    async #device(sdk) {
        if (this.#stored !== undefined)
            return this.#stored;
        const cached = await this.#readDevice();
        if (cached !== null) {
            this.#stored = cached;
            return cached;
        }
        const hardware = randomHardware();
        try {
            const registered = await sdk.registerDesktopDevice(hardware);
            const stored = {
                hardware,
                device: { ...registered, guid: randomBytes(16).toString("hex") }
            };
            await this.#writeDevice(stored);
            this.#stored = stored;
            return stored;
        }
        catch (error) {
            this.#app.log("warn", "抖音设备注册失败，扫码登录暂不可用", error);
            return null;
        }
    }
    /**
     * 读设备身份文件
     * @returns 设备身份；不存在或格式不对为 null
     */
    async #readDevice() {
        try {
            const parsed = JSON.parse(await readFile(join(this.#app.ctx.dataDir, DEVICE_FILE), "utf8"));
            const device = parsed.device;
            if (parsed.hardware === undefined || device === undefined)
                return null;
            if (typeof device.deviceId !== "string" || device.deviceId === "")
                return null;
            if (typeof device.installId !== "string" || typeof device.guid !== "string")
                return null;
            return { hardware: parsed.hardware, device: { deviceId: device.deviceId, installId: device.installId, guid: device.guid } };
        }
        catch {
            return null;
        }
    }
    /**
     * 写设备身份文件
     *
     * 先写临时文件再改名：写到一半断电也不会留下半个 JSON，下次被当成「第一次注册」。
     * @param stored 设备身份
     */
    async #writeDevice(stored) {
        const file = join(this.#app.ctx.dataDir, DEVICE_FILE);
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
        await rename(tmp, file);
    }
    /**
     * 取一份 ttwid
     * @returns `ttwid=…`；失败为空串
     */
    async #ttwid() {
        try {
            const register = await fetch(TTWID_REGISTER, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    region: "cn",
                    aid: 1768,
                    needFid: false,
                    service: "www.douyin.com",
                    migrate_info: { ticket: "", source: "node" },
                    cbUrlProtocol: "https",
                    union: true
                }),
                signal: AbortSignal.timeout(10_000)
            });
            if (!register.ok)
                return "";
            const body = (await register.json());
            if (typeof body.redirect_url !== "string" || body.redirect_url === "")
                return "";
            // 必须 manual：ttwid 挂在 302 的 Set-Cookie 上，跟随后就丢了
            const res = await fetch(body.redirect_url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
            const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
            return cookies.map(line => line.split(";")[0]?.trim() ?? "").find(line => line.startsWith("ttwid=")) ?? "";
        }
        catch (error) {
            this.#app.debug("抖音 ttwid 注册失败", error);
            return "";
        }
    }
    /** 丢弃当前二维码会话与 HTTP 客户端 */
    #resetSession() {
        this.#http = undefined;
        this.#token = undefined;
        this.#expireAt = 0;
    }
}
/**
 * 给请求加上 bd-ticket-guard 三件套
 *
 * `DouyinHttp` 只在配置里开放了 `fetch` 注入，没有提供加头的钩子；包一层正好。
 * 只有 douyin.com 需要，别的域名（ttwid 注册除外）原样放行。
 * @param clientData guard 的 client_data（base64 JSON）
 * @param publicKey P-256 公钥（base64）
 * @returns 可注入 `DouyinHttpConfig.fetch` 的 fetch
 */
function guardFetch(clientData, publicKey) {
    const fetchImpl = globalThis.fetch;
    return async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        let host = "";
        try {
            host = new URL(url).hostname;
        }
        catch {
            // 相对地址不该出现，交给底层处理
        }
        if (!host.endsWith("douyin.com"))
            return fetchImpl(input, init);
        const headers = new Headers(init?.headers);
        headers.set("bd-ticket-guard-client-data", clientData);
        headers.set("bd-ticket-guard-ree-public-key", publicKey);
        headers.set("bd-ticket-guard-version", "2");
        return fetchImpl(input, { ...init, headers });
    };
}
/**
 * 把接口给的过期时间折成毫秒时间戳
 *
 * 抖音多数时候给秒级时间戳，个别版本给毫秒或「剩余秒数」，三种都接住，免得二维码
 * 刚生成就被判过期。
 * @param value `expire_time`
 * @returns 毫秒时间戳
 */
function normalizeExpire(value) {
    if (!Number.isFinite(value) || value <= 0)
        return Date.now() + QR_TTL;
    if (value > 1e12)
        return value;
    if (value > 1e9)
        return value * 1000;
    return Date.now() + value * 1000;
}
/**
 * 造一份稳定的硬件信息
 *
 * Linux 上没有 WMI 可读，字段自造即可 —— 服务端只按它映射 device_id，不校验真伪。
 * 造好之后必须落盘复用，否则每次重启都是一台新设备。
 * @returns 硬件信息
 */
function randomHardware() {
    const hex = (bytes) => randomBytes(bytes).toString("hex").toUpperCase();
    return {
        release: "10.0.19045",
        model: "B660M DS3H AX DDR4",
        uuid: `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`,
        serial: `WD-${hex(8)}`,
        mac: [0x3c, 0x7c, 0x3f, ...randomBytes(3)].map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(":"),
        resolution: "1707x1067",
        timezone: "中国标准时间",
        timezoneName: "Asia/Shanghai",
        timezoneOffset: 28800,
        language: "zh-CN"
    };
}
/**
 * 取 Cookie 里的字段名，用于日志
 * @param jar `a=1; b=2`
 * @returns 逗号分隔的字段名
 */
function cookieNames(jar) {
    return jar
        .split(";")
        .map(pair => (pair.split("=")[0] ?? "").trim())
        .filter(name => name !== "")
        .join(",");
}
