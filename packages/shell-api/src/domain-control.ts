import type { ShellErrorCode } from './errors';
import type { Unsubscribe } from './types';

/**
 * 领域端口 RPC 契约（Wave 9 装配补齐 / M-07 四端口）。
 *
 * 背景：`__EC_WORKSPACE__` / `__EC_DOCS__` / `__EC_AUTH__` / `__EC_SETTINGS__` 四个
 * 渲染层端口此前**只有消费方没有生产者**，导致对应页面长期停留在装配引导。
 * 四个端口合计约 70 个方法，若逐个开 IPC 通道会造成通道表爆炸并让 preload
 * 白名单难以审阅；因此沿用 `AiControlHost` 已经验证过的做法：**一个通道 + 方法白名单**，
 * 由主进程按 `domain` 分流。
 *
 * 边界（与 AI 控制一致的硬约束）：
 * - 跨进程只传可结构化克隆的 JSON 值；Error / AbortSignal / 类实例永不跨界。
 * - 方法名先过白名单再分发，未知方法一律 INVALID_ARGUMENT，不做任何反射。
 * - 错误消息经脱敏后才回渲染层（诊断信息里可能夹带密钥/令牌）。
 */

/** 各域端口的稳定标识（T12-01 总装：四基础域 + 十一生产能力域） */
export const DOMAIN_KINDS = [
  'workspace',
  'docs',
  'auth',
  'settings',
  'memory',
  'pipeline',
  'git',
  'preview',
  'rename',
  'package',
  'usage',
  'ai-context',
  'code',
  'nav',
  'designer',
] as const;
export type DomainKind = (typeof DOMAIN_KINDS)[number];

const DOMAIN_KIND_SET: ReadonlySet<string> = new Set<string>(DOMAIN_KINDS);

/**
 * 域标识守卫。
 * `domain` 从渲染层跨进程传入，是不可信输入；直接拿它索引白名单表会退化成反射式调用，
 * 因此先做一次成员判定再放行。
 */
export function isDomainKind(value: unknown): value is DomainKind {
  return typeof value === 'string' && DOMAIN_KIND_SET.has(value);
}

/**
 * 每个域可调用的方法白名单。
 *
 * 必须与渲染层端口接口**逐字对应**：
 * - workspace → `features/workspace/workspace-api.tsx` 的 `WorkspaceApi`
 * - docs → `features/docs/docs-api.tsx` 的 `DocsApi`
 * - auth → `features/auth/auth-api.tsx` 的 `AuthApi`
 * - settings → `features/settings/settings-api.tsx` 的 `SettingsApi`
 *
 * 注意：`AuthApi.onOfflineChange` 是订阅语义、`AuthApi.isOffline` 是同步语义，
 * 二者不由本 RPC 承载（前者由渲染层适配器本地分发，后者走 isOffline 查询 + 本地镜像）。
 */
