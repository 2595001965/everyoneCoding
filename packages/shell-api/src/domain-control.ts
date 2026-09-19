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

/** 四个域端口的稳定标识 */
export const DOMAIN_KINDS = ['workspace', 'docs', 'auth', 'settings'] as const;
export type DomainKind = (typeof DOMAIN_KINDS)[number];

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
} as const satisfies Record<DomainKind, readonly string[]>;

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
  /** 投递事件；无注册目标时静默丢弃（不抛出，避免反过来打断业务路由） */
  send(event: DomainEvent): void;
}

export function createDomainEventSink(): DomainEventSink {
  const targets = new Map<string, (event: DomainEvent) => void>();
  return {
    register(requestId: string, send: (event: DomainEvent) => void): void {
      targets.set(requestId, send);
    },
    unregister(requestId: string): void {
      targets.delete(requestId);
    },
    send(event: DomainEvent): void {
      const target = targets.get(event.requestId);
      if (!target) return;
      try {
        target(event);
      } catch {
        // 下发失败（窗口已销毁等）不应影响业务本身
      }
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
export function isWorkspaceImportProgressEvent(value: unknown): value is WorkspaceImportProgressEvent {
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

export function isDomainKind(value: unknown): value is DomainKind {
  return typeof value === 'string' && (DOMAIN_KINDS as readonly string[]).includes(value);
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
