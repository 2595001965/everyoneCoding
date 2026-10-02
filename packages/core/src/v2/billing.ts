/**
 * V2 公共契约 —— 价格版本与账务载荷（V2-T01；PRD §9.2/§9.3/§9.4、V2-BILL-*）。
 *
 * 现状（T01 核验）：现有成本是"每百万 token 美元单价 × REAL 浮点"，
 * 无价格版本、无生效期、无平台账本。本契约固化：
 *
 * - 价格来源优先级（PRD §9.2）：平台发布价 > 官方厂商价 > 价格未知（禁止按 0 或跨渠道代用）
 * - `rates` 中 0 是合法免费价，null 是未定价——两者在契约层绝不混淆（V2-E2E-15）
 * - 缓存写费率语义固定为 `full_rate`（该桶完整费率，PRD §9.3 明确公式口径）
 * - 金额定点微单位（见 money.ts）；费用计算全整数运算，分项之和恒等于总额
 *
 * 边界：本文件只定义契约与纯函数。钱包/账本/结算的服务端实现由 T18 在
 * services 侧**拟新增**领域落地；T01 不建任何数据库迁移。
 */
import { z } from 'zod';
import { epochMsSchema, ulidSchema } from './primitives';
import {
  currencyCodeSchema,
  microsSchema,
  MICROS_PER_UNIT,
  type CurrencyCode,
  type Micros,
} from './money';
import { type NormalizedUsage } from './usage';

export const billingModeSchema = z.enum(['per_million_tokens']);
export type BillingMode = z.infer<typeof billingModeSchema>;

/**
 * 价格来源（V2-BILL-01/02）。
 * - platform_published：服务端发布且匹配该 Provider+Model 的有效售价
 * - official_vendor：厂商官网价（必须留证据 URL + 核验时间；仅估算依据，
 *   用于平台实扣前必须由服务端发布可结算快照）
 * - local_model_capability：用户本地模型能力表中的旧单价快照；不是官方价或平台价
 */
export const priceSourceSchema = z.object({
  kind: z.enum(['platform_published', 'official_vendor', 'local_model_capability']),
  evidenceUrl: z.string().url().nullable(),
  verifiedAt: epochMsSchema.nullable(),
});

/** 各桶费率：微单位 / 每百万 token。null = 该维度未定价（不按 0 处理） */
export interface PriceRates {
  uncachedInput: Micros | null;
  cacheRead: Micros | null;
  /** 键为 TTL 分桶（见 usage.ts cacheTtlBucketSchema）；值可为 null = 该分桶未定价 */
  cacheWriteByTtl: Record<string, Micros | null> | null;
  output: Micros | null;
}

/**
 * 不可变价格版本。发布后不得修改（调价 = 发布新版本 + 生效时间），
 * 在途请求按受理时快照结算（V2-BILL-03），历史账单不重算。
 */
export interface PriceVersion {
  priceVersionId: string;
  /** 路由键（providerModelKeyOf 产物）——价格绑定复合路由，不绑模型名 */
  providerModelKey: string;
  billingMode: BillingMode;
  currency: CurrencyCode;
  rates: PriceRates;
  /** 缓存写费率语义；P0 固定 full_rate（完整费率），加价模式待后续显式扩展 */
  cacheWriteRateSemantics: 'full_rate';
  source: z.infer<typeof priceSourceSchema>;
  effectiveFrom: number;
  /** null = 一直有效至新版本生效 */
  effectiveTo: number | null;
  publishedAt: number;
  /** 单调版本号（同路由内递增） */
  version: number;
}

