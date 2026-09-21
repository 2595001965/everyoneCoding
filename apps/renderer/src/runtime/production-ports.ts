/**
 * 生产端口适配器（T12-01 收尾）：把 `ShellHost.domain` 的 RPC 通道映射为
 * memory / pipeline / git / preview / rename / package / usage / ai-context / code / nav /
 * designer 十一个渲染层端口，并决定**是否注入**。
 *
 * 三条硬约束（与 `runtime/domain-ports.ts` 同一套纪律）：
 * 1. **不注入未装配的域**。`describe()` 报 `available: false` 时该端口保持不注入，
 *    页面继续显示既有装配引导；
 * 2. **同步签名端口走同步通道**。`MemoryApi` / `PipelineApi` 的消费方会在写入后立刻
 *    同步读回（如 `advance()` 后紧跟 `snapshot()`），快照缓存表达不了这种语义，
 *    因此外壳没有 `invokeSync` 时这两个端口**不注入**（Tauri / mock 如实降级），
 *    而不是返回一份脏的缓存；
 * 3. **过程事件按 requestId 关联**，跨进程错误统一还原为带 `code` 的 `ShellError`。
 *
 * 本模块只在运行时装配点（`main.tsx`）使用；业务特性仍只消费
 * `globalThis.__EC_*__`，不直接接触 shell-api。
 */

import {
  ShellError,
  createDomainRequestId,
  type DomainControlHost,
  type DomainEvent,
  type DomainKind,
} from '@ec/shell-api';
import {
  SplitModel,
  type ImpactReport,
  type QueueState,
  type SplitResult,
  type TechChoice,
} from '@ec/pipeline';
import type { BudgetConfig, BudgetDecision, UsageReportRow } from '@ec/ai';
import type { AssembledContext, ContextAssemblyRequest, ContextSources, WritePlan } from '@ec/ai';
import type { AutoCommitPolicy, CredentialBinding, GitResult } from '@ec/git';
import type { PipelineStage, PipelineStageSnapshot } from '@ec/pipeline';
import type { PreviewResult, StreamedLogLine } from '@ec/preview';

import type { ContextPanelApi } from '../features/ai/context-api';
import type { CodeViewApi } from '../features/code/code-api';
import type { GitApi, GitProgressEvent, GitRepoInfo } from '../features/git/git-api';
import type { MemoryApi } from '../features/memory/memory-api';
import type { NavApi } from '../features/nav/nav-api';
import type {
  PackageApi,
  ExportJobRequest,
  ExportProgressSnapshot,
  ImportJobRequest,
} from '../features/package/package-api';
import type { PipelineApi } from '../features/pipeline/pipeline-api';
import type {
  ApiRequestLog,
  DeviceChannel,
  PreviewApi,
  PreviewState,
} from '../features/preview/preview-api';
import type { RenameApi } from '../features/rename/rename-api';
import type { UsageApi } from '../features/usage/usage-api';
import type { DesignerPortApi } from '../features/designer/designer-api';

import { getActiveProject, requireActiveProject } from './project-context';
import { toDomainError, type DomainCaller, type DomainEventSubscriber } from './domain-ports';

/* ------------------------------ 同步调用器 ------------------------------ */

/**
 * 同步域调用器：渲染层同步签名端口的唯一出口。
 *
 * 外壳没有 `invokeSync`（Tauri / mock）时返回 null——调用方据此**不注入**
 * 同步签名端口，页面保留如实的装配引导，而不是拿到一份读到脏数据的缓存。
 */
export interface DomainSyncCaller {
  callSync<T>(domain: DomainKind, method: string, params?: unknown): T;
}

export function createDomainSyncCaller(host: DomainControlHost): DomainSyncCaller | null {
  const invokeSync = host.invokeSync?.bind(host);
  if (typeof invokeSync !== 'function') return null;
  return {
    callSync<T>(domain: DomainKind, method: string, params?: unknown): T {
      const response = invokeSync({
        requestId: createDomainRequestId(domain),
        domain,
        method,
        params: params ?? {},
      });
      if (!response.ok) throw toDomainError(response.error, domain, method);
      return response.result as T;
    },
  };
}

/* ------------------------------ 通用工具 ------------------------------ */

/**
 * 当前项目的 projectId 注入参数（域方法一律要求 projectId）。
 *
 * `params` 在端口实现里常常是「原样透传的入参对象」，静态类型是 `unknown`；
 * 非对象入参（数组 / 原始值）不能展开进信封，退化为只带 projectId，
 * 由域侧自己报 INVALID_ARGUMENT，而不是在这里静默丢掉调用。
 */
function withProject(params?: unknown): Record<string, unknown> {
  const extra =
    params !== null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  return { projectId: requireActiveProject().id, ...extra };
}

