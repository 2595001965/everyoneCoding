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
  type DomainEvent,
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
  type ShellCapabilityKey,
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
async function call<TReturn>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<TReturn> {
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
  async spawn(
    command: string,
    args: string[],
    options?: SpawnOptions,
  ): Promise<ChildProcessHandle> {
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
// 侧车事件总线
// ---------------------------------------------------------------------------

/** 侧车事件信封（Rust `EventEnvelopeWire`）：`op` 决定 `payload` 的形状 */
interface SidecarEventEnvelope {
  op: string;
  payload: unknown;
}

/** `sidecar_status` 返回值（Rust `SidecarStatusWire`） */
interface SidecarStatusWire {
  ready: {
    available: boolean;
    reason?: string;
    domains: DomainDescriptor[];
    syncDomains: string[];
    ai: { available: boolean; reason?: string };
  };
  location: string;
  protocol: number;
}

const SIDECAR_EVENT_DOMAIN = 'domain.event';
const SIDECAR_EVENT_AI_STREAM = 'ai.stream';

/**
 * 三种事件（域事件 / AI 流式分片 / 日志）共用**一条**侧车订阅。
 *
 * 为什么不各开一条通道：它们在同一次调用里互相纠缠（进度与结果），
 * 分通道就要处理"哪条通道先建立"的竞态——而竞态的表现是"偶尔丢几帧"，
 * 属于最难复现的一类故障。渲染层按 `requestId` 分流，与 Electron 形态同构。
 *
 * 订阅**惰性建立**且在所有监听器退订后释放：Rust 侧订阅表有上限，
 * 泄漏的订阅会让后续订阅全部失败（"用久了才出现的怪问题"）。
 */
const sidecarListeners = new Set<(op: string, payload: unknown) => void>();
let sidecarSubId: string | null = null;
let sidecarSubscribing = false;

function ensureSidecarSubscription(): void {
  if (sidecarSubId !== null || sidecarSubscribing) return;
  sidecarSubscribing = true;
  const channel = new Channel<SidecarEventEnvelope>();
  channel.onmessage = (message) => {
    if (message === null || typeof message !== 'object' || typeof message.op !== 'string') return;
    for (const listener of [...sidecarListeners]) {
      try {
        listener(message.op, message.payload);
      } catch {
        // 单个订阅者抛错不影响其它订阅者，更不能打断侧车的业务路由
      }
    }
  };
  void call<string>('sidecar_subscribe', { channel })
    .then((id) => {
      sidecarSubId = id;
      /**
       * 订阅返回时监听器**可能已经全部退订**（短命组件 / 立即 unmount）。
       * 这里必须立刻释放：否则这条订阅永远不会被回收，既泄漏一个 Rust 侧
       * 通道，又持续占着订阅表上限——症状是"用久了之后新订阅全部失败"。
       */
      releaseSidecarSubscriptionIfIdle();
    })
    .catch(() => {
      // 订阅失败 → 退化为"无过程反馈"：调用照常成功，只是拿不到中途进度。
      // 这与"让整次调用失败"相比是更好的降级（渲染层契约本就允许无事件）。
    })
    .finally(() => {
      sidecarSubscribing = false;
    });
}

function addSidecarListener(listener: (op: string, payload: unknown) => void): Unsubscribe {
  ensureSidecarSubscription();
  sidecarListeners.add(listener);
  return () => {
    sidecarListeners.delete(listener);
    releaseSidecarSubscriptionIfIdle();
  };
}

function releaseSidecarSubscriptionIfIdle(): void {
  if (sidecarListeners.size > 0 || sidecarSubId === null) return;
  const id = sidecarSubId;
  sidecarSubId = null;
  void call<void>('sidecar_unsubscribe', { sub_id: id }).catch(() => {});
}

/** 域调用失败的兜底响应（形状必须与 `DomainRpcResponse` 一致） */
function domainFailure(requestId: string, message: string): DomainRpcResponse {
  return {
    requestId,
    ok: false,
    error: { code: 'NOT_SUPPORTED', message, retryable: false },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// ShellHost 实现与注册
// ---------------------------------------------------------------------------

/** 创建 Tauri 外壳实现。
 *
 * 所有能力均通过 `invoke` 调用 Rust 命令，渲染层无需感知具体外壳。
 * 域端口与 AI 栈由 Rust 侧的**受控侧车**承载（Node 业务运行时），
 * 因此这里的工作就是协议搬运 + 失败时给出可读原因，绝不伪造成功。
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
      invoke: async (request: AiRpcRequest): Promise<AiRpcResponse> => {
        try {
          return await call<AiRpcResponse>('ai_invoke', { request });
        } catch (error) {
          // Rust 侧总会合成 AiRpcResponse；走到这里说明是"命令层"的意外
          // （例如运行时被卸载）。补一份同形状响应，别让渲染层看到裸异常。
          return {
            requestId: request.requestId,
            ok: false,
            error: { code: 'UNKNOWN', message: messageOf(error) },
          };
        }
      },
      stream: (request: AiStreamRequest): AiStreamHandle => {
        const listeners = new Set<(event: AiStreamEvent) => void>();
        const emit = (event: AiStreamEvent): void => {
          for (const listener of [...listeners]) {
            try {
              listener(event);
            } catch {
              // 同上：单个消费者抛错不扩散
            }
          }
        };

        // **先订阅再发起**：反过来会丢掉最初几帧（首帧往往就是 accepted/进度）
        let unsubscribe: Unsubscribe = () => {};
        const stop = (): void => {
          unsubscribe();
          unsubscribe = () => {};
        };
        unsubscribe = addSidecarListener((op, payload) => {
          if (op !== SIDECAR_EVENT_AI_STREAM) return;
          if (payload === null || typeof payload !== 'object') return;
          const frame = payload as { requestId?: unknown; event?: unknown };
          if (frame.requestId !== request.requestId) return;
          const event = frame.event as AiStreamEvent | undefined;
          if (event === undefined || event === null || typeof event.type !== 'string') return;
          emit(event);
          // `done` 是终止帧：此后不会再有本次请求的事件，退订以免泄漏
          if (event.type === 'done') stop();
        });

        void call<{ accepted?: boolean; error?: { code?: string; message?: string } }>(
          'ai_stream_start',
          { request },
        )
          .then((result) => {
            if (result?.accepted !== false) return;
            // AI 栈不可用：必须显式补 error + done。
            // 只回 accepted:false 会让界面永远转圈——这是最容易漏的一条。
            emit({
              type: 'error',
              error: {
                code: result.error?.code ?? 'NOT_SUPPORTED',
                message: result.error?.message ?? 'AI 流式生成未被接受',
              },
            });
            emit({ type: 'done', finishReason: 'error', partial: true });
            stop();
          })
          .catch((error: unknown) => {
            emit({
              type: 'error',
              error: { code: 'NOT_SUPPORTED', message: messageOf(error) },
            });
            emit({ type: 'done', finishReason: 'error', partial: true });
            stop();
          });

        return {
          requestId: request.requestId,
          on: (listener: (event: AiStreamEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          abort: () => {
            void call<void>('ai_abort', { request_id: request.requestId });
          },
        } satisfies AiStreamHandle;
      },
      abort: (requestId: string) => {
        void call<void>('ai_abort', { request_id: requestId });
      },
    } satisfies AiControlHost,
    domain: {
      /**
       * 域 RPC 经 `domain_invoke` 交给 Rust，再由 Rust 转给侧车里的真实域运行时。
       *
       * 错误语义与 Electron 一致：渲染层**永远**拿到 `DomainRpcResponse`
       * （`ok:false` + 结构化 `error`），而不是一个裸异常。
       */
      invoke: async (request: DomainRpcRequest): Promise<DomainRpcResponse> => {
        try {
          return await call<DomainRpcResponse>('domain_invoke', { request });
        } catch (error) {
          return domainFailure(request.requestId, messageOf(error));
        }
      },
      /**
       * 各域装配状态。
       *
       * 侧车不可用（没构建产物 / 没 Node / 协议不兼容 / 装配失败）时，
       * Rust 会返回**全部 15 个域 + 同一原因**；这里再兜一层，保证渲染层
       * 拿到的一定是一份完整的域清单，从而对每个页面给出如实的装配引导。
       */
      describe: async (): Promise<DomainDescriptor[]> => {
        try {
          return await call<DomainDescriptor[]>('domain_describe');
        } catch (error) {
          const reason = messageOf(error);
          return DOMAIN_KINDS.map((kind) => ({ kind, available: false, reason }));
        }
      },
      /**
       * 域事件订阅（**可选能力**，与 Electron 形态同构）。
       *
       * 请求内事件（导入进度、阶段推进）与无请求归属的事件（外部改动监视、
       * 预览后端日志）都会经这条通道到渲染层；渲染层按 `domain + payload.type`
       * 过滤，并按 requestId 关联到具体那次调用。
       */
      onEvent: (listener: (event: DomainEvent) => void): Unsubscribe =>
        addSidecarListener((op, payload) => {
          if (op !== SIDECAR_EVENT_DOMAIN) return;
          if (payload === null || typeof payload !== 'object') return;
          const event = payload as Partial<DomainEvent>;
          // 跨进程数据不信任：形状不对就丢弃，而不是把脏值塞进 UI
          if (typeof event.requestId !== 'string' || typeof event.domain !== 'string') return;
          if (event.payload === undefined) return;
          listener(event as DomainEvent);
        }),
    } satisfies DomainControlHost,
    async openExternal(url: string): Promise<void> {
      await call<void>('open_external', { url });
    },
    async capabilities(): Promise<ShellCapabilities> {
      /**
       * `ai` / `domain` 不再写死：它们由侧车的**真实装配结果**决定。
       *
       * 写死成 `false` 是"宁可保守"，但代价是 UI 永远显示"能力缺失"；
       * 写死成 `true` 更糟——用户会去点一个必然失败的按钮。
       * 所以这里问一次 `sidecar_status`（会触发侧车启动并等待就绪），
       * 并把**原因**一并带出去（`ShellCapabilities.reasons`）。
       */
      const reasons: Partial<Record<ShellCapabilityKey, string>> = {};
      let ai = false;
      let domain = false;
      try {
        const status = await call<SidecarStatusWire>('sidecar_status');
        domain = status.ready.available;
        ai = status.ready.ai.available;
        if (!domain) {
          reasons.domain = status.ready.reason ?? '侧车运行时不可用';
        }
        if (!ai) {
          reasons.ai = status.ready.ai.reason ?? 'AI 栈不可用（侧车未就绪）';
        }
      } catch (error) {
        const reason = `侧车运行时不可用：${messageOf(error)}`;
        reasons.domain = reason;
        reasons.ai = reason;
      }
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
        ai,
        domain,
        // 能力为 true 时不带原因：`reasons` 只解释"为什么缺"
        ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
      };
    },
    async dispose(): Promise<void> {
      /**
       * 注意职责边界：这里**只**释放本外壳实例持有的资源。
       *
       * 侧车进程属于**应用**而不是某个窗口，它由 Rust 在 `RunEvent::Exit`
       * 里收尾（先发协议 shutdown 让它杀掉预览后端，再强杀兜底）。
       * 若在这里关掉侧车，"关一个窗口"就会把整个应用的后端干掉。
       */
      sidecarListeners.clear();
      const subId = sidecarSubId;
      sidecarSubId = null;
      if (subId !== null) {
        await call<void>('sidecar_unsubscribe', { sub_id: subId }).catch(() => {});
      }
      // 终止本实例登记的残留子进程（fs watch / 通用 process 端口）
      await processApi.killAll().catch(() => {});
    },
  };
}

// 模块加载即注册 'tauri' 实现，供 createShell('tauri') 使用。
registerShellFactory('tauri', createTauriShell);
