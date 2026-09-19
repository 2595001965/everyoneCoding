/**
 * 域端口适配器（Wave 9 装配补齐 / M-07 四端口）。
 *
 * 职责：把 `ShellHost.domain` 的 RPC 通道映射为四个渲染层端口
 * （`WorkspaceApi` / `DocsApi` / `AuthApi` / `SettingsApi`），并决定**是否注入**。
 *
 * 三条硬约束：
 * 1. **不注入未装配的域**。`describe()` 报 `available: false` 时该端口保持不注入，
 *    页面继续显示既有装配引导。注入一个"能打开但每个动作都失败"的端口比现状更差。
 * 2. 跨进程错误统一还原为 `ShellError`，业务层按 `code` 决定提示，不解析字符串。
 * 3. **过程事件按 requestId 关联**。域事件是单向推送且全局订阅（见 `DomainEventSubscriber`），
 *    需要进度的调用自己持有 requestId 并在请求定局后退订，避免多调用串台与监听器泄漏；
 *    `onEvent` 是可选能力，外壳没提供时退化为"无过程反馈"而不是让调用失败。
 *
 * 本模块只在运行时装配点（`main.tsx`）使用；业务特性仍只消费
 * `globalThis.__EC_*__`，不直接接触 shell-api。
 */

import {
  ShellError,
  createDomainRequestId,
  createLocalEmitter,
  isWorkspaceImportProgressEvent,
  type DomainControlHost,
  type DomainDescriptor,
  type DomainEvent,
  type DomainKind,
  type DomainRpcError,
  type ShellErrorCode,
  type Unsubscribe,
} from '@ec/shell-api';

import type { ProjectSummary } from '@ec/core';
import type { AuthApi } from '../features/auth/auth-api';
import type { DocsApi } from '../features/docs/docs-api';
import type { SettingsApi } from '../features/settings/settings-api';
import type { WorkspaceApi } from '../features/workspace/workspace-api';

/** 把跨进程 error 还原为带 code 的 ShellError */
function toDomainError(
  error: DomainRpcError | undefined,
  domain: DomainKind,
  method: string,
): ShellError {
  const code = (error?.code ?? 'UNKNOWN') as ShellErrorCode;
  const message = error?.message ?? `域调用失败：${domain}.${method}`;
  return new ShellError(code, message, undefined, 'unknown');
}

export interface DomainCaller {
  /**
   * 调一次域方法。
   * @param requestId 显式请求 id；需要关联**过程事件**的调用（如 Git 导入进度）
   *   必须自己传：事件信封按它回流，调用方不先知道 id 就无从过滤。
   */
  call<T>(domain: DomainKind, method: string, params?: unknown, requestId?: string): Promise<T>;
}

export function createDomainCaller(host: DomainControlHost): DomainCaller {
  return {
    async call<T>(
      domain: DomainKind,
      method: string,
      params?: unknown,
      requestId?: string,
    ): Promise<T> {
      const response = await host.invoke({
        requestId: requestId ?? createDomainRequestId(domain),
        domain,
        method,
        params: params ?? {},
      });
      if (!response.ok) throw toDomainError(response.error, domain, method);
      return response.result as T;
    },
  };
}

/**
 * 域事件订阅器。
 * 外壳未提供 `onEvent` 能力时取 no-op 实现——调用照常成功，只是拿不到过程反馈。
 */
export type DomainEventSubscriber = (listener: (event: DomainEvent) => void) => Unsubscribe;

const NO_DOMAIN_EVENTS: DomainEventSubscriber = () => () => {};

/** 从宿主解析订阅器（`onEvent` 是可选能力，缺失即退化） */
function domainEventSubscriberOf(host: DomainControlHost): DomainEventSubscriber {
  const onEvent = host.onEvent?.bind(host);
  return onEvent ? (listener) => onEvent(listener) : NO_DOMAIN_EVENTS;
}

/* ------------------------------- 工作台 ------------------------------- */