/**
 * 把一个「带过程事件的跨进程调用」包成请求/响应 + 事件订阅。
 *
 * - `onProgress` 无法结构化克隆，必须剥掉；
 * - 事件按 requestId 关联到本次调用，请求定局后退订（避免串台与监听器泄漏）。
 */
function withProgress<T>(
  domain: DomainKind,
  eventType: string,
  subscribe: DomainEventSubscriber,
  onProgress: ((payload: unknown) => void) | undefined,
  run: (requestId: string) => Promise<T>,
): Promise<T> {
  const requestId = createDomainRequestId(domain);
  if (typeof onProgress !== 'function') return run(requestId);
  const unsubscribe = subscribe((event: DomainEvent) => {
    if (event.requestId !== requestId || event.domain !== domain) return;
    const payload = event.payload as { type?: unknown } | null | undefined;
    if (payload === null || payload === undefined || payload.type !== eventType) return;
    onProgress(payload);
  });
  return run(requestId).finally(unsubscribe);
}

/** 域方法如实降级（NOT_SUPPORTED）时转成端口的失败结果，而不是把异常甩给 UI */
function gitFail(error: unknown): GitResult<never> {
  const message = error instanceof ShellError ? error.message : String(error);
  const code = error instanceof ShellError ? error.code : 'UNKNOWN';
  return { ok: false, data: null, logs: [], error: { code: code as never, message } };
}

/** 远程传输进度事件转发（onProgress 不能跨进程，事件经 requestId 关联回流） */
function forwardGitProgress(
  onProgress: ((event: GitProgressEvent) => void) | undefined,
): ((payload: unknown) => void) | undefined {
  if (typeof onProgress !== 'function') return undefined;
  return (payload: unknown) => onProgress(payload as GitProgressEvent);
}

/* ------------------------------- 记忆中心 ------------------------------- */

export function createMemoryApi(
  call: DomainCaller,
  sync: DomainSyncCaller | null,
): MemoryApi | null {
  if (sync === null) return null;
  const m = <T>(method: string, params?: unknown): T => sync.callSync<T>('memory', method, params);
  return {
    listProjects: () => m('listProjects'),
    stats: (input) => m('stats', input),
    list: (input) => m('list', input),
    detail: (id) => m('detail', { id }),
    conflictIndex: (input) => m('conflictIndex', input),
    context: (input) => m('context', input),
    create: (draft) => m('create', draft),
    update: (id, patch, expectedVersion) =>
      m('update', {
        id,
        patch,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      }),
    setPinned: (id, pinned) => m('setPinned', { id, pinned }),
    setIssueStatus: (id, next, options) =>
      m('setIssueStatus', { id, next, explicit: options?.explicit === true }),
    moveLayer: (ids, target) => m('moveLayer', { ids: [...ids], target }),
    remove: (ids) => m('remove', { ids: [...ids] }),
    restore: (ids) => m('restore', { ids: [...ids] }),
    changeLog: (input) => m('changeLog', input),
    exportMemories: (request) => call.call('memory', 'exportMemories', request),
    importPreview: (input) => call.call('memory', 'importPreview', input),
    importCommit: (request) => call.call('memory', 'importCommit', request),
  };
}

/* ------------------------------- 开发流水线 ------------------------------- */