export const priceVersionSchema = z
  .object({
    priceVersionId: ulidSchema,
    providerModelKey: z.string(),
    billingMode: billingModeSchema,
    currency: currencyCodeSchema,
    rates: z.object({
      uncachedInput: microsSchema.nullable(),
      cacheRead: microsSchema.nullable(),
      cacheWriteByTtl: z.record(microsSchema.nullable()).nullable(),
      output: microsSchema.nullable(),
    }),
    cacheWriteRateSemantics: z.literal('full_rate'),
    source: priceSourceSchema,
    effectiveFrom: epochMsSchema,
    effectiveTo: epochMsSchema.nullable(),
    publishedAt: epochMsSchema,
    version: z.number().int().positive(),
  })
  .refine(
    (v) => v.effectiveTo === null || v.effectiveTo > v.effectiveFrom,
    'effectiveTo 必须晚于 effectiveFrom',
  );

export type PriceBucket = 'uncachedInput' | 'cacheRead' | 'output' | `cacheWrite:${string}`;

/** 列出未定价的桶（null 项）；空数组 = 全定价（0 元的免费价也算已定价） */
export function missingRateBuckets(pv: PriceVersion): PriceBucket[] {
  const missing: PriceBucket[] = [];
  if (pv.rates.uncachedInput === null) missing.push('uncachedInput');
  if (pv.rates.cacheRead === null) missing.push('cacheRead');
  if (pv.rates.output === null) missing.push('output');
  if (pv.rates.cacheWriteByTtl !== null) {
    for (const ttl of Object.keys(pv.rates.cacheWriteByTtl)) {
      if (pv.rates.cacheWriteByTtl[ttl] === null) missing.push(`cacheWrite:${ttl}`);
    }
  }
  return missing;
}

export interface CostLineItem {
  bucket: PriceBucket;
  tokens: number;
  /** 微单位/百万 token 费率 */
  rateMicrosPerMTok: Micros;
  /** 本行金额（微单位，整数四舍五入到微单位） */
  micros: Micros;
}

export interface UsageCost {
  lineItems: CostLineItem[];
  /** 各分项之和（整数加法，恒等于 ΣlineItems.micros；complete=false 时仅含可计价分项） */
  total: { currency: CurrencyCode; micros: Micros };
  /** false 表示存在"有用量但未定价"的桶（费用未知/部分估算，V2-BILL-01） */
  complete: boolean;
  /** 有 token 消耗但未定价的桶（与 missingRateBuckets 的区别：只列实际发生用量的） */
  unpricedUsedBuckets: PriceBucket[];
}

/** tokens × rateMicros/1e6 的整数四舍五入（half-up），无浮点参与 */
function tokensTimesRate(tokens: number, rateMicros: Micros): Micros {
  const numerator = tokens * rateMicros;
  const quotient = Math.floor(numerator / MICROS_PER_UNIT);
  const remainder = numerator - quotient * MICROS_PER_UNIT;
  return remainder * 2 >= MICROS_PER_UNIT ? quotient + 1 : quotient;
}

/**
 * PRD §9.3 公式的契约实现：
 *   inputTotal = uncachedInput + cacheReadInput + ΣcacheWriteInputByTTL
 *   cost = Σ(分桶 tokens × 该桶费率) / 1,000,000（逐分项四舍五入到微单位）
 *
 * 规则：
 * - 未知（null）用量的桶不产生分项；若有用量但费率未定价 → complete=false，
 *   绝不按 0 计入总额
 * - 推理 token 已含在 totalOutput 内，不重复计价
 * - 0 费率（免费价）正常产出 0 金额分项——免费与未知在此分道
 */
