/**
 * Tauri 2 外壳：把 `ShellHost` 接口落地为 Rust 命令 + `invoke` 桥接层。
 *
 * 渲染层只通过 `@ec/shell-api` 的 `createShell('tauri')` 取得本实现，
 * 禁止直接 import `@tauri-apps/*`（本文件是唯一授权的桥接层）。
 *
 * 命令命名约定：Rust 命令使用蛇形命名（如 `fs_write_atomic`），与 `ShellHost` 方法一一对应。
 */

import { invoke, Channel } from '@tauri-apps/api/core';

import {
  registerShellFactory,
  DOMAIN_KINDS,
  ShellError,
  toShellError,
  type AiControlHost,
  type AiRpcRequest,
  type AiRpcResponse,
  type AiStreamEvent,
  type AiStreamHandle,
  type AiStreamRequest,
  type AppInfo,
  type AppInfoApi,
  type ChildProcessHandle,
  type ClipboardApi,
  type DialogApi,
  type DomainControlHost,
  type DomainDescriptor,
  type DomainRpcRequest,
  type DomainRpcResponse,
  type FsApi,
  type FsDirent,
  type FsStat,
  type FsWatchEvent,
  type FsWatchHandle,
  type MessageDialogOptions,
  type NetApi,
  type NetRequest,
  type NetResponse,
  type OpenDialogOptions,
  type PathApi,
  type ProcessApi,
  type ProcessExit,
  type ProcessInfo,
  type SaveDialogOptions,
  type SecureNamespace,
  type SecureStoreApi,
  type ShellCapabilities,
  type ShellHost,
  type SpawnOptions,
  type Unsubscribe,
  type UpdateInfo,
  type UpdateProgress,
  type UpdaterApi,
  type WindowApi,
  type WindowSize,
  type WriteAtomicOptions,
} from '@ec/shell-api';

// ---------------------------------------------------------------------------
// 调用封装与错误归一化
// ---------------------------------------------------------------------------

