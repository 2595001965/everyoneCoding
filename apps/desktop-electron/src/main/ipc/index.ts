import type { IpcDependencies, IpcMainLike } from '../types';
import { registerFsIpc, disposeFsIpc } from './fs';
import { registerProcessIpc, disposeProcessIpc } from './process';
import { registerSecureStoreIpc } from './secure_store';
import { registerDialogIpc } from './dialog';
import { registerWindowIpc } from './window';
import { registerAppInfoIpc } from './app_info';
import { registerClipboardIpc } from './clipboard';
import { registerUpdaterIpc } from './updater';
import { registerNetIpc } from './net';
import { registerAiIpc } from './ai';
import { registerDomainIpc, registerUnavailableDomainIpc } from './domain';
import { CHANNELS, EVENT_CHANNELS } from '../channels';

/**
 * IPC 注册总入口：通道与 ShellHost 方法一一对应。
 * path 能力为纯计算，在渲染层本地实现（shell-api 的 createPathApi），不设 IPC。
 */

export interface RegisteredIpc {
  /** 通道名 -> handler，供测试审计 */
  handlers: Map<string, (event: unknown, payload: unknown) => Promise<unknown> | unknown>;
  dispose(): void;
}

export function registerAllIpc(ipc: IpcMainLike, deps: IpcDependencies): RegisteredIpc {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown> | unknown>();
  const wrapped: IpcMainLike = {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
      ipc.handle(channel, handler);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
      ipc.removeHandler(channel);
    },
  };

  registerFsIpc(wrapped);
  registerProcessIpc(wrapped);
  registerSecureStoreIpc(wrapped, deps);
  registerDialogIpc(wrapped, deps);
  registerWindowIpc(wrapped, deps);
  registerAppInfoIpc(wrapped, deps);
  registerClipboardIpc(wrapped, deps);
  registerUpdaterIpc(wrapped, deps);
  registerNetIpc(wrapped);
  const aiHost = deps.aiHost;
  if (aiHost) {
    registerAiIpc(wrapped, aiHost);
  } else {
    wrapped.handle(CHANNELS.ai.invoke, async (_e, payload) => ({
      requestId: (payload as { requestId?: string }).requestId ?? 'unsupported',
      ok: false,
      error: { code: 'NOT_SUPPORTED', message: 'Electron AI 栈尚未接入主进程' },
    }));
    wrapped.handle(CHANNELS.ai.abort, async () => undefined);
    wrapped.handle(CHANNELS.ai.start, async () => undefined);
  }

  const domainHost = deps.domainHost;
  if (domainHost) {
    registerDomainIpc(wrapped, domainHost);
  } else {
    registerUnavailableDomainIpc(wrapped);
  }

  wrapped.handle(CHANNELS.openExternal, async (_e, payload) => {
    const url = (payload as { url: string }).url;
    if (!/^https?:\/\//.test(url) && !/^mailto:/.test(url)) {
      throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', message: '只允许打开 http(s) 与 mailto 链接' }));
    }
    await deps.openExternal(url);
    return undefined;
  });

  const expectedChannels = flattenChannels().filter((channel) => !EVENT_CHANNELS.includes(channel));
  const missing = expectedChannels.filter((channel) => !handlers.has(channel));
  if (missing.length > 0) {
    throw new Error(`IPC 通道注册不完整，缺少: ${missing.join(', ')}`);
  }

  return {
    handlers,
    dispose: () => {
      disposeFsIpc();
      disposeProcessIpc();
      for (const channel of handlers.keys()) ipc.removeHandler(channel);
      handlers.clear();
    },
  };
}

/** 从 CHANNELS 常量推导全部通道名（唯一事实源） */
export function flattenChannels(): string[] {
  const out: string[] = [];
  for (const value of Object.values(CHANNELS)) {
    if (typeof value === 'string') {
      out.push(value);
    } else {
      for (const nested of Object.values(value)) out.push(nested);
    }
  }
  return out;
}