export const DOMAIN_RPC_METHODS = {
  workspace: [
    'listProjects',
    'getProject',
    'createProject',
    'updateProject',
    'markOpened',
    'archiveProject',
    'unarchiveProject',
    'moveToRecycleBin',
    'restoreFromRecycleBin',
    'purgeProject',
    'cleanupExpiredRecycleBin',
    'duplicateProject',
    'createFromTemplate',
    'importFromGit',
    'createFromDigest',
    'getProjectStage',
    'getThumbnailUrl',
    'getDashboardMetrics',
    'getMetricDetail',
  ],
  docs: [
    'listDocuments',
    'getDocument',
    'importDocument',
    'importFromFile',
    'updateDocument',
    'deleteDocument',
    'restoreDocument',
    'purgeDocument',
    'listVersions',
    'ignoreVersion',
    'evaluateUpdateStatus',
    'listMemoryNodes',
    'listDocLinks',
    'listMemoryRefs',
    'linkToMemory',
    'removeLink',
    'countLinksForMemories',
    'previewConvertToMemory',
    'commitConvertToMemory',
    'supportedFormats',
  ],
  auth: [
    'register',
    'login',
    'logout',
    'restore',
    'beginOAuth',
    'completeOAuth',
    'pollWechatScan',
    'listBindings',
    'bind',
    'unbind',
    'requestEmailVerification',
    'resetPassword',
    'isOffline',
    'tryRecover',
  ],
  settings: [
    'getAll',
    'update',
    'getDataDirs',
    'migrateDataDirs',
    'rollbackMigration',
    'exportProject',
    'importPackage',
    'setTelemetry',
    'inspectLocalTelemetry',
    'clearLocalTelemetry',
    'listCommands',
    'saveKeymap',
    'exportKeymap',
    'importKeymap',
    'getBackupConfig',
    'saveBackupConfig',
  ],
  memory: [
    'listProjects',
    'stats',
    'list',
    'detail',
    'conflictIndex',
    'context',
    'create',
    'update',
    'setPinned',
    'setIssueStatus',
    'moveLayer',
    'remove',
    'restore',
    'changeLog',
    'exportMemories',
    'importPreview',
    'importCommit',
  ],
  pipeline: [
    'initProject',
    'snapshot',
    'advance',
    'startStage',
    'submitForReview',
    'confirm',
    'back',
    'skip',
    'applyDownstreamStale',
    'saveArtifact',
    'listArtifacts',
    'readArtifact',
    'readDiff',
    'switchVersion',
    'notifyDownstream',
    'generateRequirement',
    'getTechChoice',
    'saveTechChoice',
    'generateTechDoc',
    'getSplit',
    'saveSplit',
    'evaluateImpact',
    'runGeneration',
    'getResumeProgress',
    'generateSplit',
    'recoverProject',
    'retryNode',
    'skipNode',
    'pauseQueue',
  ],
  git: [
    'openProject',
    'info',
    'init',
    'status',
    'stage',
    'unstage',
    'commit',
    'generateCommitMessage',
    'diff',
    'branches',
    'tags',
    'createBranch',
    'switchBranch',
    'renameBranch',
    'deleteBranch',
    'log',
    'commitDetail',
    'previewMerge',
    'merge',
    'rebase',
    'abort',
    'conflicts',
    'applyResolution',
    'requestAiMerge',
    'stashList',
    'stashPush',
    'stashApply',
    'stashDrop',
    'rollbackPlan',
    'rollbackExecute',
    'snapshots',
    'remotes',
    'addRemote',
    'editRemote',
    'removeRemote',
    'testRemote',
    'push',
    'pull',
    'fetch',
    'credentialBindings',
    'saveHttpsCredential',
    'saveSshCredential',
    'removeCredential',
    'autoCommitPolicy',
    'setAutoCommitPolicy',
    'changeSources',
  ],
  preview: [
    'state',
    'setMode',
    'start',
    'stop',
    'pages',
    'refresh',
    'requests',
    'replayRequest',
    'toCurl',
    'clearRequests',
    'projectProfile',
    'installDependencies',
    'startBackend',
    'stopBackend',
    'restartBackend',
    'backendStatus',
    'logs',
    'devices',
    'deviceQr',
    'lanSharingEnabled',
    'setLanSharing',
    'mockSettings',
    'setMockSettings',
  ],
  rename: [
    'openProject',
    'projectContext',
    'resolveRule',
    'symbolTable',
    'listTargets',
    'check',
    'analyze',
    'buildDiff',
    'execute',
    'undo',
    'history',
    'planMigration',
    'runMigration',
    'pendingCleanup',
    'cleanAliases',
    'planBatch',
    'runBatch',
  ],
  package: [
    'pickExportPath',
    'exportPackage',
    'listExportPresets',
    'saveExportPreset',
    'deleteExportPreset',
    'pickPackagePath',
    'verifyPackage',
    'previewImport',
    'previewMode',
    'importPackage',
    'runHealing',
    'adoptAnchorCandidate',
    'getBackupSettings',
    'saveBackupSettings',
    'createBackupNow',
    'listSnapshots',
    'restoreFromSnapshot',
  ],
  usage: ['listRows', 'getBudget', 'setBudget', 'budgetDecision'],
  'ai-context': ['assemble'],
  code: ['listFiles', 'readFile', 'plan', 'apply', 'requestRework'],
  nav: [
    'openProject',
    'hoverTargets',
    'resolveJump',
    'commitJump',
    'jumpStats',
    'relationGraph',
    'reverseJump',
    'dataFlow',
  ],
  designer: [
    'openProject',
    'listPages',
    'loadPage',
    'savePage',
    'createPage',
    'writePageStructure',
    'listStructureRevisions',
    'upsertRoutes',
    'readRoutes',
    'generatePage',
    'readNotes',
    'saveNote',
    'updateNote',
    'setNoteStatus',
    'removeNote',
    'noteBadges',
  ],
} as const satisfies Record<DomainKind, readonly string[]>;