export function computeUsageCost(pv: PriceVersion, usage: NormalizedUsage): UsageCost {
  if (pv.billingMode !== 'per_million_tokens') {
    throw new Error(`暂不支持的计费模式：${pv.billingMode}`);
  }
  const lineItems: CostLineItem[] = [];
  const unpricedUsedBuckets: PriceBucket[] = [];
  const pushLine = (bucket: PriceBucket, tokens: number | null, rate: Micros | null): void => {
    if (tokens === null || tokens === 0) return;
    if (rate === null) {
      unpricedUsedBuckets.push(bucket);
      return;
    }
    lineItems.push({
      bucket,
      tokens,
      rateMicrosPerMTok: rate,
      micros: tokensTimesRate(tokens, rate),
    });
  };
  pushLine('uncachedInput', usage.uncachedInput, pv.rates.uncachedInput);
  pushLine('cacheRead', usage.cacheReadInput, pv.rates.cacheRead);
  if (usage.cacheWriteInputByTtl !== null && pv.rates.cacheWriteByTtl !== null) {
    for (const [ttl, tokens] of Object.entries(usage.cacheWriteInputByTtl)) {
      pushLine(`cacheWrite:${ttl}`, tokens, pv.rates.cacheWriteByTtl[ttl] ?? null);
    }
  }
  pushLine('output', usage.totalOutput, pv.rates.output);
  let totalMicros = 0;
  for (const line of lineItems) totalMicros += line.micros;
  return {
    lineItems,
    total: { currency: pv.currency, micros: totalMicros },
    complete: unpricedUsedBuckets.length === 0,
    unpricedUsedBuckets,
  };
}

/* --------------------------- 平台账务载荷（拟新增） --------------------------- */

/**
 * 钱包快照（服务端 T18 领域；客户端只读展示）。
 * available = posted - held 是账本不变量（PRD §9.3），schema 层强制。
 */
export interface WalletSnapshot {
  accountId: string;
  currency: CurrencyCode;
  postedMicros: Micros;
  heldMicros: Micros;
  availableMicros: Micros;
  /** 快照时间；展示余额时效（PRD §2.3.5） */
  asOf: number;
  /** true = 快照过期（平台失联等），UI 不得当作实时余额 */
  stale: boolean;
}

export const walletSnapshotSchema = z
  .object({
    accountId: z.string().min(1),
    currency: currencyCodeSchema,
    postedMicros: microsSchema,
    heldMicros: microsSchema,
    availableMicros: microsSchema,
    asOf: epochMsSchema,
    stale: z.boolean(),
  })
  .refine(
    (v) => v.availableMicros === v.postedMicros - v.heldMicros,
    '账本不变量被破坏：available 必须等于 posted - held',
  );

/** 预占记录（同事务检查余额后创建；释放/结算/冲正走不可变流水，T18 实现） */
export interface WalletHold {
  holdId: string;
  accountId: string;
  currency: CurrencyCode;
  amountMicros: Micros;
  /** 预占原因；运行时枚举见 walletHoldSchema */
  reason: 'request_estimate' | 'admin';
  /** 关联的逻辑请求（幂等键的另一侧） */
  requestId: string | null;
  createdAt: number;
  releasedAt: number | null;
}

export const walletHoldSchema = z.object({
  holdId: ulidSchema,
  accountId: z.string().min(1),
  currency: currencyCodeSchema,
  amountMicros: microsSchema,
  reason: z.enum(['request_estimate', 'admin']),
  requestId: z.string().min(1).nullable(),
  createdAt: epochMsSchema,
  releasedAt: epochMsSchema.nullable(),
});

/** 账本流水引用（不可变；修正走冲正/调整，不改历史行，PRD §9.4） */
export interface LedgerEntryRef {
  entryId: string;
  accountId: string;
  currency: CurrencyCode;
  direction: 'debit' | 'credit' | 'adjustment';
  amountMicros: Micros;
  /** 幂等键；与请求内容绑定，重复提交拒绝（V2-BILL-05） */
  idempotencyKey: string;
  usageAttemptId: string | null;
  /** 人工调整必须带原因（V2-WEB-05） */
  reason: string | null;
  createdAt: number;
}

export const ledgerEntryRefSchema = z
  .object({
    entryId: ulidSchema,
    accountId: z.string().min(1),
    currency: currencyCodeSchema,
    direction: z.enum(['debit', 'credit', 'adjustment']),
    amountMicros: microsSchema,
    idempotencyKey: z.string().min(1),
    usageAttemptId: ulidSchema.nullable(),
    reason: z.string().min(1).nullable(),
    createdAt: epochMsSchema,
  })
  .refine(
    (v) => !(v.direction === 'adjustment' && v.reason === null),
    '调整流水必须携带原因（审计要求）',
  );
