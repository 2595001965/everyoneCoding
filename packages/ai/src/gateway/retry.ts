import { isAiError } from '../core/error';

/**
 * 重试策略（FR-AI-10 / FR-MDL-10）。
 *
 * 只对这些情况重试：408 / 429 / 5xx 与网络错误。
 * 401 / 402 / 内容过滤 / 上下文超限直接失败 —— 重试只会浪费配额并拖慢反馈。
 * 429 有 Retry-After 时优先遵循服务端建议时长。
 */

export interface RetryPolicy {
  /** 最大重试次数（不含首次请求） */
  maxRetries: number;
  initialDelayMs: number;
  multiplier: number;
  /** 抖动比例 0~1，默认 0.2（±20%） */
  jitterRatio: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 500,
  multiplier: 2,
  jitterRatio: 0.2,
  maxDelayMs: 30_000,
};

/** 是否值得重试 */
export function shouldRetry(error: unknown): boolean {
  if (!isAiError(error)) return false;
  return error.retryable;
}

/**
 * 计算第 attempt 次（从 1 开始）重试前的等待毫秒数。
 * 含 ±20% 抖动，避免多个请求同时重试造成惊群。
 */
export function delayFor(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, retryAfterMs?: number, random: () => number = Math.random): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(policy.maxDelayMs, retryAfterMs + Math.round(retryAfterMs * policy.jitterRatio * random()));
  }
  const base = policy.initialDelayMs * Math.pow(policy.multiplier, Math.max(0, attempt - 1));
  const jitter = base * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(base + jitter)));
}

export interface RetryHooks {
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  hooks: RetryHooks = {},
): Promise<T> {
  const sleep = hooks.sleep ?? defaultSleep;
  const gate = hooks.shouldRetry ?? shouldRetry;

  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === policy.maxRetries || !gate(error)) break;
      const retryAfter = isAiError(error) && 'retryAfterMs' in error ? (error as { retryAfterMs?: number }).retryAfterMs : undefined;
      const delayMs = delayFor(attempt + 1, policy, retryAfter ?? undefined);
      hooks.onRetry?.({
        attempt: attempt + 1,
        delayMs,
        reason: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
