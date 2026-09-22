import type { AiControlHost } from './ai-control';
import type { DomainControlHost } from './domain-control';

/** 外壳形态 */
export type ShellKind = 'tauri' | 'electron' | 'mock';

/** 运行平台 */
export type PlatformKind = 'windows' | 'linux' | 'macos';

/** CPU 架构 */
export type ArchKind = 'x64' | 'arm64' | 'ia32' | 'unknown';

/** 取消订阅函数 */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// 文件系统
// ---------------------------------------------------------------------------

export type FileEncoding = 'utf8' | 'base64' | 'binary';

export interface FsStat {
  path: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  /** Unix 毫秒时间戳 */
  mtimeMs: number;
  ctimeMs: number;
  readonly: boolean;
}

export interface FsDirent {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
}

export type WatchEventType = 'create' | 'modify' | 'remove';

export interface FsWatchEvent {
  type: WatchEventType;
  path: string;
}

export interface FsWatchHandle {
  readonly id: string;
  close(): Promise<void>;
}

export interface WriteAtomicOptions {
  encoding?: FileEncoding;
  /** 目标文件已存在时是否必须先备份（默认否） */
  createBackup?: boolean;
}

/**
 * 文件系统能力。
 * `writeAtomic` 是一等公民方法：所有写文件必须走「临时文件 → fsync → rename 替换」。
 */
