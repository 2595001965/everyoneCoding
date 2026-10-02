import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parsePlatformCatalogSnapshot, resolveCatalogPrice } from '@ec/core';
import { buildApp } from '../app.ts';
import { openDatabase } from '../db.ts';
import { loadConfig } from '../config.ts';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp(loadConfig({ dbPath: ':memory:' }), openDatabase(':memory:'));
});

async function register(email: string): Promise<{ userId: string; token: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'Abcd1234' },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as {
    identity: { accountId: string };
    tokens: { accessToken: string };
  };
  return { userId: body.identity.accountId, token: body.tokens.accessToken };
}

async function makeAdmin(email = 'catalog-admin@example.test'): Promise<string> {
  const account = await register(email);
  app.appConfig.platformAdminAccountIds.push(account.userId);
  return account.token;
}

async function request(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: { token?: string; payload?: unknown } = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await app.inject({
    method,
    url,
    ...(options.payload !== undefined
      ? { payload: options.payload as Record<string, unknown> }
      : {}),
    ...(options.token !== undefined
      ? { headers: { authorization: `Bearer ${options.token}` } }
      : {}),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function createProvider(token: string, suffix: string): Promise<Record<string, unknown>> {
  const response = await request('POST', '/api/admin/catalog/providers', {
    token,
    payload: {
      displayName: `测试渠道 ${suffix}`,
      protocol: 'openai',
      baseUrl: `https://upstream-${suffix.toLowerCase()}.internal.example/v1`,
      credentialRef: `secret://platform/${suffix.toLowerCase()}`,
      status: 'active',
    },
  });
  expect(response.status).toBe(201);
  return response.body.provider as Record<string, unknown>;
}

async function createModel(
  token: string,
  providerId: string,
  name: string,
  options: { canonicalVendor?: string | null; canonicalModel?: string | null } = {},
): Promise<Record<string, unknown>> {
  const response = await request('POST', `/api/admin/catalog/providers/${providerId}/models`, {
    token,
    payload: {
      upstreamModelName: name,
      displayName: name,
      canonicalVendor: options.canonicalVendor ?? null,
      canonicalModel: options.canonicalModel ?? null,
    },
  });
  expect(response.status).toBe(201);
  return response.body.model as Record<string, unknown>;
}

const fictionalRates = (input: number, output: number) => ({
  uncachedInput: input,
  cacheRead: 0,
  cacheWriteByTtl: { '5m': 0 },
  output,
});

describe('D10 平台目录与价格版本', () => {
  it('public snapshot omits upstream address and credential reference; only configured admins can manage pricing', async () => {
    const user = await register('catalog-user@example.test');
    expect((await request('GET', '/api/admin/catalog/providers')).status).toBe(401);
    expect(
      (await request('GET', '/api/admin/catalog/providers', { token: user.token })).status,
    ).toBe(403);
    const emptyPublic = await request('GET', '/api/catalog/snapshot');
    expect(emptyPublic.status).toBe(200);
    expect(emptyPublic.body.models).toEqual([]);
    expect(emptyPublic.body.platformPrices).toEqual([]);
    const deniedPrice = await request(
      'POST',
      '/api/admin/catalog/providers/01J00000000000000000000000/models/01J00000000000000000000001/prices',
      {
        token: user.token,
        payload: { currency: 'USD', rates: fictionalRates(1, 1), effectiveFrom: 0 },
      },
    );
    expect(deniedPrice.status).toBe(403);

    const adminToken = await makeAdmin();
    const invalid = await request('POST', '/api/admin/catalog/providers', {
      token: adminToken,
      payload: {
        displayName: '拒绝明文密钥',
        protocol: 'openai',
        baseUrl: 'https://upstream.internal.example/v1',
        credentialRef: 'sk-test-not-a-real-key',
      },
    });
    expect(invalid.status).toBe(400);

    const provider = await createProvider(adminToken, 'A');
    expect(provider.credentialConfigured).toBe(true);
    expect(provider).not.toHaveProperty('credentialRef');
    const model = await createModel(adminToken, String(provider.providerId), 'shared-model');
    const snapshotResponse = await request('GET', '/api/catalog/snapshot');
    const serialized = JSON.stringify(snapshotResponse.body);
    expect(serialized).not.toContain('upstream-a.internal.example');
    expect(serialized).not.toContain('secret://platform/a');
    expect(serialized).not.toContain('sk-test-not-a-real-key');
    expect((snapshotResponse.body.models as Array<Record<string, unknown>>)[0]?.modelId).toBe(
      model.modelId,
    );
  });

  it('keeps same upstream model prices route-specific and makes published history immutable', async () => {
    const admin = await makeAdmin();
    const providerA = await createProvider(admin, 'A');
    const providerB = await createProvider(admin, 'B');
    const modelA = await createModel(admin, String(providerA.providerId), 'shared-model');
    const modelB = await createModel(admin, String(providerB.providerId), 'shared-model');
    const routeA = `/api/admin/catalog/providers/${providerA.providerId}/models/${modelA.modelId}`;
    const routeB = `/api/admin/catalog/providers/${providerB.providerId}/models/${modelB.modelId}`;

    // 明确虚构的微单位/百万 Token 费率，仅用于渠道隔离测试。
    for (const [route, input, output] of [
      [routeA, 10, 30],
      [routeB, 900, 2_000],
    ] as const) {
      const result = await request('POST', `${route}/prices`, {
        token: admin,
        payload: { currency: 'USD', rates: fictionalRates(input, output), effectiveFrom: 0 },
      });
      expect(result.status).toBe(201);
    }

    const publicSnapshot = (await request('GET', '/api/catalog/snapshot')).body;
    const localSnapshot = parsePlatformCatalogSnapshot(JSON.stringify(publicSnapshot));
    expect(localSnapshot).not.toBeNull();
    const priceA = resolveCatalogPrice(
      localSnapshot!,
      { providerId: String(providerA.providerId), modelId: String(modelA.modelId) },
      Date.now(),
    );
    const priceB = resolveCatalogPrice(
      localSnapshot!,
      { providerId: String(providerB.providerId), modelId: String(modelB.modelId) },
      Date.now(),
    );
    expect(priceA?.rates.uncachedInput).toBe(10);
    expect(priceB?.rates.uncachedInput).toBe(900);
    expect(priceA?.providerModelKey).not.toBe(priceB?.providerModelKey);

    const publishAt = Date.now() + 60_000;
    const preview = await request('POST', `${routeA}/prices/preview`, {
      token: admin,
      payload: { currency: 'USD', rates: fictionalRates(20, 30), effectiveFrom: publishAt },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.impact).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: 'uncachedInput',
          previousMicrosPerMillion: 10,
          proposedMicrosPerMillion: 20,
          deltaMicrosPerMillion: 10,
        }),
      ]),
    );
    expect((await request('GET', `${routeA}/prices`, { token: admin })).body.prices).toHaveLength(
      1,
    );

    const adjusted = await request('POST', `${routeA}/prices`, {
      token: admin,
      payload: { currency: 'USD', rates: fictionalRates(20, 30), effectiveFrom: publishAt },
    });
    expect(adjusted.status).toBe(201);
    const history = (await request('GET', `${routeA}/prices`, { token: admin })).body
      .prices as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      version: 1,
      effectiveTo: publishAt,
      rates: fictionalRates(10, 30),
    });
    expect(history[1]).toMatchObject({
      version: 2,
      effectiveFrom: publishAt,
      rates: fictionalRates(20, 30),
    });
    expect(() =>
      app.accountDb.raw.prepare('UPDATE platform_price_version SET currency = ?').run('EUR'),
    ).toThrow(/immutable/);
    expect(() => app.accountDb.raw.prepare('DELETE FROM platform_price_version').run()).toThrow(
      /immutable/,
    );
  });

  it('distinguishes no price from free and resolves official evidence by exact canonical identity offline', async () => {
    const admin = await makeAdmin();
    const provider = await createProvider(admin, 'A');
    const modelWithEvidence = await createModel(
      admin,
      String(provider.providerId),
      'official-name',
      {
        canonicalVendor: 'vendor-fixture',
        canonicalModel: 'canonical-fixture',
      },
    );
    const aliasUnknown = await createModel(
      admin,
      String(provider.providerId),
      'alias-not-confirmed',
    );
    const freeModel = await createModel(admin, String(provider.providerId), 'free-fixture');

    const evidence = await request('POST', '/api/admin/catalog/official-prices', {
      token: admin,
      payload: {
        canonicalVendor: 'vendor-fixture',
        canonicalModel: 'canonical-fixture',
        currency: 'USD',
        rates: fictionalRates(100, 200),
        sourceUrl: 'https://vendor.example.test/pricing-fixture',
        verifiedAt: 0,
        evidenceVersion: 'synthetic-fixture-v1',
        evidenceSnapshot: 'Synthetic test evidence. This is not vendor pricing.',
        conditions: '测试夹具；不是实际价格，按每百万 Token。',
        effectiveFrom: 0,
      },
    });
    expect(evidence.status).toBe(201);
    expect(evidence.body.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);

    const free = await request(
      'POST',
      `/api/admin/catalog/providers/${provider.providerId}/models/${freeModel.modelId}/prices`,
      { token: admin, payload: { currency: 'USD', rates: fictionalRates(0, 0), effectiveFrom: 0 } },
    );
    expect(free.status).toBe(201);

    const snapshot = parsePlatformCatalogSnapshot(
      JSON.stringify((await request('GET', '/api/catalog/snapshot')).body),
    );
    expect(snapshot).not.toBeNull();
    expect(
      resolveCatalogPrice(
        snapshot!,
        { providerId: String(provider.providerId), modelId: String(modelWithEvidence.modelId) },
        Date.now(),
      ),
    ).toMatchObject({ source: { kind: 'official_vendor' }, rates: { uncachedInput: 100 } });
    expect(
      resolveCatalogPrice(
        snapshot!,
        { providerId: String(provider.providerId), modelId: String(aliasUnknown.modelId) },
        Date.now(),
      ),
    ).toBeNull();
    expect(
      resolveCatalogPrice(
        snapshot!,
        { providerId: String(provider.providerId), modelId: String(freeModel.modelId) },
        Date.now(),
      ),
    ).toMatchObject({
      source: { kind: 'platform_published' },
      rates: { uncachedInput: 0, output: 0 },
    });

    const adminEvidence = (
      await request('GET', '/api/admin/catalog/official-prices', { token: admin })
    ).body.prices as Array<Record<string, unknown>>;
    expect(adminEvidence[0]?.evidenceSnapshot).toContain('not vendor pricing');
    expect(snapshot?.officialPrices[0]?.evidenceSha256).toBe(evidence.body.evidenceSha256);
    expect(snapshot?.officialPrices[0]?.sourceUrl).toBe(
      'https://vendor.example.test/pricing-fixture',
    );
    expect(snapshot?.officialPrices[0]?.evidenceVersion).toBe('synthetic-fixture-v1');
    expect(() =>
      app.accountDb.raw
        .prepare('UPDATE platform_official_price_snapshot SET currency = ?')
        .run('EUR'),
    ).toThrow(/immutable/);
  });
});
