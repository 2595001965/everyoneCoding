import type { Unsubscribe } from './types';

/**
 * ShellHost.ai 的稳定 RPC/流式契约。
 *
 * 渲染层和外壳层只能交换可结构化克隆的 JSON 值；AsyncIterable、AbortSignal、Error
 * 等运行时对象永不跨 IPC。流式调用使用 requestId 关联事件，取消单独走 abort。
 */

export const AI_RPC_METHODS = [
  'listProviders',
  'createProvider',
  'updateProvider',
  'removeProvider',
  'setProviderEnabled',
  'reorderProviders',
  'testConnection',
  'testDraftConnection',
  'listModels',
  'listAllModels',
  'refreshModels',
  'addManualModel',
  'updateCapability',
  'getBinding',
  'saveBinding',
  'monthlyUsage',
  'usageByModel',
  'budgetConfig',
  'setBudget',
  'setLimits',
  'setProxy',
  'testProxy',
  'listRemoteSources',
  'createRemoteSource',
  'updateRemoteSource',
  'removeRemoteSource',
  'fetchRemoteSource',
  'previewRemoteSource',
  'applyRemoteSource',
  'ackRemoteRevision',
  'refreshRemoteSourcesOnBoot',
  // 密钥环：明文 Key 的唯一入口，只回传引用名
  'persistApiKey',
  'discardTempKey',
] as const;

export type AiRpcMethod = (typeof AI_RPC_METHODS)[number];

export interface AiRpcRequest {
  requestId: string;
  method: AiRpcMethod;
  params: unknown;
}

export interface AiRpcError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface AiRpcResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: AiRpcError;
}

export interface AiStreamRequest {
  requestId: string;
  purpose: string;
  messages: Array<{ role: string; content: unknown }>;
  projectId?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
}

export type AiStreamEvent =
  | { type: 'chunk'; payload: { type: string; [key: string]: unknown } }
  | { type: 'event'; payload: { type: string; [key: string]: unknown } }
  | { type: 'error'; error: AiRpcError }
  | { type: 'done'; finishReason: string; partial: boolean };

export interface AiStreamHandle {
  readonly requestId: string;
  on(listener: (event: AiStreamEvent) => void): Unsubscribe;
  abort(): void;
}

export interface AiControlHost {
  invoke(request: AiRpcRequest): Promise<AiRpcResponse>;
  stream(request: AiStreamRequest): AiStreamHandle;
  abort(requestId: string): void;
}

/**
 * 域侧可用的 AI 栈最小句柄（主进程内部使用，不经 IPC 暴露）。
 *
 * 当前唯一消费者是 usage 域的预算回灌：设置页改预算后必须即时推给
 * 运行中的 `BudgetGuard`，否则「超限在调用模型前阻断」要等重启才生效。
 */
export interface AiStackHandle {
  gateway: {
    chat(input: {
      userId: string;
      purpose: string;
      messages: ReadonlyArray<{ role: string; content: string }>;
      projectId?: string | undefined;
      signal?: AbortSignal | undefined;
    }): AsyncIterable<{ type: string; text?: string | undefined; [key: string]: unknown }>;
  };
  budget?: {
    configure(patch: {
      dailyUsd?: number | null;
      monthlyUsd?: number | null;
      alertRatio?: number;
    }): void;
  };
}

/** 主进程实现的入口；不暴露任意反射对象 */
export interface AiControlServiceHost {
  invoke(request: AiRpcRequest): Promise<AiRpcResponse>;
  stream(request: AiStreamRequest, emit: (event: AiStreamEvent) => void): void;
  abort(requestId: string): void;
  dispose(): Promise<void>;
  /** 域工厂用的最小句柄（预算回灌 / 后续生成调用共用同一份栈） */
  handle?: AiStackHandle;
}

export function createRequestId(prefix = 'ai'): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function aiErrorFromUnknown(error: unknown): AiRpcError {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof value.code === 'string' && typeof value.message === 'string') {
      return {
        code: value.code,
        message: sanitizeAiMessage(value.message),
        ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
      };
    }
  }
  return {
    code: 'UNKNOWN',
    message: sanitizeAiMessage(error instanceof Error ? error.message : String(error)),
  };
}

/** RPC 边界最后一道脱敏：普通 Error 也不能把认证头/Key 带回渲染层。 */
function sanitizeAiMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer ***')
    .replace(
      /\b(?:api[_-]?key|x-api-key|authorization|token|secret|password)\b\s*[:=]\s*[^\s,;}]+/gi,
      (match) => {
        const separator = match.match(/\s*[:=]\s*/)?.[0] ?? ': ';
        const key = match.slice(0, match.indexOf(separator)).trim();
        return `${key}${separator}***`;
      },
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***');
}

export function isAiRpcMethod(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}