export function createPipelineApi(
  call: DomainCaller,
  sync: DomainSyncCaller | null,
  subscribe: DomainEventSubscriber,
): PipelineApi | null {
  if (sync === null) return null;
  const p = <T>(method: string, params?: unknown): T =>
    sync.callSync<T>('pipeline', method, params);
  const pa = <T>(method: string, params?: unknown): Promise<T> =>
    call.call<T>('pipeline', method, params);
  return {
    ready: true,
    snapshot: (projectId) => p('snapshot', { projectId }),
    advance: (projectId, from, to) => p('advance', { projectId, from, to }),
    startStage: (projectId, stage) => p('startStage', { projectId, stage }),
    submitForReview: (projectId, stage) => p('submitForReview', { projectId, stage }),
    confirm: (projectId, stage) => p('confirm', { projectId, stage }),
    back: (projectId, from, to) => p('back', { projectId, from, to }),
    skip: (projectId, stage) => p('skip', { projectId, stage }),
    applyDownstreamStale: (projectId, stage) => p('applyDownstreamStale', { projectId, stage }),
    saveArtifact: (input) => pa('saveArtifact', input),
    listArtifacts: (projectId, stage) => p('listArtifacts', { projectId, stage }),
    readArtifact: (projectId, stage, version) => pa('readArtifact', { projectId, stage, version }),
    readDiff: (projectId, stage, version) => pa('readDiff', { projectId, stage, version }),
    switchVersion: (projectId, stage, version) => p('switchVersion', { projectId, stage, version }),
    notifyDownstream: (projectId, stage, message) =>
      p('notifyDownstream', { projectId, stage, message }),
    generateRequirement: (input) => pa('generateRequirement', input),
    getTechChoice: (projectId) => p<TechChoice | null>('getTechChoice', { projectId }),
    saveTechChoice: (projectId, choice) => pa('saveTechChoice', { projectId, choice }),
    generateTechDoc: (input) => pa('generateTechDoc', input),
    getSplit: (projectId) => p<SplitResult | null>('getSplit', { projectId }),
    saveSplit: (projectId, split) => pa('saveSplit', { projectId, split }),
    evaluateImpact: (projectId, change) => {
      // 与流水线域同源：先读真实拆分结果，再交给 SplitModel（@ec/pipeline 的浏览器入口是纯逻辑）。
      // 读不到拆分就抛结构化错误，而不是返回一个空报告伪装成「没有影响面」。
      if (p<TechChoice | null>('getTechChoice', { projectId }) === null) {
        throw new ShellError(
          'INVALID_ARGUMENT',
          '尚未完成技术选型：请先在 S3 阶段完成问卷，再评估影响面',
        );
      }
      const split = p<SplitResult | null>('getSplit', { projectId });
      if (split === null) {
        throw new ShellError('NOT_FOUND', '尚未保存拆分结果（S4），无法评估影响面');
      }
      return SplitModel.fromResult(split).evaluateImpact(change) as ImpactReport;
    },
    runGeneration: (input) => pa('runGeneration', input),
    generateSplit: (projectId, input) =>
      pa('generateSplit', { projectId, ...(input ?? {}) }) as Promise<SplitResult>,
    retryNode: (projectId, nodeId) => pa('retryNode', { projectId, nodeId }) as Promise<QueueState>,
    skipNode: (projectId, nodeId) => p('skipNode', { projectId, nodeId }) as QueueState,
    pauseQueue: (projectId) => p('pauseQueue', { projectId }) as QueueState,
    getResumeProgress: (projectId) =>
      p('getResumeProgress', { projectId }) as {
        snapshot: PipelineStageSnapshot;
        s5Progress: string | null;
        resumeStage: PipelineStage | null;
      },
    recoverProject: (projectId) =>
      pa('recoverProject', { projectId }) as Promise<{
        snapshot: PipelineStageSnapshot;
        resumeStage: PipelineStage | null;
        integrityProblems: Array<{
          stage: string;
          version: number;
          contentRef: string;
          reason: string;
        }>;
        unexpectedExit: boolean;
        artifactVersions: number;
      }>,
    subscribe: (event, listener) => {
      if (event !== 'pipeline:*') return () => {};
      return subscribe((domainEvent: DomainEvent) => {
        if (domainEvent.domain !== 'pipeline') return;
        const payload = domainEvent.payload as
          { type?: unknown; projectId?: unknown } | null | undefined;
        if (
          payload === null ||
          payload === undefined ||
          (payload.type !== 'pipeline:stage-event' && payload.type !== 'pipeline:progress')
        ) {
          return;
        }
        // 事件按项目过滤：切换项目后旧订阅不能把新项目的事件投递到旧页面
        const active = getActiveProject();
        if (
          typeof payload.projectId === 'string' &&
          active !== null &&
          payload.projectId !== active.id
        ) {
          return;
        }
        listener(payload);
      });
    },
  };
}

/* ------------------------------- Git ------------------------------- */

