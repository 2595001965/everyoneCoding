/** User wallet reads and audited operator controls. Attempt writes stay server-internal. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizedUsageSchema } from '@ec/core/v2';
import { requireAuth, requirePlatformAdmin } from '../auth-tokens.ts';
import { AppError, ErrCode } from '../errors.ts';

const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const accountIdSchema = z.string().min(1).max(128);
const attemptIdSchema = z.string().regex(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
const reasonSchema = z.string().trim().min(3).max(500);
const safeMicrosSchema = z.number().int().refine(Number.isSafeInteger);
const nonnegativeSafeMicrosSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
const walletParamsSchema = z.object({ currency: currencySchema }).strict();
const accountParamsSchema = z.object({ accountId: accountIdSchema }).strict();
const attemptParamsSchema = z.object({ attemptId: attemptIdSchema }).strict();

const adjustmentSchema = z
  .object({
    currency: currencySchema,
    amountMicros: safeMicrosSchema.refine((value) => value !== 0),
    reason: reasonSchema,
  })
  .strict();

const budgetPolicySchema = z
  .object({
    currency: currencySchema,
    dailyLimitMicros: nonnegativeSafeMicrosSchema.nullable(),
    monthlyLimitMicros: nonnegativeSafeMicrosSchema.nullable(),
    reason: reasonSchema,
  })
  .strict();

const reconciliationSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('no_upstream_execution'), reason: reasonSchema }).strict(),
  z
    .object({
      outcome: z.literal('final_usage'),
      reason: reasonSchema,
      usage: normalizedUsageSchema,
    })
    .strict(),
]);

const reversalSchema = z.object({ reason: reasonSchema }).strict();

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(ErrCode.BAD_REQUEST, '请求参数校验失败', 400);
  return result.data;
}

function idempotencyKey(value: string | string[] | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value
  ) {
    throw new AppError(ErrCode.BAD_REQUEST, '必须提供有效的 Idempotency-Key 请求头', 400);
  }
  return value;
}

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  const ledger = app.walletLedger;

  app.get('/api/wallets', { preHandler: requireAuth }, async (req) => ({
    wallets: ledger.listWallets(req.user!.userId),
  }));

  app.get<{ Params: { currency: string } }>(
    '/api/wallets/:currency',
    { preHandler: requireAuth },
    async (req) => {
      const params = parse(walletParamsSchema, req.params);
      return { wallet: ledger.getWallet(req.user!.userId, params.currency) };
    },
  );

  app.get<{ Params: { currency: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/wallets/:currency/ledger',
    { preHandler: requireAuth },
    async (req) => {
      const params = parse(walletParamsSchema, req.params);
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      const before = req.query.before === undefined ? undefined : Number(req.query.before);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AppError(ErrCode.BAD_REQUEST, 'limit 必须在 1 到 100 之间', 400);
      }
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
        throw new AppError(ErrCode.BAD_REQUEST, 'before 时间游标无效', 400);
      }
      return { entries: ledger.listLedger(req.user!.userId, params.currency, limit, before) };
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/api/billing/attempts',
    { preHandler: requireAuth },
    async (req) => {
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AppError(ErrCode.BAD_REQUEST, 'limit 必须在 1 到 100 之间', 400);
      }
      return { attempts: ledger.listAttempts(req.user!.userId, limit) };
    },
  );

  app.get<{ Params: { attemptId: string } }>(
    '/api/billing/attempts/:attemptId',
    { preHandler: requireAuth },
    async (req) => {
      const params = parse(attemptParamsSchema, req.params);
      const attempt = ledger.getAttempt(req.user!.userId, params.attemptId);
      if (!attempt) throw new AppError(ErrCode.NOT_FOUND, '计费请求不存在', 404);
      return { attempt };
    },
  );

  app.get<{ Params: { accountId: string; currency: string } }>(
    '/api/admin/wallets/:accountId/:currency',
    { preHandler: requirePlatformAdmin },
    async (req) => {
      const params = parse(
        accountParamsSchema.extend({ currency: currencySchema }).strict(),
        req.params,
      );
      if (!app.accountDb.getUserById(params.accountId))
        throw new AppError(ErrCode.NOT_FOUND, '账号不存在', 404);
      return {
        wallet: ledger.getWallet(params.accountId, params.currency),
        budgetPolicy: ledger.getBudgetPolicy(params.accountId, params.currency),
      };
    },
  );

  app.post<{ Params: { accountId: string } }>(
    '/api/admin/wallets/:accountId/adjustments',
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = parse(accountParamsSchema, req.params);
      const data = parse(adjustmentSchema, req.body);
      const result = ledger.adjustWallet({
        ...data,
        accountId: params.accountId,
        actorAccountId: req.user!.userId,
        idempotencyKey: idempotencyKey(req.headers['idempotency-key']),
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    },
  );

  app.put<{ Params: { accountId: string } }>(
    '/api/admin/wallets/:accountId/budgets',
    { preHandler: requirePlatformAdmin },
    async (req) => {
      const params = parse(accountParamsSchema, req.params);
      const data = parse(budgetPolicySchema, req.body);
      return {
        budgetPolicy: ledger.setBudgetPolicy({
          ...data,
          accountId: params.accountId,
          actorAccountId: req.user!.userId,
        }),
      };
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/api/admin/billing/reconciliation',
    { preHandler: requirePlatformAdmin },
    async (req) => {
      const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new AppError(ErrCode.BAD_REQUEST, 'limit 必须在 1 到 500 之间', 400);
      }
      return { cases: ledger.listOpenReconciliation(limit) };
    },
  );

  app.post<{ Params: { attemptId: string } }>(
    '/api/admin/billing/reconciliation/:attemptId/resolve',
    { preHandler: requirePlatformAdmin },
    async (req) => {
      const params = parse(attemptParamsSchema, req.params);
      const data = parse(reconciliationSchema, req.body);
      const attempt = ledger.resolveReconciliation({
        ...data,
        attemptId: params.attemptId,
        actorAccountId: req.user!.userId,
      });
      return { attempt };
    },
  );

  app.post<{ Params: { attemptId: string } }>(
    '/api/admin/billing/attempts/:attemptId/reversal',
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const params = parse(attemptParamsSchema, req.params);
      const data = parse(reversalSchema, req.body);
      const result = ledger.reverseSettlement({
        ...data,
        attemptId: params.attemptId,
        actorAccountId: req.user!.userId,
        idempotencyKey: idempotencyKey(req.headers['idempotency-key']),
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    },
  );
}
