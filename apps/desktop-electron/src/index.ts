/**
 * @ec/desktop-electron —— Electron 外壳入口。
 * 渲染层通过 createShell('electron') 或 detectShellKind() 获得本形态实现。
 */

export { createElectronShell, getEcShellPreload } from './bridge';
export type { EcShellPreload } from './bridge';
export { CHANNELS, PRELOAD_TOP_LEVEL_KEYS, PRELOAD_METHOD_KEYS } from './main/channels';
export { createPreloadApi, assertSurface } from './preload/api';
export { registerAllIpc, flattenChannels } from './main/ipc';
export type { IpcDependencies } from './main/types';