export function createGitApi(call: DomainCaller, subscribe: DomainEventSubscriber): GitApi {
  const g = <T>(method: string, params?: unknown): Promise<GitResult<T>> =>
    call.call<GitResult<T>>('git', method, withProject(params));
  const gOrFail = async <T>(method: string, params?: unknown): Promise<GitResult<T>> => {
    try {
      return await g<T>(method, params);
    } catch (error) {
      return gitFail(error) as GitResult<T>;
    }
  };
  return {
    ready: true,
    /**
     * 项目代码根还不是仓库时如实返回 null（UI 展示「初始化仓库」入口），
     * 而不是伪造一个 `main / clean` 的假仓库。
     * 未打开项目（`requireActiveProject` 抛错）同样返回 null——此时 UI 应展示
     * 「先去工作台打开项目」引导，而不是一个"仓库不存在"的错误。
     */
    info: async () => {
      try {
        return await call.call<GitRepoInfo | null>('git', 'info', withProject());
      } catch {
        return null;
      }
    },
    init: (options) => gOrFail('init', options),
    status: () => gOrFail('status'),
    stage: (paths) => gOrFail('stage', { paths: [...paths] }),
    unstage: (paths) => gOrFail('unstage', { paths: [...paths] }),
    commit: (input) => gOrFail('commit', { input }),
    generateCommitMessage: (input) => gOrFail('generateCommitMessage', input),
    diff: (options) => gOrFail('diff', options),
    branches: () => gOrFail('branches'),
    tags: () => gOrFail('tags'),
    createBranch: (name, startPoint) =>
      gOrFail('createBranch', { name, ...(startPoint !== undefined ? { startPoint } : {}) }),
    switchBranch: (name, create) => gOrFail('switchBranch', { name, create: create === true }),
    renameBranch: (from, to) => gOrFail('renameBranch', { from, to }),
    deleteBranch: (name, force) => gOrFail('deleteBranch', { name, force: force === true }),
    log: (options) => gOrFail('log', options),
    commitDetail: (sha) => gOrFail('commitDetail', { sha }),
    previewMerge: (source, target) => gOrFail('previewMerge', { source, target }),
    merge: (source, options) => gOrFail('merge', { source, options }),
    rebase: (onto, options) => gOrFail('rebase', { onto, options }),
    abort: (kind) => gOrFail('abort', { kind }),
    conflicts: () => gOrFail('conflicts'),
    applyResolution: (input) => gOrFail('applyResolution', { input }),
    requestAiMerge: (input) => gOrFail('requestAiMerge', { input }),
    stashList: () => gOrFail('stashList'),
    stashPush: (message) => gOrFail('stashPush', { message }),
    stashApply: (index, drop) => gOrFail('stashApply', { index, drop: drop === true }),
    stashDrop: (index) => gOrFail('stashDrop', { index }),
    rollbackPlan: (input) => gOrFail('rollbackPlan', { input }),
    rollbackExecute: (plan) => gOrFail('rollbackExecute', { plan }),
    snapshots: () => gOrFail('snapshots'),
    remotes: () => gOrFail('remotes'),
    addRemote: (name, url) => gOrFail('addRemote', { name, url }),
    editRemote: (name, url) => gOrFail('editRemote', { name, url }),
    removeRemote: (name) => gOrFail('removeRemote', { name }),
    testRemote: (name) => gOrFail('testRemote', { name }),
    push: (input, onProgress) =>
      withProgress('git', 'git:progress', subscribe, forwardGitProgress(onProgress), (requestId) =>
        call.call('git', 'push', withProject({ input }), requestId),
      ) as Promise<GitResult<{ summary: string; upToDate: boolean; forced: boolean }>>,
    pull: (input, onProgress) =>
      withProgress('git', 'git:progress', subscribe, forwardGitProgress(onProgress), (requestId) =>
        call.call('git', 'pull', withProject({ input }), requestId),
      ) as Promise<GitResult<{ conflictFiles: string[]; upToDate: boolean; fastForward: boolean }>>,
    fetch: (input, onProgress) =>
      withProgress('git', 'git:progress', subscribe, forwardGitProgress(onProgress), (requestId) =>
        call.call('git', 'fetch', withProject({ input }), requestId),
      ) as Promise<GitResult<{ summary: string; upToDate: boolean }>>,
    credentialBindings: () =>
      gOrFail<CredentialBinding[]>('credentialBindings').then((r) => r.data ?? []),
    saveHttpsCredential: (input) =>
      call.call('git', 'saveHttpsCredential', withProject({ input })).then(() => undefined),
    saveSshCredential: (input) =>
      call.call('git', 'saveSshCredential', withProject({ input })).then(() => undefined),
    removeCredential: (remoteName) =>
      call.call('git', 'removeCredential', withProject({ remoteName })).then(() => undefined),
    autoCommitPolicy: () => call.call<AutoCommitPolicy>('git', 'autoCommitPolicy', withProject()),
    setAutoCommitPolicy: (policy) =>
      call.call('git', 'setAutoCommitPolicy', withProject({ policy })).then(() => undefined),
    changeSources: () => call.call('git', 'changeSources', withProject()),
  };
}

/* ------------------------------- 预览 ------------------------------- */

/**
 * 预览域的「结构化失败」收口：域路由如实降级（NOT_SUPPORTED）时，
 * 转成 `PreviewResult` 的失败分支，而不是把异常甩给 UI。
 */
function previewFail<T>(error: unknown): PreviewResult<T> {
  const message = error instanceof ShellError ? error.message : String(error);
  return {
    ok: false,
    data: null,
    logs: [],
    error: { code: error instanceof ShellError ? error.code : 'UNKNOWN', message },
  } as PreviewResult<T>;
}

