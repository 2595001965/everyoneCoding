import { mask } from '@ec/core';

/**
 * AI 层统一错误模型（对齐 PRD §13.3）。
 *
 * 设计要点：
 * - 两类协议的适配器必须抛同一套错误类型，上层只按 kind 分支
 * - 每类错误自带 `userMessage`（中文可直接展示）与 `action`（可操作建议）
 * - `retryable` 决定 Gateway 是否重试；上层不得自行判断
 * - 任何携带服务端返回片段的错误都必须先脱敏（NFR-S-04），明文 Key 永不进入错误
 */

/** PRD §13.3 定义的七类错误（AI_ERROR_KINDS 与之逐条对应） */
export type AiErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'context_length'
  | 'content_filter'
  | 'protocol'
  | 'provider_unavailable'
  /** 用户主动中断：不属于失败，仅用于流程标记 */
  | 'aborted';

export const AI_ERROR_KINDS: readonly AiErrorKind[] = [
  'auth',
  'rate_limit',
  'timeout',
  'context_length',
  'content_filter',
  'protocol',
  'provider_unavailable',
];

export interface AiErrorOptions {
  /** 服务端返回片段（自动脱敏 + 截断） */
  snippet?: string;
  status?: number;
  providerId?: string;
  modelId?: string;
  cause?: unknown;
}

export abstract class AiError extends Error {
  abstract readonly kind: AiErrorKind;
  abstract readonly userMessage: string;
  abstract readonly action: string;

  readonly retryable: boolean;
  readonly status?: number | undefined;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  /** 已脱敏的返回片段，便于排查协议差异 */
  readonly snippet?: string | undefined;

  constructor(message: string, retryable: boolean, options: AiErrorOptions = {}) {
    super(mask(message));
    this.name = new.target.name;
    this.retryable = retryable;
    this.status = options.status;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.snippet = options.snippet === undefined ? undefined : AiError.sanitize(options.snippet);
    // 不保留底层 cause：非枚举字段同样可能被日志器打印并泄漏请求凭据。
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** 返回片段脱敏 + 截断，避免整包响应进入日志与 UI */
  private static sanitize(snippet: string): string {
    const collapsed = snippet.replace(/\s+/g, ' ').trim();
    return mask(collapsed).slice(0, 500);
  }

  /** 结构化序列化（日志与 IPC 传输用，不含调用栈） */
  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      name: this.name,
      message: this.message,
      userMessage: this.userMessage,
      action: this.action,
      retryable: this.retryable,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.providerId !== undefined ? { providerId: this.providerId } : {}),
      ...(this.modelId !== undefined ? { modelId: this.modelId } : {}),
      ...(this.snippet !== undefined ? { snippet: this.snippet } : {}),
    };
  }
}

/** 401 / 403：Key 无效或权限不足 */
export class AuthError extends AiError {
  override readonly kind = 'auth';
  override readonly userMessage = 'API Key 无效或没有访问该模型的权限。';
  override readonly action =
    '请在「设置 → 模型服务」中检查 Key 是否正确，或重新粘贴后再次连接测试。';

  constructor(message = '认证失败', options: AiErrorOptions = {}) {
    super(message, false, options);
  }
}

/** 429：限流；含服务端建议的等待时间 */
export class RateLimitError extends AiError {
  override readonly kind = 'rate_limit';
  override readonly userMessage = '模型服务返回限流（429）。';
  override readonly action = '请求已排队，稍后自动重试；若持续出现请降低并发或联系中转服务商提额。';

  /** 服务端建议等待毫秒数（Retry-After），未给出时为 undefined */
  readonly retryAfterMs: number | undefined;

  constructor(message = '请求被限流', retryAfterMs?: number, options: AiErrorOptions = {}) {
    super(message, true, options);
    this.retryAfterMs = retryAfterMs;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

/** 408 / 连接超时 / 读超时 */
export class TimeoutError extends AiError {
  override readonly kind = 'timeout';
  override readonly userMessage = '请求超时，模型服务未在限定时间内响应。';
  override readonly action = '可适当调大该 Provider 的超时时间；若仍超时请检查网络或代理设置。';

  constructor(message = '请求超时', options: AiErrorOptions = {}) {
    super(message, true, options);
  }
}

/** 上下文长度超限：上层应触发裁剪后重试 */
export class ContextLengthError extends AiError {
  override readonly kind = 'context_length';
  override readonly userMessage = '输入内容超出该模型的上下文长度。';
  override readonly action = '请精简上下文（关闭部分记忆或减少选中元素），或改用上下文更长的模型。';

  /** 服务端返回的上下文上限（若给出） */
  readonly limit: number | undefined;

  constructor(message = '上下文长度超限', limit?: number, options: AiErrorOptions = {}) {
    super(message, false, options);
    this.limit = limit;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), ...(this.limit !== undefined ? { limit: this.limit } : {}) };
  }
}

/** 内容被安全策略拦截 */
export class ContentFilterError extends AiError {
  override readonly kind = 'content_filter';
  override readonly userMessage = '生成内容被模型服务的安全策略拦截。';
  override readonly action = '请修改提示词后重试；若误判可更换模型。';

  constructor(message = '内容被安全策略拦截', options: AiErrorOptions = {}) {
    super(message, false, options);
  }
}

/** 返回结构与协议不符（常见于非标准中转） */
export class ProtocolError extends AiError {
  override readonly kind = 'protocol';
  override readonly userMessage = '模型服务返回的数据格式不符合预期。';
  override readonly action =
    '请确认该中转的协议（OpenAI 兼容 / Anthropic 兼容）与 baseUrl 是否匹配，或改用手动填写模型列表。';

  constructor(message = '返回格式不符合协议', options: AiErrorOptions = {}) {
    super(message, false, options);
  }
}

/** 5xx / 402（余额不足）/ 网络不可达 */
export class ProviderUnavailableError extends AiError {
  override readonly kind = 'provider_unavailable';
  override readonly userMessage = '模型服务当前不可用。';
  override readonly action = '若为余额不足请充值；否则请稍后重试或切换到备用 Provider。';

  constructor(message = '模型服务不可用', options: AiErrorOptions & { retryable?: boolean } = {}) {
    super(message, options.retryable ?? true, options);
  }
}

/** 用户主动中断：不作为失败统计，也不触发重试 */
export class AbortedError extends AiError {
  override readonly kind = 'aborted';
  override readonly userMessage = '已停止生成。';
  override readonly action = '已保留中断前生成的内容，可继续或重新生成。';

  constructor(message = '请求已中断', options: AiErrorOptions = {}) {
    super(message, false, options);
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}

/** 从未知异常包装为 AI 错误：中断 / 超时 / 网络 / 其余归协议错误 */
export function toAiError(error: unknown, context: AiErrorOptions = {}): AiError {
  if (isAiError(error)) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new AbortedError('请求被中断', context);
  }
  const raw = error instanceof Error ? error.message : String(error);
  const lowered = raw.toLowerCase();
  if (
    /timed out|timeout|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up/.test(
      lowered,
    )
  ) {
    return new TimeoutError(`网络请求失败：${raw}`, context);
  }
  if (/fetch failed|network|unreachable|dns/.test(lowered)) {
    return new ProviderUnavailableError(`网络不可达：${raw}`, context);
  }
  return new ProtocolError(`未预期的错误：${raw}`, context);
}
