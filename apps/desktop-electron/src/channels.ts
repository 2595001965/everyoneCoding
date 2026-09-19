/**
 * IPC 通道名常量 —— preload 与主进程共用，且与 ShellHost 方法一一对应。
 *
 * 命名规则：`<能力组>.<方法>`，例如 `fs.writeAtomic`。主进程按此注册 handler，
 * preload 按此暴露白名单，bridge 按此调用。通道字符串统一以 `ec:` 前缀避免冲突。
 *
 * 设计要点：
 * - 纯同步能力（path、net 白名单查询）走 `sendSync`，因为 ShellHost 契约要求这些方法同步返回；
 *   其余 request/response 一律走 `ipcMain.handle`（`invoke`）。
 * - 事件类通道（后缀为事件名，如 `process.stdout`）由主进程 `webContents.send` 推流，
 *   preload 用 `ipcRenderer.on` 订阅并回调渲染层，绝不在渲染层直接持有 Node 全局。
 */

import type {
  AppInfo,
  FileEncoding,
  FsDirent,
  FsStat,
  FsWatchEvent,
  HttpMethod,
  NetRequest,
  NetResponse,
  OpenDialogOptions,
  ProcessExit,
  ProcessInfo,
  SaveDialogOptions,
  SecureNamespace,
  ShellCapabilities,
  SpawnOptions,
  MessageDialogOptions,
  UpdateInfo,
  UpdateProgress,
  WindowSize,
  WriteAtomicOptions,
} from '@ec/shell-api';

/** ShellHost 方法通道（request/response 或 sendSync） */
export const METHOD_CHANNELS = {
  // fs
  'fs.readText': 'ec:fs:readText',
  'fs.readBinary': 'ec:fs:readBinary',
  'fs.writeAtomic': 'ec:fs:writeAtomic',
  'fs.stat': 'ec:fs:stat',
  'fs.readdir': 'ec:fs:readdir',
  'fs.mkdir': 'ec:fs:mkdir',
  'fs.remove': 'ec:fs:remove',
  'fs.copy': 'ec:fs:copy',
  'fs.rename': 'ec:fs:rename',
  'fs.exists': 'ec:fs:exists',
  'fs.watch': 'ec:fs:watch',
  'fs.unwatch': 'ec:fs:unwatch',
  // path（同步 sendSync）
  'path.join': 'ec:path:join',
  'path.resolve': 'ec:path:resolve',
  'path.dirname': 'ec:path:dirname',
  'path.basename': 'ec:path:basename',
  'path.extname': 'ec:path:extname',
  'path.normalize': 'ec:path:normalize',
  'path.isAbsolute': 'ec:path:isAbsolute',
  'path.isWithin': 'ec:path:isWithin',
  // dialog
  'dialog.openFile': 'ec:dialog:openFile',
  'dialog.openDirectory': 'ec:dialog:openDirectory',
  'dialog.saveFile': 'ec:dialog:saveFile',
  'dialog.showMessage': 'ec:dialog:showMessage',
  'dialog.confirm': 'ec:dialog:confirm',
  // process
  'process.spawn': 'ec:process:spawn',
  'process.list': 'ec:process:list',
  'process.killAll': 'ec:process:killAll',
  'process.write': 'ec:process:write',
  'process.kill': 'ec:process:kill',
  // window
  'window.setTitle': 'ec:window:setTitle',
  'window.minimize': 'ec:window:minimize',
  'window.maximize': 'ec:window:maximize',
  'window.unmaximize': 'ec:window:unmaximize',
  'window.isMaximized': 'ec:window:isMaximized',
  'window.setFullScreen': 'ec:window:setFullScreen',
  'window.isFullScreen': 'ec:window:isFullScreen',
  'window.setSize': 'ec:window:setSize',
  'window.getSize': 'ec:window:getSize',
  'window.center': 'ec:window:center',
  'window.focus': 'ec:window:focus',
  'window.close': 'ec:window:close',
  // secureStore
  'secureStore.set': 'ec:secureStore:set',
  'secureStore.get': 'ec:secureStore:get',
  'secureStore.delete': 'ec:secureStore:delete',
  'secureStore.has': 'ec:secureStore:has',
  'secureStore.listKeys': 'ec:secureStore:listKeys',
  // updater
  'updater.check': 'ec:updater:check',
  'updater.downloadAndInstall': 'ec:updater:downloadAndInstall',
  // appInfo
  'appInfo.get': 'ec:appInfo:get',
  'appInfo.getDataDir': 'ec:appInfo:getDataDir',
  'appInfo.setWorkspaceRoot': 'ec:appInfo:setWorkspaceRoot',
  // clipboard
  'clipboard.readText': 'ec:clipboard:readText',
  'clipboard.writeText': 'ec:clipboard:writeText',
  'clipboard.clear': 'ec:clipboard:clear',
  // net（fetch 为 invoke；白名单查询为同步 sendSync）
  'net.fetch': 'ec:net:fetch',
  'net.isHostAllowed': 'ec:net:isHostAllowed',
  'net.setAllowedHosts': 'ec:net:setAllowedHosts',
  'net.allowedHosts': 'ec:net:allowedHosts',
  // 顶层
  openExternal: 'ec:openExternal',
  capabilities: 'ec:capabilities',
  dispose: 'ec:dispose',
} as const;