/** 剥离 `undefined`，兼容 exactOptionalPropertyTypes。 */
function clean<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 提取 `{ code, message }` 结构，还原为 `ShellError`。 */
function extractShellError(err: unknown): { code: string; message?: string } | null {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.code === 'string') {
      const message = typeof e.message === 'string' ? e.message : undefined;
      return message === undefined ? { code: e.code } : { code: e.code, message };
    }
    if (typeof e.message === 'string') {
      try {
        const parsed = JSON.parse(e.message) as { code?: string; message?: string };
        if (parsed && typeof parsed.code === 'string') {
          return parsed.message === undefined
            ? { code: parsed.code }
            : { code: parsed.code, message: parsed.message };
        }
      } catch {
        /* 非 JSON，忽略 */
      }
    }
  }
  if (typeof err === 'string') {
    try {
      const parsed = JSON.parse(err) as { code?: string; message?: string };
      if (parsed && typeof parsed.code === 'string') {
        return parsed.message === undefined
          ? { code: parsed.code }
          : { code: parsed.code, message: parsed.message };
      }
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** 统一调用封装：异常归一化为 `ShellError`。 */
async function call<TReturn>(command: string, args: Record<string, unknown> = {}): Promise<TReturn> {
  try {
    return await invoke<TReturn>(command, clean(args));
  } catch (err) {
    const parsed = extractShellError(err);
    if (parsed && parsed.code) {
      throw new ShellError(parsed.code as ShellError['code'], parsed.message, undefined, 'tauri');
    }
    throw toShellError(err, 'UNKNOWN', 'tauri');
  }
}

/** 进程事件（Rust `ProcessEvent` 经 channel 推送）。 */
interface ProcessEventWire {
  kind: 'stdout' | 'stderr' | 'exit';
  data?: string;
  code?: number | null;
  signal?: string | null;
}

/** 更新进度事件（Rust `UpdateProgressEvent` 经 channel 推送）。 */
interface UpdateProgressWire {
  phase: string;
  percent?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// 路径能力（纯计算，同步实现；Rust 侧 path 仅作内部工具）
// ---------------------------------------------------------------------------

const SEP: '\\' | '/' = '\\';

function splitPath(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

function normalizePath(p: string): string {
  const raw = p.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  let joined = parts.join('/');
  if (raw.startsWith('//')) joined = `//${joined}`;
  else if (raw.startsWith('/')) joined = `/${joined}`;
  return joined === '' ? '.' : joined;
}

function isAbsolutePath(p: string): boolean {
  if (p.length >= 2 && p[1] === ':') return true;
  return p.startsWith('//') || p.startsWith('/') || p.startsWith('\\\\');
}

const pathApi: PathApi = {
  sep: SEP,
  join(...segments: string[]): string {
    const parts = segments.filter((s) => s.length > 0).flatMap(splitPath);
    if (parts.length === 0) return '.';
    const first = segments[0] ?? '';
    let prefix = '';
    if (/^[a-zA-Z]:/.test(first)) prefix = `${first.slice(0, 2)}${SEP}`;
    else if (first.startsWith('\\\\')) prefix = '\\\\';
    else if (first.startsWith('/')) prefix = SEP;
    // 盘符只作为前缀出现一次：首段若带盘符，不能重复拼进路径段
    if (prefix.length > 0 && parts[0]?.toLowerCase() === prefix.slice(0, 2).toLowerCase()) {
      parts.shift();
    }
    return prefix + parts.join(SEP);
  },
  resolve(...segments: string[]): string {
    let baseIndex = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (isAbsolutePath(segments[i] ?? '')) {
        baseIndex = i;
        break;
      }
    }
    const chosen = baseIndex >= 0 ? segments.slice(baseIndex) : segments;
    return normalizePath(chosen.join(SEP));
  },
  dirname(p: string): string {
    const n = normalizePath(p);
    const idx = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
    if (idx < 0) return '.';
    const dir = n.slice(0, idx);
    return dir === '' ? (n.startsWith('/') ? '/' : '.') : dir;
  },
  basename(p: string, suffix?: string): string {
    const n = normalizePath(p);
    const idx = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
    let name = idx >= 0 ? n.slice(idx + 1) : n;
    if (suffix && name.endsWith(suffix) && name.length > suffix.length) {
      name = name.slice(0, name.length - suffix.length);
    }
    return name;
  },
  extname(p: string): string {
    const name = this.basename(p);
    const idx = name.lastIndexOf('.');
    if (idx <= 0) return '';
    return name.slice(idx);
  },
  normalize(p: string): string {
    return normalizePath(p);
  },
  isAbsolute(p: string): boolean {
    return isAbsolutePath(p);
  },
  isWithin(parent: string, child: string): boolean {
    const par = normalizePath(parent);
    const chi = normalizePath(child);
    return chi === par || chi.startsWith(`${par}/`) || chi.startsWith(`${par}\\`);
  },
};

// ---------------------------------------------------------------------------
// 各能力实现
// ---------------------------------------------------------------------------

const fsApi: FsApi = {
  async readText(path: string, encoding?: 'utf8' | 'base64' | 'binary'): Promise<string> {
    const text = await call<string>('fs_read_text', { path, encoding });
    return text;
  },
  async readBinary(path: string): Promise<Uint8Array> {
    const arr = await call<number[]>('fs_read_binary', { path });
    return Uint8Array.from(arr);
  },
  async writeAtomic(
    path: string,
    data: string | Uint8Array,
    options?: WriteAtomicOptions,
  ): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await call<void>('fs_write_atomic', {
      path,
      data: Array.from(bytes),
      create_backup: options?.createBackup,
    });
  },
  async stat(path: string): Promise<FsStat | null> {
    return call<FsStat | null>('fs_stat', { path });
  },
  async readdir(path: string): Promise<FsDirent[]> {
    return call<FsDirent[]>('fs_readdir', { path });
  },
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await call<void>('fs_mkdir', { path, recursive: options?.recursive });
  },
  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    await call<void>('fs_remove', { path, recursive: options?.recursive });
  },
  async copy(source: string, target: string): Promise<void> {
    await call<void>('fs_copy', { source, target });
  },
  async rename(source: string, target: string): Promise<void> {
    await call<void>('fs_rename', { source, target });
  },
  async exists(path: string): Promise<boolean> {
    return call<boolean>('fs_exists', { path });
  },
  async watch(path: string, listener: (event: FsWatchEvent) => void): Promise<FsWatchHandle> {
    const channel = new Channel<FsWatchEvent>();
    const id = await call<string>('fs_watch', { path, channel });
    channel.onmessage = (e: FsWatchEvent) => listener(e);
    return {
      id,
      async close(): Promise<void> {
        await call<void>('fs_unwatch', { id });
      },
    };
  },
};

