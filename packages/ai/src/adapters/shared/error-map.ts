import {
  AuthError,
  ContentFilterError,
  ContextLengthError,
  ProtocolError,
  ProviderUnavailableError,
  RateLimitError,
  TimeoutError,
  type AiError,
  type AiErrorOptions,
} from '../../core/error';

/**
 * HTTP 状态 → 统一错误映射（两协议共用）。
 *
 * 顺序很重要：先按状态码分大类，再用响应体关键词细分。
 * 中转的错误体千奇百怪，关键词匹配失败时保留原样并附脱敏片段。
 */

export interface ErrorMapOptions extends AiErrorOptions {
  /** 响应头（用于解析 Retry-After） */
  headers?: Record<string, string>;
  model?: string;
}

export function mapHttpError(status: number, bodyText: string, options: ErrorMapOptions = {}): AiError {
  const snippet = bodyText.slice(0, 500);
  const lowered = bodyText.toLowerCase();
  const retryAfterMs = parseRetryAfter(options.headers);

  // 与状态码无关的强特征：上下文超限与内容过滤
  if (isContextLength(lowered)) {
    return new ContextLengthError(`上下文超限：${firstMessage(bodyText)}`, extractLimit(bodyText), options);
  }
  if (isContentFilter(lowered)) {
    return new ContentFilterError(`内容被过滤：${firstMessage(bodyText)}`, options);
  }

  switch (true) {
    case status === 401 || status === 403:
      return new AuthError(`认证失败（${status}）：${firstMessage(bodyText)}`, options);
    case status === 402:
      // 余额不足：重试无意义
      return new ProviderUnavailableError(`余额不足或服务未开通（402）：${firstMessage(bodyText)}`, {
        ...options,
        retryable: false,
      });
    case status === 408:
      return new TimeoutError(`请求超时（408）：${firstMessage(bodyText)}`, options);
    case status === 429:
      return new RateLimitError(`请求被限流（429）：${firstMessage(bodyText)}`, retryAfterMs, options);
    case status >= 500:
      return new ProviderUnavailableError(`服务端错误（${status}）：${firstMessage(bodyText)}`, options);
    case status === 404:
      return new ProtocolError(`接口不存在（404）：${firstMessage(bodyText)}，请检查 baseUrl 与协议是否匹配`, {
        ...options,
        snippet,
      });
    case status >= 400:
      return new ProtocolError(`请求被拒绝（${status}）：${firstMessage(bodyText)}`, { ...options, snippet });
    default:
      return new ProtocolError(`非预期状态码 ${status}`, { ...options, snippet });
  }
}

function isContextLength(lowered: string): boolean {
  return (
    lowered.includes('context_length_exceeded') ||
    lowered.includes('maximum context length') ||
    lowered.includes('context window') ||
    lowered.includes('prompt is too long') ||
    lowered.includes('too many tokens') ||
    lowered.includes('input is too long')
  );
}

function isContentFilter(lowered: string): boolean {
  return (
    lowered.includes('content_filter') ||
    lowered.includes('content policy') ||
    lowered.includes('safety') ||
    lowered.includes('blocked by')
  );
}

/** Retry-After 支持秒数与 HTTP 日期两种格式 */
export function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** 从常见错误体里取 human-readable 文案（OpenAI / Anthropic / One API 三种形状） */
export function firstMessage(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const error = record['error'];
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object') {
        const inner = error as Record<string, unknown>;
        const message = inner['message'] ?? inner['msg'] ?? inner['detail'];
        if (typeof message === 'string') return message;
      }
      const message = record['message'] ?? record['msg'] ?? record['detail'];
      if (typeof message === 'string') return message;
    }
  } catch {
    // 非 JSON：直接取前 200 字符
  }
  return bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function extractLimit(bodyText: string): number | undefined {
  const match = /(\d{3,7})\s*(?:tokens|token)/i.exec(bodyText);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}