export function createPreviewApi(call: DomainCaller, subscribe: DomainEventSubscriber): PreviewApi {
  const p = <T>(method: string, params?: unknown): Promise<T> =>
    call.call<T>('preview', method, withProject(params));
  const ok = async <T>(run: () => Promise<T>): Promise<PreviewResult<T>> => {
    try {
      return { ok: true, data: await run(), logs: [], error: null } as PreviewResult<T>;
    } catch (error) {
      return previewFail<T>(error);
    }
  };
  return {
    ready: true,
    state: () => p<PreviewState>('state'),
    setMode: (mode) => void p('setMode', { mode }),
    start: (mode) =>
      ok(async () => {
        const data = await p<{ port: number; url: string; shifted: boolean }>('start', { mode });
        const state = await p<PreviewState>('state');
        return { ...data, mode, notice: state.notice };
      }) as ReturnType<PreviewApi['start']>,
    stop: () => ok(() => p('stop').then(() => null)),
    pages: () => p('pages'),
    refresh: (reason) => ok(() => p('refresh', { reason })) as ReturnType<PreviewApi['refresh']>,
    requests: () => p<readonly ApiRequestLog[]>('requests'),
    replayRequest: (input) =>
      ok(() => p('replayRequest', input)) as ReturnType<PreviewApi['replayRequest']>,
    toCurl: (input) => p('toCurl', input),
    clearRequests: () => p('clearRequests').then(() => undefined),
    projectProfile: () => ok(() => p('projectProfile')) as ReturnType<PreviewApi['projectProfile']>,
    installDependencies: () =>
      ok(() => p('installDependencies')) as ReturnType<PreviewApi['installDependencies']>,
    startBackend: () => ok(() => p('startBackend')) as ReturnType<PreviewApi['startBackend']>,
    stopBackend: () => ok(() => p('stopBackend').then(() => null)),
    restartBackend: () => ok(() => p('restartBackend')) as ReturnType<PreviewApi['restartBackend']>,
    backendStatus: () => p('backendStatus'),
    logs: (filter) => p('logs', filter),
    /**
     * 日志流订阅（**常驻事件**，不绑定某次请求）。
     *
     * 后端的 stdout/stderr 在 `startBackend` 返回之后仍持续产生，主进程用固定哨兵
     * requestId 广播这类事件；这里按 `domain + payload.type + projectId` 三重过滤：
     * 不按 projectId 过滤的话，切换项目后旧项目后端的日志会串到当前面板里。
     */
    subscribeLogs: (listener) =>
      subscribe((event: DomainEvent) => {
        if (event.domain !== 'preview') return;
        const payload = event.payload as
          | {
              type?: unknown;
              line?: unknown;
              at?: unknown;
              level?: unknown;
              id?: unknown;
              source?: unknown;
              stream?: unknown;
              projectId?: unknown;
            }
          | null
          | undefined;
        if (payload?.type !== 'preview:log' || typeof payload.line !== 'string') return;
        const active = getActiveProject();
        if (
          typeof payload.projectId === 'string' &&
          active !== null &&
          payload.projectId !== active.id
        ) {
          return;
        }
        listener({
          id: typeof payload.id === 'string' ? payload.id : `log-${String(payload.at ?? 0)}`,
          source: (payload.source ?? 'task') as StreamedLogLine['source'],
          level: (payload.level ?? 'info') as StreamedLogLine['level'],
          text: payload.line,
          at: typeof payload.at === 'number' ? payload.at : Date.now(),
          stream: (payload.stream ?? 'stdout') as StreamedLogLine['stream'],
        });
      }),
    devices: () => p<readonly DeviceChannel[]>('devices'),
    deviceQr: (channelId) =>
      ok(() => p('deviceQr', { channelId })) as ReturnType<PreviewApi['deviceQr']>,
    lanSharingEnabled: () => p('lanSharingEnabled'),
    setLanSharing: (enabled) => p('setLanSharing', { enabled }).then(() => undefined),
    mockSettings: () => p('mockSettings'),
    setMockSettings: (patch) => p('setMockSettings', { patch }).then(() => undefined),
  };
}

/* ------------------------------- 导航 ------------------------------- */

export function createNavApi(call: DomainCaller): NavApi {
  const n = <T>(method: string, params?: unknown): Promise<T> =>
    call.call<T>('nav', method, withProject(params));
  return {
    ready: true,
    hoverTargets: (request) => n('hoverTargets', { request }),
    resolveJump: (request) => n('resolveJump', { request }),
    commitJump: (target) => n('commitJump', { target }),
    jumpStats: () => n('jumpStats'),
    relationGraph: () => n('relationGraph'),
    reverseJump: (input) => n('reverseJump', { input }),
    dataFlow: (elementId) => n('dataFlow', { elementId }),
  };
}

/* ------------------------------- 统一重命名 ------------------------------- */

