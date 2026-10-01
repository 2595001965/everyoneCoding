import path from 'node:path';

import type { IpcDependencies, IpcMainLike } from '../types';
import { CHANNELS } from '../channels';

/** 与 NSIS 钩子（build/installer.nsh）写入的留档目录逐字一致。 */
function updateBackupDir(): string | null {
  const local = process.env['LOCALAPPDATA'];
  return local ? path.join(local, 'EveryoneCoding-updates', 'electron') : null;
}

/** appInfo IPC：形态、版本、数据目录；workspaceRoot 由主进程持有。 */
export function registerAppInfoIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  let workspaceRoot: string | null = null;

  ipc.handle(CHANNELS.appInfo.get, async () => ({
    kind: 'electron',
    name: deps.app.getName(),
    version: deps.app.getVersion(),
    platform:
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    arch: process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64',
    dataDir: deps.dataDir,
    workspaceRoot,
    locale: deps.app.getLocale(),
    isPackaged: deps.app.isPackaged,
    updateBackupDir: updateBackupDir(),
  }));

  ipc.handle(CHANNELS.appInfo.getDataDir, async () => deps.dataDir);

  ipc.handle(CHANNELS.appInfo.setWorkspaceRoot, async (_e, payload) => {
    workspaceRoot = (payload as { root: string }).root;
    return undefined;
  });
}
