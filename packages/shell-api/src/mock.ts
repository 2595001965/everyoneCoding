import { ShellError, toShellError } from './errors';
import type { AiControlHost, AiRpcError, AiRpcResponse, AiStreamEvent, AiStreamHandle } from './ai-control';
import {
  DOMAIN_KINDS,
  domainUnavailableError,
  type DomainControlHost,
  type DomainDescriptor,
  type DomainRpcResponse,
} from './domain-control';
import type {
  AppInfo,
  ArchKind,
  ChildProcessHandle,
  ClipboardApi,
  DialogApi,
  FsApi,
  FsDirent,
  FsStat,
  FsWatchEvent,
  FsWatchHandle,
  MessageDialogOptions,
  NetApi,
  NetRequest,
  NetResponse,
  OpenDialogOptions,
  PathApi,
  PlatformKind,
  ProcessApi,
  ProcessExit,
  ProcessInfo,
  SaveDialogOptions,
  SecureNamespace,
  SecureStoreApi,
  ShellCapabilities,
  ShellHost,
  ShellKind,
  SpawnOptions,
  UpdateInfo,
  UpdateProgress,
  UpdaterApi,
  WindowApi,
  WindowSize,
  WriteAtomicOptions,
} from './types';

// ---------------------------------------------------------------------------
// 路径工具（Mock 专用，纯字符串计算；Windows 与 POSIX 分隔符都接受）
// ---------------------------------------------------------------------------

const normalizeKey = (input: string): string =>
  input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';

const parentOf = (key: string): string => {
  const idx = key.lastIndexOf('/');
  if (idx <= 0) return '/';
  return key.slice(0, idx);
};

// ---------------------------------------------------------------------------
// 内存文件系统
// ---------------------------------------------------------------------------

type Node = { kind: 'file'; data: Uint8Array; mtimeMs: number } | { kind: 'dir'; mtimeMs: number };

/** 原子写失败注入点，用于模拟断电 / 进程被杀 */
export type AtomicWriteFailurePoint = 'after-tmp' | 'before-rename';

export class MockFileSystem implements FsApi {
  private readonly nodes = new Map<string, Node>();
  private readonly watchers = new Map<string, Set<(event: FsWatchEvent) => void>>();
  private watchSeq = 0;

  /** 下一次原子写在指定阶段抛错（模拟断电），触发后自动清除 */
  failNextAtomicWriteAt: AtomicWriteFailurePoint | null = null;

  constructor() {
    this.nodes.set('/', { kind: 'dir', mtimeMs: Date.now() });
  }

  // -- 测试辅助 ------------------------------------------------------------
  /** 直接投放文件（绕过原子写），用于构造前置数据 */
  seed(path: string, content: string | Uint8Array): void {
    const key = normalizeKey(path);
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.ensureDir(parentOf(key));
    this.nodes.set(key, { kind: 'file', data, mtimeMs: Date.now() });
  }

  /** 读取内部存放的原始字节（测试断言用） */
  peek(path: string): Uint8Array | null {
    const node = this.nodes.get(normalizeKey(path));
    return node && node.kind === 'file' ? node.data : null;
  }

  /** 列出所有临时文件（用于断言断电后不残留 / 有残留待清理） */
  listTmpFiles(): string[] {
    return [...this.nodes.keys()].filter((k) => k.includes('.ec-tmp'));
  }

  private ensureDir(key: string): void {
    if (key === '/' || this.nodes.has(key)) return;
    this.ensureDir(parentOf(key));
    this.nodes.set(key, { kind: 'dir', mtimeMs: Date.now() });
  }

  private emit(type: FsWatchEvent['type'], path: string): void {
    const key = normalizeKey(path);
    for (const [watched, listeners] of this.watchers) {
      if (key === watched || key.startsWith(watched === '/' ? '/' : `${watched}/`)) {
        for (const listener of listeners) listener({ type, path: key });
      }
    }
  }

