/**
 * 主进程 IPC 模块的依赖抽象。
 *
 * 模块本身不 import electron（保证可在 Vitest/node 环境下单测），
 * electron 专属对象（dialog / BrowserWindow / safeStorage / clipboard）由
 * main/index.ts 构造后以最小接口注入。
 */

import type { AiControlServiceHost, DomainControlServiceHost } from '@ec/shell-api';

export interface IpcMainLike {
  handle(
    channel: string,
    handler: (event: unknown, payload: unknown) => Promise<unknown> | unknown,
  ): void;
  removeHandler(channel: string): void;
  /**
   * 同步通道注册（`ipcRenderer.sendSync` 对端）。
   * 可选：测试用的假 ipcMain 只需覆盖 handle/removeHandler；真实 Electron 一定提供。
   */
  on?(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  /** 清理同步通道监听（`dispose` 用）；与 `on` 成对出现 */
  removeAllListeners?(channel: string): void;
}

export interface IpcSenderLike {
  send(channel: string, payload: unknown): void;
}

/** `ipcMain.on` 事件对象中本模块要用的字段（returnValue 用于同步应答） */
export interface IpcSyncEventLike {
  sender?: IpcSenderLike | undefined;
  returnValue?: unknown;
}

export interface ElectronDialogLike {
  showOpenDialog(
    options: Record<string, unknown>,
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(
    options: Record<string, unknown>,
  ): Promise<{ canceled: boolean; filePath?: string }>;
  showMessageBox(options: Record<string, unknown>): Promise<{ response: number }>;
}

export interface BrowserWindowLike {
  setTitle(title: string): void;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  setFullScreen(flag: boolean): void;
  isFullScreen(): boolean;
  setSize(width: number, height: number): void;
  getSize(): number[];
  center(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
}

export interface ElectronClipboardLike {
  readText(): string;
  writeText(text: string): void;
  clear(): void;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface UpdaterLike {
  check(): Promise<{ version: string; notes?: string; releaseDate?: string } | null>;
  downloadAndInstall(): Promise<void>;
  onProgress(
    listener: (progress: { phase: string; percent?: number; message?: string }) => void,
  ): () => void;
}

export interface ElectronAppLike {
  getName(): string;
  getVersion(): string;
  getLocale(): string;
  isPackaged: boolean;
  getPath(name: 'userData' | 'home' | 'temp'): string;
}

/** 全部 IPC 模块共享的依赖集合 */
export interface IpcDependencies {
  dialog: ElectronDialogLike;
  getWindow: () => BrowserWindowLike | null;
  clipboard: ElectronClipboardLike;
  safeStorage: SafeStorageLike | null;
  updater: UpdaterLike | null;
  app: ElectronAppLike;
  /** 数据目录（默认 userData 下 data/） */
  dataDir: string;
  /** 密钥文件目录（默认 userData 下 secure/） */
  secureDir: string;
  /** 主进程 AI 控制宿主 */
  aiHost?: AiControlServiceHost;
  /** 主进程领域端口宿主（工作台 / 文档 / 账号 / 设置四域） */
  domainHost?: DomainControlServiceHost;
  /** 系统浏览器打开外链 */
  openExternal: (url: string) => Promise<void>;
}
