/**
 * preload 白名单 API 构造（独立于 electron 模块，便于在 Vitest 中做安全审计）。
 * 真正的 contextBridge.exposeInMainWorld 在 ./index.ts 中完成。
 */
import { CHANNELS, PRELOAD_METHOD_KEYS, PRELOAD_TOP_LEVEL_KEYS } from '../main/channels';

export interface InvokeIpcRendererLike {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  off(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  /**
   * 同步 IPC（`ipcRenderer.sendSync`）。
   *
   * 只用于域端口的同步方法（`MemoryApi` / `PipelineApi`，白名单在 shell-api 的
   * `DOMAIN_SYNC_METHODS`）：渲染层在调用期间会阻塞，主进程必须同步应答。
   * 可选：测试里的假 ipc 不提供它，由断言面（assertSurface）保证真实 preload 一定有。
   */
  sendSync?(channel: string, payload?: unknown): unknown;
}

function assertString(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`参数 ${name} 必须是非空字符串`);
  }
}

function assertOptionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`参数 ${name} 必须是字符串`);
  }
}

const SECURE_NAMESPACES = ['ai-key', 'oauth-token', 'git-credential', 'app-secret'];

function assertNamespace(value: unknown): void {
  assertString(value, 'namespace');
  if (!(SECURE_NAMESPACES as string[]).includes(value as string)) {
    throw new TypeError(`非法密钥命名空间: ${String(value)}`);
  }
}

/** 暴露面自检：顶层命名空间与各命名空间方法都必须落在白名单内 */
export function assertSurface(api: Record<string, unknown>): void {
  for (const key of Object.keys(api)) {
    if (!(PRELOAD_TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      throw new Error(`preload 暴露面越权: 顶层命名空间 ${key} 不在白名单内`);
    }
  }
  for (const [namespace, allowed] of Object.entries(PRELOAD_METHOD_KEYS)) {
    const actual = Object.keys((api[namespace] as Record<string, unknown>) ?? {});
    for (const method of actual) {
      if (!allowed.includes(method)) {
        throw new Error(`preload 暴露面越权: ${namespace}.${method} 不在白名单内`);
      }
    }
  }
}

function assertAiRequest(
  value: unknown,
): asserts value is { requestId: string; method?: string; params?: unknown } {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { requestId?: unknown }).requestId !== 'string' ||
    !(value as { requestId: string }).requestId
  ) {
    throw new TypeError('AI 请求必须包含非空 requestId');
  }
}

/**
 * 域端口请求校验。
 *
 * 只校验「形状」（requestId / domain / method 均为非空字符串），
 * **不校验方法名**——方法白名单是主进程的职责（`isDomainRpcMethod`），
 * preload 若也维护一份会变成两处事实源，且随端口演进必然漂移。
 */
function assertDomainRequest(value: unknown): asserts value is {
  requestId: string;
  domain: string;
  method: string;
  params?: unknown;
} {
  if (!value || typeof value !== 'object') throw new TypeError('域请求必须是对象');
  const request = value as { requestId?: unknown; domain?: unknown; method?: unknown };
  assertString(request.requestId, 'requestId');
  assertString(request.domain, 'domain');
  assertString(request.method, 'method');
}

