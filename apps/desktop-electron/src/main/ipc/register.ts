/**
 * IPC 注册辅助的历史说明：
 *
 * 早期方案曾提供 onInvoke/onSync 包装（同步通道用于 path 能力）。
 * 现行方案（T0-04 定稿）：
 * - 全部能力走异步 ipcMain.handle（见 ipc/index.ts 的 registerAllIpc）
 * - path 为渲染层本地纯计算（shell-api 的 createPathApi），不再设同步通道
 * - 错误统一以 `JSON {code,message}` 过通道，解析见 ipc/error.ts 与 src/bridge.ts
 *
 * 本文件仅保留错误包装工具的转发，避免旧引用失效。
 */
export { toWireError, parseWireError, type WireError } from './error';
