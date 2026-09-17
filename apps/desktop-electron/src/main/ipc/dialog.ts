import type { IpcDependencies, IpcMainLike } from '../types';
import { CHANNELS } from '../channels';

/** dialog IPC：全部破坏性操作（删除/覆盖）在渲染层必须先经 confirm 二次确认。 */
export function registerDialogIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  ipc.handle(CHANNELS.dialog.openFile, async (_event, payload) => {
    const options = (payload ?? {}) as Record<string, unknown>;
    const result = await deps.dialog.showOpenDialog({
      properties: options.multiple === true ? ['openFile', 'multiSelections'] : ['openFile'],
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
      ...(options.filters !== undefined ? { filters: options.filters } : {}),
    });
    return result.canceled ? null : result.filePaths;
  });

  ipc.handle(CHANNELS.dialog.openDirectory, async (_event, payload) => {
    const options = (payload ?? {}) as Record<string, unknown>;
    const result = await deps.dialog.showOpenDialog({
      properties: ['openDirectory'],
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipc.handle(CHANNELS.dialog.saveFile, async (_event, payload) => {
    const options = (payload ?? {}) as Record<string, unknown>;
    const result = await deps.dialog.showSaveDialog({
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
      ...(options.filters !== undefined ? { filters: options.filters } : {}),
    });
    return result.canceled ? null : (result.filePath ?? null);
  });

  ipc.handle(CHANNELS.dialog.showMessage, async (_event, payload) => {
    const options = payload as {
      level: string;
      title: string;
      message: string;
      detail?: string;
      buttons?: string[];
    };
    const type =
      options.level === 'error'
        ? 'error'
        : options.level === 'warning'
          ? 'warning'
          : options.level === 'question'
            ? 'question'
            : 'info';
    const result = await deps.dialog.showMessageBox({
      type,
      title: options.title,
      message: options.message,
      ...(options.detail !== undefined ? { detail: options.detail } : {}),
      buttons: options.buttons ?? ['确定'],
      noLink: true,
    });
    return result.response;
  });

  ipc.handle(CHANNELS.dialog.confirm, async (_event, payload) => {
    const options = payload as { title: string; message: string; detail?: string };
    const result = await deps.dialog.showMessageBox({
      type: 'question',
      title: options.title,
      message: options.message,
      ...(options.detail !== undefined ? { detail: options.detail } : {}),
      buttons: ['取消', '确认'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  });
}