export function createRenameApi(call: DomainCaller, subscribe: DomainEventSubscriber): RenameApi {
  const r = <T>(method: string, params?: unknown): Promise<T> =>
    call.call<T>('rename', method, withProject(params));
  return {
    ready: true,
    projectContext: () => r('projectContext'),
    resolveRule: () => r('resolveRule'),
    symbolTable: () => r('symbolTable'),
    listTargets: () => r('listTargets'),
    check: (input) => r('check', input),
    analyze: (input) => r('analyze', input),
    buildDiff: (input) => r('buildDiff', input),
    execute: (input) => r('execute', input),
    undo: (input) => r('undo', input),
    history: () => r('history'),
    planMigration: (input) => r('planMigration', input),
    runMigration: (input) => r('runMigration', input),
    subscribeMigrationLog: (listener) =>
      subscribe((event: DomainEvent) => {
        if (event.domain !== 'rename') return;
        const payload = event.payload as { type?: unknown; line?: unknown } | null | undefined;
        if (payload?.type !== 'rename:migration-log') return;
        listener(payload as never);
      }),
    pendingCleanup: () => r('pendingCleanup'),
    cleanAliases: (input) => r('cleanAliases', input),
    planBatch: (input) => r('planBatch', input),
    runBatch: (input) => r('runBatch', input),
  };
}

/* ------------------------------- 代码视图 ------------------------------- */

export function createCodeApi(call: DomainCaller, subscribe: DomainEventSubscriber): CodeViewApi {
  return {
    files: {
      listFiles: () => call.call('code', 'listFiles', withProject()),
      readFile: (path) => call.call('code', 'readFile', withProject({ path })),
    },
    write: {
      plan: (input) => call.call('code', 'plan', withProject(input)),
      apply: (plan) => call.call('code', 'apply', withProject({ plan })),
      requestRework: (request) =>
        call.call('code', 'requestRework', withProject({ request })).then(() => undefined),
    },
    subscribeExternalChanges: (listener) =>
      subscribe((event: DomainEvent) => {
        if (event.domain !== 'code') return;
        const payload = event.payload as
          { type?: unknown; path?: unknown; message?: unknown } | null | undefined;
        if (payload?.type !== 'code:external-change') return;
        listener({
          path: String(payload.path ?? ''),
          message: String(payload.message ?? ''),
          // 提示语与动作取自 @ec/ai 的 ExternalChangeWatcher 口径（与主进程同一份文案）
          actions: [
            { key: 'rollback', label: '回滚到最近提交' },
            { key: 'regenerate', label: '让 AI 重新生成' },
          ],
        });
      }),
    /**
     * AI 重改的写入计划回流。
     *
     * 主进程产生计划后经 `code:write-plan` 事件下发（未登记在域的通用载荷守卫里的
     * 事件会被渲染层丢弃，所以这条通道是显式契约，而不是"顺手加个事件"）。
     */
    subscribeWritePlan: (listener) =>
      subscribe((event: DomainEvent) => {
        if (event.domain !== 'code') return;
        const payload = event.payload as
          { type?: unknown; plan?: unknown; source?: unknown } | null | undefined;
        if (
          payload?.type !== 'code:write-plan' ||
          payload.plan === null ||
          payload.plan === undefined
        ) {
          return;
        }
        listener({
          plan: payload.plan as WritePlan,
          source: typeof payload.source === 'string' ? payload.source : 'rework',
        });
      }),
  };
}

/* ------------------------------- AI 上下文 ------------------------------- */

export function createAiContextApi(call: DomainCaller): ContextPanelApi {
  return {
    ready: true,
    /**
     * 已装配的数据源（T12-02）：记忆 / 备注 / 设计器 DSL / 文档 / 代码。
     *
     * 与主进程 `AI_CONTEXT_SOURCES` 逐项对齐 —— 面板据此说明"哪些块会有内容"，
     * 谎报一项就会让用户以为某个空块是"没有数据"而不是"没接线"。
     * 缺 `elements` 时元素祖先链块永远跳过，这正是本轮修掉的缺口。
     */
    availableSources: [
      'memory',
      'notes',
      'elements',
      'documents',
      'code',
    ] as (keyof ContextSources)[],
    assemble: (request: ContextAssemblyRequest) =>
      call.call<AssembledContext>('ai-context', 'assemble', { request }),
  };
}

/* ------------------------------- 用量 ------------------------------- */

export function createUsageApi(call: DomainCaller): UsageApi {
  return {
    // usage_record 行结构与 @ec/ai 的 UsageReportRow 完全同形（域层原样透传），不做二次加工
    listRows: () => call.call<UsageReportRow[]>('usage', 'listRows'),
    getBudget: () => call.call<BudgetConfig>('usage', 'getBudget'),
    setBudget: (config: BudgetConfig) => call.call('usage', 'setBudget', { config }),
    budgetDecision: () => call.call<BudgetDecision>('usage', 'budgetDecision'),
  };
}

