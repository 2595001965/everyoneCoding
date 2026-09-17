import { createPathApi, ShellError, toShellError, type AiRpcRequest, type AiRpcResponse, type AiStreamEvent, type AiStreamRequest } from '@ec/shell-api';
import type {
  AppInfo,
  ChildProcessHandle,
  DomainDescriptor,
  DomainRpcRequest,
  DomainRpcResponse,
  FsWatchHandle,
  ProcessExit,
  ShellHost,
} from '@ec/shell-api';
import { registerShellFactory } from '@ec/shell-api';

/**
 * Electron 桥接层：把 preload 暴露的 window.ecShell 封装为 ShellHost。
 * path 能力为纯计算，直接用 shell-api 的共享实现（与 Tauri 侧同语义）。
 */

export interface EcShellPreload {
  fs: {
    readText(filePath: string, encoding?: string): Promise<string>;
    readBinary(filePath: string): Promise<number[]>;
    writeAtomic(filePath: string, data: string | number[], encoding?: string): Promise<void>;
    stat(filePath: string): Promise<Record<string, unknown> | null>;
    readdir(dirPath: string): Promise<Array<{ name: string; path: string; isFile: boolean; isDirectory: boolean }>>;
    mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void>;
    remove(target: string, options?: { recursive?: boolean }): Promise<void>;
    copy(source: string, target: string): Promise<void>;
    rename(source: string, target: string): Promise<void>;
    exists(target: string): Promise<boolean>;
    watch(
      target: string,
      listener: (event: { type: 'create' | 'modify' | 'remove'; path: string }) => void,
    ): Promise<{ id: string; close(): Promise<void> }>;
  };
  dialog: {
    openFile(options?: Record<string, unknown>): Promise<string[] | null>;
    openDirectory(options?: Record<string, unknown>): Promise<string | null>;
    saveFile(options?: Record<string, unknown>): Promise<string | null>;
    showMessage(options: Record<string, unknown>): Promise<number>;
    confirm(options: Record<string, unknown>): Promise<boolean>;
  };
  process: {
    spawn(command: string, args: string[], options?: Record<string, unknown>): Promise<{ id: string; pid: number | null }>;
    write(id: string, data: string): Promise<void>;
    kill(id: string, signal?: string): Promise<boolean>;
    list(): Promise<Array<{ id: string; pid: number | null; command: string; args: string[] }>>;
    killAll(): Promise<void>;
    onStdout(id: string, cb: (chunk: string) => void): () => void;
    onStderr(id: string, cb: (chunk: string) => void): () => void;
    onExit(id: string, cb: (result: ProcessExit) => void): () => void;
  };
  window: {
    setTitle(title: string): Promise<void>;
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    unmaximize(): Promise<void>;
    isMaximized(): Promise<boolean>;
    setFullScreen(fullscreen: boolean): Promise<void>;
    isFullScreen(): Promise<boolean>;
    setSize(size: { width: number; height: number }): Promise<void>;
    getSize(): Promise<number[]>;
    center(): Promise<void>;
    focus(): Promise<void>;
    close(): Promise<void>;
  };
  secureStore: {
    set(namespace: 'ai-key' | 'oauth-token' | 'git-credential' | 'app-secret', key: string, value: string): Promise<void>;
    get(namespace: 'ai-key' | 'oauth-token' | 'git-credential' | 'app-secret', key: string): Promise<string | null>;
    delete(namespace: 'ai-key' | 'oauth-token' | 'git-credential' | 'app-secret', key: string): Promise<void>;
    has(namespace: 'ai-key' | 'oauth-token' | 'git-credential' | 'app-secret', key: string): Promise<boolean>;
    listKeys(namespace: 'ai-key' | 'oauth-token' | 'git-credential' | 'app-secret'): Promise<string[]>;
  };
  updater: {
    check(): Promise<{ version: string; notes?: string; releaseDate?: string } | null>;
    downloadAndInstall(): Promise<void>;
    onProgress(
      cb: (progress: { phase: 'checking' | 'available' | 'downloading' | 'installing' | 'done' | 'error'; percent?: number; message?: string }) => void,
    ): () => void;
  };
  appInfo: {
    get(): Promise<AppInfo>;
    getDataDir(): Promise<string>;
    setWorkspaceRoot(root: string): Promise<void>;
  };
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
    clear(): Promise<void>;
  };
  net: {
    fetch(request: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | number[];
      timeoutMs?: number;
    }): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }>;
    isHostAllowed(host: string): Promise<boolean>;
    setAllowedHosts(hosts: string[] | '*'): Promise<void>;
  };
  ai: {
    invoke(request: AiRpcRequest): Promise<AiRpcResponse>;
    stream(request: AiStreamRequest, listener: (event: AiStreamEvent) => void): { requestId: string; off(): void };
    abort(requestId: string): Promise<void>;
  };
  domain: {
    invoke(request: DomainRpcRequest): Promise<DomainRpcResponse>;
    describe(): Promise<DomainDescriptor[]>;
  };
  openExternal(url: string): Promise<void>;
}

