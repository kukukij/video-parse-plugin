import type { PluginContext } from "@yunzai-ng/types";
import type { BilibiliConfig } from "../config.js";
import type { BilibiliCredential } from "../types.js";
/** 统计信息的持久化形状 */
interface Stats {
    /** 累计解析成功次数 */
    total: number;
    /** 今日解析成功次数 */
    today: number;
    /** `today` 对应的日期（`toDateString` 形式），跨天时用来归零 */
    day: string;
}
/** 群信息缓存：只记名字，够面板显示即可 */
interface GroupNote {
    /** 群名 */
    name?: string;
    /** 最近一次在本群解析成功的时刻（毫秒） */
    lastAt?: number;
}
/** 面板快照里的一条最近解析 */
export interface RecentParse {
    /** 视频标题 */
    title: string;
    /** BV 号 */
    bvid: string;
    /** 群号 */
    gid: string;
    /** 群名 */
    group?: string;
    /** 时刻（毫秒） */
    at: number;
}
/** 面板读取的状态快照 */
export interface StatusSnapshot {
    /** 插件名 */
    name: string;
    /** 插件版本 */
    version: string;
    /** 生成时刻（毫秒） */
    updatedAt: number;
    /** 已运行毫秒数 */
    uptimeMs: number;
    /** 已运行的易读形式 */
    uptime: string;
    /** 登录状态 */
    login: {
        /** 是否持有凭据 */
        loggedIn: boolean;
        /** 昵称 */
        uname?: string;
        /** mid */
        mid?: number;
        /** 头像 */
        face?: string;
        /** 登录时刻 */
        loginTime?: number;
    };
    /** 统计 */
    stats: {
        /** 累计 */
        total: number;
        /** 今日 */
        today: number;
    };
    /** 群开关现状 */
    groups: Array<{
        gid: string;
        name?: string;
        /** 综合结论：这个群到底解不解析 */
        enabled: boolean;
        /** 是否在黑名单里 */
        blocked: boolean;
        /** 是否在白名单里 */
        whitelisted: boolean;
        lastAt?: number;
    }>;
    /** 白名单是否生效（非空即生效：只解析名单内的群） */
    whitelistActive: boolean;
    /** 关键配置的只读投影 */
    config: {
        enabled: boolean;
        /** 视频下载档位：画质与体积上限已合并成一项 */
        videoMode: string;
        renderCard: boolean;
        cardAsForward: boolean;
        parseCacheTTL: number;
        parseInPrivate: boolean;
        /** 直播录制时长（秒），0 表示只发直播卡片 */
        liveRecord: number;
    };
    /** 抖音侧配置现状：面板按平台分区展示，B 站那几项不再和它混在一起 */
    douyin: {
        /** 是否解析抖音链接 */
        enabled: boolean;
        /** 视频下载档位（画质与体积上限合并） */
        videoMode: string;
        /** 图文图片是否进总转发（嵌套） */
        imagesAsForward: boolean;
        /** 图文动图是否取原视频发送 */
        noteVideo: boolean;
        /** 评论图是否开启 */
        commentEnabled: boolean;
        /** 评论图条数，0 表示不发 */
        commentCount: number;
        /** 直播录制时长（秒），0 表示只发直播卡片 */
        liveRecord: number;
        /** 是否填了登录 Cookie */
        cookieSet: boolean;
    };
    /** 最近解析成功记录，新的在前 */
    recent: RecentParse[];
    /** 当前冷却中的条目数 */
    cacheSize: number;
}
/**
 * 插件运行期状态
 */
