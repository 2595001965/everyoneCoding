/**
 * preload 入口：仅在 Electron 渲染进程中执行。
 * 白名单 API 的构造与自检在 ./api.ts（无 electron 依赖，可在测试中审计）。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { createPreloadApi, assertSurface } from './api';

if (process.contextIsolated && contextBridge && ipcRenderer) {
  const exposed = createPreloadApi(ipcRenderer);
  assertSurface(exposed);
  contextBridge.exposeInMainWorld('ecShell', exposed);
}
