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
}

/** 主进程实现的入口（渲染层只消费 DomainControlHost） */
export interface DomainControlServiceHost extends DomainControlHost {
  dispose(): Promise<void>;
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