  // -- FsApi ---------------------------------------------------------------
  async readText(path: string, encoding: 'utf8' | 'base64' | 'binary' = 'utf8'): Promise<string> {
    const node = this.nodes.get(normalizeKey(path));
    if (!node) throw new ShellError('NOT_FOUND', `文件不存在: ${path}`, undefined, 'mock');
    if (node.kind !== 'file') throw new ShellError('INVALID_ARGUMENT', `不是文件: ${path}`, undefined, 'mock');
    if (encoding === 'utf8') return new TextDecoder().decode(node.data);
    return Buffer.from(node.data).toString(encoding === 'base64' ? 'base64' : 'binary');
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const node = this.nodes.get(normalizeKey(path));
    if (!node) throw new ShellError('NOT_FOUND', `文件不存在: ${path}`, undefined, 'mock');
    if (node.kind !== 'file') throw new ShellError('INVALID_ARGUMENT', `不是文件: ${path}`, undefined, 'mock');
    return new Uint8Array(node.data);
  }

  async writeAtomic(
    path: string,
    data: string | Uint8Array,
    _options?: WriteAtomicOptions,
  ): Promise<void> {
    const key = normalizeKey(path);
    if (this.nodes.get(key)?.kind === 'dir') {
      throw new ShellError('INVALID_ARGUMENT', `目标是目录: ${path}`, undefined, 'mock');
    }
    this.ensureDir(parentOf(key));
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const tmp = `${key}.ec-tmp-${++this.watchSeq}`;

    // 阶段一：写入临时文件
    this.nodes.set(tmp, { kind: 'file', data: new Uint8Array(bytes), mtimeMs: Date.now() });
    if (this.failNextAtomicWriteAt === 'after-tmp') {
      this.failNextAtomicWriteAt = null;
      throw new ShellError('IO_ERROR', '模拟断电：临时文件写入后中断', undefined, 'mock');
    }

    // 阶段二：rename 替换（Mock 中保证是「不存在中间态」的最后一步）
    if (this.failNextAtomicWriteAt === 'before-rename') {
      this.failNextAtomicWriteAt = null;
      throw new ShellError('IO_ERROR', '模拟断电：rename 前中断', undefined, 'mock');
    }
    const existed = this.nodes.has(key);
    this.nodes.delete(tmp);
    this.nodes.set(key, { kind: 'file', data: new Uint8Array(bytes), mtimeMs: Date.now() });
    this.emit(existed ? 'modify' : 'create', key);
  }

  async stat(path: string): Promise<FsStat | null> {
    const key = normalizeKey(path);
    const node = this.nodes.get(key);
    if (!node) return null;
    return {
      path: key,
      size: node.kind === 'file' ? node.data.byteLength : 0,
      isFile: node.kind === 'file',
      isDirectory: node.kind === 'dir',
      mtimeMs: node.mtimeMs,
      ctimeMs: node.mtimeMs,
      readonly: false,
    };
  }

