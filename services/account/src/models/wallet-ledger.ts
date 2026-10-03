/**
 * Server-owned platform wallet, holds, billing attempts and reconciliation.
 * This ledger is intentionally separate from client-side usage_report/usage records.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  computeUsageCost,
  currencyCodeSchema,
  normalizedUsageSchema,
  priceVersionSchema,
  providerModelKeyOf,
  providerModelRouteSchema,
  ulidSchema,
  type NormalizedUsage,
  type PriceRates,
  type PriceVersion,
} from '@ec/core/v2';
import { AppError, ErrCode } from '../errors.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEFAULT_RECONCILIATION_SLA_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ATTEMPT_LEASE_MS = 30 * 1000;

export type BillingAttemptStatus =
  | 'reserved'
  | 'unknown_pending_reconciliation'
  | 'reconciliation_required'
  | 'settled'
  | 'released'
  | 'reversed';

interface WalletRow {
  account_id: string;
  currency: string;
  posted_micros: number;
  held_micros: number;
  revision: number;
  updated_at: number;
}

interface AttemptRow {
  attempt_id: string;
  account_id: string;
  logical_request_id: string;
  request_idempotency_key: string;
  request_fingerprint: string;
  currency: string;
  price_version_id: string;
  provider_model_key: string;
  price_snapshot_json: string;
  reserve_micros: number;
  final_micros: number | null;
  status: BillingAttemptStatus;
  dispatch_state: 'not_dispatched' | 'dispatched';
  usage_json: string | null;
  cost_lines_json: string | null;
  settlement_fingerprint: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

interface LedgerRow {
  entry_id: string;
  account_id: string;
  currency: string;
  entry_type: 'adjustment' | 'hold' | 'release' | 'settlement' | 'reversal';
  amount_micros: number;
  posted_delta: number;
  held_delta: number;
  idempotency_key: string;
  attempt_id: string | null;
  hold_id: string | null;
  reverses_entry_id: string | null;
  reason: string | null;
  created_at: number;
}

interface PlatformPriceRow {
  price_version_id: string;
  provider_model_key: string;
  billing_mode: 'per_million_tokens';
  currency: string;
  rates_json: string;
  cache_write_rate_semantics: 'full_rate';
  source_json: string;
  effective_from: number;
  published_at: number;
  version: number;
  provider_status: string;
  model_status: string;
}

interface OfficialPriceRow {
  snapshot_id: string;
  canonical_vendor: string;
  canonical_model: string;
  billing_mode: 'per_million_tokens';
  currency: string;
  rates_json: string;
  source_url: string;
  verified_at: number;
  effective_from: number;
  published_at: number;
  version: number;
  provider_model_key: string;
  provider_status: string;
  model_status: string;
}

export interface WalletSnapshot {
  accountId: string;
  currency: string;
  postedMicros: number;
  heldMicros: number;
  availableMicros: number;
  asOf: number;
  stale: false;
  revision: number;
}

export interface WalletLedgerEntry {
  entryId: string;
  accountId: string;
  currency: string;
  type: LedgerRow['entry_type'];
  amountMicros: number;
  postedDeltaMicros: number;
  heldDeltaMicros: number;
  attemptId: string | null;
  holdId: string | null;
  reversesEntryId: string | null;
  reason: string | null;
  createdAt: number;
}

export interface BillingAttemptView {
  attemptId: string;
  logicalRequestId: string;
  accountId: string;
  currency: string;
  providerModelKey: string;
  priceVersionId: string;
  priceSnapshot: PriceVersion;
  reservedMicros: number;
  finalMicros: number | null;
  status: BillingAttemptStatus;
  dispatchState: 'not_dispatched' | 'dispatched';
  usage: NormalizedUsage | null;
  costLines: ReturnType<typeof computeUsageCost>['lineItems'] | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

export interface ReserveAttemptInput {
  accountId: string;
  attemptId: string;
  logicalRequestId: string;
  idempotencyKey: string;
  providerModelKey: string;
  priceVersionId: string;
  /** Trusted gateway context estimate; totalOutput is the maximum accepted output. */
  usageEstimate: NormalizedUsage;
  /** SHA-256 of the transient request bytes. Only the digest is persisted. */
  contentFingerprint?: string;
}

export interface WalletLedgerOptions {
  now?: () => number;
  attemptLeaseMs?: number;
  reconciliationSlaMs?: number;
}

function newUlid(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError('ULID timestamp is out of range');
  }
  const entropy = randomBytes(10);
  let value = (BigInt(now) << 80n) | BigInt(`0x${entropy.toString('hex')}`);
  let id = '';
  for (let index = 0; index < 26; index += 1) {
    id = (ALPHABET[Number(value & 31n)] ?? '0') + id;
    value >>= 5n;
  }
  return id;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeInteger(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AppError(ErrCode.BAD_REQUEST, `${label} 超出安全整数范围`, 400);
  }
  return value;
}

function validateIdempotencyKey(value: string): string {
  if (value.length < 1 || value.length > 200 || value.trim() !== value) {
    throw new AppError(ErrCode.BAD_REQUEST, 'Idempotency-Key 长度或格式无效', 400);
  }
  return value;
}

function sumSafe(values: number[], label: string): number {
  let total = 0;
  for (const value of values) {
    safeInteger(value, label);
    total += value;
    safeInteger(total, label);
  }
  return total;
}

function usageIsComplete(usage: NormalizedUsage): boolean {
  if (
    usage.totalInput === null ||
    usage.uncachedInput === null ||
    usage.cacheReadInput === null ||
    usage.cacheWriteInputByTtl === null ||
    usage.totalOutput === null
  ) {
    return false;
  }
  const categories = sumSafe(
    [usage.uncachedInput, usage.cacheReadInput, ...Object.values(usage.cacheWriteInputByTtl)],
    'Token 用量',
  );
  safeInteger(usage.totalInput, 'Token 用量');
  safeInteger(usage.totalOutput, 'Token 用量');
  if (usage.reasoningOutput !== null) {
    safeInteger(usage.reasoningOutput, '推理 Token 用量');
    if (usage.reasoningOutput > usage.totalOutput) return false;
  }
  return categories === usage.totalInput;
}

function assertSafeCostProducts(price: PriceVersion, usage: NormalizedUsage): void {
  const pairs: Array<[number | null, number | null]> = [
    [usage.uncachedInput, price.rates.uncachedInput],
    [usage.cacheReadInput, price.rates.cacheRead],
    [usage.totalOutput, price.rates.output],
  ];
  for (const [ttl, tokens] of Object.entries(usage.cacheWriteInputByTtl ?? {})) {
    pairs.push([tokens, price.rates.cacheWriteByTtl?.[ttl] ?? null]);
  }
  for (const [tokens, rate] of pairs) {
    if (tokens !== null && rate !== null && !Number.isSafeInteger(tokens * rate)) {
      throw new AppError(ErrCode.BAD_REQUEST, 'Token 数与费率乘积超出安全整数范围', 400);
    }
  }
}

