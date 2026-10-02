/**
 * V2 平台目录快照契约（D10）。
 *
 * 快照是普通 JSON，可由客户端保存在本机后离线读取。它只含平台公开目录、
 * 价格和可公开核验的官方价格证据，不含上游地址、凭据引用或密钥。
 */
import { z } from 'zod';
import { priceVersionSchema, type PriceVersion } from './billing';
import { providerModelInfoSchema, type ProviderModelInfo } from './provider-model';
import { epochMsSchema, ulidSchema } from './primitives';
import { currencyCodeSchema, microsSchema } from './money';

export const catalogProviderStatusSchema = z.enum(['active', 'maintenance']);

export interface CatalogProvider {
  providerId: string;
  displayName: string;
  protocol: 'openai' | 'anthropic';
  status: z.infer<typeof catalogProviderStatusSchema>;
  statusReason: string | null;
  updatedAt: number;
}

export const catalogProviderSchema = z.object({
  providerId: ulidSchema,
  displayName: z.string().min(1),
  protocol: z.enum(['openai', 'anthropic']),
  status: catalogProviderStatusSchema,
  statusReason: z.string().nullable(),
  updatedAt: epochMsSchema,
});

export interface CatalogModel extends ProviderModelInfo {
  /** 上游要求的模型标识；同名模型可在不同 Provider 独立出现。 */
  upstreamModelName: string;
}

export const catalogModelSchema = providerModelInfoSchema.extend({
  upstreamModelName: z.string().min(1),
});

/** 官方价格是估算依据。目录保留核验版本、条件和有效区间，不猜测别名。 */
export interface OfficialPriceSnapshot {
  snapshotId: string;
  canonicalVendor: string;
  canonicalModel: string;
  billingMode: 'per_million_tokens';
  currency: string;
  rates: PriceVersion['rates'];
  sourceUrl: string;
  verifiedAt: number;
  evidenceVersion: string;
  evidenceSha256: string;
  conditions: string;
  effectiveFrom: number;
  effectiveTo: number | null;
  publishedAt: number;
  version: number;
}

export const officialPriceSnapshotSchema = z
  .object({
    snapshotId: ulidSchema,
    canonicalVendor: z.string().min(1),
    canonicalModel: z.string().min(1),
    billingMode: z.literal('per_million_tokens'),
    currency: currencyCodeSchema,
    rates: z.object({
      uncachedInput: microsSchema.nullable(),
      cacheRead: microsSchema.nullable(),
      cacheWriteByTtl: z.record(microsSchema.nullable()).nullable(),
      output: microsSchema.nullable(),
    }),
    sourceUrl: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === 'https:'),
    verifiedAt: epochMsSchema,
    evidenceVersion: z.string().min(1),
    evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    conditions: z.string().min(1),
    effectiveFrom: epochMsSchema,
    effectiveTo: epochMsSchema.nullable(),
    publishedAt: epochMsSchema,
    version: z.number().int().positive(),
  })
  .refine((value) => value.effectiveTo === null || value.effectiveTo > value.effectiveFrom);

export interface PlatformCatalogSnapshot {
  schemaVersion: 1;
  generatedAt: number;
  providers: CatalogProvider[];
  models: CatalogModel[];
  platformPrices: PriceVersion[];
  officialPrices: OfficialPriceSnapshot[];
}

export const platformCatalogSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: epochMsSchema,
  providers: z.array(catalogProviderSchema),
  models: z.array(catalogModelSchema),
  platformPrices: z.array(priceVersionSchema),
  officialPrices: z.array(officialPriceSnapshotSchema),
});

/** 解析从本机文件/设置存储读取的目录 JSON；格式不明或损坏时返回 null。 */
export function parsePlatformCatalogSnapshot(value: unknown): PlatformCatalogSnapshot | null {
  let input = value;
  if (typeof value === 'string') {
    try {
      input = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = platformCatalogSnapshotSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * 解析目录快照中某一确切 Provider+Model 路由的适用价格。
 *
 * 平台价优先；只有没有匹配时，才以完全相等的 canonical 身份查官网快照。
 * 平台版本中的 null 桶不会从官网价混入，0 仍是明确免费价。
 */
export function resolveCatalogPrice(
  snapshot: PlatformCatalogSnapshot,
  route: { providerId: string; modelId: string },
  at: number,
): PriceVersion | null {
  const model = snapshot.models.find(
    (item) => item.providerId === route.providerId && item.modelId === route.modelId,
  );
  if (!model || !snapshot.providers.some((item) => item.providerId === route.providerId)) {
    return null;
  }

  const activeAt = (from: number, to: number | null): boolean =>
    from <= at && (to === null || at < to);
  const platform = snapshot.platformPrices
    .filter(
      (price) =>
        price.providerModelKey === `${route.providerId}/${route.modelId}` &&
        activeAt(price.effectiveFrom, price.effectiveTo),
    )
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
  if (platform) return platform;

  if (model.canonicalVendor === null || model.canonicalModel === null) return null;
  const official = snapshot.officialPrices
    .filter(
      (price) =>
        price.canonicalVendor === model.canonicalVendor &&
        price.canonicalModel === model.canonicalModel &&
        activeAt(price.effectiveFrom, price.effectiveTo),
    )
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
  if (!official) return null;

  return {
    priceVersionId: official.snapshotId,
    providerModelKey: `${route.providerId}/${route.modelId}`,
    billingMode: official.billingMode,
    currency: official.currency,
    rates: official.rates,
    cacheWriteRateSemantics: 'full_rate',
    source: {
      kind: 'official_vendor',
      evidenceUrl: official.sourceUrl,
      verifiedAt: official.verifiedAt,
    },
    effectiveFrom: official.effectiveFrom,
    effectiveTo: official.effectiveTo,
    publishedAt: official.publishedAt,
    version: official.version,
  };
}
