/** 平台公开目录、服务端管理 API 与不可变价格/官网证据发布。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  currencyCodeSchema,
  epochMsSchema,
  microsSchema,
  providerModelRouteSchema,
  type PriceRates,
} from '@ec/core';
import { AppError, ErrCode } from '../errors.ts';
import { requirePlatformAdmin } from '../auth-tokens.ts';
import { writeAudit } from '../logger.ts';
import {
  PlatformCatalogDb,
  type ModelWrite,
  type OfficialPriceWrite,
  type PriceWrite,
  type ProviderWrite,
} from '../models/platform-catalog.ts';

const ratesSchema = z
  .object({
    uncachedInput: microsSchema.gte(0).nullable(),
    cacheRead: microsSchema.gte(0).nullable(),
    cacheWriteByTtl: z.record(microsSchema.gte(0).nullable()).nullable(),
    output: microsSchema.gte(0).nullable(),
  })
  .strict();

const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:');

const providerIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const paramsSchema = z.object({ providerId: providerIdSchema, modelId: providerIdSchema });
const patchCredentialRefSchema = z
  .string()
  .regex(/^(env:[A-Z][A-Z0-9_]{0,127}|secret:\/\/[A-Za-z0-9_./-]{1,240})$/)
  .nullable();

const providerCreateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    protocol: z.enum(['openai', 'anthropic']),
    baseUrl: httpsUrlSchema,
    credentialRef: patchCredentialRefSchema.optional().default(null),
    status: z.enum(['active', 'maintenance', 'disabled']).default('active'),
    statusReason: z.string().trim().max(500).nullable().optional().default(null),
  })
  .strict()
  .refine((value) => value.status !== 'active' || value.credentialRef !== null);

const providerPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    protocol: z.enum(['openai', 'anthropic']).optional(),
    baseUrl: httpsUrlSchema.optional(),
    credentialRef: patchCredentialRefSchema.optional(),
    status: z.enum(['active', 'maintenance', 'disabled']).optional(),
    statusReason: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

const modelCreateSchema = z
  .object({
    upstreamModelName: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(120),
    canonicalVendor: z.string().trim().min(1).max(120).nullable().optional().default(null),
    canonicalModel: z.string().trim().min(1).max(200).nullable().optional().default(null),
    contextWindowTokens: z.number().int().positive().nullable().optional().default(null),
    contextWindowSource: z
      .enum(['measured', 'reported', 'estimated', 'inferred', 'unknown'])
      .nullable()
      .optional()
      .default(null),
    capabilities: z
      .array(z.string().trim().min(1).max(80))
      .max(100)
      .nullable()
      .optional()
      .default(null),
    status: z.enum(['active', 'disabled']).default('active'),
  })
  .strict()
  .refine((value) => (value.canonicalVendor === null) === (value.canonicalModel === null))
  .refine((value) => (value.contextWindowTokens === null) === (value.contextWindowSource === null));

const modelPatchSchema = z
  .object({
    upstreamModelName: z.string().trim().min(1).max(200).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    canonicalVendor: z.string().trim().min(1).max(120).nullable().optional(),
    canonicalModel: z.string().trim().min(1).max(200).nullable().optional(),
    contextWindowTokens: z.number().int().positive().nullable().optional(),
    contextWindowSource: z
      .enum(['measured', 'reported', 'estimated', 'inferred', 'unknown'])
      .nullable()
      .optional(),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(100).nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0)
  .refine((value) => (value.canonicalVendor === undefined) === (value.canonicalModel === undefined))
  .refine((value) => (value.canonicalVendor === null) === (value.canonicalModel === null))
  .refine(
    (value) =>
      (value.contextWindowTokens === undefined) === (value.contextWindowSource === undefined),
  )
  .refine((value) => (value.contextWindowTokens === null) === (value.contextWindowSource === null));

const priceWriteSchema = z
  .object({
    currency: currencyCodeSchema,
    rates: ratesSchema,
    sourceUrl: httpsUrlSchema.nullable().optional().default(null),
    verifiedAt: epochMsSchema.nullable().optional().default(null),
    effectiveFrom: epochMsSchema,
  })
  .strict()
  .refine((value) => (value.sourceUrl === null) === (value.verifiedAt === null))
  .refine((value) => value.verifiedAt === null || value.verifiedAt <= value.effectiveFrom)
  .refine((value) => value.verifiedAt === null || value.verifiedAt <= Date.now());

const officialPriceSchema = z
  .object({
    canonicalVendor: z.string().trim().min(1).max(120),
    canonicalModel: z.string().trim().min(1).max(200),
    currency: currencyCodeSchema,
    rates: ratesSchema,
    sourceUrl: httpsUrlSchema,
    verifiedAt: epochMsSchema,
    evidenceVersion: z.string().trim().min(1).max(200),
    evidenceSnapshot: z.string().trim().min(1).max(16_000),
    conditions: z.string().trim().min(1).max(2_000),
    effectiveFrom: epochMsSchema,
  })
  .strict()
  .refine((value) => value.verifiedAt <= value.effectiveFrom)
  .refine((value) => value.verifiedAt <= Date.now());

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(ErrCode.BAD_REQUEST, '请求参数校验失败', 400);
  return result.data;
}

function conflicted<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(ErrCode.CONFLICT, '目录版本冲突或生效时间无效', 409);
  }
}

function providerRoute(
  providerId: string,
  modelId: string,
): { providerId: string; modelId: string } {
  return parse(providerModelRouteSchema, { providerId, modelId });
}

function auditActor(app: FastifyInstance, action: string, userId: string, target: string): void {
  writeAudit(
    app.accountDb.raw,
    action,
    `管理员=${userId.slice(0, 8)}*** 目标=${target.slice(0, 12)}***`,
  );
}

function rateDiff(
  current: PriceRates | null,
  proposed: PriceRates,
): Array<{
  bucket: string;
  previousMicrosPerMillion: number | null;
  proposedMicrosPerMillion: number | null;
  deltaMicrosPerMillion: number | null;
}> {
  const changes: Array<{
    bucket: string;
    previousMicrosPerMillion: number | null;
    proposedMicrosPerMillion: number | null;
    deltaMicrosPerMillion: number | null;
  }> = [];
  const push = (bucket: string, before: number | null, after: number | null): void => {
    changes.push({
      bucket,
      previousMicrosPerMillion: before,
      proposedMicrosPerMillion: after,
      deltaMicrosPerMillion: before === null || after === null ? null : after - before,
    });
  };
  push('uncachedInput', current?.uncachedInput ?? null, proposed.uncachedInput);
  push('cacheRead', current?.cacheRead ?? null, proposed.cacheRead);
  push('output', current?.output ?? null, proposed.output);
  const ttls = new Set([
    ...Object.keys(current?.cacheWriteByTtl ?? {}),
    ...Object.keys(proposed.cacheWriteByTtl ?? {}),
  ]);
  if (current?.cacheWriteByTtl === null || proposed.cacheWriteByTtl === null) {
    push(
      'cacheWrite:*',
      current?.cacheWriteByTtl === null ? null : null,
      proposed.cacheWriteByTtl === null ? null : null,
    );
  } else {
    for (const ttl of [...ttls].sort()) {
      push(
        `cacheWrite:${ttl}`,
        current?.cacheWriteByTtl?.[ttl] ?? null,
        proposed.cacheWriteByTtl?.[ttl] ?? null,
      );
    }
  }
  return changes;
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const catalog = new PlatformCatalogDb(app.accountDb.raw);

  // 公共 API 和可供本地缓存的 JSON 快照完全一致，只读公开字段。
  app.get('/api/catalog', async (_req, reply) => reply.send(catalog.buildPublicSnapshot()));
  app.get('/api/catalog/snapshot', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return reply.send(catalog.buildPublicSnapshot());
  });

  app.get('/api/admin/catalog/providers', { preHandler: requirePlatformAdmin }, async () => ({
    providers: catalog.listAdminProviders(),
  }));

  app.post(
    '/api/admin/catalog/providers',
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const data = parse(providerCreateSchema, req.body) as ProviderWrite;
      const provider = catalog.createProvider(data);
      auditActor(app, 'catalog.provider.create', req.user!.userId, String(provider.providerId));
      return reply.code(201).send({ provider });
    },
  );

  app.patch<{ Params: { providerId: string } }>(
    '/api/admin/catalog/providers/:providerId',
    { preHandler: requirePlatformAdmin },
    async (req) => {
      const providerId = parse(providerIdSchema, req.params.providerId);
      const patch = parse(providerPatchSchema, req.body) as Partial<ProviderWrite>;
      const provider = conflicted(() => catalog.updateProvider(providerId, patch));
      if (!provider) throw new AppError(ErrCode.NOT_FOUND, 'Provider 不存在', 404);
      auditActor(app, 'catalog.provider.update', req.user!.userId, providerId);
      return { provider };
    },
  );

  app.get('/api/admin/catalog/models', { preHandler: requirePlatformAdmin }, async () => ({
    models: catalog.listAdminModels(),
  }));

  app.post<{ Params: { providerId: string } }>(
    '/api/admin/catalog/providers/:providerId/models',
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const providerId = parse(providerIdSchema, req.params.providerId);
      const data = parse(modelCreateSchema, req.body) as ModelWrite;
      const model = conflicted(() => catalog.createModel(providerId, data));
      if (!model) throw new AppError(ErrCode.NOT_FOUND, 'Provider 不存在', 404);
      auditActor(app, 'catalog.model.create', req.user!.userId, String(model.modelId));
      return reply.code(201).send({ model });
    },
  );

  app.patch<{ Params: { providerId: string; modelId: string } }>(
    '/api/admin/catalog/providers/:providerId/models/:modelId',
    { preHandler: requirePlatformAdmin },
    async (req) => {
      const params = parse(paramsSchema, req.params);
      const patch = parse(modelPatchSchema, req.body) as Partial<ModelWrite>;
      const model = conflicted(() => catalog.updateModel(params.providerId, params.modelId, patch));
      if (!model) throw new AppError(ErrCode.NOT_FOUND, 'ProviderModel 不存在', 404);
      auditActor(app, 'catalog.model.update', req.user!.userId, params.modelId);
      return { model };
    },
  );

  app.get<{ Params: { providerId: string; modelId: string } }>(
    '/api/admin/catalog/providers/:providerId/models/:modelId/prices',
    { preHandler: requirePlatformAdmin },
    async (req) => {
      const route = parse(paramsSchema, req.params);
      if (!catalog.hasModel(route.providerId, route.modelId)) {
        throw new AppError(ErrCode.NOT_FOUND, 'ProviderModel 不存在', 404);
      }
      return { prices: catalog.listPrices(route.providerId, route.modelId) };
    },
  );

  app.post<{ Params: { providerId: string; modelId: string } }>(
    '/api/admin/catalog/providers/:providerId/models/:modelId/prices/preview',
    { preHandler: requirePlatformAdmin },
    async (req) => {
      const route = parse(paramsSchema, req.params);
      providerRoute(route.providerId, route.modelId);
      if (!catalog.hasModel(route.providerId, route.modelId)) {
        throw new AppError(ErrCode.NOT_FOUND, 'ProviderModel 不存在', 404);
      }
      const data = parse(priceWriteSchema, req.body) as PriceWrite;
      const issue = catalog.pricePublicationIssue(
        route.providerId,
        route.modelId,
        data.effectiveFrom,
      );
      if (issue === 'not_found') throw new AppError(ErrCode.NOT_FOUND, 'ProviderModel 不存在', 404);
      if (issue === 'inactive') {
        throw new AppError(ErrCode.CONFLICT, 'Provider 或模型已停用，不能发布新价格', 409);
      }
      if (issue === 'conflict') {
        throw new AppError(ErrCode.CONFLICT, '生效时间必须晚于已发布版本且不得回溯当前时间', 409);
      }
      const currentPrice = catalog.getPriceAt(route.providerId, route.modelId, data.effectiveFrom);
      return {
        route,
        effectiveFrom: data.effectiveFrom,
        nextVersion: catalog.listPrices(route.providerId, route.modelId).length + 1,
        currentPrice,
        proposed: {
          ...data,
          billingMode: 'per_million_tokens',
          cacheWriteRateSemantics: 'full_rate',
        },
        impact: rateDiff(currentPrice?.rates ?? null, data.rates),
        note: 'null 表示未定价，不会从官网价或其他 Provider 补入；0 表示免费。',
      };
    },
  );

  app.post<{ Params: { providerId: string; modelId: string } }>(
    '/api/admin/catalog/providers/:providerId/models/:modelId/prices',
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const route = parse(paramsSchema, req.params);
      providerRoute(route.providerId, route.modelId);
      const data = parse(priceWriteSchema, req.body) as PriceWrite;
      const price = conflicted(() => catalog.publishPrice(route.providerId, route.modelId, data));
      if (!price) throw new AppError(ErrCode.NOT_FOUND, '有效 ProviderModel 不存在', 404);
      auditActor(app, 'catalog.price.publish', req.user!.userId, price.priceVersionId);
      return reply.code(201).send({ price });
    },
  );

  app.get('/api/admin/catalog/official-prices', { preHandler: requirePlatformAdmin }, async () => ({
    prices: catalog.listAdminOfficialPrices(),
  }));

  app.post(
    '/api/admin/catalog/official-prices',
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const data = parse(officialPriceSchema, req.body) as OfficialPriceWrite;
      const price = conflicted(() => catalog.publishOfficialPrice(data, req.user!.userId));
      auditActor(app, 'catalog.official-price.verify', req.user!.userId, price.snapshotId);
      return reply.code(201).send({ price, evidenceSha256: price.evidenceSha256 });
    },
  );
}
