import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db.ts';
import type { NormalizedUsage } from '@ec/core/v2';
import type { ReserveAttemptInput } from '../models/wallet-ledger.ts';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(now = Date.now()): string {
  let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let result = '';
  for (let index = 0; index < 26; index += 1) {
    result = (alphabet[Number(value & 31n)] ?? '0') + result;
    value >>= 5n;
  }
  return result;
}

function usageEstimate(
  input: number,
  output: number,
  quality: NormalizedUsage['quality'] = 'context_estimate',
): NormalizedUsage {
  return {
    totalInput: input,
    uncachedInput: input,
    cacheReadInput: 0,
    cacheWriteInputByTtl: {},
    totalOutput: output,
    reasoningOutput: null,
    quality,
  };
}

let root: string;
let dbPath: string;
let database: Database;
let app: FastifyInstance;
let adminAccountIds: string[] = [];

async function openTestApp(): Promise<void> {
  database = openDatabase(dbPath);
  app = await buildApp(
    loadConfig({
      dbPath,
      platformAdminAccountIds: [...adminAccountIds],
      billingAttemptLeaseMs: 1_000,
      billingReconciliationSlaMs: 60_000,
    }),
    database,
  );
}

async function closeTestApp(): Promise<void> {
  if (app) await app.close();
  if (database?.open) database.close();
}

beforeEach(async () => {
  adminAccountIds = [];
  root = mkdtempSync(join(tmpdir(), 'everyone-coding-wallet-'));
  dbPath = join(root, 'account.sqlite');
  await openTestApp();
});

afterEach(async () => {
  await closeTestApp();
  rmSync(root, { recursive: true, force: true });
});

async function register(
  email = `${randomUUID()}@example.test`,
): Promise<{ accountId: string; token: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'Abcd1234' },
  });
  expect(response.statusCode).toBe(201);
  const result = response.json() as {
    identity: { accountId: string };
    tokens: { accessToken: string };
  };
  return { accountId: result.identity.accountId, token: result.tokens.accessToken };
}

async function makeAdmin(): Promise<{ accountId: string; token: string }> {
  const admin = await register();
  adminAccountIds.push(admin.accountId);
  app.appConfig.platformAdminAccountIds.push(admin.accountId);
  return admin;
}

