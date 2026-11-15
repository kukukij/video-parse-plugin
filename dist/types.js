/**
 * 模块职责：B 站视频解析的全部数据契约（配置、视频信息、登录凭据）
 * 依赖方向：仅依赖 node 内置类型；不 import 内核，故可被任何一层引用
 * 生命周期：纯类型 + 一处运行期枚举
 * 注意事项：`QrCodeLoginStatus` 的取值是 B 站自己定的，**不能改**，它不是我们的枚举
 */
/** 二维码登录状态（取值来自 B 站，勿改） */
export var QrCodeLoginStatus;
(function (QrCodeLoginStatus) {
    /** 等待扫码 */
    QrCodeLoginStatus[QrCodeLoginStatus["WAITING"] = 86101] = "WAITING";
    /** 已扫码，等待手机确认 */
    QrCodeLoginStatus[QrCodeLoginStatus["SCANNED"] = 86090] = "SCANNED";
    /** 二维码过期 */
    QrCodeLoginStatus[QrCodeLoginStatus["EXPIRED"] = 86038] = "EXPIRED";
    /** 登录成功 */
    QrCodeLoginStatus[QrCodeLoginStatus["SUCCESS"] = 0] = "SUCCESS";
})(QrCodeLoginStatus || (QrCodeLoginStatus = {}));
