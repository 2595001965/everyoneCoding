import type { IpcDependencies, IpcMainLike } from '../types';
import { CHANNELS } from '../channels';

/** clipboard IPC */
export function registerClipboardIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  ipc.handle(CHANNELS.clipboard.readText, async () => deps.clipboard.readText());
  ipc.handle(CHANNELS.clipboard.writeText, async (_e, payload) => {
    deps.clipboard.writeText((payload as { text: string }).text);
    return undefined;
  });
  ipc.handle(CHANNELS.clipboard.clear, async () => {
    deps.clipboard.clear();
    return undefined;
  });
}