/** 主进程 → 渲染层事件通道（订阅式） */
export const EVENT_CHANNELS = {
  'fs.watchEvent': 'ec:fs:watchEvent',
  'process.stdout': 'ec:process:stdout',
  'process.stderr': 'ec:process:stderr',
  'process.exit': 'ec:process:exit',
  'updater.progress': 'ec:updater:progress',
} as const;

/** 全部通道（方法 + 事件） */
export const CHANNELS = { ...METHOD_CHANNELS, ...EVENT_CHANNELS } as const;

/** 同步通道（sendSync，对应 ShellHost 契约中的同步方法） */
export const SYNC_CHANNELS: ReadonlySet<string> = new Set<string>([
  METHOD_CHANNELS['path.join'],
  METHOD_CHANNELS['path.resolve'],
  METHOD_CHANNELS['path.dirname'],
  METHOD_CHANNELS['path.basename'],
  METHOD_CHANNELS['path.extname'],
  METHOD_CHANNELS['path.normalize'],
  METHOD_CHANNELS['path.isAbsolute'],
  METHOD_CHANNELS['path.isWithin'],
  METHOD_CHANNELS['net.isHostAllowed'],
  METHOD_CHANNELS['net.setAllowedHosts'],
  METHOD_CHANNELS['net.allowedHosts'],
]);

/** 序列化后的 ShellError（跨 IPC 传递，避免底层堆栈泄漏） */
export interface SerializedShellError {
  __shellError: true;
  code: string;
  message: string;
}

/**
 * 渲染层安全接口：preload 通过 contextBridge 暴露的对象。
 * 每个键名与 CHANNELS 的键一一对应，值要么是 request/response 函数，要么是事件订阅函数。
 * 绝不包含 require / process / Buffer 等 Node 全局。
 */
export interface ElectronShellApi {
  // fs
  'fs.readText': (path: string, encoding?: FileEncoding) => Promise<string>;
  'fs.readBinary': (path: string) => Promise<Uint8Array>;
  'fs.writeAtomic': (
    path: string,
    data: string | Uint8Array,
    options?: WriteAtomicOptions,
  ) => Promise<void>;
  'fs.stat': (path: string) => Promise<FsStat | null>;
  'fs.readdir': (path: string) => Promise<FsDirent[]>;
  'fs.mkdir': (path: string, options?: { recursive?: boolean }) => Promise<void>;
  'fs.remove': (path: string, options?: { recursive?: boolean }) => Promise<void>;
  'fs.copy': (source: string, target: string) => Promise<void>;
  'fs.rename': (source: string, target: string) => Promise<void>;
  'fs.exists': (path: string) => Promise<boolean>;
  'fs.watch': (path: string) => Promise<string>;
  'fs.unwatch': (id: string) => Promise<void>;