/* ------------------------------- 归档与迁移 ------------------------------- */

export function createPackageApi(call: DomainCaller, subscribe: DomainEventSubscriber): PackageApi {
  return {
    pickExportPath: (defaultName) => call.call('package', 'pickExportPath', { defaultName }),
    exportPackage: (request: ExportJobRequest) => {
      // onProgress 不能跨进程（结构化克隆抛错），剥掉后经 package:progress 事件回流。
      // 域当前只回传 stage / processed / total（计数与失败清单随最终结果返回），
      // 这里只填真实字段，其余保持空结构，不编造进度。
      const { onProgress, ...rest } = request;
      return withProgress(
        'package',
        'package:progress',
        subscribe,
        onProgress === undefined
          ? undefined
          : (payload) => {
              const wire = payload as {
                stage?: unknown;
                processed?: unknown;
                total?: unknown;
                currentFile?: unknown;
              };
              onProgress({
                stage: String(wire.stage ?? 'enumerating') as ExportProgressSnapshot['stage'],
                processed: Number(wire.processed ?? 0),
                total: Number(wire.total ?? 0),
                currentFile: typeof wire.currentFile === 'string' ? wire.currentFile : null,
                counts: {
                  projects: 0,
                  memoryItems: 0,
                  documents: 0,
                  pages: 0,
                  codeFiles: 0,
                  attachments: 0,
                },
                failures: [],
                excludeStats: null,
                redactionFindings: [],
                elapsedMs: 0,
              });
            },
        (requestId) => call.call('package', 'exportPackage', { request: rest }, requestId),
      );
    },
    listExportPresets: () => call.call('package', 'listExportPresets'),
    saveExportPreset: (preset) => call.call('package', 'saveExportPreset', { preset }),
    deleteExportPreset: (name) => call.call('package', 'deleteExportPreset', { name }),
    pickPackagePath: () => call.call('package', 'pickPackagePath'),
    verifyPackage: (packagePath, password, publicKeyPem) =>
      call.call('package', 'verifyPackage', {
        packagePath,
        ...(password !== undefined ? { password } : {}),
        ...(publicKeyPem !== undefined ? { publicKeyPem } : {}),
      }),
    previewImport: (packagePath, password) =>
      call.call('package', 'previewImport', {
        packagePath,
        ...(password !== undefined ? { password } : {}),
      }),
    previewMode: (packagePath, mode, password) =>
      call.call('package', 'previewMode', {
        packagePath,
        mode,
        ...(password !== undefined ? { password } : {}),
      }),
    importPackage: (request: ImportJobRequest) => {
      // onProgress 不能跨进程（结构化克隆抛错），剥掉后经 package:progress 事件回流
      const { onProgress, ...rest } = request;
      return withProgress(
        'package',
        'package:progress',
        subscribe,
        onProgress === undefined
          ? undefined
          : (payload) => {
              const snapshot = payload as {
                stage?: unknown;
                processed?: unknown;
                total?: unknown;
              };
              onProgress(
                String(snapshot.stage ?? ''),
                Number(snapshot.processed ?? 0),
                Number(snapshot.total ?? 0),
                null,
              );
            },
        (requestId) => call.call('package', 'importPackage', { request: rest }, requestId),
      );
    },
    runHealing: (projectId) => call.call('package', 'runHealing', { projectId: projectId ?? null }),
    adoptAnchorCandidate: (anchorId, filePath, symbol) =>
      call.call('package', 'adoptAnchorCandidate', { anchorId, filePath, symbol }),
    getBackupSettings: () => call.call('package', 'getBackupSettings'),
    saveBackupSettings: (settings) => call.call('package', 'saveBackupSettings', { settings }),
    createBackupNow: () => call.call('package', 'createBackupNow'),
    listSnapshots: () => call.call('package', 'listSnapshots'),
    restoreFromSnapshot: (path) => call.call('package', 'restoreFromSnapshot', { path }),
  };
}

/* ------------------------------- 设计器 ------------------------------- */

export function createDesignerApi(call: DomainCaller): DesignerPortApi {
  const d = <T>(method: string, params?: unknown): Promise<T> =>
    call.call<T>('designer', method, params);
  return {
    openProject: (projectId) => d('openProject', { projectId }),
    listPages: (projectId) => d('listPages', { projectId }),
    loadPage: (projectId, pageId) => d('loadPage', { projectId, pageId }),
    savePage: (projectId, envelope) => d('savePage', { projectId, envelope }),
    createPage: (projectId, input) => d('createPage', { projectId, input }),
    writePageStructure: (input) => d('writePageStructure', { input }),
    listStructureRevisions: (pageId) => d('listStructureRevisions', { pageId }),
    upsertRoutes: (projectId, routes) => d('upsertRoutes', { projectId, routes: [...routes] }),
    readRoutes: (projectId) => d('readRoutes', { projectId }),
    generatePage: (projectId, request) => d('generatePage', { projectId, request }),
    readNotes: (input) => d('readNotes', input),
    saveNote: (input) => d('saveNote', { projectId: input.projectId, input }),
    updateNote: (input) =>
      d('updateNote', { projectId: input.projectId, id: input.id, patch: input.patch }),
    setNoteStatus: (input) => d('setNoteStatus', input),
    removeNote: (input) => d('removeNote', input),
    noteBadges: (input) => d('noteBadges', input),
  };
}

