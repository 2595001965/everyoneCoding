import type { IpcDependencies, IpcMainLike } from '../types';
import { CHANNELS } from '../channels';

/** window IPC：仅窗口管理；渲染层不得接触任何窗口实现细节。 */
export function registerWindowIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  const withWindow = <T>(
    task: (win: NonNullable<ReturnType<IpcDependencies['getWindow']>>) => T,
  ): T => {
    const win = deps.getWindow();
    if (!win || win.isDestroyed()) {
      throw new Error(JSON.stringify({ code: 'NOT_SUPPORTED', message: '窗口不存在' }));
    }
    return task(win);
  };

  ipc.handle(CHANNELS.window.setTitle, (_e, payload) =>
    withWindow((win) => win.setTitle((payload as { title: string }).title)),
  );
  ipc.handle(CHANNELS.window.minimize, () => withWindow((win) => win.minimize()));
  ipc.handle(CHANNELS.window.maximize, () => withWindow((win) => win.maximize()));
  ipc.handle(CHANNELS.window.unmaximize, () => withWindow((win) => win.unmaximize()));
  ipc.handle(CHANNELS.window.isMaximized, () => withWindow((win) => win.isMaximized()));
  ipc.handle(CHANNELS.window.setFullScreen, (_e, payload) =>
    withWindow((win) => win.setFullScreen((payload as { fullscreen: boolean }).fullscreen)),
  );
  ipc.handle(CHANNELS.window.isFullScreen, () => withWindow((win) => win.isFullScreen()));
  ipc.handle(CHANNELS.window.setSize, (_e, payload) => {
    const { width, height } = payload as { width: number; height: number };
    return withWindow((win) => win.setSize(width, height));
  });
  ipc.handle(CHANNELS.window.getSize, () => withWindow((win) => win.getSize()));
  ipc.handle(CHANNELS.window.center, () => withWindow((win) => win.center()));
  ipc.handle(CHANNELS.window.focus, () => withWindow((win) => win.focus()));
  ipc.handle(CHANNELS.window.close, () => withWindow((win) => win.close()));
}