async function request(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  options: { token?: string; payload?: unknown; idempotencyKey?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method,
    url,
    ...(options.payload === undefined
      ? {}
      : { payload: options.payload as Record<string, unknown> }),
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function createPrice(
  adminToken: string,
  inputRate = 1_000_000,
  outputRate = 1_000_000,
): Promise<{
  providerModelKey: string;
  priceVersionId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const providerResponse = await request('POST', '/api/admin/catalog/providers', {
    token: adminToken,
    payload: {
      displayName: `Wallet fixture ${suffix}`,
      protocol: 'openai',
      baseUrl: `https://fixture-${suffix}.example.test/v1`,
      credentialRef: `secret://fixture/${suffix}`,
      status: 'active',
    },
  });
  expect(providerResponse.status).toBe(201);
  const providerId = String((providerResponse.body.provider as Record<string, unknown>).providerId);
  const modelResponse = await request('POST', `/api/admin/catalog/providers/${providerId}/models`, {
    token: adminToken,
    payload: { upstreamModelName: `wallet-${suffix}`, displayName: `Wallet ${suffix}` },
  });
  expect(modelResponse.status).toBe(201);
  const modelId = String((modelResponse.body.model as Record<string, unknown>).modelId);
  const priceResponse = await request(
    'POST',
    `/api/admin/catalog/providers/${providerId}/models/${modelId}/prices`,
    {
      token: adminToken,
      payload: {
        currency: 'USD',
        rates: {
          uncachedInput: inputRate,
          cacheRead: inputRate,
          cacheWriteByTtl: {},
          output: outputRate,
        },
        effectiveFrom: 0,
      },
    },
  );
  expect(priceResponse.status).toBe(201);
  return {
    providerModelKey: `${providerId}/${modelId}`,
    priceVersionId: String((priceResponse.body.price as Record<string, unknown>).priceVersionId),
  };
}

async function credit(
  admin: { accountId: string; token: string },
  targetAccountId: string,
  amountMicros: number,
): Promise<void> {
  const result = await request('POST', `/api/admin/wallets/${targetAccountId}/adjustments`, {
    token: admin.token,
    idempotencyKey: `credit-${randomUUID()}`,
    payload: { currency: 'USD', amountMicros, reason: 'Synthetic test wallet credit' },
  });
  expect(result.status).toBe(201);
}

function reserveInput(
  accountId: string,
  price: { providerModelKey: string; priceVersionId: string },
  reserveTokens: number,
  key: string,
): ReserveAttemptInput {
  return {
    accountId,
    attemptId: ulid(),
    logicalRequestId: `logical-${randomUUID()}`,
    idempotencyKey: key,
    providerModelKey: price.providerModelKey,
    priceVersionId: price.priceVersionId,
    usageEstimate: usageEstimate(reserveTokens, 0),
  };
}

interface WorkerMessage {
  ready?: boolean;
  ok?: boolean;
  code?: string;
  attempt?: { attemptId: string };
  wallet?: { availableMicros: number; heldMicros: number };
}

function workerWithMessages(input: ReserveAttemptInput): {
  worker: Worker;
  nextMessage: () => Promise<WorkerMessage>;
} {
  const worker = new Worker(new URL('./wallet-reserve-worker.ts', import.meta.url), {
    workerData: { dbPath, input },
    execArgv: [
      '--experimental-transform-types',
      '--experimental-loader',
      new URL('./wallet-ts-loader.mjs', import.meta.url).href,
    ],
  });
  const buffered: WorkerMessage[] = [];
  const waiters: Array<(value: WorkerMessage) => void> = [];
  worker.on('message', (message: WorkerMessage) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else buffered.push(message);
  });
  return {
    worker,
    nextMessage: () => {
      const message = buffered.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

describe('V2-D11 server wallet ledger', () => {
  it('serializes concurrent real SQLite reservations across independent worker threads without overdraft', async () => {
    const admin = await makeAdmin();
    const user = await register();
    const price = await createPrice(admin.token);
    await credit(admin, user.accountId, 10_000);

    const first = workerWithMessages(reserveInput(user.accountId, price, 6_000, 'parallel-one'));
    const second = workerWithMessages(reserveInput(user.accountId, price, 6_000, 'parallel-two'));
    expect(await Promise.all([first.nextMessage(), second.nextMessage()])).toEqual([
      { ready: true },
      { ready: true },
    ]);
    const outcomes = Promise.all([first.nextMessage(), second.nextMessage()]);
    first.worker.postMessage('reserve');
    second.worker.postMessage('reserve');
    const results = await outcomes;
    await Promise.all([first.worker.terminate(), second.worker.terminate()]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.code).toBe('INSUFFICIENT_BALANCE');
    const wallet = app.walletLedger.getWallet(user.accountId, 'USD');
    expect(wallet).toMatchObject({
      postedMicros: 10_000,
      heldMicros: 6_000,
      availableMicros: 4_000,
    });
    const entries = app.walletLedger.listLedger(user.accountId, 'USD');
    expect(entries.filter((entry) => entry.type === 'hold')).toHaveLength(1);
  });

  it('binds settlement to the accepted price snapshot, replays once, and records an audited reversal', async () => {
    const admin = await makeAdmin();
    const user = await register();
    const price = await createPrice(admin.token, 1_000_000, 3_000_000);
    await credit(admin, user.accountId, 50_000);
    const input = reserveInput(user.accountId, price, 2_000, 'settle-once');
    const first = app.walletLedger.reserveAttempt(input);
    const replay = app.walletLedger.reserveAttempt(input);
    expect(replay.replayed).toBe(true);
    expect(replay.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(first.attempt.priceSnapshot.priceVersionId).toBe(price.priceVersionId);
    const [providerId, modelId] = price.providerModelKey.split('/');
    const changedPrice = await request(
      'POST',
      `/api/admin/catalog/providers/${providerId}/models/${modelId}/prices`,
      {
        token: admin.token,
        payload: {
          currency: 'USD',
          rates: {
            uncachedInput: 9_000_000,
            cacheRead: 9_000_000,
            cacheWriteByTtl: {},
            output: 9_000_000,
          },
          effectiveFrom: Date.now() + 60_000,
        },
      },
    );
    expect(changedPrice.status).toBe(201);

    const usage = usageEstimate(1_000, 500, 'upstream_final');
    app.walletLedger.markUnknown(first.attempt.attemptId, 'simulated upstream disconnect');
    await closeTestApp();
    await openTestApp();

    expect(app.walletLedger.listOpenReconciliation()).toHaveLength(1);
    const resolved = await request(
      'POST',
      `/api/admin/billing/reconciliation/${first.attempt.attemptId}/resolve`,
      {
        token: admin.token,
        payload: { outcome: 'final_usage', reason: 'upstream query confirmed final usage', usage },
      },
    );
    expect(resolved.status).toBe(200);
    const resolvedReplay = await request(
      'POST',
      `/api/admin/billing/reconciliation/${first.attempt.attemptId}/resolve`,
      {
        token: admin.token,
        payload: { outcome: 'final_usage', reason: 'upstream query confirmed final usage', usage },
      },
    );
    expect(resolvedReplay.status).toBe(200);
    expect((resolved.body.attempt as Record<string, unknown>).status).toBe('settled');
    const repeated = app.walletLedger.settleTrustedUsage(first.attempt.attemptId, usage);
    expect(repeated.status).toBe('settled');
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM wallet_ledger_entry WHERE attempt_id = ? AND entry_type = 'settlement'",
        )
        .get(first.attempt.attemptId),
    ).toMatchObject({ n: 1 });
    expect(repeated.finalMicros).toBe(2_500);
    expect(repeated.priceSnapshot.rates.output).toBe(3_000_000);

    const reversal = await request(
      'POST',
      `/api/admin/billing/attempts/${first.attempt.attemptId}/reversal`,
      {
        token: admin.token,
        idempotencyKey: 'reversal-once',
        payload: { reason: 'verified duplicate provider charge correction' },
      },
    );
    expect(reversal.status).toBe(201);
    const reversalReplay = await request(
      'POST',
      `/api/admin/billing/attempts/${first.attempt.attemptId}/reversal`,
      {
        token: admin.token,
        idempotencyKey: 'reversal-once',
        payload: { reason: 'verified duplicate provider charge correction' },
      },
    );
    expect(reversalReplay.status).toBe(200);
    expect(app.walletLedger.getWallet(user.accountId, 'USD')).toMatchObject({
      postedMicros: 50_000,
      heldMicros: 0,
      availableMicros: 50_000,
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM wallet_ledger_entry WHERE attempt_id = ? AND entry_type = 'reversal'",
        )
        .get(first.attempt.attemptId),
    ).toMatchObject({ n: 1 });
    expect(
      database
        .prepare('SELECT COUNT(*) AS n FROM billing_audit_event WHERE attempt_id = ?')
        .get(first.attempt.attemptId),
    ).toMatchObject({ n: 4 });
    const other = await register();
    expect(
      (
        await request('GET', `/api/billing/attempts/${first.attempt.attemptId}`, {
          token: other.token,
        })
      ).status,
    ).toBe(404);
    const ownWallet = await request('GET', '/api/wallets/USD', { token: user.token });
    expect(ownWallet.body.wallet).toMatchObject({ postedMicros: 50_000, availableMicros: 50_000 });
    expect((await request('GET', '/api/wallets/USD/ledger', { token: user.token })).status).toBe(
      200,
    );
    expect(
      (
        await request('POST', '/api/billing/attempts', {
          token: user.token,
          payload: { amountMicros: 1, attemptId: first.attempt.attemptId },
        })
      ).status,
    ).toBe(404);
  });

  it('uses only an audited official snapshot when that exact model identity matches', async () => {
    const admin = await makeAdmin();
    const user = await register();
    const suffix = randomUUID().slice(0, 8);
    const providerResponse = await request('POST', '/api/admin/catalog/providers', {
      token: admin.token,
      payload: {
        displayName: `Official fixture ${suffix}`,
        protocol: 'openai',
        baseUrl: `https://official-fixture-${suffix}.example.test/v1`,
        credentialRef: `secret://fixture/${suffix}`,
        status: 'active',
      },
    });
    expect(providerResponse.status).toBe(201);
    const providerId = String(
      (providerResponse.body.provider as Record<string, unknown>).providerId,
    );
    const modelResponse = await request(
      'POST',
      `/api/admin/catalog/providers/${providerId}/models`,
      {
        token: admin.token,
        payload: {
          upstreamModelName: `official-${suffix}`,
          displayName: `Official ${suffix}`,
          canonicalVendor: 'synthetic-vendor',
          canonicalModel: 'synthetic-model',
        },
      },
    );
    expect(modelResponse.status).toBe(201);
    const modelId = String((modelResponse.body.model as Record<string, unknown>).modelId);
    const official = await request('POST', '/api/admin/catalog/official-prices', {
      token: admin.token,
      payload: {
        canonicalVendor: 'synthetic-vendor',
        canonicalModel: 'synthetic-model',
        currency: 'USD',
        rates: {
          uncachedInput: 2_000_000,
          cacheRead: 2_000_000,
          cacheWriteByTtl: {},
          output: 4_000_000,
        },
        sourceUrl: 'https://vendor.example.test/synthetic-pricing',
        verifiedAt: 0,
        evidenceVersion: 'synthetic-evidence-v1',
        evidenceSnapshot: 'Synthetic pricing evidence; not a real vendor offer.',
        conditions: 'Synthetic fixture, per million tokens.',
        effectiveFrom: 0,
      },
    });
    expect(official.status).toBe(201);
    const price = {
      providerModelKey: `${providerId}/${modelId}`,
      priceVersionId: String((official.body.price as Record<string, unknown>).snapshotId),
    };
    await credit(admin, user.accountId, 20_000);
    const held = app.walletLedger.reserveAttempt(
      reserveInput(user.accountId, price, 2_000, 'official-snapshot'),
    );
    expect(held.attempt.priceSnapshot.source.kind).toBe('official_vendor');
    const settled = app.walletLedger.settleTrustedUsage(
      held.attempt.attemptId,
      usageEstimate(1_000, 500, 'upstream_final'),
    );
    expect(settled.finalMicros).toBe(4_000);
    expect(app.walletLedger.getWallet(user.accountId, 'USD').availableMicros).toBe(16_000);
  });

  it('recovers an expired in-flight lease to an auditable unknown case and releases only after verified no-execution', async () => {
    const admin = await makeAdmin();
    const user = await register();
    const price = await createPrice(admin.token);
    await credit(admin, user.accountId, 20_000);
    const input = reserveInput(user.accountId, price, 4_000, 'recovery-hold');
    const held = app.walletLedger.reserveAttempt(input);
    const recovered = app.walletLedger.recoverExpiredAttempts(Date.now() + 2_000);
    expect(recovered).toBe(1);
    await closeTestApp();
    await openTestApp();

    expect(app.walletLedger.listOpenReconciliation()).toMatchObject([
      expect.objectContaining({
        attemptId: held.attempt.attemptId,
        reason: 'lease_expired_during_recovery',
      }),
    ]);
    expect(app.walletLedger.getWallet(user.accountId, 'USD')).toMatchObject({
      postedMicros: 20_000,
      heldMicros: 4_000,
      availableMicros: 16_000,
    });
    const resolution = await request(
      'POST',
      `/api/admin/billing/reconciliation/${held.attempt.attemptId}/resolve`,
      {
        token: admin.token,
        payload: {
          outcome: 'no_upstream_execution',
          reason: 'gateway audit proves dispatch did not occur',
        },
      },
    );
    expect(resolution.status).toBe(200);
    const resolutionReplay = await request(
      'POST',
      `/api/admin/billing/reconciliation/${held.attempt.attemptId}/resolve`,
      {
        token: admin.token,
        payload: {
          outcome: 'no_upstream_execution',
          reason: 'gateway audit proves dispatch did not occur',
        },
      },
    );
    expect(resolutionReplay.status).toBe(200);
    expect((resolution.body.attempt as Record<string, unknown>).status).toBe('released');
    expect(app.walletLedger.listOpenReconciliation()).toHaveLength(0);
    expect(app.walletLedger.getWallet(user.accountId, 'USD').availableMicros).toBe(20_000);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM wallet_ledger_entry WHERE attempt_id = ? AND entry_type = 'release'",
        )
        .get(held.attempt.attemptId),
    ).toMatchObject({ n: 1 });
  });

  it('keeps a dispatched cancellation frozen as unknown until final usage is reconciled', async () => {
    const admin = await makeAdmin();
    const user = await register();
    const price = await createPrice(admin.token);
    await credit(admin, user.accountId, 10_000);
    const held = app.walletLedger.reserveAttempt(
      reserveInput(user.accountId, price, 2_000, 'cancel-race'),
    );
    expect(app.walletLedger.markAttemptDispatched(held.attempt.attemptId)).toBe(true);
    expect(() =>
      app.walletLedger.releaseUndispatched({
        attemptId: held.attempt.attemptId,
        reason: 'cancel pressed after upstream dispatch began',
      }),
    ).toThrow(/确认未执行/);

    app.walletLedger.markUnknown(held.attempt.attemptId, 'cancel raced with upstream execution');
    expect(() =>
      app.walletLedger.releaseUndispatched({
        attemptId: held.attempt.attemptId,
        reason: 'cancel does not prove upstream did not execute',
      }),
    ).toThrow(/确认未执行/);
    expect(app.walletLedger.getWallet(user.accountId, 'USD')).toMatchObject({
      postedMicros: 10_000,
      heldMicros: 2_000,
      availableMicros: 8_000,
    });

    const settled = app.walletLedger.settleTrustedUsage(
      held.attempt.attemptId,
      usageEstimate(1_000, 0, 'upstream_final'),
    );
    expect(settled.status).toBe('settled');
    expect(app.walletLedger.getWallet(user.accountId, 'USD')).toMatchObject({
      postedMicros: 9_000,
      heldMicros: 0,
      availableMicros: 9_000,
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM wallet_ledger_entry WHERE attempt_id = ? AND entry_type IN ('settlement', 'release')",
        )
        .get(held.attempt.attemptId),
    ).toMatchObject({ n: 1 });
  });

  it('checks daily budgets in the reservation transaction and rejects changed idempotent adjustments', async () => {
    const admin = await makeAdmin();
    const user = await register();
    const price = await createPrice(admin.token);
    await credit(admin, user.accountId, 100_000);
    const budget = await request('PUT', `/api/admin/wallets/${user.accountId}/budgets`, {
      token: admin.token,
      payload: {
        currency: 'USD',
        dailyLimitMicros: 5_000,
        monthlyLimitMicros: null,
        reason: 'Synthetic fixture cap',
      },
    });
    expect(budget.status).toBe(200);
    app.walletLedger.reserveAttempt(reserveInput(user.accountId, price, 3_000, 'budget-one'));
    expect(() =>
      app.walletLedger.reserveAttempt(reserveInput(user.accountId, price, 3_000, 'budget-two')),
    ).toThrow(/日平台钱包预算不足/);
    const cleared = await request('PUT', `/api/admin/wallets/${user.accountId}/budgets`, {
      token: admin.token,
      payload: {
        currency: 'USD',
        dailyLimitMicros: null,
        monthlyLimitMicros: null,
        reason: 'Remove synthetic test cap',
      },
    });
    expect(cleared.status).toBe(200);
    expect(
      app.walletLedger.reserveAttempt(
        reserveInput(user.accountId, price, 3_000, 'budget-after-clear'),
      ).attempt.status,
    ).toBe('reserved');

    const adjustKey = 'one-adjustment-only';
    const adjustment = await request('POST', `/api/admin/wallets/${user.accountId}/adjustments`, {
      token: admin.token,
      idempotencyKey: adjustKey,
      payload: { currency: 'USD', amountMicros: 1_000, reason: 'manual test correction' },
    });
    expect(adjustment.status).toBe(201);
    const conflictingAdjustment = await request(
      'POST',
      `/api/admin/wallets/${user.accountId}/adjustments`,
      {
        token: admin.token,
        idempotencyKey: adjustKey,
        payload: { currency: 'USD', amountMicros: 2_000, reason: 'different manual correction' },
      },
    );
    expect(conflictingAdjustment.status).toBe(409);
    expect(app.walletLedger.getWallet(user.accountId, 'USD').postedMicros).toBe(101_000);
  });

  it('rolls back wallet, hold and attempt together when a ledger insert fails, including after reopen', async () => {
    const admin = await makeAdmin();
    const user = await register();
    const price = await createPrice(admin.token);
    await credit(admin, user.accountId, 20_000);
    const input = reserveInput(user.accountId, price, 4_000, 'rollback-reserve');
    expect(() =>
      database
        .prepare(
          'UPDATE wallet_account SET posted_micros = posted_micros + 1, revision = revision + 1, updated_at = ? WHERE account_id = ? AND currency = ?',
        )
        .run(Date.now(), user.accountId, 'USD'),
    ).toThrow(/matching ledger entry/);
    database.exec(`CREATE TRIGGER wallet_test_abort_hold BEFORE INSERT ON wallet_ledger_entry
      WHEN NEW.entry_type = 'hold' BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END`);
    expect(() => app.walletLedger.reserveAttempt(input)).toThrow(/injected ledger failure/);
    expect(app.walletLedger.getWallet(user.accountId, 'USD')).toMatchObject({
      postedMicros: 20_000,
      heldMicros: 0,
      availableMicros: 20_000,
    });
    expect(
      database
        .prepare('SELECT COUNT(*) AS n FROM billing_attempt WHERE attempt_id = ?')
        .get(input.attemptId),
    ).toMatchObject({ n: 0 });
    expect(
      database
        .prepare('SELECT COUNT(*) AS n FROM wallet_hold WHERE attempt_id = ?')
        .get(input.attemptId),
    ).toMatchObject({ n: 0 });
    database.exec('DROP TRIGGER wallet_test_abort_hold');
    await closeTestApp();
    await openTestApp();
    expect(app.walletLedger.getWallet(user.accountId, 'USD').availableMicros).toBe(20_000);
    expect(app.walletLedger.listAttempts(user.accountId)).toHaveLength(0);
  });
});