export declare class BilibiliApp {
    /** 插件上下文 */
    readonly ctx: PluginContext<BilibiliConfig>;
    /** 启动时刻 */
    readonly startedAt: number;
    /** 当前凭据；未登录时 undefined */
    credential: BilibiliCredential | undefined;
    /** 上一次登录校验拿到的用户信息，供快照与状态命令复用 */
    userInfo: {
        uname: string;
        mid: number;
        face: string;
    } | undefined;
    /** 统计 */
    stats: Stats;
    /** 群名与最近解析时刻 */
    groups: Map<string, GroupNote>;
    /** 最近解析成功记录 */
    recent: RecentParse[];
    /** 解析冷却：`gid:bvid` → 过期时刻 */
    private readonly cooldown;
    /** 快照节流用的定时器 */
    private snapshotTimer;
    /** 自己开的延时任务（如延迟删临时视频），卸载时要一并清掉 */
    private readonly timers;
    /** 快照最后一次落盘的时刻 */
    private lastSnapshotAt;
    /** 是否正在停机 */
    private disposed;
    /**
     * @param ctx 插件上下文
     */
    constructor(ctx: PluginContext<BilibiliConfig>);
    /** 当前配置的只读视图 */
    get config(): Readonly<BilibiliConfig>;
    /** 已运行毫秒数 */
    get uptime(): number;
    /**
     * 从 KV 与磁盘恢复状态
     *
     * 只读不写：setup 里不做任何网络与磁盘重活，30 秒超时是硬约束。
     * @returns 恢复完成
     */
    restore(): Promise<void>;
    /**
     * 写日志
     * @param level 级别
     * @param msg 文案
     * @param extra 附加对象，会随日志一起输出
     */
    log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void;
    /**
     * 写调试日志，仅在 `debug` 打开时输出
     * @param msg 文案
     * @param extra 附加对象
     */
    debug(msg: string, extra?: unknown): void;
    /** 跨天时把今日计数归零 */
    private rollDay;
    /**
     * 记一次成功的解析
     * @param info 视频与群信息
     */
    markParsed(info: {
        bvid: string;
        title: string;
        gid: string;
        group?: string;
    }): Promise<void>;
    /** 把群名缓存写回 KV */
    private persistGroups;
    /**
     * 某个群是否启用解析
     *
     * 黑名单优先于白名单：两边都填的群按黑名单算。白名单为空表示不限群。
     * @param gid 群号
     * @returns 是否启用
     */
    isGroupEnabled(gid: string): boolean;
    /**
     * 某个群是否在黑名单里
     * @param gid 群号
     * @returns 在黑名单里为 true
     */
    isGroupBlocked(gid: string): boolean;
    /**
     * 某个群是否在白名单里
     * @param gid 群号
     * @returns 在白名单里为 true
     */
    isGroupWhitelisted(gid: string): boolean;
    /**
     * 把群加入 / 移出黑名单并落盘
     * @param gid 群号
     * @param blocked 是否拉黑
     * @returns 落盘后的状态
     */
    setGroupBlocked(gid: string, blocked: boolean): Promise<boolean>;
    /**
     * 把群加入 / 移出白名单并落盘
     * @param gid 群号
     * @param listed 是否加入
     * @returns 落盘后的状态
     */
    setGroupWhitelisted(gid: string, listed: boolean): Promise<boolean>;
    /**
     * 该视频在这个群里是否处于冷却中
     * @param gid 群号
     * @param bvid BV 号
     * @returns 冷却中为 true
     */
    inCooldown(gid: string, bvid: string): boolean;
    /**
     * 记一次冷却
     * @param gid 群号
     * @param bvid BV 号
     */
    touchCooldown(gid: string, bvid: string): void;
    /** 冷却表条目数 */
    get cacheSize(): number;
    /**
     * 当前状态快照
     * @returns 可直接 JSON 化的对象
     */
    snapshot(): StatusSnapshot;
    /** 是否持有可用的凭据（不校验是否已过期） */
    isLoggedIn(): boolean;
    /**
     * 安排一次快照落盘
     *
     * 节流而非防抖：连续解析十条视频时，防抖会一直不写盘，面板上就一直是空的。
     */
    scheduleSnapshot(): void;
    /** 快照文件路径 */
    get snapshotFile(): string;
    /** 立即落盘一次（写临时文件再改名，避免面板读到半截 JSON） */
    writeSnapshot(): Promise<void>;
    /**
     * 安排一个延时任务
     *
     * 不用裸 `setTimeout`：它不在 `ctx` 的登记表里，插件卸载后仍会醒来，去动一个
     * 已经不存在的上下文。登记在这里，`dispose()` 时统一清掉。
     * @param fn 任务
     * @param ms 延时毫秒
     */
    later(fn: () => void, ms: number): void;
    /**
     * 释放资源
     *
     * 定时器必须自己收：它不在 `ctx` 的登记表里，`ctx.onDispose` 只认这里主动登记的东西。
     */
    dispose(): void;
}
export {};