const dialogApi: DialogApi = {
  async openFile(options?: OpenDialogOptions): Promise<string[] | null> {
    return call<string[] | null>('dialog_open_file', {
      title: options?.title,
      filters: options?.filters?.map((f) => [f.name, f.extensions.join(',')]),
      multiple: options?.multiple,
    });
  },
  async openDirectory(options?: OpenDialogOptions): Promise<string | null> {
    return call<string | null>('dialog_open_directory', { title: options?.title });
  },
  async saveFile(options?: SaveDialogOptions): Promise<string | null> {
    return call<string | null>('dialog_save_file', {
      title: options?.title,
      filters: options?.filters?.map((f) => [f.name, f.extensions.join(',')]),
    });
  },
  async showMessage(options: MessageDialogOptions): Promise<number> {
    return call<number>('dialog_show_message', { title: options.title, message: options.message });
  },
  async confirm(options: Omit<MessageDialogOptions, 'level' | 'buttons'>): Promise<boolean> {
    return call<boolean>('dialog_confirm', { title: options.title, message: options.message });
  },
};

const processApi: ProcessApi = {
  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<ChildProcessHandle> {
    const channel = new Channel<ProcessEventWire>();
    const spawned = await call<{ id: string; pid: number | null }>('process_spawn', {
      command,
      args,
      cwd: options?.cwd,
      env: options?.env,
      shell: options?.shell,
      channel,
    });

    const stdoutListeners = new Set<(chunk: string) => void>();
    const stderrListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(result: ProcessExit) => void>();
    let exitedResolve: (result: ProcessExit) => void = () => {};
    const exited = new Promise<ProcessExit>((resolve) => {
      exitedResolve = resolve;
    });

    channel.onmessage = (e: ProcessEventWire) => {
      if (e.kind === 'stdout' && e.data !== undefined) {
        for (const l of stdoutListeners) l(e.data);
      } else if (e.kind === 'stderr' && e.data !== undefined) {
        for (const l of stderrListeners) l(e.data);
      } else if (e.kind === 'exit') {
        const result: ProcessExit = { code: e.code ?? null, signal: e.signal ?? null };
        for (const l of exitListeners) l(result);
        exitedResolve(result);
      }
    };

    return {
      id: spawned.id,
      pid: spawned.pid,
      async write(data: string): Promise<void> {
        await call<void>('process_write', { id: spawned.id, data });
      },
      async kill(): Promise<void> {
        await call<void>('process_kill', { id: spawned.id });
      },
      onStdout(listener: (chunk: string) => void): Unsubscribe {
        stdoutListeners.add(listener);
        return () => stdoutListeners.delete(listener);
      },
      onStderr(listener: (chunk: string) => void): Unsubscribe {
        stderrListeners.add(listener);
        return () => stderrListeners.delete(listener);
      },
      onExit(listener: (result: ProcessExit) => void): Unsubscribe {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      get exited(): Promise<ProcessExit> {
        return exited;
      },
    };
  },
  async list(): Promise<ProcessInfo[]> {
    return call<ProcessInfo[]>('process_list');
  },
  async killAll(): Promise<void> {
    await call<void>('process_kill_all');
  },
};

const windowApi: WindowApi = {
  async setTitle(title: string): Promise<void> {
    await call<void>('window_set_title', { title });
  },
  async minimize(): Promise<void> {
    await call<void>('window_minimize');
  },
  async maximize(): Promise<void> {
    await call<void>('window_maximize');
  },
  async unmaximize(): Promise<void> {
    await call<void>('window_unmaximize');
  },
  async isMaximized(): Promise<boolean> {
    return call<boolean>('window_is_maximized');
  },
  async setFullScreen(fullscreen: boolean): Promise<void> {
    await call<void>('window_set_fullscreen', { fullscreen });
  },
  async isFullScreen(): Promise<boolean> {
    return call<boolean>('window_is_fullscreen');
  },
  async setSize(size: WindowSize): Promise<void> {
    await call<void>('window_set_size', { width: size.width, height: size.height });
  },
  async getSize(): Promise<WindowSize> {
    return call<WindowSize>('window_get_size');
  },
  async center(): Promise<void> {
    await call<void>('window_center');
  },
  async focus(): Promise<void> {
    await call<void>('window_focus');
  },
  async close(): Promise<void> {
    await call<void>('window_close');
  },
};

const secureStoreApi: SecureStoreApi = {
  async set(namespace: SecureNamespace, key: string, value: string): Promise<void> {
    await call<void>('secure_store_set', { namespace, key, value });
  },
  async get(namespace: SecureNamespace, key: string): Promise<string | null> {
    return call<string | null>('secure_store_get', { namespace, key });
  },
  async delete(namespace: SecureNamespace, key: string): Promise<void> {
    await call<void>('secure_store_delete', { namespace, key });
  },
  async has(namespace: SecureNamespace, key: string): Promise<boolean> {
    return call<boolean>('secure_store_has', { namespace, key });
  },
  async listKeys(namespace: SecureNamespace): Promise<string[]> {
    return call<string[]>('secure_store_list_keys', { namespace });
  },
};

const updaterApi: UpdaterApi = {
  async check(): Promise<UpdateInfo | null> {
    return call<UpdateInfo | null>('updater_check');
  },
  async downloadAndInstall(): Promise<void> {
    await call<void>('updater_download_and_install');
  },
  onProgress(listener: (progress: UpdateProgress) => void): Unsubscribe {
    const channel = new Channel<UpdateProgressWire>();
    let unsubscribed = false;
    let updaterUnsub: (() => Promise<void>) | null = null;
    void call<string>('updater_subscribe', { channel }).then((subId) => {
      if (unsubscribed) return;
      channel.onmessage = (e: UpdateProgressWire) => {
        const progress: UpdateProgress = {
          phase: e.phase as UpdateProgress['phase'],
          ...(e.percent !== undefined ? { percent: e.percent } : {}),
          ...(e.message !== undefined ? { message: e.message } : {}),
        };
        listener(progress);
      };
      updaterUnsub = async () => {
        await call<void>('updater_unsubscribe', { sub_id: subId });
      };
    });
    return () => {
      unsubscribed = true;
      void updaterUnsub?.();
    };
  },
};

const appInfoApi: AppInfoApi = {
  async get() {
    return call<AppInfo>('app_info_get');
  },
  async getDataDir(): Promise<string> {
    return call<string>('app_info_get_data_dir');
  },
  async setWorkspaceRoot(root: string): Promise<void> {
    await call<void>('app_info_set_workspace_root', { root });
  },
};

const clipboardApi: ClipboardApi = {
  async readText(): Promise<string> {
    return call<string>('clipboard_read_text');
  },
  async writeText(text: string): Promise<void> {
    await call<void>('clipboard_write_text', { text });
  },
  async clear(): Promise<void> {
    await call<void>('clipboard_clear');
  },
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// 受限网络：本地镜像白名单（供 isHostAllowed 同步判断）。
let allowedHosts: string[] | '*' = [];

const netApi: NetApi = {
  setAllowedHosts(hosts: string[] | '*'): void {
    allowedHosts = hosts;
    void call<void>('net_set_allowed_hosts', { hosts: hosts === '*' ? '*' : [...hosts] });
  },
  isHostAllowed(host: string): boolean {
    if (allowedHosts === '*') return true;
    return allowedHosts.includes(host);
  },
  async fetch(request: NetRequest): Promise<NetResponse> {
    let host = '';
    try {
      host = new URL(request.url).host;
    } catch {
      /* 非法 URL 交由 Rust 侧校验 */
    }
    if (!netApi.isHostAllowed(host)) {
      throw new ShellError('NET_BLOCKED', `目标主机未被放行: ${host}`, undefined, 'tauri');
    }
    const wire: Record<string, unknown> = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      timeout_ms: request.timeoutMs,
    };
    if (typeof request.body === 'string') wire.body = request.body;
    else if (request.body instanceof Uint8Array) wire.body_base64 = bytesToBase64(request.body);
    return call<NetResponse>('net_fetch', { request: wire });
  },
  allowedHosts(): string[] | '*' {
    return allowedHosts;
  },
};

// ---------------------------------------------------------------------------
// ShellHost 实现与注册
// ---------------------------------------------------------------------------

/** 创建 Tauri 外壳实现。
 *
 * 所有能力均通过 `invoke` 调用 Rust 命令，渲染层无需感知具体外壳。
 */
export function createTauriShell(): ShellHost {
  return {
    kind: 'tauri',
    fs: fsApi,
    path: pathApi,
    dialog: dialogApi,
    process: processApi,
    window: windowApi,
    secureStore: secureStoreApi,
    updater: updaterApi,
    appInfo: appInfoApi,
    clipboard: clipboardApi,
    net: netApi,
    ai: {
      invoke: (request: AiRpcRequest) => call<AiRpcResponse>('ai_invoke', { request }),
      stream: (request: AiStreamRequest) => {
        const channel = new Channel<{ requestId: string; event: AiStreamEvent }>();
        const listeners = new Set<(event: AiStreamEvent) => void>();
        channel.onmessage = (message) => {
          if (message.requestId === request.requestId) {
            for (const listener of listeners) listener(message.event);
          }
        };
        void call<void>('ai_stream_start', { request, channel }).catch((error) => {
          const event: AiStreamEvent = { type: 'error', error: { code: 'NOT_SUPPORTED', message: error instanceof Error ? error.message : String(error) } };
          for (const listener of listeners) listener(event);
        });
        return {
          requestId: request.requestId,
          on: (listener: (event: AiStreamEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          abort: () => { void call<void>('ai_abort', { requestId: request.requestId }); },
        } satisfies AiStreamHandle;
      },
      abort: (requestId: string) => { void call<void>('ai_abort', { requestId }); },
    } satisfies AiControlHost,
    domain: {
      // Rust 侧尚未提供域端口命令（工作台 / 文档 / 账号 / 设置四域）。
      // 与 ai 同一口径：如实返回 NOT_SUPPORTED，让渲染层保留装配引导，
      // 而不是注入一个"能打开但每个动作都失败"的端口。
      invoke: (request: DomainRpcRequest) =>
        Promise.resolve<DomainRpcResponse>({
          requestId: request.requestId,
          ok: false,
          error: { code: 'NOT_SUPPORTED', message: 'Tauri 外壳尚未接入域端口运行时' },
        }),
      describe: () =>
        Promise.resolve<DomainDescriptor[]>(
          DOMAIN_KINDS.map((kind) => ({
            kind,
            available: false,
            reason: 'Tauri 外壳尚未接入域端口运行时',
          })),
        ),
    } satisfies DomainControlHost,
    async openExternal(url: string): Promise<void> {
      await call<void>('open_external', { url });
    },
    async capabilities(): Promise<ShellCapabilities> {
      return {
        fs: true,
        watch: true,
        process: true,
        dialog: true,
        window: true,
        secureStore: true,
        updater: true,
        net: true,
        clipboard: true,
        openExternal: true,
        // Rust 侧 AI 栈尚未接入（commands/ai.rs 仍返回 NOT_SUPPORTED）。
        // 这里如实报 false：UI 走"能力缺失"引导，而不是让用户去点一个必然失败的按钮。
        ai: false,
        // 同上：域端口通道未接入，如实报 false。
        domain: false,
      };
    },
    async dispose(): Promise<void> {
      // 终止残留子进程，释放资源。
      await processApi.killAll().catch(() => {});
    },
  };
}

// 模块加载即注册 'tauri' 实现，供 createShell('tauri') 使用。
registerShellFactory('tauri', createTauriShell);