/**
 * 同步调用白名单（T12-01 收尾：同步签名端口）。
 *
 * 背景：渲染层有两个端口是**同步签名**——`MemoryApi`（记忆中心的读与写）与
 * `PipelineApi`（状态机快照 / 推进 / 工件台账），它们的消费方在渲染期直接读、
 * 写入后立刻再读同一份状态（如 `advance()` 后紧跟 `snapshot()`）。
 * 这类语义用异步 RPC + 快照缓存无法正确表达（写入后立刻读会拿到上一拍的数据），
 * 因此在域通道之外再开一条**同步**通道：渲染层 `sendSync` → 主进程同步路由。
 *
 * 为什么另立白名单而不是复用 `DOMAIN_RPC_METHODS`：
 * 同步通道会阻塞渲染进程，只能承载「本地 SQLite / 文件、无网络、无 AI」的方法。
 * 一旦某天有人把 `generateRequirement` 之类挂进来，UI 会直接卡死几十秒，
 * 因此这里**显式列出**允许同步的方法，默认拒绝。
 */
export const DOMAIN_SYNC_METHODS = {
  memory: [
    'listProjects',
    'stats',
    'list',
    'detail',
    'conflictIndex',
    'context',
    'create',
    'update',
    'setPinned',
    'setIssueStatus',
    'moveLayer',
    'remove',
    'restore',
    'changeLog',
  ],
  pipeline: [
    'initProject',
    'snapshot',
    'advance',
    'startStage',
    'submitForReview',
    'confirm',
    'back',
    'skip',
    'applyDownstreamStale',
    'listArtifacts',
    'switchVersion',
    'notifyDownstream',
    'getTechChoice',
    'getSplit',
    'getResumeProgress',
    'getQueueState',
  ],
} as const satisfies Partial<Record<DomainKind, readonly string[]>>;

/** 同步方法白名单校验：未登记的域一律没有同步口 */
export function isDomainSyncMethod(domain: string, method: string): boolean {
  if (!isDomainKind(domain)) return false;
  const allowed = (DOMAIN_SYNC_METHODS as Record<string, readonly string[] | undefined>)[domain];
  return allowed !== undefined && allowed.includes(method);
}

/** 域的装配状态：`available=false` 时渲染层**不注入**该端口，页面保留如实引导 */
export interface DomainDescriptor {
  kind: DomainKind;
  available: boolean;
  /** 不可用原因（面向用户，不含路径与密钥）；available 为 true 时缺省 */
  reason?: string;
}

/** 域调用失败的结构化原因（跨进程传递） */
export interface DomainRpcError {
  code: ShellErrorCode;
  message: string;
  retryable?: boolean;
}

export interface DomainRpcRequest {
  requestId: string;
  domain: DomainKind;
  method: string;
  params: unknown;
}

export interface DomainRpcResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: DomainRpcError;
}

/* ----------------------------- 域事件通道 ----------------------------- */

