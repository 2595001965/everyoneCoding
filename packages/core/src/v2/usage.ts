/**
 * V2 公共契约 —— 用量标准化与尝试记录（V2-T01；PRD §9.1、V2-USG-*、V2-BILL-09）。
 *
 * 现状（T01 核验）：@ec/ai `Usage { promptTokens, completionTokens, totalTokens }`
 * 把 Anthropic 缓存读/写并入 prompt，无推理 token、无 attempt/logicalRequest 粒度、
 * 金额为 REAL。本契约定义 V2 目标口径（T11 落地改造）：
 *
 * - 一次用户动作 = logicalRequestId；一次真实上游调用 = attemptId；重试/容灾必然新 attempt
 * - 规范化 usage 的各输入分类**互斥**：totalInput = uncachedInput + cacheReadInput + ΣcacheWrite
 *   - 上游 input 已含缓存时：拆分，不得再加一遍（"缓存 Token 加两遍"是验收红线）
 *   - 上游 input 不含缓存时：补齐 totalInput
 * - 未知字段一律 null + usageSource 标记；**chunk 数不是 token**；最终 usage 替换估算而非追加
 * - 推理 token 若已含在 totalOutput 中只能细分展示（reasoningOutput ≤ totalOutput），不二次收费
 */
import { z } from 'zod';
import { epochMsSchema, opaqueIdSchema, revisionSchema, ulidSchema } from './primitives';

/** 缓存写 TTL 分桶键（如 Anthropic 的 `5m` / `1h`；未知 TTL 用上游原样标记） */
export const cacheTtlBucketSchema = z.string().min(1).max(32);
export type CacheTtlBucket = string;

/** usage 数据质量：进 UI 与账务前必须可见 */
export const usageQualitySchema = z.enum([
  /** 上游最终 usage（可信） */
  'upstream_final',
  /** 流式过程中的估算（会被最终值替换） */
  'stream_estimate',
  /** 发送前按上下文预估（仅用于预占/告警，不是消耗） */
  'context_estimate',
  /** 无法归类 */
  'unknown',
]);
export type UsageQuality = z.infer<typeof usageQualitySchema>;

/**
 * 规范化 usage。全部数值字段 `null = 未知`，**禁止以 0 冒充未知**；
 * cacheWriteInputByTtl 为 null 表示协议未上报任何分桶（≠ 空桶集合）。
 */
export interface NormalizedUsage {
  /** 该协议报告的总输入（含缓存部分，若协议如此报告） */
  totalInput: number | null;
  /** 未命中缓存的输入 */
  uncachedInput: number | null;
  /** 缓存读输入 */
  cacheReadInput: number | null;
  /** 缓存写输入，按 TTL 分桶 */
  cacheWriteInputByTtl: Record<string, number> | null;
  /** 总输出（若含推理 token，reasoningOutput 是其子集） */
  totalOutput: number | null;
  /** 推理输出子集（≤ totalOutput；只细分展示，不另收费） */
  reasoningOutput: number | null;
  quality: UsageQuality;
}

export const normalizedUsageSchema = z.object({
  totalInput: z.number().int().nonnegative().nullable(),
  uncachedInput: z.number().int().nonnegative().nullable(),
  cacheReadInput: z.number().int().nonnegative().nullable(),
  cacheWriteInputByTtl: z.record(z.number().int().nonnegative()).nullable(),
  totalOutput: z.number().int().nonnegative().nullable(),
  reasoningOutput: z.number().int().nonnegative().nullable(),
  quality: usageQualitySchema,
});

/** 协议原始 usage 的标准化输入描述（各协议适配器负责映射，T11 实现） */
export interface ProtocolUsageReport {
  /** 协议的 input 字段是否已包含缓存读/写 token（Anthropic 是，OpenAI 否） */
  inputIncludesCache: boolean;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokensByTtl: Record<string, number> | null;
  outputTokens: number | null;
  /** 推理 token 是否已包含在 outputTokens 内（多数协议是） */
  reasoningTokensIncludedInOutput: boolean;
  reasoningTokens: number | null;
}

const sumRecord = (record: Record<string, number> | null): number => {
  if (!record) return 0;
  let sum = 0;
  for (const v of Object.values(record)) sum += v;
  return sum;
};

/**
 * 协议 usage → 规范化 usage（纯函数）。
 *
 * - inputIncludesCache=true：totalInput = inputTokens；uncached = total − cacheRead − ΣcacheWrite
 *   （拆分项未知则 uncached 为 null，total 保持不动，不猜）
 * - inputIncludesCache=false：uncachedInput = inputTokens；totalInput = input + cacheRead + ΣcacheWrite
 *   （input 缺失时 total 仍可由缓存项单独给出？不——缺主项即 null，宁缺勿错）
 * - reasoningOutput 仅在"已含于输出"时记录子集；独立上报且未含于输出时并入 totalOutput
 *   由适配器决定，本函数只做标记传递
 */
export function normalizeProtocolUsage(report: ProtocolUsageReport): NormalizedUsage {
  const cacheWriteSum = sumRecord(report.cacheWriteTokensByTtl);
  let totalInput: number | null;
  let uncachedInput: number | null;
  if (report.inputIncludesCache) {
    // input 已含缓存：拆分。总量保持上游原值；拆分项任一未知则不猜 uncached
    totalInput = report.inputTokens;
    uncachedInput =
      report.inputTokens !== null && report.cacheReadTokens !== null
        ? report.inputTokens - report.cacheReadTokens - cacheWriteSum
        : null;
  } else {
    // input 不含缓存：补齐总量。cacheRead/分桶为 null 视为"协议无此维度"（贡献 0）；
    // 适配器若遇"有维度但值缺失"，必须改走 inputIncludesCache=true 路径或保留未知
    uncachedInput = report.inputTokens;
    totalInput =
      report.inputTokens !== null
        ? report.inputTokens + (report.cacheReadTokens ?? 0) + cacheWriteSum
        : null;
  }
  const totalOutput = report.outputTokens;
  const reasoningOutput =
    report.reasoningTokens !== null && report.reasoningTokensIncludedInOutput
      ? report.reasoningTokens
      : null;
  return {
    totalInput,
    uncachedInput,
    cacheReadInput: report.cacheReadTokens,
    cacheWriteInputByTtl: report.cacheWriteTokensByTtl,
    totalOutput,
    reasoningOutput,
    quality: 'upstream_final',
  };
}

