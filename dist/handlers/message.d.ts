/**
 * 模块职责：自动解析 —— 群里有人贴 B 站链接就出卡片
 * 依赖方向：依赖 app、services/bilibili、handlers/card
 * 生命周期：随插件注册，卸载时由内核回收
 * 注意事项：这里用**中间件**而不是命令，是刻意的：
 *
 *          - 命令要前缀，而贴链接的人不会先打 `#bili`；
 *          - `ctx.on("message")` 在内核里是「命令路由之后」的通知，那时别的插件已经
 *            各自处理过一轮，抢不到"先手"，也无法阻断重复解析。
 *
 *          代价是中间件挡在所有命令前面，故每一步都先做最便宜的判断（开关、场景、
 *          前缀、有没有链接），再碰网络。
 */
import type { Disposer, MessageEvent } from "@yunzai-ng/types";
import type { BilibiliApp } from "../core/app.js";
import { type BilibiliApi } from "../services/bilibili.js";
/**
 * 注册自动解析中间件
 * @param app 运行期状态
 * @param api B 站接口
 * @returns 注销句柄
 */
export declare function registerAutoParse(app: BilibiliApp, api: BilibiliApi): Disposer;
/**
 * 解析并发送
 * @param app 运行期状态
 * @param api B 站接口
 * @param e 消息事件
 * @returns 是否已处理（失败也算"处理过"，以免同一插件再试一遍）
 */
export declare function tryParse(app: BilibiliApp, api: BilibiliApi, e: MessageEvent): Promise<boolean>;