export interface FsApi {
  readText(path: string, encoding?: FileEncoding): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeAtomic(path: string, data: string | Uint8Array, options?: WriteAtomicOptions): Promise<void>;
  stat(path: string): Promise<FsStat | null>;
  readdir(path: string): Promise<FsDirent[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  copy(source: string, target: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  watch(path: string, listener: (event: FsWatchEvent) => void): Promise<FsWatchHandle>;
}

// ---------------------------------------------------------------------------
// 路径（纯计算，同步）
// ---------------------------------------------------------------------------

export interface PathApi {
  readonly sep: '\\' | '/';
  join(...segments: string[]): string;
  resolve(...segments: string[]): string;
  dirname(path: string): string;
  basename(path: string, suffix?: string): string;
  extname(path: string): string;
  normalize(path: string): string;
  isAbsolute(path: string): boolean;
  /** 判断 child 是否位于 parent 目录之内（含自身） */
  isWithin(parent: string, child: string): boolean;
}

// ---------------------------------------------------------------------------
// 对话框
// ---------------------------------------------------------------------------

export type DialogMessageLevel = 'info' | 'warning' | 'error' | 'question';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
  multiple?: boolean;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export interface MessageDialogOptions {
  level: DialogMessageLevel;
  title: string;
  message: string;
  detail?: string;
  /** 按钮文案，默认 ['确定']；返回值为按钮下标 */
  buttons?: string[];
}

export interface DialogApi {
  openFile(options?: OpenDialogOptions): Promise<string[] | null>;
  openDirectory(options?: OpenDialogOptions): Promise<string | null>;
  saveFile(options?: SaveDialogOptions): Promise<string | null>;
  showMessage(options: MessageDialogOptions): Promise<number>;
  /** 语义化二次确认，返回用户是否确认（破坏性操作统一走这里） */
  confirm(options: Omit<MessageDialogOptions, 'level' | 'buttons'>): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// 进程
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Windows 下通过 cmd.exe 执行，用于 .bat/.cmd */
  shell?: boolean;
}

export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

export interface ChildProcessHandle {
  readonly id: string;
  readonly pid: number | null;
  /** 写入 stdin */
  write(data: string): Promise<void>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  onStdout(listener: (chunk: string) => void): Unsubscribe;
  onStderr(listener: (chunk: string) => void): Unsubscribe;
  onExit(listener: (result: ProcessExit) => void): Unsubscribe;
  readonly exited: Promise<ProcessExit>;
}

export interface ProcessInfo {
  id: string;
  pid: number | null;
  command: string;
  args: string[];
}

export interface ProcessApi {
  spawn(command: string, args: string[], options?: SpawnOptions): Promise<ChildProcessHandle>;
  list(): Promise<ProcessInfo[]>;
  killAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowApi {
  setTitle(title: string): Promise<void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  unmaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  setFullScreen(fullscreen: boolean): Promise<void>;
  isFullScreen(): Promise<boolean>;
  setSize(size: WindowSize): Promise<void>;
  getSize(): Promise<WindowSize>;
  center(): Promise<void>;
  focus(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 安全存储（DPAPI）
// ---------------------------------------------------------------------------

/** 密钥命名空间，避免不同用途互相污染 */
export type SecureNamespace = 'ai-key' | 'oauth-token' | 'git-credential' | 'app-secret';

export interface SecureStoreApi {
  set(namespace: SecureNamespace, key: string, value: string): Promise<void>;
  get(namespace: SecureNamespace, key: string): Promise<string | null>;
  delete(namespace: SecureNamespace, key: string): Promise<void>;
  has(namespace: SecureNamespace, key: string): Promise<boolean>;
  /** 只返回 key 名，不返回任何值 */
  listKeys(namespace: SecureNamespace): Promise<string[]>;
}

// ===========================================================================
// AI 控制（RPC + 流式）
// ===========================================================================
// ---------------------------------------------------------------------------
// 自动更新
// ---------------------------------------------------------------------------

export interface UpdateInfo {
  version: string;
  notes?: string;
  releaseDate?: string;
}

export type UpdatePhase =
  'checking' | 'available' | 'downloading' | 'installing' | 'done' | 'error';

export interface UpdateProgress {
  phase: UpdatePhase;
  /** 0–100，仅 downloading 阶段有意义 */
  percent?: number;
  message?: string;
}

export interface UpdaterApi {
  check(): Promise<UpdateInfo | null>;
  downloadAndInstall(): Promise<void>;
  onProgress(listener: (progress: UpdateProgress) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// 应用信息
// ---------------------------------------------------------------------------

export interface AppInfo {
  kind: ShellKind;
  name: string;
  version: string;
  platform: PlatformKind;
  arch: ArchKind;
  /** 本地数据目录（记忆、SQLite、快照均落在此） */
  dataDir: string;
  /** 当前工作区根目录，未设置时为 null */
  workspaceRoot: string | null;
  locale: string;
  isPackaged: boolean;
}

export interface AppInfoApi {
  get(): Promise<AppInfo>;
  getDataDir(): Promise<string>;
  setWorkspaceRoot(root: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 剪贴板
// ---------------------------------------------------------------------------

export interface ClipboardApi {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 受限网络
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface NetRequest {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface NetResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 受限网络能力：默认拒绝所有主机，需显式放行（OAuth / AI 请求 / 版本检查）。
 * 这是「不依赖命令行、不出网上传用户内容」硬约束的 enforcer。
 */
export interface NetApi {
  fetch(request: NetRequest): Promise<NetResponse>;
  isHostAllowed(host: string): boolean;
  setAllowedHosts(hosts: string[] | '*'): void;
  allowedHosts(): string[] | '*';
}

// ---------------------------------------------------------------------------
// 能力探测与总接口
// ---------------------------------------------------------------------------

/** 能力名集合（`ShellCapabilities` 里除 `reasons` 外的全部键） */
export type ShellCapabilityKey =
  | 'fs'
  | 'watch'
  | 'process'
  | 'dialog'
  | 'window'
  | 'secureStore'
  | 'updater'
  | 'net'
  | 'clipboard'
  | 'openExternal'
  | 'ai'
  | 'domain';

export interface ShellCapabilities {
  fs: boolean;
  watch: boolean;
  process: boolean;
  dialog: boolean;
  window: boolean;
  secureStore: boolean;
  updater: boolean;
  net: boolean;
  clipboard: boolean;
  openExternal: boolean;
  /** AI 栈是否可用（主进程已装配 SQLite + 密钥环 + AiStack 时为 true） */
  ai: boolean;
  /**
   * 领域端口 RPC 通道是否可用。为 true 仅表示**通道存在**，
   * 具体某个域是否装配完成由 `ShellHost.domain.describe()` 回答。
   */
  domain: boolean;
  /**
   * 能力缺失的**真实原因**（可选，面向用户，不得含路径与密钥）。
   *
   * 存在的意义：布尔 `false` 只说明"不可用"，用户与排查者无从判断是
   * "还没做"、"这台机器缺外部工具链"还是"用户自己禁用"。外壳如实上报原因后，
   * UI 可以给出可操作的引导，验收报告也能如实列出**受外部条件限制**的功能，
   * 而不是让它们看起来像普通缺失。
   *
   * 约定：只在对应能力为 `false` 时出现；能力为 `true` 却带原因 = 外壳在说谎，
   * `negotiate()` 会把它当作能力清单里的普通条目（不参与 `degraded` 计算）。
   */
  reasons?: Partial<Record<ShellCapabilityKey, string>>;
}

/** 外壳宿主：渲染层唯一允许接触的外壳对象 */
export interface ShellHost {
  readonly kind: ShellKind;
  readonly fs: FsApi;
  readonly path: PathApi;
  readonly dialog: DialogApi;
  readonly process: ProcessApi;
  readonly window: WindowApi;
  readonly secureStore: SecureStoreApi;
  readonly updater: UpdaterApi;
  /** AI 控制入口：渲染层经此调用主进程 AiStack（RPC + 流式），不反向依赖 @ec/ai */
  readonly ai: AiControlHost;
  /**
   * 领域端口入口（工作台 / 文档 / 账号 / 设置四域）。
   * 渲染层经此把 `globalThis.__EC_WORKSPACE__` 等端口装配到业务特性，
   * 不反向依赖 `@ec/core` 的 SQLite 侧实现。
   */
  readonly domain: DomainControlHost;
  readonly appInfo: AppInfoApi;
  readonly clipboard: ClipboardApi;
  readonly net: NetApi;
  openExternal(url: string): Promise<void>;
  capabilities(): Promise<ShellCapabilities>;
  /** 释放资源（监听、子进程、数据库连接），应用退出前调用 */
  dispose(): Promise<void>;
}
