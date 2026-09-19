import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { IpcMainLike, IpcSenderLike } from '../types';
import { CHANNELS } from '../channels';

/**
 * process IPC：托管外部子进程（真实后端 / 工具链命令）。
 * stdout / stderr / exit 通过 webContents 推给渲染层，payload 携带子进程 id。
 */

interface ManagedProcess {
  id: string;
  pid: number | null;
  command: string;
  args: string[];
  child: ChildProcessWithoutNullStreams;
}

const processes = new Map<string, ManagedProcess>();
const cleanups: Array<() => void> = [];

function errorPayload(code: string, message: string): Error {
  return new Error(JSON.stringify({ code, message }));
}

export function registerProcessIpc(ipc: IpcMainLike): void {
  ipc.handle(CHANNELS.process.spawn, (event, payload) => {
    const { command, args, options } = payload as {
      command: string;
      args: string[];
      options?: { cwd?: string; env?: Record<string, string>; shell?: boolean };
    };
    if (command.trim().length === 0) {
      throw errorPayload('INVALID_ARGUMENT', '命令不能为空');
    }
    const sender = (event as { sender?: IpcSenderLike } | null)?.sender;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = nodeSpawn(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        shell: options?.shell ?? false,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw errorPayload(
        'PROCESS_SPAWN_FAILED',
        `进程启动失败: ${error instanceof Error ? error.message : ''}`,
      );
    }

    const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    processes.set(id, { id, pid: child.pid ?? null, command, args, child });

    child.stdout.on('data', (chunk: Buffer) => {
      sender?.send(CHANNELS.process.stdout, { id, chunk: chunk.toString('utf8') });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      sender?.send(CHANNELS.process.stderr, { id, chunk: chunk.toString('utf8') });
    });
    child.on('exit', (code, signal) => {
      sender?.send(CHANNELS.process.exit, { id, code, signal });
      processes.delete(id);
    });
    child.on('error', (error: Error) => {
      sender?.send(CHANNELS.process.stderr, { id, chunk: error.message });
      sender?.send(CHANNELS.process.exit, { id, code: null, signal: 'SPAWN_ERROR' });
      processes.delete(id);
    });

    return { id, pid: child.pid ?? null };
  });

  ipc.handle(CHANNELS.process.write, async (_event, payload) => {
    const { id, data } = payload as { id: string; data: string };
    const entry = processes.get(id);
    if (!entry) throw errorPayload('NOT_FOUND', `子进程不存在: ${id}`);
    entry.child.stdin.write(data);
    return undefined;
  });

  ipc.handle(CHANNELS.process.kill, async (_event, payload) => {
    const { id, signal } = payload as { id: string; signal?: string };
    const entry = processes.get(id);
    if (!entry) return false;
    entry.child.kill((signal ?? 'SIGTERM') as NodeJS.Signals);
    return true;
  });

  ipc.handle(CHANNELS.process.list, async () => {
    return [...processes.values()].map((entry) => ({
      id: entry.id,
      pid: entry.pid,
      command: entry.command,
      args: entry.args,
    }));
  });

  ipc.handle(CHANNELS.process.killAll, async () => {
    for (const entry of processes.values()) {
      entry.child.kill('SIGTERM');
    }
    return undefined;
  });

  registerCleanup(() => {
    for (const entry of processes.values()) {
      entry.child.kill('SIGTERM');
    }
    processes.clear();
  });
}

function registerCleanup(task: () => void): void {
  cleanups.push(task);
}

/** 应用退出前清理全部子进程 */
export function disposeProcessIpc(): void {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
}

/** 供测试使用：进程注册表是否为空 */
export function hasActiveProcesses(): boolean {
  return processes.size > 0;
}

/** Windows 下 .bat / .cmd 需要 shell 执行（供 main/index.ts 的默认参数使用） */
export function needsShellForWindows(command: string): boolean {
  return (
    path.extname(command).toLowerCase() === '.bat' || path.extname(command).toLowerCase() === '.cmd'
  );
}
