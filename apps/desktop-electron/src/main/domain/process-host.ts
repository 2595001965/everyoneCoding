import {
  spawn as nodeSpawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';

import { ShellError } from '@ec/shell-api';

/**
 * 受控进程端口（T12-04 实现要点 3：「预览后端托管必须走受控进程端口」）。
 *
 * 「受控」体现在四件事上，缺一不可：
 * 1. **只有主进程能 spawn**：渲染层拿不到 `child_process`，只能经域 RPC 请求；
 * 2. **命令与工作目录都受约束**：cwd 必须落在工程根内（由调用方用
 *    `ProjectPaths` 解析后传入，避免把 `..` 透给 `spawn`）；
 * 3. **有上限与登记表**：一次最多 `MAX_CONCURRENT` 个子进程，退出时统一回收，
 *    防止用户反复点「启动后端」把机器拖死；
 * 4. **输出不缓冲在内存里无限增长**：按块回调，由调用方（LogStream）负责截断。
 *
 * 与 `ipc/process.ts` 的关系：那份是给渲染层直接用的通用 process IPC；
 * 本文件是**域内**用的进程能力，两者不共用注册表（域内进程不暴露给渲染层），
 * 但都遵守 `ProcessHostPort` 契约以便领域层（`@ec/preview`）在两种形态下可复用。
 */

/** 与 `@ec/preview` 的 `ProcessHostPort` 结构一致（此处不复用其类型，避免领域包反向依赖外壳） */
export interface ControlledProcessHandle {
  readonly id: string;
  readonly pid: number | null;
  onStdout(listener: (chunk: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  onExit(listener: (result: { code: number | null; signal: string | null }) => void): () => void;
  kill(): Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface ControlledProcessHost {
  spawn(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string>; shell?: boolean },
  ): Promise<ControlledProcessHandle>;
  /** 当前活跃进程（诊断 / UI 展示） */
  list(): readonly { id: string; pid: number | null; command: string }[];
  dispose(): Promise<void>;
}

/** 同时活跃的子进程上限：预览场景最多「静态服务 + 后端 + 安装」三条线 */
const MAX_CONCURRENT = 8;

export interface CreateControlledProcessHostOptions {
  /**
   * 允许的工作目录根（工程目录根）。传 null 表示不限制（仅测试用）——
   * 生产必须传，否则 cwd 可被请求方带出任一位置。
   */
  allowedRoot: string | null;
  /** 进程环境变量基线（默认继承当前进程 env） */
  env?: NodeJS.ProcessEnv;
  /** 单进程输出缓冲上限（字符），超出丢弃最早的部分，防止内存膨胀 */
  maxOutputBuffer?: number;
}

interface Entry {
  id: string;
  pid: number | null;
  command: string;
  cwd: string | null;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<{ code: number | null; signal: string | null }>;
  stdoutBuffer: string[];
  stderrBuffer: string[];
  listeners: {
    stdout: Set<(chunk: string) => void>;
    stderr: Set<(chunk: string) => void>;
    exit: Set<(result: { code: number | null; signal: string | null }) => void>;
  };
  settled: boolean;
  timer: NodeJS.Timeout | null;
}

/** 判定 cwd 是否落在允许的根之下（`root + sep` 前缀，杜绝 /root-evil） */
function withinRoot(root: string, cwd: string): boolean {
  const base = root.endsWith('\\') || root.endsWith('/') ? root.slice(0, -1) : root;
  return cwd === base || cwd.startsWith(base + '\\') || cwd.startsWith(base + '/');
}

/** Windows 进程树整棵结束（`taskkill /T /F`）；失败静默，由调用方的超时兜底 */
function killTree(pid: number): Promise<void> {
  return new Promise((resolveKill) => {
    execFile(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 5_000 },
      () => resolveKill(),
    );
  });
}

export function createControlledProcessHost(
  options: CreateControlledProcessHostOptions,
): ControlledProcessHost {
  const entries = new Map<string, Entry>();
  const maxBuffer = options.maxOutputBuffer ?? 200;
  let seq = 0;

  const recycle = (id: string): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entries.delete(id);
  };

  const dispose = async (): Promise<void> => {
    const handles = [...entries.values()];
    await Promise.all(
      handles.map(async (entry) => {
        try {
          entry.child.kill('SIGTERM');
          await entry.exited;
        } catch {
          // 已经在退出的进程：忽略
        }
      }),
    );
    entries.clear();
  };

  return {
    async spawn(command, args, spawnOptions) {
      const cmd = command.trim();
      if (cmd.length === 0) throw new ShellError('INVALID_ARGUMENT', '命令不能为空');
      if (entries.size >= MAX_CONCURRENT) {
        throw new ShellError(
          'INVALID_ARGUMENT',
          `同时运行的外部进程已达上限（${MAX_CONCURRENT}），请先停止部分预览服务`,
        );
      }

      const cwd = spawnOptions?.cwd ?? null;
      if (cwd !== null && options.allowedRoot !== null && !withinRoot(options.allowedRoot, cwd)) {
        // cwd 越界意味着调用方拼错了根目录；在这里拒绝比让进程在别的目录里跑更安全
        throw new ShellError('PATH_ESCAPE', '进程工作目录越出工程根目录，已拒绝启动');
      }

      const env = { ...(options.env ?? process.env), ...(spawnOptions?.env ?? {}) };
      let child: ChildProcessWithoutNullStreams;
      try {
        child = nodeSpawn(cmd, [...args], {
          ...(cwd !== null ? { cwd } : {}),
          env,
          shell: spawnOptions?.shell ?? true,
          windowsHide: true,
        }) as ChildProcessWithoutNullStreams;
      } catch (error) {
        throw new ShellError(
          'PROCESS_SPAWN_FAILED',
          `进程启动失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const id = `dp-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;
      let resolveExit!: (result: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>(
        (resolvePromise) => {
          resolveExit = resolvePromise;
        },
      );

      const entry: Entry = {
        id,
        pid: child.pid ?? null,
        command: cmd,
        cwd,
        child,
        exited,
        stdoutBuffer: [],
        stderrBuffer: [],
        listeners: { stdout: new Set(), stderr: new Set(), exit: new Set() },
        settled: false,
        timer: null,
      };
      entries.set(id, entry);

      const deliver = (kind: 'stdout' | 'stderr', chunk: string): void => {
        const buffer = kind === 'stdout' ? entry.stdoutBuffer : entry.stderrBuffer;
        buffer.push(chunk);
        if (buffer.length > maxBuffer) buffer.splice(0, buffer.length - maxBuffer);
        for (const listener of entry.listeners[kind]) {
          try {
            listener(chunk);
          } catch {
            // 单个监听器抛错不影响其它监听器与进程本身
          }
        }
      };

      const settle = (result: { code: number | null; signal: string | null }): void => {
        if (entry.settled) return;
        entry.settled = true;
        for (const listener of entry.listeners.exit) {
          try {
            listener(result);
          } catch {
            // 同上
          }
        }
        resolveExit(result);
        // 保留一小段时间供"进程已退出但仍有人在读输出"的场景；随后回收登记表
        entry.timer = setTimeout(() => recycle(id), 5_000);
        entry.timer.unref?.();
      };

      child.stdout?.on('data', (chunk: Buffer) => deliver('stdout', chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => deliver('stderr', chunk.toString('utf8')));
      child.on('exit', (code, signal) => settle({ code: code ?? null, signal: signal ?? null }));
      child.on('error', (error: Error) => {
        deliver('stderr', error.message);
        settle({ code: null, signal: 'SPAWN_ERROR' });
      });

      return {
        id,
        pid: child.pid ?? null,
        onStdout(listener) {
          entry.listeners.stdout.add(listener);
          // 回放已缓冲的输出：调用方拿到 handle 之前产生的行不该丢
          for (const buffered of entry.stdoutBuffer) listener(buffered);
          return () => entry.listeners.stdout.delete(listener);
        },
        onStderr(listener) {
          entry.listeners.stderr.add(listener);
          for (const buffered of entry.stderrBuffer) listener(buffered);
          return () => entry.listeners.stderr.delete(listener);
        },
        onExit(listener) {
          if (entry.settled) {
            // 已退出：立即回调，避免调用方 await 一个永远不会触发的事件
            void exited.then(listener);
            return () => undefined;
          }
          entry.listeners.exit.add(listener);
          return () => entry.listeners.exit.delete(listener);
        },
        async kill() {
          if (entry.settled) return;
          try {
            if (process.platform === 'win32' && entry.pid !== null) {
              // Windows 上 kill 掉 `npm run dev` 这类 shell 父进程**不会**带孙进程
              // （node.exe 会变成孤儿，继续占着工程目录与端口，表现为"停了后端但目录删不掉"）。
              // `taskkill /T` 按进程树整棵结束，与 Electron 主进程退出时的回收语义一致。
              await killTree(entry.pid);
            } else {
              child.kill('SIGTERM');
            }
          } catch {
            // 进程可能已消失
          }
          // 给 3 秒优雅退出窗口，超时强杀；否则残留进程会占住端口
          const timeout = setTimeout(() => {
            try {
              if (process.platform === 'win32' && entry.pid !== null) {
                void killTree(entry.pid);
              } else {
                child.kill('SIGKILL');
              }
            } catch {
              // 忽略
            }
          }, 3_000);
          timeout.unref?.();
          try {
            await exited;
          } finally {
            clearTimeout(timeout);
          }
        },
        exited,
      };
    },

    list() {
      return [...entries.values()].map((entry) => ({
        id: entry.id,
        pid: entry.pid,
        command: entry.command,
      }));
    },

    dispose,
  };
}