export function getEcShellPreload(): EcShellPreload {
  const api = (globalThis as unknown as { ecShell?: EcShellPreload }).ecShell;
  if (!api) {
    throw new ShellError(
      'NOT_SUPPORTED',
      '当前环境未暴露 ecShell preload 桥（请确认 preload/index.js 已加载）',
      undefined,
      'electron',
    );
  }
  return api;
}

/** 包装 preload 异常为 ShellError（主进程错误以 JSON {code,message} 传递） */
async function call<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('{') && message.includes('"code"')) {
      try {
        const parsed = JSON.parse(message) as { code?: string; message?: string };
        if (parsed.code) {
          throw new ShellError(parsed.code as never, parsed.message ?? message, undefined, 'electron');
        }
      } catch (parseError) {
        if (parseError instanceof ShellError) throw parseError;
      }
    }
    throw toShellError(error, 'IO_ERROR', 'electron');
  }
}

export function createElectronShell(preload?: EcShellPreload): ShellHost {
  const api = preload ?? getEcShellPreload();
  const pathApi = createPathApi('\\');
  let localAllowlist: string[] | '*' = [];

  const watchHandles = new Set<{ id: string; close(): Promise<void> }>();

  const processApi = {
    async spawn(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; shell?: boolean }): Promise<ChildProcessHandle> {
      const { id, pid } = await call(() => api.process.spawn(command, args, options));
      const stdoutListeners = new Set<(chunk: string) => void>();
      const stderrListeners = new Set<(chunk: string) => void>();
      const exitListeners = new Set<(result: ProcessExit) => void>();
      let exitResult: ProcessExit | null = null;

      const offStdout = api.process.onStdout(id, (chunk) => {
        for (const listener of stdoutListeners) listener(chunk);
      });
      const offStderr = api.process.onStderr(id, (chunk) => {
        for (const listener of stderrListeners) listener(chunk);
      });
      // 进程退出后自动解绑 preload 侧监听，避免长期驻留泄漏
      const offExit = api.process.onExit(id, (result) => {
        exitResult = result;
        for (const listener of exitListeners) listener(result);
        offStdout();
        offStderr();
        offExit();
      });

      return {
        id,
        pid,
        write: async (data: string) => call(() => api.process.write(id, data)),
        kill: async (signal?: 'SIGTERM' | 'SIGKILL') => {
          await call(() => api.process.kill(id, signal));
        },
        onStdout: (listener) => {
          stdoutListeners.add(listener);
          return () => stdoutListeners.delete(listener);
        },
        onStderr: (listener) => {
          stderrListeners.add(listener);
          return () => stderrListeners.delete(listener);
        },
        onExit: (listener) => {
          if (exitResult) listener(exitResult);
          else exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        exited: new Promise<ProcessExit>((resolve) => {
          const off = api.process.onExit(id, (result) => {
            off();
            resolve(result);
          });
        }),
      };
    },
    list: () => call(() => api.process.list()),
    killAll: async () => call(() => api.process.killAll()),
  };

  const shell: ShellHost = {
    kind: 'electron',
    path: pathApi,
    fs: {
      readText: (filePath, encoding) => call(() => api.fs.readText(filePath, encoding)),
      readBinary: async (filePath) => {
        const bytes = await call(() => api.fs.readBinary(filePath));
        return Uint8Array.from(bytes);
      },
      writeAtomic: (filePath, data, options) =>
        call(() =>
          api.fs.writeAtomic(
            filePath,
            typeof data === 'string' ? data : Array.from(data),
            options?.encoding,
          ),
        ),
      stat: (filePath) => call(async () => (await api.fs.stat(filePath)) as never),
      readdir: (dirPath) => call(() => api.fs.readdir(dirPath)),
      mkdir: (dirPath, options) => call(() => api.fs.mkdir(dirPath, options)),
      remove: (target, options) => call(() => api.fs.remove(target, options)),
      copy: (source, target) => call(() => api.fs.copy(source, target)),
      rename: (source, target) => call(() => api.fs.rename(source, target)),
      exists: (target) => call(() => api.fs.exists(target)),
      watch: async (target, listener) => {
        const handle = await call(() => api.fs.watch(target, listener));
        const entry = { id: handle.id, close: () => handle.close() };
        watchHandles.add(entry);
        return {
          id: handle.id,
          close: async () => {
            watchHandles.delete(entry);
            await handle.close();
          },
        } satisfies FsWatchHandle;
      },
    },
    dialog: {
      openFile: (options) => call(() => api.dialog.openFile(options as Record<string, unknown>)),
      openDirectory: (options) => call(() => api.dialog.openDirectory(options as Record<string, unknown>)),
      saveFile: (options) => call(() => api.dialog.saveFile(options as Record<string, unknown>)),
      showMessage: (options) => call(() => api.dialog.showMessage({ ...options })),
      confirm: async (options) => {
        const result = await call(() => api.dialog.confirm({ ...options, level: 'question' }));
        return result === true;
      },
    },
    process: processApi,
    window: {
      setTitle: async (title) => call(() => api.window.setTitle(title)),
      minimize: () => call(() => api.window.minimize()),
      maximize: () => call(() => api.window.maximize()),
      unmaximize: () => call(() => api.window.unmaximize()),
      isMaximized: () => call(() => api.window.isMaximized()),
      setFullScreen: async (fullscreen) => call(() => api.window.setFullScreen(fullscreen)),
      isFullScreen: () => call(() => api.window.isFullScreen()),
      setSize: async (size) => call(() => api.window.setSize(size)),
      getSize: async () => {
        const [width, height] = await call(() => api.window.getSize());
        return { width: width ?? 0, height: height ?? 0 };
      },
      center: () => call(() => api.window.center()),
      focus: () => call(() => api.window.focus()),
      close: () => call(() => api.window.close()),
    },
    secureStore: {
      set: (namespace, key, value) => call(() => api.secureStore.set(namespace, key, value)),
      get: (namespace, key) => call(() => api.secureStore.get(namespace, key)),
      delete: (namespace, key) => call(() => api.secureStore.delete(namespace, key)),
      has: (namespace, key) => call(() => api.secureStore.has(namespace, key)),
      listKeys: (namespace) => call(() => api.secureStore.listKeys(namespace)),
    },
    updater: {
      check: () => call(() => api.updater.check()),
      downloadAndInstall: () => call(() => api.updater.downloadAndInstall()),
      onProgress: (listener) => api.updater.onProgress(listener),
    },
    appInfo: {
      get: () => call(() => api.appInfo.get()),
      getDataDir: () => call(() => api.appInfo.getDataDir()),
      setWorkspaceRoot: (root) => call(() => api.appInfo.setWorkspaceRoot(root)),
    },
    clipboard: {
      readText: () => call(() => api.clipboard.readText()),
      writeText: (text) => call(() => api.clipboard.writeText(text)),
      clear: () => call(() => api.clipboard.clear()),
    },
    net: {
      fetch: (request) =>
        call(async () => {
          const wire: {
            url: string;
            method?: string;
            headers?: Record<string, string>;
            body?: string | number[];
            timeoutMs?: number;
          } = { url: request.url, ...(request.headers !== undefined ? { headers: request.headers } : {}) };
          if (request.method !== undefined) wire.method = request.method;
          if (request.timeoutMs !== undefined) wire.timeoutMs = request.timeoutMs;
          if (request.body !== undefined) {
            wire.body = typeof request.body === 'string' ? request.body : Array.from(request.body);
          }
          return api.net.fetch(wire);
        }),
      // 白名单镜像在渲染层同步维护：isHostAllowed / allowedHosts 为同步语义，
      // setAllowedHosts 同时异步同步到主进程（主进程侧 fetch 前仍会二次校验）。
      isHostAllowed: (host) => {
        if (localAllowlist === '*') return true;
        return (localAllowlist as string[]).includes(host.toLowerCase());
      },
      setAllowedHosts: (hosts) => {
        localAllowlist = hosts;
        void call(() => api.net.setAllowedHosts(hosts)).catch(() => undefined);
      },
      allowedHosts: () => localAllowlist,
    },
    ai: {
      invoke: (request) => call(() => api.ai.invoke(request)),
      stream: (request: AiStreamRequest) => {
        const listeners = new Set<(event: AiStreamEvent) => void>();
        const wire = api.ai.stream(request, (event) => {
          for (const listener of listeners) listener(event);
        });
        return {
          requestId: wire.requestId,
          on: (listener: (event: AiStreamEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          abort: () => { void api.ai.abort(request.requestId); },
        };
      },
      abort: (requestId) => call(() => api.ai.abort(requestId)),
    },
    domain: {
      invoke: (request: DomainRpcRequest) => call(() => api.domain.invoke(request)),
      describe: () => call(() => api.domain.describe()),
    },
    openExternal: (url) => call(() => api.openExternal(url)),
    capabilities: async () => ({
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
      ai: true,
      domain: true,
    }),
    dispose: async () => {
      await Promise.allSettled([...watchHandles].map((handle) => handle.close()));
      watchHandles.clear();
      await call(() => api.process.killAll()).catch(() => undefined);
    },
  };

  return shell;
}

/** 渲染层启动入口：注册到 shell-api 工厂 */
registerShellFactory('electron', () => createElectronShell());