/** 缓存命中率：要么可计算，要么明确不可用——不产虚假 0%（V2-USG-03） */
export type CacheHitRate =
  | { kind: 'measured'; numerator: number; denominator: number; value: number }
  | {
      kind: 'not_applicable';
      reason: 'no_cache_data' | 'zero_input' | 'unknown_input_total';
    };

/**
 * cacheHitRate = cacheReadInput / totalInput（分母含缓存读写，互斥口径见文件头）。
 * - cacheRead 未知 → no_cache_data（显示 N/A，不是 0%）
 * - totalInput 未知 → unknown_input_total
 * - totalInput = 0（协议明确报告）→ zero_input
 */
export function cacheHitRateOf(usage: NormalizedUsage): CacheHitRate {
  if (usage.cacheReadInput === null) return { kind: 'not_applicable', reason: 'no_cache_data' };
  if (usage.totalInput === null) return { kind: 'not_applicable', reason: 'unknown_input_total' };
  if (usage.totalInput === 0) return { kind: 'not_applicable', reason: 'zero_input' };
  return {
    kind: 'measured',
    numerator: usage.cacheReadInput,
    denominator: usage.totalInput,
    value: usage.cacheReadInput / usage.totalInput,
  };
}

/** 计入消耗的 token 总数 = totalInput + totalOutput；任一未知即 null（不猜测，PRD §9.3 公式） */
export function consumedTokensOf(usage: NormalizedUsage): number | null {
  if (usage.totalInput === null || usage.totalOutput === null) return null;
  return usage.totalInput + usage.totalOutput;
}

/** 同一 attempt 的事件/更正只能把估算替换为最终值（V2-USG-07），不允许两份并存 */
export function replaceEstimateWithFinal(
  current: NormalizedUsage,
  final: NormalizedUsage,
): NormalizedUsage {
  return final.quality === 'upstream_final'
    ? { ...final }
    : /** 非最终值不允许走替换通道 */
      current;
}

/* --------------------------- UsageAttempt 实体 --------------------------- */

export const attemptStatusSchema = z.enum([
  'pending',
  'streaming',
  'succeeded',
  'failed',
  'cancelled',
  /** 上游可能已执行但结果未知：待对账，不得当免费或自动重发（PRD §9.4） */
  'unknown_pending_reconciliation',
]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

/**
 * 一次真实上游调用的计量记录。
 * 存储现状：现有 usage_record 无 attempt/logicalRequest 维度（T01 核验），
 * 本实体为 V2 目标结构，落库由 T11 迁移追加（新增表，不改历史表语义）。
 */
export interface UsageAttempt {
  attemptId: string;
  /** 用户动作级关联 ID（同一动作的多次尝试共享） */
  logicalRequestId: string;
  /** 上游返回的请求 ID（若有） */
  providerRequestId: string | null;
  /** 实际路由（providerModelKeyOf 产物；容灾切换后 = 实际命中的路由，非用户所选） */
  route: string;
  sessionId: string | null;
  taskId: string | null;
  projectId: string | null;
  /** 用途字符串（对齐 @ec/ai AiPurpose；core 不反向依赖 ai 包） */
  purpose: string | null;
  startedAt: number;
  endedAt: number | null;
  status: AttemptStatus;
  /** 本 attempt 的 usage 来源 */
  usageSource: UsageQuality;
  /** 协议原始 usage（不解释、不脱敏结构；仅排除密钥字段） */
  rawUsage: unknown | null;
  /** 规范化 usage；未知整体为 null */
  normalized: NormalizedUsage | null;
  /** 受理时固定的价格快照引用（priceVersionId；见 billing.ts） */
  priceSnapshotRef: string | null;
  revision: number;
}

export const usageAttemptSchema = z
  .object({
    attemptId: ulidSchema,
    logicalRequestId: opaqueIdSchema,
    providerRequestId: z.string().min(1).nullable(),
    route: z
      .string()
      .regex(
        /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}\/[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/,
        '路由必须是 providerModelKey（{providerId}/{modelId}）',
      ),
    sessionId: opaqueIdSchema.nullable(),
    taskId: opaqueIdSchema.nullable(),
    projectId: opaqueIdSchema.nullable(),
    purpose: z.string().min(1).nullable(),
    startedAt: epochMsSchema,
    endedAt: epochMsSchema.nullable(),
    status: attemptStatusSchema,
    usageSource: usageQualitySchema,
    rawUsage: z.unknown().nullable(),
    normalized: normalizedUsageSchema.nullable(),
    priceSnapshotRef: ulidSchema.nullable(),
    revision: revisionSchema,
  })
  // 结束态必须有 endedAt；进行中态不得有
  .refine(
    (v) =>
      (v.status === 'succeeded' ||
        v.status === 'failed' ||
        v.status === 'cancelled' ||
        v.status === 'unknown_pending_reconciliation') ===
      (v.endedAt !== null),
    '终态 attempt 必须有 endedAt，进行中不得有',
  )
  .refine(
    (v) => v.normalized === null || v.normalized.quality === v.usageSource,
    'usageSource 必须与 normalized.quality 一致',
  );
