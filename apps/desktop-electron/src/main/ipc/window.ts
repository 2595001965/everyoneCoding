import type { IpcDependencies, IpcMainLike } from '../types';
import { CHANNELS } from '../channels';

/** window IPC：仅窗口管理；渲染层不得接触任何窗口实现细节。 */
export function registerWindowIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  ipc.handle(CHANNELS.window.openAgentWindow, (_e, payload) => {
    const input = payload as { projectId: string; projectName: string; sessionId: string; title: string };
    for (const [key, value] of Object.entries(input)) {
      if (typeof value !== 'string' || value.length === 0) throw new TypeError(`参数 ${key} 必须是非空字符串`);
    }
    deps.openAgentWindow(input);
  });
  const withWindow = <T>(
    event: unknown,
    task: (win: NonNullable<ReturnType<IpcDependencies['getWindow']>>) => T,
  ): T => {
    const win = deps.getWindow(event);
    if (!win || win.isDestroyed()) {
      throw new Error(JSON.stringify({ code: 'NOT_SUPPORTED', message: '窗口不存在' }));
    }
    return task(win);
  };

  ipc.handle(CHANNELS.window.setTitle, (event, payload) =>
    withWindow(event, (win) => win.setTitle((payload as { title: string }).title)),
  );
  ipc.handle(CHANNELS.window.minimize, (event) => withWindow(event, (win) => win.minimize()));
  ipc.handle(CHANNELS.window.maximize, (event) => withWindow(event, (win) => win.maximize()));
  ipc.handle(CHANNELS.window.unmaximize, (event) => withWindow(event, (win) => win.unmaximize()));
  ipc.handle(CHANNELS.window.isMaximized, (event) => withWindow(event, (win) => win.isMaximized()));
  ipc.handle(CHANNELS.window.setFullScreen, (event, payload) =>
    withWindow(event, (win) => win.setFullScreen((payload as { fullscreen: boolean }).fullscreen)),
  );
  ipc.handle(CHANNELS.window.isFullScreen, (event) => withWindow(event, (win) => win.isFullScreen()));
  ipc.handle(CHANNELS.window.setSize, (event, payload) => {
    const { width, height } = payload as { width: number; height: number };
    return withWindow(event, (win) => win.setSize(width, height));
  });
  ipc.handle(CHANNELS.window.getSize, (event) => withWindow(event, (win) => win.getSize()));
  ipc.handle(CHANNELS.window.center, (event) => withWindow(event, (win) => win.center()));
  ipc.handle(CHANNELS.window.focus, (event) => withWindow(event, (win) => win.focus()));
  ipc.handle(CHANNELS.window.close, (event) => withWindow(event, (win) => win.close()));
}
