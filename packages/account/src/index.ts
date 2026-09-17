/**
 * @ec/account —— 账号客户端（T9-05）。
 *
 * 边界（D-02 / D-06 / D-09）：服务端**仅**负责账号注册/登录与版本更新；
 * 不提供云同步、远程配置下发与分享链接。
 *
 * 浏览器安全：本包全部模块为纯逻辑 + 端口注入（网络经 `TransportPort`、
 * 令牌经 `SecureStorePort`、系统能力经 `SystemPort`），无 Node 内置模块依赖。
 */

export * from './auth-types';
export * from './auth-client';
export * from './session';
export * from './binding';
export * from './offline';
export * from './security';
export * from './oauth/google';
export * from './oauth/github';
export * from './oauth/wechat';
