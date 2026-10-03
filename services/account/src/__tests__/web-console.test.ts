import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db.ts';
import { PlatformCatalogDb } from '../models/platform-catalog.ts';
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

let db: Database;
let app: FastifyInstance;
let owner: { id: string; token: string };
let other: { id: string; token: string };
let attemptIds: string[];
let providerId: string;
let modelId: string;
let priceVersionId: string;

async function register(email: string): Promise<{ id: string; token: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'Abcd1234' },
  });
  expect(response.statusCode).toBe(201);
  const payload = response.json() as {
    identity: { accountId: string };
    tokens: { accessToken: string };
  };
  return { id: payload.identity.accountId, token: payload.tokens.accessToken };
}

function createCatalogFixture(): void {
  const catalog = new PlatformCatalogDb(db);
  const now = Date.now();
  const provider = catalog.createProvider({
    displayName: 'Local D13 fixture',
    protocol: 'openai',
    baseUrl: 'https://fixture.example/v1',
    credentialRef: 'env:LOCAL_D13_FIXTURE',
    status: 'active',
    statusReason: null,
  });
  providerId = String(provider['providerId']);
  const model = catalog.createModel(providerId, {
    upstreamModelName: `model-${randomUUID()}`,
    displayName: 'Local model fixture',
    canonicalVendor: null,
    canonicalModel: null,
    contextWindowTokens: null,
    contextWindowSource: null,
    capabilities: null,
    status: 'active',
  });
  modelId = String(model?.['modelId']);
  const price = catalog.publishPrice(providerId, modelId, {
    currency: 'USD',
    rates: {
      uncachedInput: 1_000_000,
      cacheRead: 1_000_000,
      cacheWriteByTtl: {},
      output: 1_000_000,
    },
    sourceUrl: null,
    verifiedAt: null,
    effectiveFrom: now,
  });
  if (!price) throw new Error('fixture price creation failed');
  priceVersionId = price.priceVersionId;
}

function reserveInput(input: Partial<ReserveAttemptInput> = {}): ReserveAttemptInput {
  const usageEstimate = {
    totalInput: 1,
    uncachedInput: 1,
    cacheReadInput: 0,
    cacheWriteInputByTtl: {},
    totalOutput: 1,
    reasoningOutput: null,
    quality: 'context_estimate' as const,
  };
  return {
    accountId: owner.id,
    attemptId: ulid(),
    logicalRequestId: `web-${randomUUID()}`,
    idempotencyKey: `web-${randomUUID()}`,
    providerModelKey: `${providerId}/${modelId}`,
    priceVersionId,
    usageEstimate,
    projectId: 'project_fixture_01',
    sessionId: 'session_fixture_01',
    ...input,
  };
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  app = await buildApp(
    loadConfig({
      dbPath: ':memory:',
      jwtSecret: 'web-console-test-secret-0123456789',
      platformAdminAccountIds: [],
      enableDevEmailOutbox: false,
    }),
    db,
  );
  owner = await register(`${randomUUID()}@web.test`);
  other = await register(`${randomUUID()}@web.test`);
  attemptIds = [];
  createCatalogFixture();
});

afterEach(async () => {
  await app.close();
  if (db.open) db.close();
});

