import type { IpcDependencies, IpcMainLike } from '../types';
import { CHANNELS } from '../channels';

/** appInfo IPC：形态、版本、数据目录；workspaceRoot 由主进程持有。 */
export function registerAppInfoIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  let workspaceRoot: string | null = null;

  ipc.handle(CHANNELS.appInfo.get, async () => ({
    kind: 'electron',
    name: deps.app.getName(),
    version: deps.app.getVersion(),
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    arch: process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64',
    dataDir: deps.dataDir,
    workspaceRoot,
    locale: deps.app.getLocale(),
    isPackaged: deps.app.isPackaged,
  }));

  ipc.handle(CHANNELS.appInfo.getDataDir, async () => deps.dataDir);

  ipc.handle(CHANNELS.appInfo.setWorkspaceRoot, async (_e, payload) => {
    workspaceRoot = (payload as { root: string }).root;
    return undefined;
  });
}
