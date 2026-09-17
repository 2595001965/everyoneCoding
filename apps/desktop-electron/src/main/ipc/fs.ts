import { promises as fsp, watch as fsWatchNative, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { IpcMainLike, IpcSenderLike } from '../types';
import { CHANNELS } from '../channels';

/**
 * fs IPC：把 ShellHost.fs 落地为主进程能力。
 * 核心约束：writeAtomic 必须是「写 .tmp → fsync → rename 替换」（NFR-R-02）。
 */

export function registerFsIpc(ipc: IpcMainLike): void {
  const watchers = new Map<string, FSWatcher>();

  ipc.handle(CHANNELS.fs.readText, async (_event, payload) => {
    const { filePath, encoding } = payload as { filePath: string; encoding?: string };
    if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
      throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', message: `不支持的编码: ${encoding}` }));
    }
    return fsp.readFile(filePath, encoding === 'base64' ? 'base64' : 'utf8');
  });

  ipc.handle(CHANNELS.fs.readBinary, async (_event, payload) => {
    const { filePath } = payload as { filePath: string };
    const buffer = await fsp.readFile(filePath);
    return Array.from(buffer);
  });

  ipc.handle(CHANNELS.fs.writeAtomic, async (_event, payload) => {
    const { filePath, data, encoding } = payload as {
      filePath: string;
      data: string | number[];
      encoding?: string;
    };
    const buffer =
      typeof data === 'string' ? Buffer.from(data, encoding === 'base64' ? 'base64' : 'utf8') : Buffer.from(data);
    const tmp = `${filePath}.ec-tmp-${process.pid}-${Date.now()}`;
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(buffer);
      // fsync 确保内容落盘后才允许 rename（断电不产生半截目标文件）
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsp.rename(tmp, filePath);
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    return undefined;
  });

  ipc.handle(CHANNELS.fs.stat, async (_event, payload) => {
    const { filePath } = payload as { filePath: string };
    try {
      const stat = await fsp.stat(filePath);
      return {
        path: filePath,
        size: stat.size,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        readonly: false,
      };
    } catch {
      return null;
    }
  });

  ipc.handle(CHANNELS.fs.readdir, async (_event, payload) => {
    const { dirPath } = payload as { dirPath: string };
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  });

  ipc.handle(CHANNELS.fs.mkdir, async (_event, payload) => {
    const { dirPath, recursive } = payload as { dirPath: string; recursive?: boolean };
    await fsp.mkdir(dirPath, { recursive: recursive ?? true });
    return undefined;
  });

  ipc.handle(CHANNELS.fs.remove, async (_event, payload) => {
    const { target, recursive } = payload as { target: string; recursive?: boolean };
    await fsp.rm(target, { recursive: recursive ?? true, force: true });
    return undefined;
  });

  ipc.handle(CHANNELS.fs.copy, async (_event, payload) => {
    const { source, target } = payload as { source: string; target: string };
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
    return undefined;
  });

  ipc.handle(CHANNELS.fs.rename, async (_event, payload) => {
    const { source, target } = payload as { source: string; target: string };
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(source, target);
    return undefined;
  });

  ipc.handle(CHANNELS.fs.exists, async (_event, payload) => {
    const { target } = payload as { target: string };
    try {
      await fsp.access(target);
      return true;
    } catch {
      return false;
    }
  });

  ipc.handle(CHANNELS.fs.watch, (event, payload) => {
    const { target } = payload as { target: string };
    const watchId = `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sender = (event as { sender?: IpcSenderLike } | null)?.sender;
    const watcher = fsWatchNative(target, { recursive: true }, (eventType, filename) => {
      sender?.send(CHANNELS.fs.watch, {
        id: watchId,
        type: eventType === 'rename' ? 'create' : 'modify',
        path: filename === null ? target : path.join(target, String(filename)),
      });
    });
    watchers.set(watchId, watcher);
    return { id: watchId };
  });

  ipc.handle(CHANNELS.fs.unwatch, (_event, payload) => {
    const { id } = payload as { id: string };
    watchers.get(id)?.close();
    watchers.delete(id);
    return undefined;
  });

  registerCleanup(() => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  });
}

const cleanups: Array<() => void> = [];

function registerCleanup(task: () => void): void {
  cleanups.push(task);
}

/** 应用退出时清理全部 fs watcher */
export function disposeFsIpc(): void {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
}