export function createPreloadApi(ipc: InvokeIpcRendererLike): Record<string, unknown> {
  const fs = {
    readText: (filePath: string, encoding?: string) => {
      assertString(filePath, 'filePath');
      assertOptionalString(encoding, 'encoding');
      return ipc.invoke(CHANNELS.fs.readText, { filePath, encoding });
    },
    readBinary: (filePath: string) => {
      assertString(filePath, 'filePath');
      return ipc.invoke(CHANNELS.fs.readBinary, { filePath });
    },
    writeAtomic: (filePath: string, data: string | number[], encoding?: string) => {
      assertString(filePath, 'filePath');
      if (typeof data !== 'string' && !Array.isArray(data)) {
        throw new TypeError('参数 data 必须是字符串或字节数组');
      }
      return ipc.invoke(CHANNELS.fs.writeAtomic, { filePath, data, encoding });
    },
    stat: (filePath: string) => {
      assertString(filePath, 'filePath');
      return ipc.invoke(CHANNELS.fs.stat, { filePath });
    },
    readdir: (dirPath: string) => {
      assertString(dirPath, 'dirPath');
      return ipc.invoke(CHANNELS.fs.readdir, { dirPath });
    },
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => {
      assertString(dirPath, 'dirPath');
      return ipc.invoke(CHANNELS.fs.mkdir, { dirPath, recursive: options?.recursive ?? true });
    },
    remove: (target: string, options?: { recursive?: boolean }) => {
      assertString(target, 'target');
      return ipc.invoke(CHANNELS.fs.remove, { target, recursive: options?.recursive ?? true });
    },
    copy: (source: string, target: string) => {
      assertString(source, 'source');
      assertString(target, 'target');
      return ipc.invoke(CHANNELS.fs.copy, { source, target });
    },
    rename: (source: string, target: string) => {
      assertString(source, 'source');
      assertString(target, 'target');
      return ipc.invoke(CHANNELS.fs.rename, { source, target });
    },
    exists: (target: string) => {
      assertString(target, 'target');
      return ipc.invoke(CHANNELS.fs.exists, { target });
    },
    watch: (target: string, listener: (event: { type: string; path: string }) => void) => {
      assertString(target, 'target');
      if (typeof listener !== 'function') throw new TypeError('参数 listener 必须是函数');
      const wrapped = (_event: unknown, payload: unknown) => {
        listener(payload as { type: string; path: string });
      };
      ipc.on(CHANNELS.fs.watch, wrapped);
      let closed = false;
      return {
        id: 'pending',
        close: async () => {
          if (closed) return;
          closed = true;
          ipc.off(CHANNELS.fs.watch, wrapped);
          await ipc.invoke(CHANNELS.fs.unwatch, { id: 'pending' });
        },
      };
    },
  };

  const dialog = {
    openFile: (options?: Record<string, unknown>) =>
      ipc.invoke(CHANNELS.dialog.openFile, options ?? {}),
    openDirectory: (options?: Record<string, unknown>) =>
      ipc.invoke(CHANNELS.dialog.openDirectory, options ?? {}),
    saveFile: (options?: Record<string, unknown>) =>
      ipc.invoke(CHANNELS.dialog.saveFile, options ?? {}),
    showMessage: (options: Record<string, unknown>) =>
      ipc.invoke(CHANNELS.dialog.showMessage, options),
    confirm: (options: Record<string, unknown>) => ipc.invoke(CHANNELS.dialog.confirm, options),
  };

  // 进程事件流：订阅按进程 id 过滤，避免把别的子进程日志串进来
  const stdoutListeners = new Set<{ id: string; cb: (chunk: string) => void }>();
  const stderrListeners = new Set<{ id: string; cb: (chunk: string) => void }>();
  const exitListeners = new Set<{
    id: string;
    cb: (result: { code: number | null; signal: string | null }) => void;
  }>();

  ipc.on(CHANNELS.process.stdout, (_event, payload) => {
    const data = payload as { id: string; chunk: string };
    for (const entry of stdoutListeners) if (entry.id === data.id) entry.cb(data.chunk);
  });
  ipc.on(CHANNELS.process.stderr, (_event, payload) => {
    const data = payload as { id: string; chunk: string };
    for (const entry of stderrListeners) if (entry.id === data.id) entry.cb(data.chunk);
  });
  ipc.on(CHANNELS.process.exit, (_event, payload) => {
    const data = payload as { id: string; code: number | null; signal: string | null };
    for (const entry of exitListeners) {
      if (entry.id === data.id) entry.cb({ code: data.code, signal: data.signal });
    }
  });

  const processApi = {
    spawn: (command: string, args: string[], options?: Record<string, unknown>) => {
      assertString(command, 'command');
      if (!Array.isArray(args)) throw new TypeError('参数 args 必须是字符串数组');
      return ipc.invoke(CHANNELS.process.spawn, { command, args, options }) as Promise<{
        id: string;
        pid: number | null;
      }>;
    },
    write: (id: string, data: string) => {
      assertString(id, 'id');
      return ipc.invoke(CHANNELS.process.write, { id, data });
    },
    kill: (id: string, signal?: string) => {
      assertString(id, 'id');
      return ipc.invoke(CHANNELS.process.kill, { id, signal });
    },
    list: () => ipc.invoke(CHANNELS.process.list),
    killAll: () => ipc.invoke(CHANNELS.process.killAll),
    onStdout: (id: string, cb: (chunk: string) => void) => {
      assertString(id, 'id');
      const entry = { id, cb };
      stdoutListeners.add(entry);
      return () => stdoutListeners.delete(entry);
    },
    onStderr: (id: string, cb: (chunk: string) => void) => {
      assertString(id, 'id');
      const entry = { id, cb };
      stderrListeners.add(entry);
      return () => stderrListeners.delete(entry);
    },
    onExit: (id: string, cb: (result: { code: number | null; signal: string | null }) => void) => {
      assertString(id, 'id');
      const entry = { id, cb };
      exitListeners.add(entry);
      return () => exitListeners.delete(entry);
    },
  };

  const windowApi = {
    setTitle: (title: string) => ipc.invoke(CHANNELS.window.setTitle, { title }),
    minimize: () => ipc.invoke(CHANNELS.window.minimize),
    maximize: () => ipc.invoke(CHANNELS.window.maximize),
    unmaximize: () => ipc.invoke(CHANNELS.window.unmaximize),
    isMaximized: () => ipc.invoke(CHANNELS.window.isMaximized),
    setFullScreen: (fullscreen: boolean) =>
      ipc.invoke(CHANNELS.window.setFullScreen, { fullscreen }),
    isFullScreen: () => ipc.invoke(CHANNELS.window.isFullScreen),
    setSize: (size: { width: number; height: number }) => ipc.invoke(CHANNELS.window.setSize, size),
    getSize: () => ipc.invoke(CHANNELS.window.getSize),
    center: () => ipc.invoke(CHANNELS.window.center),
    focus: () => ipc.invoke(CHANNELS.window.focus),
    close: () => ipc.invoke(CHANNELS.window.close),
  };

  const secureStore = {
    set: (namespace: string, key: string, value: string) => {
      assertNamespace(namespace);
      assertString(key, 'key');
      if (typeof value !== 'string' || value.length === 0)
        throw new TypeError('value 必须是非空字符串');
      return ipc.invoke(CHANNELS.secureStore.set, { namespace, key, value });
    },
    get: (namespace: string, key: string) => {
      assertNamespace(namespace);
      assertString(key, 'key');
      return ipc.invoke(CHANNELS.secureStore.get, { namespace, key });
    },
    delete: (namespace: string, key: string) => {
      assertNamespace(namespace);
      assertString(key, 'key');
      return ipc.invoke(CHANNELS.secureStore.delete, { namespace, key });
    },
    has: (namespace: string, key: string) => {
      assertNamespace(namespace);
      assertString(key, 'key');
      return ipc.invoke(CHANNELS.secureStore.has, { namespace, key });
    },
    listKeys: (namespace: string) => {
      assertNamespace(namespace);
      return ipc.invoke(CHANNELS.secureStore.listKeys, { namespace });
    },
  };

  const updater = {
    check: () => ipc.invoke(CHANNELS.updater.check),
    downloadAndInstall: () => ipc.invoke(CHANNELS.updater.downloadAndInstall),
    onProgress: (cb: (progress: { phase: string; percent?: number; message?: string }) => void) => {
      if (typeof cb !== 'function') throw new TypeError('参数 cb 必须是函数');
      const wrapped = (_event: unknown, payload: unknown) => cb(payload as { phase: string });
      ipc.on(CHANNELS.updater.onProgress, wrapped);
      return () => ipc.off(CHANNELS.updater.onProgress, wrapped);
    },
  };

  const appInfo = {
    get: () => ipc.invoke(CHANNELS.appInfo.get),
    getDataDir: () => ipc.invoke(CHANNELS.appInfo.getDataDir),
    setWorkspaceRoot: (root: string) => {
      assertString(root, 'root');
      return ipc.invoke(CHANNELS.appInfo.setWorkspaceRoot, { root });
    },
  };

  const clipboardApi = {
    readText: () => ipc.invoke(CHANNELS.clipboard.readText),
    writeText: (text: string) => {
      assertString(text, 'text');
      return ipc.invoke(CHANNELS.clipboard.writeText, { text });
    },
    clear: () => ipc.invoke(CHANNELS.clipboard.clear),
  };

  const net = {
    fetch: (request: Record<string, unknown>) => {
      assertString(request.url, 'url');
      return ipc.invoke(CHANNELS.net.fetch, request);
    },
    isHostAllowed: (host: string) => {
      assertString(host, 'host');
      return ipc.invoke(CHANNELS.net.isHostAllowed, { host });
    },
    setAllowedHosts: (hosts: string[] | '*') => ipc.invoke(CHANNELS.net.setAllowedHosts, { hosts }),
  };

  const ai = {
    invoke: (request: unknown) => {
      assertAiRequest(request);
      return ipc.invoke(CHANNELS.ai.invoke, request);
    },
    stream: (request: unknown, listener: (event: unknown) => void) => {
      assertAiRequest(request);
      if (typeof listener !== 'function') throw new TypeError('参数 listener 必须是函数');
      const requestId = (request as { requestId: string }).requestId;
      const wrapped = (_event: unknown, payload: unknown) => {
        const envelope = payload as { requestId?: unknown; event?: unknown };
        if (envelope.requestId === requestId) listener(envelope.event);
      };
      ipc.on(CHANNELS.ai.stream, wrapped);
      void ipc.invoke(CHANNELS.ai.start, request);
      return {
        requestId: (request as { requestId: string }).requestId,
        off: () => ipc.off(CHANNELS.ai.stream, wrapped),
      };
    },
    abort: (requestId: string) => ipc.invoke(CHANNELS.ai.abort, { requestId }),
  };

  const domain = {
    invoke: (request: unknown) => {
      assertDomainRequest(request);
      return ipc.invoke(CHANNELS.domain.invoke, request);
    },
    /**
     * 同步域调用：供渲染层的同步签名端口（`MemoryApi` / `PipelineApi`）使用。
     *
     * 与 `invoke` 的差别仅在于它阻塞渲染进程直到主进程把结果放进
     * `event.returnValue`。方法白名单是主进程的职责（`DOMAIN_SYNC_METHODS`），
     * 这里只做形状校验——同一理由：preload 维护第二份白名单必然漂移。
     */
    invokeSync: (request: unknown) => {
      assertDomainRequest(request);
      if (typeof ipc.sendSync !== 'function') {
        throw new TypeError('当前外壳不支持同步域调用（sendSync 缺失）');
      }
      return ipc.sendSync(CHANNELS.domain.invokeSync, request);
    },
    describe: () => ipc.invoke(CHANNELS.domain.describe),
    /**
     * 订阅域事件（主进程 → 渲染层单向推送）。
     *
     * 与 `ai.stream` 的差别：AI 流在发起时就绑定 requestId，域事件则可能
     * 属于任意一次域调用，故这里只做**形状校验**后原样回调，
     * 由渲染层按 `requestId` 过滤到自己关心的那次调用。
     */
    onEvent: (listener: (event: unknown) => void) => {
      if (typeof listener !== 'function') throw new TypeError('参数 listener 必须是函数');
      const wrapped = (_event: unknown, payload: unknown) => {
        if (!payload || typeof payload !== 'object') return;
        const envelope = payload as { requestId?: unknown };
        // 缺 requestId 的事件无法关联到任何调用，直接丢弃（渲染层无从过滤）
        if (typeof envelope.requestId !== 'string' || envelope.requestId.length === 0) return;
        listener(payload);
      };
      ipc.on(CHANNELS.domain.event, wrapped);
      return () => ipc.off(CHANNELS.domain.event, wrapped);
    },
  };

  const api = {
    fs,
    dialog,
    process: processApi,
    window: windowApi,
    secureStore,
    updater,
    appInfo,
    clipboard: clipboardApi,
    net,
    ai,
    domain,
    openExternal: (url: string) => {
      assertString(url, 'url');
      if (!/^https?:\/\//.test(url) && !/^mailto:/.test(url)) {
        throw new TypeError('只允许打开 http(s) 与 mailto 链接');
      }
      return ipc.invoke(CHANNELS.openExternal, { url });
    },
  };

  assertSurface(api as Record<string, unknown>);
  return api;
}