/**
 * 域事件信封（主进程 → 渲染层**单向**推送）。
 *
 * 域 RPC 是请求/响应模型，天然承载不了「执行到哪一步」这类中途信息：
 * 克隆一个大仓库要几十秒到几分钟，若只有请求/响应，界面只能干等。
 * 这里补一条与 `AiControlHost.stream` 同构的事件通道，把过程反馈送回来。
 *
 * 事件**不携带自己的 id**，而是复用触发它的请求 `requestId`：
 * - 渲染层据此把事件关联到具体那次调用，多请求并发时不会串台；
 * - 请求结束（resolve/reject）后渲染层退订，事件自然失去投递目标。
 *
 * 载荷必须可结构化克隆（函数 / 类实例 / Error 永不跨界，见本模块顶部边界）。
 */
export interface DomainEvent {
  /** 触发事件的域请求 id，与 `DomainRpcRequest.requestId` 一致 */
  requestId: string;
  domain: DomainKind;
  /** 域自定义载荷 */
  payload: unknown;
}

/**
 * 事件下发注册表（主进程侧）。
 *
 * 之所以按 requestId 注册而不是"广播到所有窗口"：域调用可能并发
 * （工作台与文档中心同时刷新），而事件只属于发起那次请求的渲染进程。
 * IPC 层在 `invoke` 期间注册 `event.sender`，在 `finally` 中注销——
 * 请求一结束就没有投递目标，不会给已结束的请求留下悬空回调。
 */
export interface DomainEventSink {
  register(requestId: string, send: (event: DomainEvent) => void): void;
  unregister(requestId: string): void;
  /**
   * 投递**请求内**事件：只给注册了该 `requestId` 的目标。
   * 无注册目标时静默丢弃（不抛出，避免反过来打断业务路由）。
   */
  send(event: DomainEvent): void;
  /**
   * 投递**无请求归属**的事件（长驻进程日志、文件监视器等）给所有常驻订阅者。
   *
   * 为什么不复用 `send` 的兜底：`send` 的"请求结束即无投递目标"是一条**刻意**的保证
   * （见 `register` 注释：请求一结束就没有悬空回调），把它改成"找不到目标就广播"
   * 会让已结束请求的迟到事件重新落到窗口上。两个语义分开，各自保持精确：
   * 请求内的进度走 `send`，请求外的常驻流走 `broadcast`。
   */
  broadcast(event: DomainEvent): void;
  /** 订阅常驻事件（仅接收 `broadcast` 投递的载荷） */
  subscribe(listener: (event: DomainEvent) => void): Unsubscribe;
}

export function createDomainEventSink(): DomainEventSink {
  const targets = new Map<string, (event: DomainEvent) => void>();
  const broadcasters = new Set<(event: DomainEvent) => void>();
  return {
    register(requestId: string, send: (event: DomainEvent) => void): void {
      targets.set(requestId, send);
    },
    unregister(requestId: string): void {
      targets.delete(requestId);
    },
    send(event: DomainEvent): void {
      const target = targets.get(event.requestId);
      if (target === undefined) return;
      try {
        target(event);
      } catch {
        // 下发失败（窗口已销毁等）不应影响业务本身
      }
    },
    broadcast(event: DomainEvent): void {
      for (const listener of broadcasters) {
        try {
          listener(event);
        } catch {
          // 单个订阅者失败不影响其它订阅者
        }
      }
    },
    subscribe(listener: (event: DomainEvent) => void): Unsubscribe {
      broadcasters.add(listener);
      return () => {
        broadcasters.delete(listener);
      };
    },
  };
}

/**
 * `ShellHost.domain` 的稳定契约。
 *
 * `describe()` 刻意独立于 RPC 方法白名单：它回答的是「这个域能不能用」，
 * 而不是「这个域支持哪些方法」——渲染层据此决定是否注入全局端口。
 */