export function createWorkspaceApi(
  call: DomainCaller,
  subscribe: DomainEventSubscriber = NO_DOMAIN_EVENTS,
): WorkspaceApi {
  const c = <T>(method: string, params?: unknown, requestId?: string): Promise<T> =>
    call.call<T>('workspace', method, params, requestId);
  return {
    listProjects: (query) => c('listProjects', { query }),
    getProject: (id) => c('getProject', { id }),
    createProject: (input) => c('createProject', { input }),
    updateProject: (id, patch) => c('updateProject', { id, patch }),
    markOpened: (id) => c('markOpened', { id }),
    archiveProject: (id) => c('archiveProject', { id }),
    unarchiveProject: (id) => c('unarchiveProject', { id }),
    moveToRecycleBin: (id) => c('moveToRecycleBin', { id }),
    restoreFromRecycleBin: (id) => c('restoreFromRecycleBin', { id }),
    purgeProject: (id) => c('purgeProject', { id }),
    cleanupExpiredRecycleBin: () => c('cleanupExpiredRecycleBin'),
    duplicateProject: (id, options) => c('duplicateProject', { id, options }),
    createFromTemplate: (input) => c('createFromTemplate', { input }),
    importFromGit: (input) => {
      // `onProgress` 是函数，**无法跨进程**：Electron 的结构化克隆会直接抛
      // "An object could not be cloned"。进度改走**域事件通道**：
      // 本次调用自带 requestId，主进程把三阶段进度事件按该 id 推回来。
      const { onProgress, ...cloneable } = input;
      const requestId = createDomainRequestId('workspace');
      const pending = c<ProjectSummary>('importFromGit', { input: cloneable }, requestId);
      if (onProgress === undefined) return pending;

      // 只认本次调用的 workspace 事件；载荷形状不对就丢弃（跨进程数据不信任）
      const off = subscribe((event) => {
        if (event.requestId !== requestId || event.domain !== 'workspace') return;
        if (!isWorkspaceImportProgressEvent(event.payload)) return;
        onProgress({
          stage: event.payload.stage,
          ratio: event.payload.ratio,
          message: event.payload.message,
        });
      });
      // 请求定局（成功或失败）即退订，不留悬空监听
      return pending.finally(off);
    },
    createFromDigest: (input) => c('createFromDigest', { input }),
    getProjectStage: (projectId) => c('getProjectStage', { projectId }),
    getThumbnailUrl: (projectId) => c('getThumbnailUrl', { projectId }),
    getDashboardMetrics: (projectId) => c('getDashboardMetrics', { projectId }),
    getMetricDetail: (projectId, key) => c('getMetricDetail', { projectId, key }),
  };
}

/* ------------------------------- 文档中心 ------------------------------- */

type DocFormatList = ReturnType<DocsApi['supportedFormats']>;

/**
 * `DocsApi.supportedFormats()` 是**同步**签名（面板首帧就要渲染格式清单），
 * 而 RPC 天然异步。因此装配时取一次并闭包缓存：格式清单由外壳决定，运行期不变。
 * 取不到时退化为空清单——比让首帧抛错更合适，且不阻塞其余方法。
 */
export async function createDocsApi(call: DomainCaller): Promise<DocsApi> {
  const c = <T>(method: string, params?: unknown): Promise<T> =>
    call.call<T>('docs', method, params);
  let formats: DocFormatList = [];
  try {
    formats = await c<DocFormatList>('supportedFormats');
  } catch {
    formats = [];
  }

  return {
    listDocuments: (projectId, opts) => c('listDocuments', { projectId, opts }),
    getDocument: (id) => c('getDocument', { id }),
    importDocument: (input) => c('importDocument', { input }),
    importFromFile: (input) => c('importFromFile', { input }),
    updateDocument: (input) => c('updateDocument', { input }),
    deleteDocument: (id) => c('deleteDocument', { id }),
    restoreDocument: (id) => c('restoreDocument', { id }),
    purgeDocument: (id) => c('purgeDocument', { id }),
    listVersions: (id) => c('listVersions', { id }),
    ignoreVersion: (id, version) => c('ignoreVersion', { id, version }),
    evaluateUpdateStatus: (id) => c('evaluateUpdateStatus', { id }),
    listMemoryNodes: (projectId) => c('listMemoryNodes', { projectId }),
    listDocLinks: (documentId) => c('listDocLinks', { documentId }),
    listMemoryRefs: (memoryId) => c('listMemoryRefs', { memoryId }),
    linkToMemory: (input) => c('linkToMemory', { input }),
    removeLink: (id) => c('removeLink', { id }),
    countLinksForMemories: (memoryIds) => c('countLinksForMemories', { memoryIds }),
    previewConvertToMemory: (input) => c('previewConvertToMemory', { input }),
    commitConvertToMemory: (input) => c('commitConvertToMemory', { input }),
    supportedFormats: () => formats,
  };
}

/* -------------------------------- 账号 -------------------------------- */