  async readdir(path: string): Promise<FsDirent[]> {
    const key = normalizeKey(path);
    const node = this.nodes.get(key);
    if (!node) throw new ShellError('NOT_FOUND', `目录不存在: ${path}`, undefined, 'mock');
    if (node.kind !== 'dir') throw new ShellError('INVALID_ARGUMENT', `不是目录: ${path}`, undefined, 'mock');
    const prefix = key === '/' ? '/' : `${key}/`;
    const out: FsDirent[] = [];
    for (const [candidate, child] of this.nodes) {
      if (candidate === '/' || !candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push({
        name: rest,
        path: candidate,
        isFile: child.kind === 'file',
        isDirectory: child.kind === 'dir',
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const key = normalizeKey(path);
    if (this.nodes.has(key)) {
      if (this.nodes.get(key)?.kind === 'dir') return;
      throw new ShellError('ALREADY_EXISTS', `已存在同名文件: ${path}`, undefined, 'mock');
    }
    if (!options?.recursive && !this.nodes.has(parentOf(key))) {
      throw new ShellError('NOT_FOUND', `父目录不存在: ${path}`, undefined, 'mock');
    }
    this.ensureDir(key);
    this.emit('create', key);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const key = normalizeKey(path);
    const node = this.nodes.get(key);
    if (!node) return;
    if (node.kind === 'dir' && !options?.recursive) {
      const children = await this.readdir(key);
      if (children.length > 0) {
        throw new ShellError('INVALID_ARGUMENT', `目录非空: ${path}`, undefined, 'mock');
      }
    }
    const prefix = `${key}/`;
    for (const candidate of [...this.nodes.keys()]) {
      if (candidate === key || (node.kind === 'dir' && candidate.startsWith(prefix))) {
        this.nodes.delete(candidate);
      }
    }
    this.emit('remove', key);
  }

  async copy(source: string, target: string): Promise<void> {
    const from = this.nodes.get(normalizeKey(source));
    if (!from) throw new ShellError('NOT_FOUND', `源文件不存在: ${source}`, undefined, 'mock');
    if (from.kind !== 'file') throw new ShellError('INVALID_ARGUMENT', `不是文件: ${source}`, undefined, 'mock');
    await this.writeAtomic(target, new Uint8Array(from.data));
  }

  async rename(source: string, target: string): Promise<void> {
    const from = normalizeKey(source);
    const node = this.nodes.get(from);
    if (!node) throw new ShellError('NOT_FOUND', `源不存在: ${source}`, undefined, 'mock');
    const to = normalizeKey(target);
    this.ensureDir(parentOf(to));
    this.nodes.delete(from);
    this.nodes.set(to, node);
    this.emit('remove', from);
    this.emit('create', to);
  }

  async exists(path: string): Promise<boolean> {
    return this.nodes.has(normalizeKey(path));
  }

  async watch(path: string, listener: (event: FsWatchEvent) => void): Promise<FsWatchHandle> {
    const key = normalizeKey(path);
    const id = `w${++this.watchSeq}`;
    const set = this.watchers.get(key) ?? new Set();
    set.add(listener);
    this.watchers.set(key, set);
    return {
      id,
      close: async () => {
        set.delete(listener);
        if (set.size === 0) this.watchers.delete(key);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 内存进程
// ---------------------------------------------------------------------------

/** Mock 子进程的外部控制器：测试用它推日志与结束进程 */
export interface MockProcessController {
  pushStdout(chunk: string): void;
  pushStderr(chunk: string): void;
  exit(code: number | null, signal?: string | null): void;
}

export interface MockProcessHandle extends ChildProcessHandle, MockProcessController {
  readonly command: string;
  readonly args: string[];
  readonly options: SpawnOptions | undefined;
  readonly stdin: string[];
  killed: boolean;
}

export class MockProcessApi implements ProcessApi {
  readonly handles: MockProcessHandle[] = [];
  private seq = 0;
  private readonly handlers = new Map<
    string,
    (args: string[], controller: MockProcessController) => void | Promise<void>
  >();

  /** 预置命令处理器（按命令名匹配），让测试无需手工推流 */
  registerHandler(
    command: string,
    handler: (args: string[], controller: MockProcessController) => void | Promise<void>,
  ): void {
    this.handlers.set(command, handler);
  }

  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<ChildProcessHandle> {
    const stdoutListeners = new Set<(chunk: string) => void>();
    const stderrListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(result: ProcessExit) => void>();
    // 输出缓冲：命令执行可能早于调用方订阅，迟到订阅会先收到已产生的片段
    const stdoutBuffer: string[] = [];
    const stderrBuffer: string[] = [];
    let resolveExit!: (value: ProcessExit) => void;
    const exited = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    let settled = false;
    let exitResult: ProcessExit | null = null;

    const handle: MockProcessHandle = {
      id: `p${++this.seq}`,
      pid: 1000 + this.seq,
      command,
      args,
      options,
      stdin: [],
      killed: false,
      exited,
      pushStdout: (chunk) => {
        stdoutBuffer.push(chunk);
        for (const listener of stdoutListeners) listener(chunk);
      },
      pushStderr: (chunk) => {
        stderrBuffer.push(chunk);
        for (const listener of stderrListeners) listener(chunk);
      },
      exit: (code, signal = null) => {
        if (settled) return;
        settled = true;
        const result: ProcessExit = { code, signal };
        exitResult = result;
        resolveExit(result);
        for (const listener of exitListeners) listener(result);
      },
      write: async (data) => {
        handle.stdin.push(data);
      },
      kill: async () => {
        handle.killed = true;
        handle.exit(null, 'SIGTERM');
      },
      onStdout: (listener) => {
        for (const chunk of stdoutBuffer) listener(chunk);
        stdoutListeners.add(listener);
        return () => stdoutListeners.delete(listener);
      },
      onStderr: (listener) => {
        for (const chunk of stderrBuffer) listener(chunk);
        stderrListeners.add(listener);
        return () => stderrListeners.delete(listener);
      },
      onExit: (listener) => {
        if (exitResult) listener(exitResult);
        else exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    };

    this.handles.push(handle);
    const handler = this.handlers.get(command);
    // 延后到下一个微任务执行，确保调用方先完成 onStdout / onExit 订阅
    if (handler) {
      void Promise.resolve().then(() => {
        void handler(args, handle);
      });
    }
    return handle;
  }

  async list(): Promise<ProcessInfo[]> {
    return this.handles.map((h) => ({ id: h.id, pid: h.pid, command: h.command, args: h.args }));
  }

  async killAll(): Promise<void> {
    for (const handle of this.handles) await handle.kill();
  }
}

// ---------------------------------------------------------------------------
// Mock 安全存储（模拟 DPAPI 按 Windows 用户上下文隔离）
// ---------------------------------------------------------------------------

class MockSecureStore implements SecureStoreApi {
  private readonly entries = new Map<string, { sid: string; cipher: string }>();
  private currentSid: string;

  constructor(sid: string) {
    this.currentSid = sid;
  }

  /** 模拟切换 Windows 用户：切换后旧数据一律不可解密 */
  setUserSid(sid: string): void {
    this.currentSid = sid;
  }

  private keyOf(namespace: SecureNamespace, key: string): string {
    return JSON.stringify([namespace, key]);
  }

  async set(namespace: SecureNamespace, key: string, value: string): Promise<void> {
    // 模拟 CryptProtectData：密文里绑定当前用户 SID
    const cipher = Buffer.from(`${this.currentSid}::${value}`, 'utf8').toString('base64');
    this.entries.set(this.keyOf(namespace, key), { sid: this.currentSid, cipher });
  }

  async get(namespace: SecureNamespace, key: string): Promise<string | null> {
    const entry = this.entries.get(this.keyOf(namespace, key));
    if (!entry) return null;
    if (entry.sid !== this.currentSid) {
      throw new ShellError('DECRYPT_FAILED', '当前用户上下文无法解密该项（模拟 DPAPI）', undefined, 'mock');
    }
    const raw = Buffer.from(entry.cipher, 'base64').toString('utf8');
    return raw.slice(raw.indexOf('::') + 2);
  }

  async delete(namespace: SecureNamespace, key: string): Promise<void> {
    this.entries.delete(this.keyOf(namespace, key));
  }

  async has(namespace: SecureNamespace, key: string): Promise<boolean> {
    return this.entries.has(this.keyOf(namespace, key));
  }

  async listKeys(namespace: SecureNamespace): Promise<string[]> {
    return [...this.entries.keys()]
      .map((raw) => JSON.parse(raw) as [SecureNamespace, string])
      .filter((pair) => pair[0] === namespace)
      .map((pair) => pair[1]);
  }

  /** 测试辅助：读取落盘的密文，用于断言「磁盘上检索不到明文」 */
  peekCipher(namespace: SecureNamespace, key: string): string | null {
    return this.entries.get(this.keyOf(namespace, key))?.cipher ?? null;
  }
}

// ---------------------------------------------------------------------------
// Mock 网络（默认全部拒绝）
// ---------------------------------------------------------------------------

class MockNet implements NetApi {
  private hosts: string[] | '*' = [];
  private responder: ((request: NetRequest) => NetResponse | Promise<NetResponse>) | null = null;

  setResponder(responder: ((request: NetRequest) => NetResponse | Promise<NetResponse>) | null): void {
    this.responder = responder;
  }

  isHostAllowed(host: string): boolean {
    if (this.hosts === '*') return true;
    return this.hosts.includes(host);
  }

  setAllowedHosts(hosts: string[] | '*'): void {
    this.hosts = hosts;
  }

  allowedHosts(): string[] | '*' {
    return this.hosts;
  }

  async fetch(request: NetRequest): Promise<NetResponse> {
    let host: string;
    try {
      host = new URL(request.url).host;
    } catch (error) {
      throw new ShellError('INVALID_ARGUMENT', `非法 URL: ${request.url}`, error, 'mock');
    }
    if (!this.isHostAllowed(host)) {
      throw new ShellError('NET_BLOCKED', `主机未放行: ${host}`, undefined, 'mock');
    }
    if (!this.responder) {
      throw new ShellError('NET_ERROR', '未配置响应器', undefined, 'mock');
    }
    return this.responder(request);
  }
}

// ---------------------------------------------------------------------------
// MockShell
// ---------------------------------------------------------------------------

export interface MockShellOptions {
  platform?: PlatformKind;
  arch?: ArchKind;
  dataDir?: string;
  name?: string;
  version?: string;
  userSid?: string;
  locale?: string;
  isPackaged?: boolean;
  capabilities?: Partial<ShellCapabilities>;
  /** 注入自定义 AI 控制宿主（默认返回 NOT_SUPPORTED） */
  ai?: AiControlHost;
  /** 注入自定义领域端口宿主（默认四域全部如实报告不可用） */
  domain?: DomainControlHost;
}

/** 内存实现的外壳，供渲染层无外壳开发、单元测试与契约测试使用 */
export class MockShell implements ShellHost {
  readonly kind: ShellKind = 'mock';
  readonly fs: MockFileSystem;
  readonly path: PathApi;
  readonly dialog: DialogApi;
  readonly process: MockProcessApi;
  readonly window: WindowApi;
  readonly secureStore: SecureStoreApi;
  readonly updater: UpdaterApi;
  /** AI 控制入口：默认返回 NOT_SUPPORTED（内存外壳无真实栈），可由 options.ai 注入 */
  readonly ai: AiControlHost;
  /** 领域端口入口：默认四域全部不可用，可由 options.domain 注入 */
  readonly domain: DomainControlHost;
  readonly appInfo: AppInfoApiLike;
  readonly clipboard: ClipboardApi;
  readonly net: NetApi;

  private readonly capabilityFlags: ShellCapabilities;
  private readonly secure: MockSecureStore;
  private disposed = false;

  /** 测试辅助：对话框脚本化返回值队列 */
  readonly dialogQueue: {
    openFile?: string[] | null;
    openDirectory?: string | null;
    saveFile?: string | null;
    message?: number;
  } = {};
  /** 测试辅助：记录外部调用 */
  readonly openedExternal: string[] = [];
  /** 测试辅助：更新器脚本 */
  nextUpdateInfo: UpdateInfo | null = null;

  constructor(options: MockShellOptions = {}) {
    this.fs = new MockFileSystem();
    this.process = new MockProcessApi();
    this.secure = new MockSecureStore(options.userSid ?? 'S-1-5-21-mock-user');
    this.secureStore = this.secure;
    this.ai = options.ai ?? createMockAiControlHost();
    this.domain = options.domain ?? createMockDomainControlHost();
    this.net = new MockNet();
    this.capabilityFlags = {
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
      // 内存外壳默认无真实 AI 栈；需要时可注入自定义 AiControlHost
      ai: false,
      // 内存外壳默认无域运行时；需要时可注入自定义 DomainControlHost
      domain: false,
      ...options.capabilities,
    };

    const sep: '\\' | '/' = options.platform === 'windows' || options.platform === undefined ? '\\' : '/';
    this.path = createPathApi(sep);

    let clipboardText = '';
    this.clipboard = {
      readText: async () => clipboardText,
      writeText: async (text) => {
        clipboardText = text;
      },
      clear: async () => {
        clipboardText = '';
      },
    };

    const windowState = { maximized: false, fullscreen: false, title: options.name ?? 'EveryoneCoding', size: { width: 1440, height: 900 } };
    this.window = {
      setTitle: async (title) => {
        windowState.title = title;
      },
      minimize: async () => undefined,
      maximize: async () => {
        windowState.maximized = true;
      },
      unmaximize: async () => {
        windowState.maximized = false;
      },
      isMaximized: async () => windowState.maximized,
      setFullScreen: async (fullscreen) => {
        windowState.fullscreen = fullscreen;
      },
      isFullScreen: async () => windowState.fullscreen,
      setSize: async (size: WindowSize) => {
        windowState.size = size;
      },
      getSize: async () => windowState.size,
      center: async () => undefined,
      focus: async () => undefined,
      close: async () => undefined,
    };

    const messages: MessageDialogOptions[] = [];
    this.dialog = {
      openFile: async () => this.dialogQueue.openFile ?? null,
      openDirectory: async () => this.dialogQueue.openDirectory ?? null,
      saveFile: async () => this.dialogQueue.saveFile ?? null,
      showMessage: async (opts) => {
        messages.push(opts);
        return this.dialogQueue.message ?? 0;
      },
      confirm: async (opts) => {
        messages.push({ ...opts, level: 'question', buttons: ['取消', '确认'] });
        return (this.dialogQueue.message ?? 0) === 1;
      },
    };
    this.messageHistory = messages;

    const progressListeners = new Set<(progress: UpdateProgress) => void>();
    this.updater = {
      check: async () => this.nextUpdateInfo,
      downloadAndInstall: async () => {
        for (const listener of progressListeners) listener({ phase: 'downloading', percent: 100 });
        for (const listener of progressListeners) listener({ phase: 'done' });
      },
      onProgress: (listener) => {
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
      },
    };

    const dataDir = options.dataDir ?? `${sep === '\\' ? 'C:' : ''}/Users/mock/AppData/Roaming/EveryoneCoding`;
    let workspaceRoot: string | null = null;
    const info: AppInfo = {
      kind: 'mock',
      name: options.name ?? 'EveryoneCoding',
      version: options.version ?? '0.1.0',
      platform: options.platform ?? 'windows',
      arch: options.arch ?? 'x64',
      dataDir,
      workspaceRoot,
      locale: options.locale ?? 'zh-CN',
      isPackaged: options.isPackaged ?? false,
    };
    this.appInfo = {
      get: async () => ({ ...info, workspaceRoot }),
      getDataDir: async () => dataDir,
      setWorkspaceRoot: async (root) => {
        workspaceRoot = root;
        info.workspaceRoot = root;
      },
    };
  }

  /** 测试辅助：对话框调用历史 */
  readonly messageHistory: MessageDialogOptions[];

  /** 测试辅助：切换「Windows 用户」以验证 DPAPI 隔离 */
  setUserSid(sid: string): void {
    this.secure.setUserSid(sid);
  }

  /** 测试辅助：读取密钥落盘密文 */
  peekSecureCipher(namespace: SecureNamespace, key: string): string | null {
    return this.secure.peekCipher(namespace, key);
  }

  async openExternal(url: string): Promise<void> {
    this.openedExternal.push(url);
  }

  async capabilities(): Promise<ShellCapabilities> {
    return { ...this.capabilityFlags };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.process.killAll();
  }
}

/** AppInfoApi 的本地别名，避免额外 import 噪音 */
type AppInfoApiLike = ShellHost['appInfo'];

// ---------------------------------------------------------------------------
// Mock AI 控制宿主（内存外壳无真实栈时使用）
// ---------------------------------------------------------------------------

/** 默认 Mock AI 宿主：所有调用返回 NOT_SUPPORTED，stream 立即以 error 结束。
 * 测试需要真实行为时，应通过 options.ai 注入受控宿主（如包内 LocalAiControlHost）。 */
export function createMockAiControlHost(): AiControlHost {
  const notSupported: AiRpcError = { code: 'NOT_SUPPORTED', message: '内存外壳未装配 AI 栈' };
  return {
    async invoke(request): Promise<AiRpcResponse> {
      return { requestId: request.requestId, ok: false, error: notSupported };
    },
    stream(request): AiStreamHandle {
      const listeners = new Set<(event: AiStreamEvent) => void>();
      // 下一微任务立即以 error 结束，避免调用方永久悬挂
      void Promise.resolve().then(() => {
        for (const listener of listeners) {
          listener({ type: 'error', error: notSupported });
          listener({ type: 'done', finishReason: 'error', partial: true });
        }
      });
      return {
        requestId: request.requestId,
        on(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        abort() {
          /* 无进行中的请求，no-op */
        },
      };
    },
    abort() {
      /* no-op */
    },
  };
}

// ---------------------------------------------------------------------------
// Mock 领域端口宿主（内存外壳无真实栈时使用）
// ---------------------------------------------------------------------------

/** 默认 Mock 领域宿主：四个域全部**如实**报告不可用，invoke 一律返回 NOT_SUPPORTED。
 *
 * 之所以不返回假数据：渲染层据 describe() 决定是否注入全局端口，
 * 假可用会让页面拿到一个"能打开但每个动作都失败"的端口，比保留装配引导更糟。
 * 需要真实行为时通过 options.domain 注入受控宿主。 */
export function createMockDomainControlHost(): DomainControlHost {
  return {
    async invoke(request): Promise<DomainRpcResponse> {
      return {
        requestId: request.requestId,
        ok: false,
        error: domainUnavailableError(request.domain, `内存外壳未装配 ${request.domain} 域运行时`),
      };
    },
    async describe(): Promise<DomainDescriptor[]> {
      return DOMAIN_KINDS.map((kind) => ({
        kind,
        available: false,
        reason: '内存外壳未装配域运行时',
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// 路径实现（Mock 与双形态共享同一套纯函数语义）
// ---------------------------------------------------------------------------

export function createPathApi(sep: '\\' | '/'): PathApi {
  const toPosix = (p: string) => p.replace(/\\/g, '/');
  const toNative = (p: string) => (sep === '\\' ? p.replace(/\//g, '\\') : p);

  const normalizeInput = (p: string) => {
    const posix = toPosix(p);
    const isAbs = posix.startsWith('/') || /^[a-zA-Z]:\//.test(posix);
    const parts: string[] = [];
    for (const segment of posix.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
        else if (!isAbs) parts.push('..');
        continue;
      }
      parts.push(segment);
    }
    const drive = /^([a-zA-Z]):/.exec(posix);
    const driveLetter = drive?.[1];
    // Windows 盘符只作为前缀出现一次，不能重复拼进路径段
    const dropDrive =
      driveLetter !== undefined &&
      parts[0] !== undefined &&
      parts[0].toLowerCase() === `${driveLetter.toLowerCase()}:`;
    const segments = dropDrive ? parts.slice(1) : parts;
    const prefix = driveLetter !== undefined ? `${driveLetter}:/` : isAbs ? '/' : '';
    return `${prefix}${segments.join('/')}`;
  };

  return {
    sep,
    join: (...segments) => toNative(normalizeInput([...segments].join('/'))),
    resolve: (...segments) => toNative(normalizeInput(segments.map(toPosix).join('/'))),
    dirname: (p) => {
      const norm = normalizeInput(p);
      const idx = norm.lastIndexOf('/');
      if (idx < 0) return '.';
      if (idx === 0) return toNative('/');
      return toNative(norm.slice(0, idx));
    },
    basename: (p, suffix) => {
      const norm = normalizeInput(p);
      const name = norm.slice(norm.lastIndexOf('/') + 1);
      return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    },
    extname: (p) => {
      const name = normalizeInput(p).slice(normalizeInput(p).lastIndexOf('/') + 1);
      const idx = name.lastIndexOf('.');
      return idx <= 0 ? '' : name.slice(idx);
    },
    normalize: (p) => toNative(normalizeInput(p)),
    isAbsolute: (p) => {
      const posix = toPosix(p);
      return posix.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(posix);
    },
    isWithin: (parent, child) => {
      const p = normalizeInput(parent);
      const c = normalizeInput(child);
      return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
    },
  };
}

export { toShellError };
export type { OpenDialogOptions, SaveDialogOptions };