export interface DomainControlHost {
  invoke(request: DomainRpcRequest): Promise<DomainRpcResponse>;
  /**
   * **同步**调用（可选能力）。
   *
   * 只承载 `DOMAIN_SYNC_METHODS` 白名单内的方法（本地 SQLite / 文件，无网络与 AI）。
   * 渲染层用它驱动同步签名的端口（`MemoryApi` / `PipelineApi`）。
   * 未实现该能力的外壳（Tauri / 早期 mock）退化为「这两个端口不注入」，
   * 对应页面保留如实的装配引导，而不是拿到一个读到脏数据的端口。
   */
  invokeSync?(request: DomainRpcRequest): DomainRpcResponse;
  /** 各域装配状态；未装配的域必须如实回答 false 而不是假装可用 */
  describe(): Promise<DomainDescriptor[]>;
  /**
   * 订阅域事件（**可选能力**）。
   *
   * 未实现该能力的外壳（Tauri / 早期 mock）不提供本方法，渲染层据此
   * 退化为「无过程反馈」——即调用照常成功，只是拿不到中途进度，
   * 而不是让整次调用失败。
   */
  onEvent?(listener: (event: DomainEvent) => void): Unsubscribe;
}

/** 主进程实现的入口（渲染层只消费 DomainControlHost） */
export interface DomainControlServiceHost extends DomainControlHost {
  dispose(): Promise<void>;
  /** 事件下发注册表；IPC 层按 requestId 注册渲染进程发送器 */
  events: DomainEventSink;
  /**
   * 同步调用口（主进程必实现）。
   *
   * 与 `invoke` 的差别只有「不返回 Promise」：路由、白名单校验、错误脱敏完全同一套，
   * 未登记同步口的域/方法返回 `NOT_SUPPORTED` / `INVALID_ARGUMENT`，不做任何降级伪装。
   */
  invokeSync(request: DomainRpcRequest): DomainRpcResponse;
}

/* ------------------------- 导入进度事件（首个消费者） ------------------------- */

/**
 * `workspace.importFromGit` 的执行阶段。
 *
 * 这三个阶段是用户实际等待的全部时间：克隆（可分比例）、扫描仓库文件、
 * 落库并生成项目记忆。只报克隆进度的话，扫描与落库期间界面会退回"转圈"，
 * 所以通道一次铺到三个阶段，`ratio` 在不可知时为 `null`。
 */
export const WORKSPACE_IMPORT_STAGES = ['clone', 'inspect', 'finalize'] as const;
export type WorkspaceImportStage = (typeof WORKSPACE_IMPORT_STAGES)[number];

/** 导入进度（渲染层消费的形状） */
export interface WorkspaceImportProgress {
  stage: WorkspaceImportStage;
  /** 仅 clone 阶段可知比例（0-1）；其余阶段为 null，UI 应显示不确定进度 */
  ratio: number | null;
  message: string;
}

/** 事件载荷（`type` 用于跨进程判别，避免把别的域事件误当进度） */
export const WORKSPACE_IMPORT_PROGRESS_EVENT = 'workspace:import-progress';

export interface WorkspaceImportProgressEvent extends WorkspaceImportProgress {
  type: typeof WORKSPACE_IMPORT_PROGRESS_EVENT;
}

/**
 * 跨进程载荷守卫。
 * 渲染层不信任主进程来的任意对象：形状不对就丢弃，而不是把脏值塞进 UI。
 */
export function isWorkspaceImportProgressEvent(
  value: unknown,
): value is WorkspaceImportProgressEvent {
  if (value === null || typeof value !== 'object') return false;
  const event = value as { type?: unknown; stage?: unknown; ratio?: unknown; message?: unknown };
  if (event.type !== WORKSPACE_IMPORT_PROGRESS_EVENT) return false;
  if (!(WORKSPACE_IMPORT_STAGES as readonly string[]).includes(event.stage as string)) return false;
  if (event.ratio !== null) {
    if (typeof event.ratio !== 'number' || !Number.isFinite(event.ratio)) return false;
    if (event.ratio < 0 || event.ratio > 1) return false;
  }
  return typeof event.message === 'string';
}

/* ------------------------- 新增域事件载荷（T12-01） ------------------------- */

/** 通用进度事件（pipeline / package 等长任务复用同一形状） */
export interface DomainProgressEvent {
  type: string;
  /** 比例不可知时为 null（UI 走不确定进度，不准假装 100%） */
  ratio: number | null;
  message: string;
}

