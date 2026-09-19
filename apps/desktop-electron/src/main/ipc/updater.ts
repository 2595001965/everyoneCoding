import type { IpcDependencies, IpcMainLike } from '../types';
import { CHANNELS } from '../channels';

/**
 * updater IPC：electron-updater 由 main/index.ts 注入。
 * 未配置 updater（如开发环境）时显式报 NOT_SUPPORTED，而不是静默假装成功。
 */
export function registerUpdaterIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  ipc.handle(CHANNELS.updater.check, async () => {
    if (!deps.updater) {
      throw new Error(JSON.stringify({ code: 'NOT_SUPPORTED', message: '自动更新未配置' }));
    }
    return deps.updater.check();
  });

  ipc.handle(CHANNELS.updater.downloadAndInstall, async () => {
    if (!deps.updater) {
      throw new Error(JSON.stringify({ code: 'NOT_SUPPORTED', message: '自动更新未配置' }));
    }
    await deps.updater.downloadAndInstall();
    return undefined;
  });

  // 更新进度直接经主窗口 webContents 推给渲染层
  deps.updater?.onProgress((progress) => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) {
      const webContents = (
        win as unknown as { webContents?: { send: (channel: string, payload: unknown) => void } }
      ).webContents;
      webContents?.send(CHANNELS.updater.onProgress, progress);
    }
  });
}
