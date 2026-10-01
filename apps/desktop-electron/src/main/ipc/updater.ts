import type { IpcDependencies, IpcMainLike, UpdaterLike } from '../types';
import { CHANNELS } from '../channels';

/**
 * updater IPC：electron-updater 由 main/index.ts 装配（`updater/electron-updater-host.ts`）。
 * 未配置 updater（如开发环境）时显式报 NOT_SUPPORTED，而不是静默假装成功；
 * 消息里带 `UPDATE_NOT_CONFIGURED:` 标记，渲染层 `classifyUpdateError` 据此归类。
 */
export function registerUpdaterIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  const requireUpdater = (): UpdaterLike => {
    if (!deps.updater) {
      throw new Error(
        JSON.stringify({ code: 'NOT_SUPPORTED', message: 'UPDATE_NOT_CONFIGURED: 自动更新未配置' }),
      );
    }
    return deps.updater;
  };

  ipc.handle(CHANNELS.updater.check, async () => requireUpdater().check());

  ipc.handle(CHANNELS.updater.download, async () => requireUpdater().download());

  ipc.handle(CHANNELS.updater.installAndRestart, async () => {
    await requireUpdater().installAndRestart();
    return undefined;
  });

  ipc.handle(CHANNELS.updater.downloadAndInstall, async () => {
    await requireUpdater().downloadAndInstall();
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