/** 流水线阶段状态变化事件（替代不可跨进程的 EventBus 监听） */
export const PIPELINE_STAGE_EVENT = 'pipeline:stage-event';
/** 流水线节点生成进度事件（S5） */
export const PIPELINE_PROGRESS_EVENT = 'pipeline:progress';
/** Git 远程传输进度事件 */
export const GIT_PROGRESS_EVENT = 'git:progress';
/** 预览后端日志行事件 */
export const PREVIEW_LOG_EVENT = 'preview:log';
/**
 * 重命名迁移执行日志行事件（T12-04）。
 *
 * 迁移执行会逐条 SQL 跑几秒到几十秒，UI 需要边跑边看；载荷形状与 `@ec/registry`
 * 的 `MigrationLogLine` 一致（level / message / at / index / total）。
 */
export const RENAME_MIGRATION_LOG_EVENT = 'rename:migration-log';
/** 归档导出/导入进度事件 */
export const PACKAGE_PROGRESS_EVENT = 'package:progress';
/** 代码外部改动提示事件（ExternalChangeWatcher 经域事件回流渲染层） */
export const CODE_EXTERNAL_CHANGE_EVENT = 'code:external-change';
/**
 * 代码写入计划事件（T12-02）。
 *
 * 「交给 AI 修改」是一次**两段式**交互：`requestRework` 只负责真实模型调用 + 生成计划，
 * 计划不能当返回值（渲染层契约是 `Promise<void>`），也不能由主进程自行落盘
 * （必须由用户看过 diff 再确认）。因此计划经事件交给 UI：UI 渲染 DiffView，
 * 用户确认后调用 `code.apply` 走同一份 WritePipeline 事务。
 */
export const CODE_WRITE_PLAN_EVENT = 'code:write-plan';

function isPositiveRatio(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPipelineStageEventShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event['projectId'] === 'string' &&
    typeof event['event'] === 'string' &&
    isPositiveRatio(event['ratio']) &&
    (event['data'] === undefined || typeof event['data'] === 'object')
  );
}

function isPipelineProgressEventShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event['projectId'] === 'string' &&
    typeof event['message'] === 'string' &&
    isPositiveRatio(event['ratio'])
  );
}

function isGitProgressEventShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  const phases = ['idle', 'connecting', 'transferring', 'done', 'error'];
  return (
    typeof event['phase'] === 'string' &&
    (phases as readonly string[]).includes(event['phase']) &&
    typeof event['message'] === 'string' &&
    isPositiveRatio(event['percent'])
  );
}

function isPreviewLogEventShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event['line'] === 'string' &&
    typeof event['at'] === 'number' &&
    (event['level'] === undefined || typeof event['level'] === 'string')
  );
}

function isRenameMigrationLogEventShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  const levels = ['info', 'success', 'warn', 'error'];
  return (
    typeof event['message'] === 'string' &&
    typeof event['at'] === 'number' &&
    (levels as readonly string[]).includes(event['level'] as string)
  );
}

function isPackageProgressEventShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event['stage'] === 'string' &&
    typeof event['processed'] === 'number' &&
    typeof event['total'] === 'number'
  );
}

function isCodeExternalChangeEventShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event['path'] === 'string' && typeof event['message'] === 'string';
}

/**
 * 写入计划事件形状：计划本体必须带 id / mode / entries（数组）才算合法。
 *
 * 只校验到这一层 —— 逐字段校验 entries 等于把渲染层的 DiffViewModel 契约复制一份到
 * 跨进程边界上，两边一旦漂移就会出现"事件被静默丢弃"这种最难查的故障。
 */
function isCodeWritePlanEventShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (typeof event['projectId'] !== 'string') return false;
  const plan = event['plan'];
  if (plan === null || typeof plan !== 'object') return false;
  const candidate = plan as Record<string, unknown>;
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['mode'] === 'string' &&
    Array.isArray(candidate['entries'])
  );
}