  // path（同步）
  'path.join': (...segments: string[]) => string;
  'path.resolve': (...segments: string[]) => string;
  'path.dirname': (path: string) => string;
  'path.basename': (path: string, suffix?: string) => string;
  'path.extname': (path: string) => string;
  'path.normalize': (path: string) => string;
  'path.isAbsolute': (path: string) => boolean;
  'path.isWithin': (parent: string, child: string) => boolean;

  // dialog
  'dialog.openFile': (options?: OpenDialogOptions) => Promise<string[] | null>;
  'dialog.openDirectory': (options?: OpenDialogOptions) => Promise<string | null>;
  'dialog.saveFile': (options?: SaveDialogOptions) => Promise<string | null>;
  'dialog.showMessage': (options: MessageDialogOptions) => Promise<number>;
  'dialog.confirm': (options: Omit<MessageDialogOptions, 'level' | 'buttons'>) => Promise<boolean>;

  // process
  'process.spawn': (
    command: string,
    args: string[],
    options?: SpawnOptions,
  ) => Promise<{ id: string; pid: number | null }>;
  'process.list': () => Promise<ProcessInfo[]>;
  'process.killAll': () => Promise<void>;
  'process.write': (id: string, data: string) => Promise<void>;
  'process.kill': (id: string, signal?: 'SIGTERM' | 'SIGKILL') => Promise<void>;

  // window
  'window.setTitle': (title: string) => Promise<void>;
  'window.minimize': () => Promise<void>;
  'window.maximize': () => Promise<void>;
  'window.unmaximize': () => Promise<void>;
  'window.isMaximized': () => Promise<boolean>;
  'window.setFullScreen': (fullscreen: boolean) => Promise<void>;
  'window.isFullScreen': () => Promise<boolean>;
  'window.setSize': (size: WindowSize) => Promise<void>;
  'window.getSize': () => Promise<WindowSize>;
  'window.center': () => Promise<void>;
  'window.focus': () => Promise<void>;
  'window.close': () => Promise<void>;

  // secureStore
  'secureStore.set': (namespace: SecureNamespace, key: string, value: string) => Promise<void>;
  'secureStore.get': (namespace: SecureNamespace, key: string) => Promise<string | null>;
  'secureStore.delete': (namespace: SecureNamespace, key: string) => Promise<void>;
  'secureStore.has': (namespace: SecureNamespace, key: string) => Promise<boolean>;
  'secureStore.listKeys': (namespace: SecureNamespace) => Promise<string[]>;

  // updater
  'updater.check': () => Promise<UpdateInfo | null>;
  'updater.downloadAndInstall': () => Promise<void>;

  // appInfo
  'appInfo.get': () => Promise<AppInfo>;
  'appInfo.getDataDir': () => Promise<string>;
  'appInfo.setWorkspaceRoot': (root: string) => Promise<void>;

  // clipboard
  'clipboard.readText': () => Promise<string>;
  'clipboard.writeText': (text: string) => Promise<void>;
  'clipboard.clear': () => Promise<void>;

  // net
  'net.fetch': (request: NetRequest) => Promise<NetResponse>;
  'net.isHostAllowed': (host: string) => boolean;
  'net.setAllowedHosts': (hosts: string[] | '*') => void;
  'net.allowedHosts': () => string[] | '*';

  // 顶层
  openExternal: (url: string) => Promise<void>;
  capabilities: () => Promise<ShellCapabilities>;
  dispose: () => Promise<void>;

  // 事件订阅（主进程 → 渲染层）
  'fs.watchEvent': (handler: (id: string, event: FsWatchEvent) => void) => () => void;
  'process.stdout': (handler: (id: string, chunk: string) => void) => () => void;
  'process.stderr': (handler: (id: string, chunk: string) => void) => () => void;
  'process.exit': (handler: (id: string, result: ProcessExit) => void) => () => void;
  'updater.progress': (handler: (progress: UpdateProgress) => void) => () => void;
}

/** 通道方法的 HTTP 方法（net 专用，预留） */
export type NetHttpMethod = HttpMethod;