function toWalletSnapshot(
  row: WalletRow | undefined,
  accountId: string,
  currency: string,
  now: number,
): WalletSnapshot {
  const postedMicros = row?.posted_micros ?? 0;
  const heldMicros = row?.held_micros ?? 0;
  const availableMicros = postedMicros - heldMicros;
  if (!Number.isSafeInteger(availableMicros) || availableMicros < 0) {
    throw new Error('账本余额不变量损坏');
  }
  return {
    accountId,
    currency,
    postedMicros,
    heldMicros,
    availableMicros,
    asOf: row?.updated_at ?? now,
    stale: false,
    revision: row?.revision ?? 0,
  };
}

function toLedgerEntry(row: LedgerRow): WalletLedgerEntry {
  return {
    entryId: row.entry_id,
    accountId: row.account_id,
    currency: row.currency,
    type: row.entry_type,
    amountMicros: row.amount_micros,
    postedDeltaMicros: row.posted_delta,
    heldDeltaMicros: row.held_delta,
    attemptId: row.attempt_id,
    holdId: row.hold_id,
    reversesEntryId: row.reverses_entry_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function toAttemptView(row: AttemptRow): BillingAttemptView {
  return {
    attemptId: row.attempt_id,
    logicalRequestId: row.logical_request_id,
    accountId: row.account_id,
    currency: row.currency,
    providerModelKey: row.provider_model_key,
    priceVersionId: row.price_version_id,
    priceSnapshot: priceVersionSchema.parse(JSON.parse(row.price_snapshot_json) as unknown),
    reservedMicros: row.reserve_micros,
    finalMicros: row.final_micros,
    status: row.status,
    dispatchState: row.dispatch_state,
    usage:
      row.usage_json === null
        ? null
        : normalizedUsageSchema.parse(JSON.parse(row.usage_json) as unknown),
    costLines:
      row.cost_lines_json === null
        ? null
        : (JSON.parse(row.cost_lines_json) as ReturnType<typeof computeUsageCost>['lineItems']),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

export class WalletLedger {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly attemptLeaseMs: number;
  private readonly reconciliationSlaMs: number;

  constructor(db: Database, options: WalletLedgerOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.attemptLeaseMs = options.attemptLeaseMs ?? DEFAULT_ATTEMPT_LEASE_MS;
    this.reconciliationSlaMs = options.reconciliationSlaMs ?? DEFAULT_RECONCILIATION_SLA_MS;
    if (!Number.isSafeInteger(this.attemptLeaseMs) || this.attemptLeaseMs < 1_000) {
      throw new RangeError('billing attempt lease must be an integer of at least one second');
    }
    if (!Number.isSafeInteger(this.reconciliationSlaMs) || this.reconciliationSlaMs < 1_000) {
      throw new RangeError('billing reconciliation SLA must be an integer of at least one second');
    }
    this.db.pragma('busy_timeout = 5000');
  }

  getWallet(accountId: string, currencyInput: string): WalletSnapshot {
    const currency = currencyCodeSchema.parse(currencyInput);
    const row = this.db
      .prepare('SELECT * FROM wallet_account WHERE account_id = ? AND currency = ?')
      .get(accountId, currency) as WalletRow | undefined;
    return toWalletSnapshot(row, accountId, currency, this.now());
  }

  listWallets(accountId: string): WalletSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM wallet_account WHERE account_id = ? ORDER BY currency')
      .all(accountId) as WalletRow[];
    return rows.map((row) => toWalletSnapshot(row, accountId, row.currency, this.now()));
  }

  listLedger(
    accountId: string,
    currencyInput: string,
    limit = 50,
    before?: number,
  ): WalletLedgerEntry[] {
    const currency = currencyCodeSchema.parse(currencyInput);
    const pageSize = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows =
      before === undefined
        ? this.db
            .prepare(
              `SELECT * FROM wallet_ledger_entry WHERE account_id = ? AND currency = ?
           ORDER BY created_at DESC, entry_id DESC LIMIT ?`,
            )
            .all(accountId, currency, pageSize)
        : this.db
            .prepare(
              `SELECT * FROM wallet_ledger_entry WHERE account_id = ? AND currency = ? AND created_at < ?
           ORDER BY created_at DESC, entry_id DESC LIMIT ?`,
            )
            .all(accountId, currency, before, pageSize);
    return (rows as LedgerRow[]).map(toLedgerEntry);
  }

  getAttempt(accountId: string, attemptId: string): BillingAttemptView | null {
    const row = this.db
      .prepare('SELECT * FROM billing_attempt WHERE account_id = ? AND attempt_id = ?')
      .get(accountId, attemptId) as AttemptRow | undefined;
    return row ? toAttemptView(row) : null;
  }

  listAttempts(accountId: string, limit = 50): BillingAttemptView[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM billing_attempt WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(accountId, Math.max(1, Math.min(100, Math.trunc(limit)))) as AttemptRow[];
    return rows.map(toAttemptView);
  }

  listOpenReconciliation(limit = 100): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT c.case_id AS caseId, c.attempt_id AS attemptId, a.account_id AS accountId,
              a.currency, a.provider_model_key AS providerModelKey,
              a.price_version_id AS priceVersionId, a.reserve_micros AS reserveMicros,
              a.final_micros AS finalMicros, a.status AS attemptStatus,
              c.reason, c.created_at AS createdAt, c.due_at AS dueAt, c.status
       FROM billing_reconciliation_case c
       JOIN billing_attempt a ON a.attempt_id = c.attempt_id
       WHERE c.status = 'open' ORDER BY c.due_at, c.created_at LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, Math.trunc(limit)))) as Array<Record<string, unknown>>;
  }

  getAdminAttempt(attemptId: string): BillingAttemptView | null {
    const row = this.db
      .prepare('SELECT * FROM billing_attempt WHERE attempt_id = ?')
      .get(attemptId) as AttemptRow | undefined;
    return row ? toAttemptView(row) : null;
  }

  adjustWallet(input: {
    accountId: string;
    currency: string;
    amountMicros: number;
    reason: string;
    idempotencyKey: string;
    actorAccountId: string;
  }): { entry: WalletLedgerEntry; wallet: WalletSnapshot; replayed: boolean } {
    const currency = currencyCodeSchema.parse(input.currency);
    const amount = safeInteger(input.amountMicros, '额度调整金额', Number.MIN_SAFE_INTEGER);
    if (amount === 0) throw new AppError(ErrCode.BAD_REQUEST, '额度调整金额不能为 0', 400);
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw new AppError(ErrCode.BAD_REQUEST, '额度调整原因长度必须为 3 到 500 个字符', 400);
    }
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = fingerprint({
      accountId: input.accountId,
      currency,
      amountMicros: amount,
      reason,
    });
    const tx = this.db.transaction(() => {
      const ledgerKey = `admin-adjustment:${idempotencyKey}`;
      const existing = this.db
        .prepare('SELECT * FROM wallet_ledger_entry WHERE account_id = ? AND idempotency_key = ?')
        .get(input.accountId, ledgerKey) as
        (LedgerRow & { request_fingerprint: string }) | undefined;
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new AppError(ErrCode.IDEMPOTENCY_CONFLICT, '相同幂等键对应了不同的额度调整', 409);
        }
        return {
          entry: toLedgerEntry(existing),
          wallet: this.getWallet(input.accountId, currency),
          replayed: true,
        };
      }
      this.ensureAccountExists(input.accountId);
      this.ensureWallet(input.accountId, currency);
      const wallet = this.walletRow(input.accountId, currency)!;
      if (amount < 0 && -amount > wallet.posted_micros - wallet.held_micros) {
        throw new AppError('INSUFFICIENT_BALANCE', '可用余额不足，不能执行该额度扣减', 409);
      }
      const entry = this.applyMovement({
        wallet,
        postedDelta: amount,
        heldDelta: 0,
        entryType: 'adjustment',
        amountMicros: Math.abs(amount),
        idempotencyKey: ledgerKey,
        requestFingerprint,
        reason,
        actorAccountId: input.actorAccountId,
        action: 'wallet.admin_adjustment',
        details: { amountMicros: amount },
      });
      return { entry, wallet: this.getWallet(input.accountId, currency), replayed: false };
    });
    return tx.immediate();
  }

  setBudgetPolicy(input: {
    accountId: string;
    currency: string;
    dailyLimitMicros: number | null;
    monthlyLimitMicros: number | null;
    actorAccountId: string;
    reason: string;
  }): Record<string, unknown> {
    const currency = currencyCodeSchema.parse(input.currency);
    const daily =
      input.dailyLimitMicros === null ? null : safeInteger(input.dailyLimitMicros, '日预算');
    const monthly =
      input.monthlyLimitMicros === null ? null : safeInteger(input.monthlyLimitMicros, '月预算');
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw new AppError(ErrCode.BAD_REQUEST, '预算调整原因长度必须为 3 到 500 个字符', 400);
    }
    const tx = this.db.transaction(() => {
      this.ensureAccountExists(input.accountId);
      this.ensureWallet(input.accountId, currency);
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO wallet_budget_policy
          (account_id, currency, daily_limit_micros, monthly_limit_micros, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, currency) DO UPDATE SET
           daily_limit_micros = excluded.daily_limit_micros,
           monthly_limit_micros = excluded.monthly_limit_micros,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
        )
        .run(input.accountId, currency, daily, monthly, input.actorAccountId, now);
      this.audit({
        action: 'wallet.budget_policy.update',
        actorAccountId: input.actorAccountId,
        targetAccountId: input.accountId,
        reason,
        details: { currency, dailyLimitMicros: daily, monthlyLimitMicros: monthly },
        now,
      });
      return {
        accountId: input.accountId,
        currency,
        dailyLimitMicros: daily,
        monthlyLimitMicros: monthly,
        updatedAt: now,
      };
    });
    return tx.immediate();
  }

  getBudgetPolicy(accountId: string, currencyInput: string): Record<string, unknown> | null {
    const currency = currencyCodeSchema.parse(currencyInput);
    return (
      (this.db
        .prepare(
          `SELECT account_id AS accountId, currency,
              daily_limit_micros AS dailyLimitMicros,
              monthly_limit_micros AS monthlyLimitMicros, updated_at AS updatedAt
       FROM wallet_budget_policy WHERE account_id = ? AND currency = ?`,
        )
        .get(accountId, currency) as Record<string, unknown> | undefined) ?? null
    );
  }

  reserveAttempt(input: ReserveAttemptInput): {
    attempt: BillingAttemptView;
    wallet: WalletSnapshot;
    replayed: boolean;
  } {
    const accountId = input.accountId;
    const attemptId = ulidSchema.parse(input.attemptId);
    const priceVersionId = ulidSchema.parse(input.priceVersionId);
    const routeParts = input.providerModelKey.split('/');
    const routeResult = providerModelRouteSchema.safeParse(
      routeParts.length === 2 ? { providerId: routeParts[0], modelId: routeParts[1] } : null,
    );
    if (!routeResult.success)
      throw new AppError(ErrCode.BAD_REQUEST, 'Provider/Model 路由键无效', 400);
    const route = routeResult.data;
    const providerModelKey = providerModelKeyOf(route);
    const logicalRequestId = input.logicalRequestId.trim();
    if (logicalRequestId.length < 1 || logicalRequestId.length > 200) {
      throw new AppError(ErrCode.BAD_REQUEST, 'logicalRequestId 无效', 400);
    }
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const usageEstimate = normalizedUsageSchema.parse(input.usageEstimate);
    if (usageEstimate.quality !== 'context_estimate' || !usageIsComplete(usageEstimate)) {
      throw new AppError(ErrCode.BAD_REQUEST, '预占必须使用完整的服务端上下文估算', 400);
    }
    const contentFingerprint = input.contentFingerprint ?? null;
    if (contentFingerprint !== null && !/^[0-9a-f]{64}$/.test(contentFingerprint)) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求内容指纹无效', 400);
    }
    const requestFingerprint = fingerprint({
      attemptId,
      logicalRequestId,
      providerModelKey,
      contentFingerprint,
    });
    const tx = this.db.transaction(() => {
      const duplicate = this.db
        .prepare(
          'SELECT * FROM billing_attempt WHERE account_id = ? AND request_idempotency_key = ?',
        )
        .get(accountId, idempotencyKey) as AttemptRow | undefined;
      if (duplicate) {
        if (duplicate.request_fingerprint !== requestFingerprint) {
          throw new AppError(ErrCode.IDEMPOTENCY_CONFLICT, '幂等键已用于不同的计费请求', 409);
        }
        return {
          attempt: toAttemptView(duplicate),
          wallet: this.getWallet(accountId, duplicate.currency),
          replayed: true,
        };
      }
      const pendingLogical = this.db
        .prepare(
          `SELECT attempt_id FROM billing_attempt
           WHERE account_id = ? AND logical_request_id = ?
             AND status IN ('reserved', 'unknown_pending_reconciliation', 'reconciliation_required')
           LIMIT 1`,
        )
        .get(accountId, logicalRequestId) as { attempt_id: string } | undefined;
      if (pendingLogical) {
        throw new AppError(
          ErrCode.CONFLICT,
          '该逻辑请求仍在执行或待对账；先查询账单状态，不要重新发送收费请求',
          409,
        );
      }
      const existingAttempt = this.db
        .prepare('SELECT attempt_id FROM billing_attempt WHERE attempt_id = ?')
        .get(attemptId);
      if (existingAttempt) throw new AppError(ErrCode.CONFLICT, 'attemptId 已被另一请求使用', 409);
      this.ensureAccountExists(accountId);
      const now = this.now();
      const price = this.getApplicablePrice(priceVersionId, providerModelKey, now);
      if (!price) throw new AppError('PRICE_UNKNOWN', '没有匹配的有效服务端价格快照', 409);
      assertSafeCostProducts(price, usageEstimate);
      const estimateCost = computeUsageCost(price, usageEstimate);
      if (!estimateCost.complete) {
        throw new AppError('PRICE_UNKNOWN', '预占所需的 Token 计费维度未定价', 409);
      }
      const reserveMicros = safeInteger(estimateCost.total.micros, '预占金额');
      this.ensureWallet(accountId, price.currency);
      const wallet = this.walletRow(accountId, price.currency)!;
      if (reserveMicros > wallet.posted_micros - wallet.held_micros) {
        throw new AppError('INSUFFICIENT_BALANCE', '可用余额不足，无法预占本次请求', 409);
      }
      this.assertBudgets(accountId, price.currency, reserveMicros, now);

      const holdId = newUlid(now);
      const leaseExpiresAt = now + this.attemptLeaseMs;
      this.db
        .prepare(
          `INSERT INTO billing_attempt
          (attempt_id, account_id, logical_request_id, request_idempotency_key, request_fingerprint,
           currency, price_version_id, provider_model_key, price_snapshot_json, reserve_micros,
           status, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        )
        .run(
          attemptId,
          accountId,
          logicalRequestId,
          idempotencyKey,
          requestFingerprint,
          price.currency,
          price.priceVersionId,
          providerModelKey,
          JSON.stringify(price),
          reserveMicros,
          leaseExpiresAt,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO wallet_hold (hold_id, attempt_id, account_id, currency, amount_micros, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(holdId, attemptId, accountId, price.currency, reserveMicros, now, now);
      this.applyMovement({
        wallet,
        postedDelta: 0,
        heldDelta: reserveMicros,
        entryType: 'hold',
        amountMicros: reserveMicros,
        idempotencyKey: `billing-hold:${attemptId}`,
        requestFingerprint,
        attemptId,
        holdId,
        action: 'billing.attempt.reserve',
        details: { priceVersionId, reserveMicros },
        now,
      });
      const created = this.db
        .prepare('SELECT * FROM billing_attempt WHERE attempt_id = ?')
        .get(attemptId) as AttemptRow;
      return {
        attempt: toAttemptView(created),
        wallet: this.getWallet(accountId, price.currency),
        replayed: false,
      };
    });
    return tx.immediate();
  }

  /** Check a replay before consulting the current catalog or price version. */
  findIdempotentReplay(input: {
    accountId: string;
    idempotencyKey: string;
    attemptId: string;
    logicalRequestId: string;
    providerModelKey: string;
    contentFingerprint: string;
  }): BillingAttemptView | null {
    const accountId = input.accountId;
    const attemptId = ulidSchema.parse(input.attemptId);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const routeParts = input.providerModelKey.split('/');
    const route = providerModelRouteSchema.safeParse(
      routeParts.length === 2 ? { providerId: routeParts[0], modelId: routeParts[1] } : null,
    );
    if (!route.success || !/^[0-9a-f]{64}$/.test(input.contentFingerprint)) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求幂等信息无效', 400);
    }
    const logicalRequestId = input.logicalRequestId.trim();
    const row = this.db
      .prepare(
        'SELECT * FROM billing_attempt WHERE account_id = ? AND request_idempotency_key = ?',
      )
      .get(accountId, idempotencyKey) as AttemptRow | undefined;
    if (!row) return null;
    const expected = fingerprint({
      attemptId,
      logicalRequestId,
      providerModelKey: providerModelKeyOf(route.data),
      contentFingerprint: input.contentFingerprint,
    });
    if (row.attempt_id !== attemptId || row.request_fingerprint !== expected) {
      throw new AppError(ErrCode.IDEMPOTENCY_CONFLICT, '幂等键已用于不同的计费请求', 409);
    }
    return toAttemptView(row);
  }

  renewAttemptLease(attemptIdInput: string): boolean {
    const attemptId = ulidSchema.parse(attemptIdInput);
    const now = this.now();
    const changed = this.db
      .prepare(
        `UPDATE billing_attempt SET lease_expires_at = ?, updated_at = ?
       WHERE attempt_id = ? AND status = 'reserved'`,
      )
      .run(now + this.attemptLeaseMs, now, attemptId);
    return changed.changes === 1;
  }

  /** Persist the upstream-dispatch boundary before the gateway writes request bytes. */
  markAttemptDispatched(attemptIdInput: string): boolean {
    const attemptId = ulidSchema.parse(attemptIdInput);
    const tx = this.db.transaction(() => {
      const attempt = this.attemptRow(attemptId);
      if (!attempt || attempt.status !== 'reserved') return false;
      if (attempt.dispatch_state === 'dispatched') return true;
      const now = this.now();
      this.db
        .prepare(
          `UPDATE billing_attempt SET dispatch_state = 'dispatched', lease_expires_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = 'reserved' AND dispatch_state = 'not_dispatched'`,
        )
        .run(now + this.attemptLeaseMs, now, attemptId);
      this.audit({
        action: 'billing.attempt.dispatched',
        targetAccountId: attempt.account_id,
        attemptId,
        details: { dispatchState: 'dispatched' },
        now,
      });
      return true;
    });
    return tx.immediate();
  }

  markUnknown(attemptIdInput: string, reason: string): BillingAttemptView {
    const attemptId = ulidSchema.parse(attemptIdInput);
    const note = reason.trim();
    if (note.length < 3 || note.length > 500)
      throw new AppError(ErrCode.BAD_REQUEST, '未知状态原因无效', 400);
    const tx = this.db.transaction(() => {
      const attempt = this.attemptRow(attemptId);
      if (!attempt) throw new AppError(ErrCode.NOT_FOUND, '计费请求不存在', 404);
      if (
        attempt.status === 'unknown_pending_reconciliation' ||
        attempt.status === 'reconciliation_required'
      ) {
        this.ensureReconciliationCase(attemptId, note, this.now());
        this.audit({
          action: 'billing.attempt.unknown_replayed',
          targetAccountId: attempt.account_id,
          attemptId,
          reason: note,
          details: { existingPendingCase: true },
          now: this.now(),
        });
        return toAttemptView(attempt);
      }
      if (attempt.status !== 'reserved')
        throw new AppError(ErrCode.CONFLICT, '终态请求不能标为未知', 409);
      const now = this.now();
      this.db
        .prepare(
          `UPDATE billing_attempt SET status = 'unknown_pending_reconciliation',
         lease_expires_at = NULL, updated_at = ? WHERE attempt_id = ?`,
        )
        .run(now, attemptId);
      this.ensureReconciliationCase(attemptId, note, now);
      this.audit({
        action: 'billing.attempt.unknown',
        targetAccountId: attempt.account_id,
        attemptId,
        reason: note,
        details: { previousStatus: attempt.status },
        now,
      });
      return toAttemptView(this.attemptRow(attemptId)!);
    });
    return tx.immediate();
  }

  recoverExpiredAttempts(now = this.now()): number {
    const tx = this.db.transaction(() => {
      const expired = this.db
        .prepare(
          `SELECT attempt_id, account_id FROM billing_attempt
         WHERE status = 'reserved' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        )
        .all(now) as Array<{ attempt_id: string; account_id: string }>;
      for (const row of expired) {
        this.db
          .prepare(
            `UPDATE billing_attempt SET status = 'unknown_pending_reconciliation',
           lease_expires_at = NULL, updated_at = ? WHERE attempt_id = ? AND status = 'reserved'`,
          )
          .run(now, row.attempt_id);
        this.ensureReconciliationCase(row.attempt_id, 'lease_expired_during_recovery', now);
        this.audit({
          action: 'billing.attempt.recovered_unknown',
          targetAccountId: row.account_id,
          attemptId: row.attempt_id,
          reason: 'lease_expired_during_recovery',
          details: { heldUntilReconciliation: true },
          now,
        });
      }
      return expired.length;
    });
    return tx.immediate();
  }

  settleTrustedUsage(
    attemptIdInput: string,
    usageInput: NormalizedUsage,
    actorAccountId: string | null = null,
    resolutionNote: string | null = null,
  ): BillingAttemptView {
    const attemptId = ulidSchema.parse(attemptIdInput);
    const usage = normalizedUsageSchema.parse(usageInput);
    const tx = this.db.transaction(() => {
      const attempt = this.attemptRow(attemptId);
      if (!attempt) throw new AppError(ErrCode.NOT_FOUND, '计费请求不存在', 404);
      if (attempt.status === 'released')
        throw new AppError(ErrCode.CONFLICT, '已确认未发往上游的请求不能结算', 409);
      const settleFingerprint = fingerprint(usage);
      if (attempt.settlement_fingerprint && attempt.settlement_fingerprint !== settleFingerprint) {
        throw new AppError(
          ErrCode.IDEMPOTENCY_CONFLICT,
          '同一 attempt 收到不一致的最终用量；需走冲正/审计流程',
          409,
        );
      }
      if (attempt.status === 'settled' || attempt.status === 'reversed')
        return toAttemptView(attempt);
      if (usage.quality !== 'upstream_final' || !usageIsComplete(usage)) {
        this.markAttemptUnknownInTransaction(
          attempt,
          'final_usage_incomplete_or_untrusted',
          this.now(),
          usage,
        );
        return toAttemptView(this.attemptRow(attemptId)!);
      }
      const price = priceVersionSchema.parse(JSON.parse(attempt.price_snapshot_json) as unknown);
      assertSafeCostProducts(price, usage);
      const cost = computeUsageCost(price, usage);
      if (!cost.complete) {
        this.markAttemptUnknownInTransaction(
          attempt,
          'final_usage_has_unpriced_bucket',
          this.now(),
          usage,
        );
        return toAttemptView(this.attemptRow(attemptId)!);
      }
      const finalMicros = safeInteger(cost.total.micros, '最终扣款');
      const hold = this.db
        .prepare('SELECT * FROM wallet_hold WHERE attempt_id = ?')
        .get(attemptId) as
        | {
            hold_id: string;
            account_id: string;
            currency: string;
            amount_micros: number;
            status: string;
          }
        | undefined;
      if (!hold || hold.status !== 'active')
        throw new AppError(ErrCode.CONFLICT, '预占已释放或不存在', 409);
      const wallet = this.walletRow(attempt.account_id, attempt.currency);
      if (!wallet) throw new Error('预占关联钱包不存在');
      const heldAfter = wallet.held_micros - hold.amount_micros;
      const fundsForCharge = wallet.posted_micros - heldAfter;
      if (finalMicros > fundsForCharge) {
        const now = this.now();
        this.db
          .prepare(
            `UPDATE billing_attempt SET status = 'reconciliation_required', final_micros = ?,
           usage_json = ?, cost_lines_json = ?, settlement_fingerprint = ?, lease_expires_at = NULL,
           updated_at = ? WHERE attempt_id = ?`,
          )
          .run(
            finalMicros,
            JSON.stringify(usage),
            JSON.stringify(cost.lineItems),
            settleFingerprint,
            now,
            attemptId,
          );
        this.ensureReconciliationCase(attemptId, 'insufficient_available_for_final_charge', now);
        this.audit({
          action: 'billing.attempt.settlement_blocked',
          targetAccountId: attempt.account_id,
          attemptId,
          reason: 'insufficient_available_for_final_charge',
          details: { finalMicros, holdMicros: hold.amount_micros },
          now,
        });
        return toAttemptView(this.attemptRow(attemptId)!);
      }
      const now = this.now();
      this.applyMovement({
        wallet,
        postedDelta: -finalMicros,
        heldDelta: -hold.amount_micros,
        entryType: 'settlement',
        amountMicros: finalMicros,
        idempotencyKey: `billing-settlement:${attemptId}`,
        requestFingerprint: settleFingerprint,
        attemptId,
        holdId: hold.hold_id,
        actorAccountId,
        action: actorAccountId ? 'billing.reconciliation.final_usage' : 'billing.attempt.settle',
        reason: resolutionNote,
        details: {
          finalMicros,
          priceVersionId: attempt.price_version_id,
          costLines: cost.lineItems,
        },
        now,
      });
      this.db
        .prepare(`UPDATE wallet_hold SET status = 'settled', updated_at = ? WHERE attempt_id = ?`)
        .run(now, attemptId);
      this.db
        .prepare(
          `UPDATE billing_attempt SET status = 'settled', final_micros = ?, usage_json = ?,
         cost_lines_json = ?, settlement_fingerprint = ?, lease_expires_at = NULL,
         updated_at = ?, settled_at = ? WHERE attempt_id = ?`,
        )
        .run(
          finalMicros,
          JSON.stringify(usage),
          JSON.stringify(cost.lineItems),
          settleFingerprint,
          now,
          now,
          attemptId,
        );
      this.resolveReconciliationCase(attemptId, 'final_usage', actorAccountId, resolutionNote, now);
      return toAttemptView(this.attemptRow(attemptId)!);
    });
    return tx.immediate();
  }

  /** Release a hold only after the trusted gateway received a definite upstream rejection. */
  releaseRejectedAttempt(input: { attemptId: string; reason: string }): BillingAttemptView {
    const attemptId = ulidSchema.parse(input.attemptId);
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500)
      throw new AppError(ErrCode.BAD_REQUEST, '上游拒绝原因无效', 400);
    const tx = this.db.transaction(() => {
      const attempt = this.attemptRow(attemptId);
      if (!attempt) throw new AppError(ErrCode.NOT_FOUND, '计费请求不存在', 404);
      if (attempt.status === 'released') return toAttemptView(attempt);
      if (attempt.status !== 'reserved' || attempt.dispatch_state !== 'dispatched') {
        throw new AppError(ErrCode.CONFLICT, '只有已派发且被上游明确拒绝的请求才能释放预占', 409);
      }
      const hold = this.db
        .prepare('SELECT * FROM wallet_hold WHERE attempt_id = ?')
        .get(attemptId) as { hold_id: string; amount_micros: number; status: string } | undefined;
      const wallet = this.walletRow(attempt.account_id, attempt.currency);
      if (!hold || hold.status !== 'active' || !wallet)
        throw new AppError(ErrCode.CONFLICT, '有效预占不存在', 409);
      const now = this.now();
      this.applyMovement({
        wallet,
        postedDelta: 0,
        heldDelta: -hold.amount_micros,
        entryType: 'release',
        amountMicros: hold.amount_micros,
        idempotencyKey: `billing-release:${attemptId}`,
        requestFingerprint: fingerprint({ attemptId, reason, rejectedByUpstream: true }),
        attemptId,
        holdId: hold.hold_id,
        reason,
        action: 'billing.attempt.upstream_rejected',
        details: { releasedMicros: hold.amount_micros, dispatchState: attempt.dispatch_state },
        now,
      });
      this.db
        .prepare("UPDATE wallet_hold SET status = 'released', updated_at = ? WHERE attempt_id = ?")
        .run(now, attemptId);
      this.db
        .prepare(
          `UPDATE billing_attempt SET status = 'released', lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ?`,
        )
        .run(now, attemptId);
      return toAttemptView(this.attemptRow(attemptId)!);
    });
    return tx.immediate();
  }

  releaseUndispatched(input: {
    attemptId: string;
    reason: string;
    actorAccountId?: string;
  }): BillingAttemptView {
    const attemptId = ulidSchema.parse(input.attemptId);
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500)
      throw new AppError(ErrCode.BAD_REQUEST, '释放原因无效', 400);
    const tx = this.db.transaction(() => {
      const attempt = this.attemptRow(attemptId);
      if (!attempt) throw new AppError(ErrCode.NOT_FOUND, '计费请求不存在', 404);
      if (attempt.status === 'released') return toAttemptView(attempt);
      const manualResolution = input.actorAccountId !== undefined;
      const allowed =
        (attempt.status === 'reserved' && attempt.dispatch_state === 'not_dispatched') ||
        (manualResolution &&
          (attempt.status === 'unknown_pending_reconciliation' ||
            attempt.status === 'reconciliation_required'));
      if (!allowed) throw new AppError(ErrCode.CONFLICT, '只有确认未执行的请求才能释放预占', 409);
      if (manualResolution && !this.hasOpenReconciliationCase(attemptId)) {
        throw new AppError(ErrCode.CONFLICT, '请求不在待处理对账队列中', 409);
      }
      const hold = this.db
        .prepare('SELECT * FROM wallet_hold WHERE attempt_id = ?')
        .get(attemptId) as { hold_id: string; amount_micros: number; status: string } | undefined;
      const wallet = this.walletRow(attempt.account_id, attempt.currency);
      if (!hold || hold.status !== 'active' || !wallet)
        throw new AppError(ErrCode.CONFLICT, '有效预占不存在', 409);
      const now = this.now();
      this.applyMovement({
        wallet,
        postedDelta: 0,
        heldDelta: -hold.amount_micros,
        entryType: 'release',
        amountMicros: hold.amount_micros,
        idempotencyKey: `billing-release:${attemptId}`,
        requestFingerprint: fingerprint({ attemptId, reason }),
        attemptId,
        holdId: hold.hold_id,
        actorAccountId: input.actorAccountId ?? null,
        action: manualResolution
          ? 'billing.reconciliation.no_execution'
          : 'billing.attempt.release',
        reason,
        details: { releasedMicros: hold.amount_micros },
        now,
      });
      this.db
        .prepare("UPDATE wallet_hold SET status = 'released', updated_at = ? WHERE attempt_id = ?")
        .run(now, attemptId);
      this.db
        .prepare(
          `UPDATE billing_attempt SET status = 'released', lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ?`,
        )
        .run(now, attemptId);
      this.resolveReconciliationCase(
        attemptId,
        'no_upstream_execution',
        input.actorAccountId ?? null,
        reason,
        now,
      );
      return toAttemptView(this.attemptRow(attemptId)!);
    });
    return tx.immediate();
  }

  resolveReconciliation(
    input:
      | {
          attemptId: string;
          outcome: 'no_upstream_execution';
          reason: string;
          actorAccountId: string;
        }
      | {
          attemptId: string;
          outcome: 'final_usage';
          usage: NormalizedUsage;
          reason: string;
          actorAccountId: string;
        },
  ): BillingAttemptView {
    const caseRow = this.db
      .prepare(
        'SELECT status, resolution, resolution_note FROM billing_reconciliation_case WHERE attempt_id = ?',
      )
      .get(input.attemptId) as
      | { status: 'open' | 'resolved'; resolution: string | null; resolution_note: string | null }
      | undefined;
    if (!caseRow) {
      throw new AppError(ErrCode.NOT_FOUND, '待处理对账记录不存在', 404);
    }
    const reason = input.reason.trim();
    if (caseRow.status === 'resolved') {
      const attempt = this.getAdminAttempt(input.attemptId);
      const sameResolution =
        caseRow.resolution === input.outcome &&
        caseRow.resolution_note === reason &&
        (input.outcome === 'no_upstream_execution'
          ? attempt?.status === 'released'
          : (attempt?.status === 'settled' || attempt?.status === 'reversed') &&
            attempt.usage !== null &&
            fingerprint(attempt.usage) === fingerprint(input.usage));
      if (attempt && sameResolution) return attempt;
      throw new AppError(ErrCode.IDEMPOTENCY_CONFLICT, '该对账记录已用不同结果处理', 409);
    }
    if (input.outcome === 'no_upstream_execution') {
      return this.releaseUndispatched({
        attemptId: input.attemptId,
        reason,
        actorAccountId: input.actorAccountId,
      });
    }
    const result = this.settleTrustedUsage(
      input.attemptId,
      input.usage,
      input.actorAccountId,
      reason,
    );
    if (
      result.status === 'unknown_pending_reconciliation' ||
      result.status === 'reconciliation_required'
    ) {
      throw new AppError(ErrCode.CONFLICT, '最终用量尚未结算，预占保持冻结并留在对账队列', 409);
    }
    return result;
  }

  reverseSettlement(input: {
    attemptId: string;
    idempotencyKey: string;
    reason: string;
    actorAccountId: string;
  }): { entry: WalletLedgerEntry; wallet: WalletSnapshot; replayed: boolean } {
    const attemptId = ulidSchema.parse(input.attemptId);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500)
      throw new AppError(ErrCode.BAD_REQUEST, '冲正原因无效', 400);
    const requestFingerprint = fingerprint({ attemptId, reason });
    const tx = this.db.transaction(() => {
      const attempt = this.attemptRow(attemptId);
      if (!attempt) throw new AppError(ErrCode.NOT_FOUND, '计费请求不存在', 404);
      const ledgerKey = `admin-reversal:${idempotencyKey}`;
      const existingByKey = this.db
        .prepare('SELECT * FROM wallet_ledger_entry WHERE account_id = ? AND idempotency_key = ?')
        .get(attempt.account_id, ledgerKey) as
        (LedgerRow & { request_fingerprint: string }) | undefined;
      if (existingByKey) {
        if (existingByKey.request_fingerprint !== requestFingerprint) {
          throw new AppError(ErrCode.IDEMPOTENCY_CONFLICT, '相同幂等键对应了不同的冲正', 409);
        }
        return {
          entry: toLedgerEntry(existingByKey),
          wallet: this.getWallet(attempt.account_id, attempt.currency),
          replayed: true,
        };
      }
      if (attempt.status !== 'settled' || attempt.final_micros === null) {
        throw new AppError(ErrCode.CONFLICT, '只有已结算且未冲正的请求可以冲正', 409);
      }
      const settlement = this.db
        .prepare(
          "SELECT * FROM wallet_ledger_entry WHERE attempt_id = ? AND entry_type = 'settlement'",
        )
        .get(attemptId) as LedgerRow | undefined;
      if (!settlement) throw new Error('结算流水不存在');
      const wallet = this.walletRow(attempt.account_id, attempt.currency);
      if (!wallet) throw new Error('钱包不存在');
      const entry = this.applyMovement({
        wallet,
        postedDelta: attempt.final_micros,
        heldDelta: 0,
        entryType: 'reversal',
        amountMicros: attempt.final_micros,
        idempotencyKey: ledgerKey,
        requestFingerprint,
        attemptId,
        reversesEntryId: settlement.entry_id,
        actorAccountId: input.actorAccountId,
        action: 'billing.settlement.reverse',
        reason,
        details: { reversedEntryId: settlement.entry_id, amountMicros: attempt.final_micros },
      });
      const now = this.now();
      this.db
        .prepare(
          "UPDATE billing_attempt SET status = 'reversed', updated_at = ? WHERE attempt_id = ?",
        )
        .run(now, attemptId);
      return {
        entry,
        wallet: this.getWallet(attempt.account_id, attempt.currency),
        replayed: false,
      };
    });
    return tx.immediate();
  }

  private assertBudgets(
    accountId: string,
    currency: string,
    newHoldMicros: number,
    now: number,
  ): void {
    const policy = this.db
      .prepare(
        'SELECT daily_limit_micros, monthly_limit_micros FROM wallet_budget_policy WHERE account_id = ? AND currency = ?',
      )
      .get(accountId, currency) as
      { daily_limit_micros: number | null; monthly_limit_micros: number | null } | undefined;
    if (!policy) return;
    const totalActiveHolds = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount_micros), 0) AS total FROM wallet_hold WHERE account_id = ? AND currency = ? AND status = 'active'",
      )
      .get(accountId, currency) as { total: number };
    const activeHolds = safeInteger(totalActiveHolds.total, '活动预占合计');
    const dayStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    for (const [label, cap, start] of [
      ['日', policy.daily_limit_micros, dayStart],
      ['月', policy.monthly_limit_micros, monthStart],
    ] as const) {
      if (cap === null) continue;
      const spentRow = this.db
        .prepare(
          `SELECT COALESCE(SUM(CASE
             WHEN entry_type = 'settlement' THEN amount_micros
             WHEN entry_type = 'reversal' THEN -amount_micros
             ELSE 0 END), 0) AS total
         FROM wallet_ledger_entry WHERE account_id = ? AND currency = ? AND created_at >= ?`,
        )
        .get(accountId, currency, start) as { total: number };
      const spent = Math.max(
        0,
        safeInteger(spentRow.total, `${label}已用预算`, Number.MIN_SAFE_INTEGER),
      );
      const committed = sumSafe([spent, activeHolds, newHoldMicros], `${label}预算占用`);
      if (committed > cap) throw new AppError('BUDGET_EXCEEDED', `${label}平台钱包预算不足`, 409);
    }
  }

  private getApplicablePrice(
    priceVersionId: string,
    routeKey: string,
    at: number,
  ): PriceVersion | null {
    const platform = this.db
      .prepare(
        `SELECT pv.*, p.status AS provider_status, m.status AS model_status
       FROM platform_price_version pv
       JOIN platform_provider p ON p.provider_id = pv.provider_id
       JOIN platform_model m ON m.provider_id = pv.provider_id AND m.model_id = pv.model_id
       WHERE pv.price_version_id = ?`,
      )
      .get(priceVersionId) as PlatformPriceRow | undefined;
    if (platform) {
      if (
        platform.provider_model_key !== routeKey ||
        platform.provider_status !== 'active' ||
        platform.model_status !== 'active'
      )
        return null;
      const next = this.db
        .prepare(
          'SELECT MIN(effective_from) AS next_from FROM platform_price_version WHERE provider_model_key = ? AND effective_from > ?',
        )
        .get(routeKey, platform.effective_from) as { next_from: number | null };
      const price = priceVersionSchema.parse({
        priceVersionId: platform.price_version_id,
        providerModelKey: platform.provider_model_key,
        billingMode: platform.billing_mode,
        currency: platform.currency,
        rates: JSON.parse(platform.rates_json) as PriceRates,
        cacheWriteRateSemantics: 'full_rate',
        source: JSON.parse(platform.source_json) as PriceVersion['source'],
        effectiveFrom: platform.effective_from,
        effectiveTo: next.next_from,
        publishedAt: platform.published_at,
        version: platform.version,
      });
      return this.isPriceActive(price, at) ? price : null;
    }

    const routeParts = routeKey.split('/');
    const route = providerModelRouteSchema.safeParse({
      providerId: routeParts[0],
      modelId: routeParts[1],
    });
    if (!route.success) return null;
    const official = this.db
      .prepare(
        `SELECT o.*, p.status AS provider_status, m.status AS model_status,
              m.provider_id || '/' || m.model_id AS provider_model_key
       FROM platform_official_price_snapshot o
       JOIN platform_model m ON m.canonical_vendor = o.canonical_vendor AND m.canonical_model = o.canonical_model
       JOIN platform_provider p ON p.provider_id = m.provider_id
       WHERE o.snapshot_id = ? AND m.provider_id = ? AND m.model_id = ?`,
      )
      .get(priceVersionId, route.data.providerId, route.data.modelId) as
      OfficialPriceRow | undefined;
    if (
      !official ||
      official.provider_model_key !== routeKey ||
      official.provider_status !== 'active' ||
      official.model_status !== 'active'
    )
      return null;
    const next = this.db
      .prepare(
        `SELECT MIN(effective_from) AS next_from FROM platform_official_price_snapshot
       WHERE canonical_vendor = ? AND canonical_model = ? AND effective_from > ?`,
      )
      .get(official.canonical_vendor, official.canonical_model, official.effective_from) as {
      next_from: number | null;
    };
    const price = priceVersionSchema.parse({
      priceVersionId: official.snapshot_id,
      providerModelKey: routeKey,
      billingMode: official.billing_mode,
      currency: official.currency,
      rates: JSON.parse(official.rates_json) as PriceRates,
      cacheWriteRateSemantics: 'full_rate',
      source: {
        kind: 'official_vendor',
        evidenceUrl: official.source_url,
        verifiedAt: official.verified_at,
      },
      effectiveFrom: official.effective_from,
      effectiveTo: next.next_from,
      publishedAt: official.published_at,
      version: official.version,
    });
    return this.isPriceActive(price, at) ? price : null;
  }

  private isPriceActive(price: PriceVersion, at: number): boolean {
    return price.effectiveFrom <= at && (price.effectiveTo === null || at < price.effectiveTo);
  }

  private ensureAccountExists(accountId: string): void {
    if (!this.db.prepare('SELECT 1 FROM account_user WHERE id = ?').get(accountId)) {
      throw new AppError(ErrCode.NOT_FOUND, '账号不存在', 404);
    }
  }

  private ensureWallet(accountId: string, currency: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO wallet_account(account_id, currency, posted_micros, held_micros, revision, updated_at)
       VALUES (?, ?, 0, 0, 1, ?)`,
      )
      .run(accountId, currency, this.now());
  }

  private walletRow(accountId: string, currency: string): WalletRow | undefined {
    return this.db
      .prepare('SELECT * FROM wallet_account WHERE account_id = ? AND currency = ?')
      .get(accountId, currency) as WalletRow | undefined;
  }

  private attemptRow(attemptId: string): AttemptRow | undefined {
    return this.db.prepare('SELECT * FROM billing_attempt WHERE attempt_id = ?').get(attemptId) as
      AttemptRow | undefined;
  }

  private applyMovement(input: {
    wallet: WalletRow;
    postedDelta: number;
    heldDelta: number;
    entryType: LedgerRow['entry_type'];
    amountMicros: number;
    idempotencyKey: string;
    requestFingerprint: string;
    attemptId?: string;
    holdId?: string;
    reversesEntryId?: string;
    reason?: string | null;
    actorAccountId?: string | null;
    action: string;
    details: Record<string, unknown>;
    now?: number;
  }): WalletLedgerEntry {
    const now = input.now ?? this.now();
    const posted = safeInteger(input.wallet.posted_micros + input.postedDelta, '入账余额');
    const held = safeInteger(input.wallet.held_micros + input.heldDelta, '冻结余额');
    if (held > posted) throw new AppError('INSUFFICIENT_BALANCE', '钱包余额不足以支持该流水', 409);
    const entryId = newUlid(now);
    this.db
      .prepare(
        `INSERT INTO wallet_ledger_entry
        (entry_id, account_id, currency, entry_type, amount_micros, posted_delta, held_delta,
         idempotency_key, request_fingerprint, attempt_id, hold_id, reverses_entry_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryId,
        input.wallet.account_id,
        input.wallet.currency,
        input.entryType,
        safeInteger(input.amountMicros, '流水金额'),
        input.postedDelta,
        input.heldDelta,
        input.idempotencyKey,
        input.requestFingerprint,
        input.attemptId ?? null,
        input.holdId ?? null,
        input.reversesEntryId ?? null,
        input.reason ?? null,
        now,
      );
    this.db
      .prepare(
        `UPDATE wallet_account SET posted_micros = ?, held_micros = ?, revision = revision + 1, updated_at = ?
       WHERE account_id = ? AND currency = ?`,
      )
      .run(posted, held, now, input.wallet.account_id, input.wallet.currency);
    this.audit({
      action: input.action,
      actorAccountId: input.actorAccountId ?? null,
      targetAccountId: input.wallet.account_id,
      attemptId: input.attemptId ?? null,
      entryId,
      reason: input.reason ?? null,
      details: input.details,
      now,
    });
    const row = this.db
      .prepare('SELECT * FROM wallet_ledger_entry WHERE entry_id = ?')
      .get(entryId) as LedgerRow;
    return toLedgerEntry(row);
  }

  private audit(input: {
    action: string;
    actorAccountId?: string | null;
    targetAccountId?: string | null;
    attemptId?: string | null;
    entryId?: string | null;
    reason?: string | null;
    details: Record<string, unknown>;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO billing_audit_event
        (event_id, action, actor_account_id, target_account_id, attempt_id, entry_id, reason, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newUlid(input.now),
        input.action,
        input.actorAccountId ?? null,
        input.targetAccountId ?? null,
        input.attemptId ?? null,
        input.entryId ?? null,
        input.reason ?? null,
        JSON.stringify(input.details),
        input.now,
      );
  }

  private ensureReconciliationCase(attemptId: string, reason: string, now: number): void {
    const existing = this.db
      .prepare(
        "SELECT case_id FROM billing_reconciliation_case WHERE attempt_id = ? AND status = 'open'",
      )
      .get(attemptId);
    if (existing) return;
    this.db
      .prepare(
        `INSERT INTO billing_reconciliation_case
        (case_id, attempt_id, reason, status, created_at, due_at)
       VALUES (?, ?, ?, 'open', ?, ?)`,
      )
      .run(newUlid(now), attemptId, reason, now, now + this.reconciliationSlaMs);
  }

  private markAttemptUnknownInTransaction(
    attempt: AttemptRow,
    reason: string,
    now: number,
    observedUsage?: NormalizedUsage,
  ): void {
    const usageJson = observedUsage === undefined ? null : JSON.stringify(observedUsage);
    if (attempt.status === 'reserved') {
      this.db
        .prepare(
          `UPDATE billing_attempt SET status = 'unknown_pending_reconciliation',
         usage_json = COALESCE(usage_json, ?), lease_expires_at = NULL, updated_at = ? WHERE attempt_id = ?`,
        )
        .run(usageJson, now, attempt.attempt_id);
    } else if (observedUsage !== undefined) {
      this.db
        .prepare(
          'UPDATE billing_attempt SET usage_json = COALESCE(usage_json, ?), updated_at = ? WHERE attempt_id = ?',
        )
        .run(usageJson, now, attempt.attempt_id);
    }
    this.ensureReconciliationCase(attempt.attempt_id, reason, now);
    this.audit({
      action: 'billing.attempt.usage_unknown',
      targetAccountId: attempt.account_id,
      attemptId: attempt.attempt_id,
      reason,
      details: {
        holdRetained: true,
        observedUsageFingerprint: observedUsage === undefined ? null : fingerprint(observedUsage),
        observedUsageQuality: observedUsage?.quality ?? null,
      },
      now,
    });
  }

  private hasOpenReconciliationCase(attemptId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM billing_reconciliation_case WHERE attempt_id = ? AND status = 'open'",
        )
        .get(attemptId),
    );
  }

  private resolveReconciliationCase(
    attemptId: string,
    resolution: 'final_usage' | 'no_upstream_execution',
    resolvedBy: string | null,
    note: string | null,
    now: number,
  ): void {
    this.db
      .prepare(
        `UPDATE billing_reconciliation_case SET status = 'resolved', resolved_at = ?, resolved_by = ?,
       resolution = ?, resolution_note = ? WHERE attempt_id = ? AND status = 'open'`,
      )
      .run(now, resolvedBy, resolution, note, attemptId);
  }
}