/** 域事件载荷注册表：`type` 判别字段 → 形状守卫（跨进程数据不信任） */
const DOMAIN_EVENT_PAYLOAD_GUARDS: ReadonlyArray<{
  type: string;
  guard: (payload: unknown) => boolean;
}> = [
  { type: WORKSPACE_IMPORT_PROGRESS_EVENT, guard: isWorkspaceImportProgressEvent },
  { type: PIPELINE_STAGE_EVENT, guard: isPipelineStageEventShape },
  { type: PIPELINE_PROGRESS_EVENT, guard: isPipelineProgressEventShape },
  { type: GIT_PROGRESS_EVENT, guard: isGitProgressEventShape },
  { type: PREVIEW_LOG_EVENT, guard: isPreviewLogEventShape },
  { type: RENAME_MIGRATION_LOG_EVENT, guard: isRenameMigrationLogEventShape },
  { type: PACKAGE_PROGRESS_EVENT, guard: isPackageProgressEventShape },
  { type: CODE_EXTERNAL_CHANGE_EVENT, guard: isCodeExternalChangeEventShape },
  { type: CODE_WRITE_PLAN_EVENT, guard: isCodeWritePlanEventShape },
];

/**
 * 渲染层通用载荷过滤：按 `type` 字段匹配已知事件形状，形状不对就丢弃。
 * 域内新增事件时在此登记守卫；未登记的 `type` 一律不投递（防脏数据进 UI）。
 */
export function isKnownDomainEventPayload(type: string, payload: unknown): boolean {
  const entry = DOMAIN_EVENT_PAYLOAD_GUARDS.find((item) => item.type === type);
  return entry !== undefined && entry.guard(payload);
}

/** 方法白名单校验：不做反射，未知域/未知方法直接拒绝 */
export function isDomainRpcMethod(domain: string, method: string): boolean {
  if (!isDomainKind(domain)) return false;
  return (DOMAIN_RPC_METHODS[domain] as readonly string[]).includes(method);
}

export function createDomainRequestId(domain: DomainKind): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${domain}-${Date.now().toString(36)}-${random}`;
}

/**
 * RPC 边界最后一道脱敏。
 * 与 AI 通道同一策略：域名端口同样可能把日志/诊断串带回来，不能原样透传。
 *
 * 规则顺序有讲究——**必须先抹 Bearer，再抹 key:value**：
 * 反过来的话 `Authorization: Bearer <token>` 会被 key:value 规则只吃掉 `Bearer`，
 * 真正的令牌反而留在串里。同时 key:value 规则用负向先行断言跳过已经变成占位符
 * 或 `Bearer` 标记本身的值，避免把上一步的产物 `Bearer ***` 二次拆成 `*** ***`。
 */
export function sanitizeDomainMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer ***')
    .replace(
      /\b(?:api[_-]?key|x-api-key|authorization|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?!\*{3}(?!\S))(?!Bearer\b)[^\s,;}]+/gi,
      (match) => {
        const separator = match.match(/\s*[:=]\s*/)?.[0] ?? ': ';
        const key = match.slice(0, match.indexOf(separator)).trim();
        return `${key}${separator}***`;
      },
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***');
}

/** 把任意异常规整为可跨进程的 DomainRpcError（不携带堆栈） */
export function domainErrorFromUnknown(error: unknown): DomainRpcError {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof value.code === 'string' && typeof value.message === 'string') {
      return {
        code: value.code as ShellErrorCode,
        message: sanitizeDomainMessage(value.message),
        ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
      };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'UNKNOWN', message: sanitizeDomainMessage(message) };
}

/** 域当前不可用时的标准错误（渲染层据此回退到装配引导） */
export function domainUnavailableError(kind: DomainKind, reason?: string): DomainRpcError {
  return {
    code: 'NOT_SUPPORTED',
    message: reason ?? `域端口 ${kind} 尚未装配`,
    retryable: false,
  };
}

/** 订阅型能力的本地分发器（AuthApi.onOfflineChange 等使用） */
export function createLocalEmitter<T>(initial: T): {
  get(): T;
  set(next: T): void;
  on(listener: (value: T) => void): Unsubscribe;
} {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => current,
    set(next: T): void {
      if (Object.is(current, next)) return;
      current = next;
      for (const listener of listeners) listener(next);
    },
    on(listener: (value: T) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
