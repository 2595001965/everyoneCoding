import {
  computeUsageCost,
  microsFromDecimal,
  type ContextSnapshot,
  type PriceVersion,
  type UsageAttempt,
  type UsageCost,
} from '@ec/core';
import { newUlid } from '@ec/data';
import type { Model } from '../domain/model';
import type { UsagePurpose } from '../domain/purpose-binding';

export interface AttemptContext extends ContextSnapshot {
  safetyMarginTokens: number | null;
  /** 当前发送载荷的快照。下一请求必须根据新载荷重算。 */
  kind: 'sent_estimate' | 'next_request_estimate';
  measuredSentInputTokens: number | null;
}

export interface AttemptMetrics {
  queuedMs: number;
  firstOutputAt: number | null;
  ttftMs: number | null;
  outputTokensPerSecond: number | null;
  averageOutputTokensPerSecond: number | null;
  rateSource: 'estimated' | 'reported' | 'unknown';
  toolExecutionMs: number | null;
}

export interface AttemptPrice {
  snapshotId: string;
  /** 旧模型表的单价只作外部费用估算；不是已核验官方价或平台售价。 */
  origin: 'local_model_capability' | 'configured_price_version';
  price: PriceVersion;
}

/** 草稿试连没有 model 行：route=null，明确保留原因，禁止伪造公共路由。 */
export interface MeteredAttempt extends Omit<UsageAttempt, 'route' | 'purpose'> {
  userId: string;
  providerId: string | null;
  modelRowId: string | null;
  upstreamModelName: string;
  protocol: 'openai' | 'anthropic';
  route: string | null;
  routeUnavailableReason: 'unsaved_draft' | 'missing_model_row' | null;
  purpose: UsagePurpose | string;
  context: AttemptContext;
  metrics: AttemptMetrics;
  priceSnapshot: AttemptPrice | null;
  /** 本地成本估算，与平台实扣独立。 */
  cost: UsageCost | null;
  billingState: 'estimated' | 'unknown_pending_reconciliation';
}

export function capturePrice(
  route: string | null,
  model: Model | null,
  at: number,
  configured?: PriceVersion | null,
): AttemptPrice | null {
  if (!route) return null;
  if (configured) {
    if (
      configured.providerModelKey !== route ||
      configured.effectiveFrom > at ||
      (configured.effectiveTo !== null && at >= configured.effectiveTo)
    ) {
      throw new Error('价格快照不匹配实际路由或调用时间');
    }
    return {
      snapshotId: configured.priceVersionId,
      origin: 'configured_price_version',
      price: JSON.parse(JSON.stringify(configured)) as PriceVersion,
    };
  }
  if (!model) return null;
  const id = newUlid();
  const rate = (value: number | null): number | null => {
    if (value === null || !Number.isFinite(value) || value < 0) return null;
    try {
      return microsFromDecimal('USD', String(value)).micros;
    } catch {
      return null;
    }
  };
  return {
    snapshotId: id,
    origin: 'local_model_capability',
    price: {
      priceVersionId: id,
      providerModelKey: route,
      billingMode: 'per_million_tokens',
      currency: 'USD',
      rates: {
        uncachedInput: rate(model.capability.inputPricePerMTok),
        cacheRead: null,
        cacheWriteByTtl: null,
        output: rate(model.capability.outputPricePerMTok),
      },
      cacheWriteRateSemantics: 'full_rate',
      source: { kind: 'local_model_capability', evidenceUrl: null, verifiedAt: null },
      effectiveFrom: at,
      effectiveTo: null,
      publishedAt: at,
      version: 1,
    },
  };
}

export function costForAttempt(attempt: MeteredAttempt): UsageCost | null {
  const usage = attempt.normalized;
  if (!usage || !attempt.priceSnapshot) return null;
  const cost = computeUsageCost(attempt.priceSnapshot.price, usage);
  // 公共纯函数只计算已知桶；运行时必须另标未知维度，不能误报完整费用。
  const writesUnknown =
    usage.cacheWriteInputByTtl !== null &&
    Object.values(usage.cacheWriteInputByTtl).some((tokens) => tokens > 0) &&
    attempt.priceSnapshot.price.rates.cacheWriteByTtl === null;
  return {
    ...cost,
    complete:
      cost.complete &&
      !writesUnknown &&
      usage.totalInput !== null &&
      usage.totalOutput !== null &&
      usage.uncachedInput !== null &&
      usage.cacheReadInput !== null &&
      usage.cacheWriteInputByTtl !== null,
  };
}
