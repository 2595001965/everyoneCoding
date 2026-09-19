/**
 * 外壳抽象层统一入口。
 *
 * 渲染层与业务包只从这里取 ShellHost，禁止直接 import @tauri-apps/* 或 electron。
 */

import { ShellError } from './errors';
import { MockShell, type MockShellOptions } from './mock';
import type { ShellCapabilities, ShellHost, ShellKind } from './types';

export { AI_RPC_METHODS, aiErrorFromUnknown, createRequestId, isAiRpcMethod } from './ai-control';
export type { AiControlHost } from './ai-control';
export {
  DOMAIN_KINDS,
  DOMAIN_RPC_METHODS,
  WORKSPACE_IMPORT_PROGRESS_EVENT,
  WORKSPACE_IMPORT_STAGES,
  createDomainEventSink,
  createDomainRequestId,
  createLocalEmitter,
  domainErrorFromUnknown,
  domainUnavailableError,
  isDomainKind,
  isDomainRpcMethod,
  isWorkspaceImportProgressEvent,
  sanitizeDomainMessage,
} from './domain-control';
export type {
  DomainControlHost,
  DomainControlServiceHost,
  DomainDescriptor,
  DomainEvent,
  DomainEventSink,
  DomainKind,
  DomainRpcError,
  DomainRpcRequest,
  DomainRpcResponse,
  WorkspaceImportProgress,
  WorkspaceImportProgressEvent,
  WorkspaceImportStage,
} from './domain-control';
export type {
  AiRpcMethod,
  AiRpcRequest,
  AiRpcError,
  AiRpcResponse,
  AiStreamRequest,
  AiStreamEvent,
  AiStreamHandle,
  AiControlServiceHost,
} from './ai-control';
export * from './types';
export * from './errors';
export {
  MockShell,
  MockFileSystem,
  MockProcessApi,
  createPathApi,
  createMockAiControlHost,
  createMockDomainControlHost,
} from './mock';
export type {
  MockShellOptions,
  MockProcessHandle,
  MockProcessController,
  AtomicWriteFailurePoint,
} from './mock';
export { runShellContract } from './contract';
export type { ContractHarness, ContractExpect, ShellContractOptions } from './contract';

/** 外壳 API 版本：实现与渲染层做版本协商，能力缺失时降级而非报错 */
export const SHELL_API_VERSION = 1;

export type ShellFactory = () => Promise<ShellHost> | ShellHost;

const registry = new Map<ShellKind, ShellFactory>();

/**
 * 注册具体外壳实现。
 * - apps/desktop-tauri 启动时注册 'tauri'
 * - apps/desktop-electron 启动时注册 'electron'
 */
export function registerShellFactory(kind: ShellKind, factory: ShellFactory): void {
  registry.set(kind, factory);
}

export function hasShellFactory(kind: ShellKind): boolean {
  return registry.has(kind);
}

/** 环境探测：优先 Tauri，其次 Electron，都没有则回退 mock（供无外壳开发） */
export function detectShellKind(): ShellKind {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope['__TAURI_INTERNALS__'] !== undefined || scope['isTauri'] === true) return 'tauri';
  const proc = scope['process'] as { versions?: Record<string, string> } | undefined;
  if (proc?.versions?.['electron'] !== undefined) return 'electron';
  const nav = scope['navigator'] as { userAgent?: string } | undefined;
  if (nav?.userAgent?.includes('Electron')) return 'electron';
  return 'mock';
}

export interface CreateShellOptions {
  /** 仅对 mock 形态生效 */
  mock?: MockShellOptions;
  /** 未注册实现时是否回退 mock（默认 false，生产必须显式失败） */
  fallbackToMock?: boolean;
}

/**
 * 创建外壳宿主。
 * 未注册实现且不允许回退时抛 NOT_SUPPORTED，避免生产环境静默退化成假外壳。
 */
export async function createShell(
  kind?: ShellKind,
  options: CreateShellOptions = {},
): Promise<ShellHost> {
  const resolved = kind ?? detectShellKind();
  if (resolved === 'mock') return new MockShell(options.mock ?? {});

  const factory = registry.get(resolved);
  if (!factory) {
    if (options.fallbackToMock) return new MockShell(options.mock ?? {});
    throw new ShellError(
      'NOT_SUPPORTED',
      `外壳 ${resolved} 未注册实现（请先调用 registerShellFactory）`,
      undefined,
      resolved,
    );
  }
  return factory();
}

export interface ShellHandshake {
  apiVersion: number;
  kind: ShellKind;
  capabilities: ShellCapabilities;
  /** 缺失的能力列表，UI 据此降级 */
  degraded: string[];
}

/**
 * 版本与能力协商：永不因能力缺失抛错，只返回降级清单。
 */
export async function negotiate(shell: ShellHost): Promise<ShellHandshake> {
  let capabilities: ShellCapabilities;
  try {
    capabilities = await shell.capabilities();
  } catch {
    capabilities = {
      fs: false,
      watch: false,
      process: false,
      dialog: false,
      window: false,
      secureStore: false,
      updater: false,
      net: false,
      clipboard: false,
      openExternal: false,
      ai: false,
      domain: false,
    };
  }
  const degraded = Object.entries(capabilities)
    .filter(([, available]) => !available)
    .map(([name]) => name);
  return { apiVersion: SHELL_API_VERSION, kind: shell.kind, capabilities, degraded };
}