describe('V2-D13 website and admin API boundary', () => {
  it('serves health and hardens responses without enabling cross-origin access or development outbox in production mode', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['referrer-policy']).toBe('no-referrer');
    expect(health.headers['access-control-allow-origin']).toBeUndefined();

    const catalog = await app.inject({ method: 'GET', url: '/api/catalog' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.body).not.toContain('fixture.example');
    expect(catalog.body).not.toContain('LOCAL_D13_FIXTURE');

    const verifyPage = await app.inject({
      method: 'GET',
      url: '/verify-email?token=LOCAL_D13_NOREFLECT_TOKEN',
    });
    expect(verifyPage.statusCode).toBe(200);
    expect(verifyPage.body).toContain('src="/verify-email.js"');
    expect(verifyPage.body).not.toContain('<script>');
    expect(verifyPage.body).not.toContain('LOCAL_D13_NOREFLECT_TOKEN');
    expect((await app.inject({ method: 'GET', url: '/verify-email.js' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/verify-email.css' })).statusCode).toBe(200);

    const outbox = await app.inject({ method: 'GET', url: '/api/dev/email-outbox' });
    expect(outbox.statusCode).toBe(404);

    const tlsDb = openDatabase(':memory:');
    const requiresTls = await buildApp(
      loadConfig({
        dbPath: ':memory:',
        jwtSecret: 'web-console-test-secret-0123456789',
        requireHttps: true,
        enableDevEmailOutbox: false,
      }),
      tlsDb,
    );
    const httpResponse = await requiresTls.inject({ method: 'GET', url: '/health' });
    expect(httpResponse.statusCode).toBe(426);
    const trustedTlsProxyResponse = await requiresTls.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(trustedTlsProxyResponse.statusCode).toBe(200);
    await requiresTls.close();
    tlsDb.close();
  });

  it('paginates and filters only the caller’s billing attempts by date, route, project, and session', async () => {
    const ledger = app.walletLedger;
    const adjustment = ledger.adjustWallet({
      accountId: owner.id,
      currency: 'USD',
      amountMicros: 1_000_000,
      reason: 'local D13 test allowance',
      idempotencyKey: `adjust-${randomUUID()}`,
      actorAccountId: owner.id,
    });
    expect(adjustment.wallet.availableMicros).toBe(1_000_000);

    for (let index = 0; index < 2; index += 1) {
      const input = reserveInput({
        providerModelKey: `${providerId}/${modelId}`,
        projectId: 'project_fixture_01',
        sessionId: index === 0 ? 'session_fixture_01' : 'session_fixture_02',
      });
      const created = ledger.reserveAttempt(input);
      attemptIds.push(created.attempt.attemptId);
    }

    const start = Date.now() - 60_000;
    const params = new URLSearchParams({
      limit: '1',
      from: String(start),
      providerId,
      modelId,
      projectId: 'project_fixture_01',
    });
    const first = await app.inject({
      method: 'GET',
      url: `/api/billing/attempts?${params}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json() as {
      attempts: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(firstPage.attempts).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.attempts[0]).toMatchObject({ projectId: 'project_fixture_01' });

    const second = await app.inject({
      method: 'GET',
      url: `/api/billing/attempts?${new URLSearchParams({ ...Object.fromEntries(params), cursor: firstPage.nextCursor! })}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect((second.json() as { attempts: unknown[] }).attempts).toHaveLength(1);

    const sessionFilter = await app.inject({
      method: 'GET',
      url: `/api/billing/attempts?${new URLSearchParams({ projectId: 'project_fixture_01', sessionId: 'session_fixture_01' })}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(
      (sessionFilter.json() as { attempts: Array<Record<string, unknown>> }).attempts,
    ).toHaveLength(1);

    const privateList = await app.inject({
      method: 'GET',
      url: '/api/billing/attempts',
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect((privateList.json() as { attempts: unknown[] }).attempts).toHaveLength(0);
    const otherAttempt = await app.inject({
      method: 'GET',
      url: `/api/billing/attempts/${attemptIds[0]}`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(otherAttempt.statusCode).toBe(404);
  });

  it('keeps admin price and wallet audit APIs behind the server-side allowlist', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(denied.statusCode).toBe(403);

    app.walletLedger.adjustWallet({
      accountId: owner.id,
      currency: 'USD',
      amountMicros: 10,
      reason: 'audit read fixture',
      idempotencyKey: `admin-audit-${randomUUID()}`,
      actorAccountId: other.id,
    });

    app.appConfig.platformAdminAccountIds = [other.id];
    const account = await app.inject({
      method: 'GET',
      url: `/api/admin/accounts/${owner.id}`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(account.statusCode).toBe(200);
    expect(account.json()).toMatchObject({ account: { accountId: owner.id } });

    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit?limit=50',
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(audit.statusCode).toBe(200);
    expect(
      (audit.json() as { events: Array<{ action: string }> }).events.some(
        (event) => event.action === 'wallet.admin_adjustment',
      ),
    ).toBe(true);
  });
});