/* ------------------------------ 装配与注入 ------------------------------ */

/** 生产端口全局槽位（键名与各特性 `readInjected*` 读取的一致） */
export interface ProductionPortGlobals {
  __EC_MEMORY__?: unknown;
  __EC_PIPELINE__?: unknown;
  __EC_GIT__?: unknown;
  __EC_PREVIEW__?: unknown;
  __EC_RENAME__?: unknown;
  __EC_PACKAGE__?: unknown;
  __EC_USAGE__?: unknown;
  __EC_AI_CONTEXT__?: unknown;
  __EC_CODE__?: unknown;
  __EC_NAV__?: unknown;
  __EC_DESIGNER__?: unknown;
  [key: string]: unknown;
}

export interface ProductionInstallResult {
  installed: DomainKind[];
  /** 有域可用、但同步口缺失（Tauri / mock）而未注入的域，附原因供启动日志定位 */
  unavailable: Array<{ kind: DomainKind; reason: string }>;
}

/**
 * 按 `describe()` 结果构造十一域端口并写入全局槽位。
 *
 * 两条规则：
 * - `available: false` 的域不注入（页面保留装配引导）；
 * - memory / pipeline 额外要求外壳提供同步口（`invokeSync`），否则也不注入——
 *   它们的消费方在写入后立刻同步读回，异步通道给不出正确结果。
 */
export async function installProductionPorts(
  host: DomainControlHost,
  call: DomainCaller,
  subscribe: DomainEventSubscriber,
  available: ReadonlySet<DomainKind>,
  globals: ProductionPortGlobals = globalThis as unknown as ProductionPortGlobals,
): Promise<ProductionInstallResult> {
  const sync = createDomainSyncCaller(host);
  const unavailable: Array<{ kind: DomainKind; reason: string }> = [];

  const needSync = (kind: DomainKind): boolean => {
    if (sync !== null) return true;
    unavailable.push({
      kind,
      reason: '外壳未提供同步域通道（invokeSync），同步签名的端口不注入',
    });
    return false;
  };

  if (available.has('memory') && needSync('memory')) {
    globals['__EC_MEMORY__'] = createMemoryApi(call, sync);
  }
  if (available.has('pipeline') && needSync('pipeline')) {
    globals['__EC_PIPELINE__'] = createPipelineApi(call, sync, subscribe);
  }
  if (available.has('git')) globals['__EC_GIT__'] = createGitApi(call, subscribe);
  if (available.has('preview')) globals['__EC_PREVIEW__'] = createPreviewApi(call, subscribe);
  if (available.has('rename')) globals['__EC_RENAME__'] = createRenameApi(call, subscribe);
  if (available.has('package')) globals['__EC_PACKAGE__'] = createPackageApi(call, subscribe);
  if (available.has('usage')) globals['__EC_USAGE__'] = createUsageApi(call);
  if (available.has('ai-context')) {
    globals['__EC_AI_CONTEXT__'] = createAiContextApi(call);
  }
  if (available.has('code')) globals['__EC_CODE__'] = createCodeApi(call, subscribe);
  if (available.has('nav')) globals['__EC_NAV__'] = createNavApi(call);
  if (available.has('designer')) globals['__EC_DESIGNER__'] = createDesignerApi(call);

  const installed: DomainKind[] = [];
  const slots: ReadonlyArray<readonly [DomainKind, keyof ProductionPortGlobals]> = [
    ['memory', '__EC_MEMORY__'],
    ['pipeline', '__EC_PIPELINE__'],
    ['git', '__EC_GIT__'],
    ['preview', '__EC_PREVIEW__'],
    ['rename', '__EC_RENAME__'],
    ['package', '__EC_PACKAGE__'],
    ['usage', '__EC_USAGE__'],
    ['ai-context', '__EC_AI_CONTEXT__'],
    ['code', '__EC_CODE__'],
    ['nav', '__EC_NAV__'],
    ['designer', '__EC_DESIGNER__'],
  ];
  for (const [kind, key] of slots) {
    if (globals[key] !== undefined && globals[key] !== null) installed.push(kind);
  }
  return { installed, unavailable };
}