export function createAuthApi(call: DomainCaller): AuthApi {
  const c = <T>(method: string, params?: unknown): Promise<T> =>
    call.call<T>('auth', method, params);
  // 端口要求 isOffline 同步返回，故本地镜像；订阅或恢复流程时刷新一次
  const offline = createLocalEmitter(false);
  const refresh = async (): Promise<void> => {
    try {
      offline.set(await c<boolean>('isOffline'));
    } catch {
      // 探测失败按离线处理，但不抛出：离线态查询不应打断页面渲染
      offline.set(true);
    }
  };
  return {
    register: (input) => c('register', { input }),
    login: (input) => c('login', { input }),
    logout: () => c('logout'),
    restore: () => c('restore'),
    beginOAuth: (provider) => c('beginOAuth', { provider }),
    completeOAuth: (provider, callbackUrl, rememberMe) =>
      c('completeOAuth', { provider, callbackUrl, rememberMe }),
    pollWechatScan: (state) => c('pollWechatScan', { state }),
    listBindings: () => c('listBindings'),
    bind: (provider) => c('bind', { provider }),
    unbind: (provider, hasPassword) => c('unbind', { provider, hasPassword }),
    requestEmailVerification: (email) => c('requestEmailVerification', { email }),
    resetPassword: (input) => c('resetPassword', { input }),
    isOffline: () => offline.get(),
    onOfflineChange: (listener) => {
      const off = offline.on(listener);
      void refresh();
      return off;
    },
    tryRecover: async () => {
      const ok = await c<boolean>('tryRecover');
      await refresh();
      return ok;
    },
  };
}

/* -------------------------------- 设置 -------------------------------- */

export function createSettingsApi(call: DomainCaller): SettingsApi {
  const c = <T>(method: string, params?: unknown): Promise<T> =>
    call.call<T>('settings', method, params);
  return {
    getAll: () => c('getAll'),
    update: (patch) => c('update', { patch }),
    getDataDirs: () => c('getDataDirs'),
    migrateDataDirs: (next) => c('migrateDataDirs', { next }),
    rollbackMigration: () => c('rollbackMigration'),
    exportProject: (input) => c('exportProject', { input }),
    importPackage: (input) => c('importPackage', { input }),
    setTelemetry: (enabled) => c('setTelemetry', { enabled }),
    inspectLocalTelemetry: () => c('inspectLocalTelemetry'),
    clearLocalTelemetry: () => c('clearLocalTelemetry'),
    listCommands: () => c('listCommands'),
    saveKeymap: (keymap) => c('saveKeymap', { keymap }),
    exportKeymap: () => c('exportKeymap'),
    importKeymap: (json) => c('importKeymap', { json }),
    getBackupConfig: () => c('getBackupConfig'),
    saveBackupConfig: (config) => c('saveBackupConfig', { config }),
  };
}

/* ------------------------------ 装配与注入 ------------------------------ */

/** 渲染层全局端口槽位（键名与各特性 `readInjected*` 读取的一致） */
export interface DomainPortGlobals {
  __EC_WORKSPACE__?: unknown;
  __EC_DOCS__?: unknown;
  __EC_AUTH__?: unknown;
  __EC_SETTINGS__?: unknown;
  [key: string]: unknown;
}

export interface DomainInstallResult {
  installed: DomainKind[];
  unavailable: DomainDescriptor[];
}

/** 只取 `available: true` 的域；未装配的域不产出端口 */
export function selectAvailableDomains(descriptors: readonly DomainDescriptor[]): DomainKind[] {
  return descriptors.filter((item) => item.available).map((item) => item.kind);
}

/**
 * 按 `describe()` 结果构造端口并写入全局槽位。
 * 返回装配清单，供启动日志与降级提示定位"某页为何仍是引导态"。
 */
export async function installDomainPorts(
  host: DomainControlHost,
  globals: DomainPortGlobals = globalThis as unknown as DomainPortGlobals,
): Promise<DomainInstallResult> {
  const descriptors = await host.describe();
  const available = new Set(selectAvailableDomains(descriptors));
  const call = createDomainCaller(host);
  const subscribe = domainEventSubscriberOf(host);

  if (available.has('workspace')) globals['__EC_WORKSPACE__'] = createWorkspaceApi(call, subscribe);
  if (available.has('docs')) globals['__EC_DOCS__'] = await createDocsApi(call);
  if (available.has('auth')) globals['__EC_AUTH__'] = createAuthApi(call);
  if (available.has('settings')) globals['__EC_SETTINGS__'] = createSettingsApi(call);

  return {
    installed: selectAvailableDomains(descriptors),
    unavailable: descriptors.filter((item) => !item.available),
  };
}
