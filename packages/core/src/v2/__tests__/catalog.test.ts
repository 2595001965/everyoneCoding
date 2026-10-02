import { describe, expect, it } from 'vitest';
import { computeUsageCost, parsePlatformCatalogSnapshot, resolveCatalogPrice } from '..';
import type { PlatformCatalogSnapshot } from '..';

const PROVIDER_A = '01J00000000000000000000000';
const PROVIDER_B = '01J00000000000000000000001';
const MODEL_A = '01J00000000000000000000002';
const MODEL_B = '01J00000000000000000000003';

function fixture(): PlatformCatalogSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: 1_800_000_000_000,
    providers: [
      {
        providerId: PROVIDER_A,
        displayName: '测试渠道 A',
        protocol: 'openai',
        status: 'active',
        statusReason: null,
        updatedAt: 1_700_000_000_000,
      },
      {
        providerId: PROVIDER_B,
        displayName: '测试渠道 B',
        protocol: 'openai',
        status: 'active',
        statusReason: null,
        updatedAt: 1_700_000_000_000,
      },
    ],
    models: [
      {
        providerId: PROVIDER_A,
        modelId: MODEL_A,
        providerSource: 'platform',
        displayName: '共享模型',
        protocol: 'openai',
        baseUrl: null,
        canonicalVendor: 'vendor-fixture',
        canonicalModel: 'canonical-fixture',
        contextWindowTokens: null,
        contextWindowSource: null,
        capabilities: null,
        revision: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        upstreamModelName: 'shared-model',
      },
      {
        providerId: PROVIDER_B,
        modelId: MODEL_B,
        providerSource: 'platform',
        displayName: '共享模型',
        protocol: 'openai',
        baseUrl: null,
        canonicalVendor: 'vendor-fixture',
        canonicalModel: 'canonical-fixture',
        contextWindowTokens: null,
        contextWindowSource: null,
        capabilities: null,
        revision: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        upstreamModelName: 'shared-model',
      },
    ],
    platformPrices: [
      {
        priceVersionId: '01J00000000000000000000004',
        providerModelKey: `${PROVIDER_A}/${MODEL_A}`,
        billingMode: 'per_million_tokens',
        currency: 'USD',
        rates: {
          uncachedInput: 10,
          cacheRead: null,
          cacheWriteByTtl: null,
          output: 30,
        },
        cacheWriteRateSemantics: 'full_rate',
        source: { kind: 'platform_published', evidenceUrl: null, verifiedAt: null },
        effectiveFrom: 1_700_000_000_000,
        effectiveTo: null,
        publishedAt: 1_700_000_000_000,
        version: 1,
      },
    ],
    officialPrices: [
      {
        snapshotId: '01J00000000000000000000005',
        canonicalVendor: 'vendor-fixture',
        canonicalModel: 'canonical-fixture',
        billingMode: 'per_million_tokens',
        currency: 'USD',
        rates: { uncachedInput: 1, cacheRead: 1, cacheWriteByTtl: {}, output: 1 },
        sourceUrl: 'https://vendor.example.test/pricing',
        verifiedAt: 1_700_000_000_000,
        evidenceVersion: 'test-fixture-v1',
        evidenceSha256: 'a'.repeat(64),
        conditions: '仅用于纯函数测试的虚构证据',
        effectiveFrom: 1_700_000_000_000,
        effectiveTo: null,
        publishedAt: 1_700_000_000_000,
        version: 1,
      },
    ],
  };
}

describe('platform catalog snapshot', () => {
  it('reads serialized local snapshots and keeps same-name channel prices isolated', () => {
    const localSnapshot = parsePlatformCatalogSnapshot(JSON.stringify(fixture()));
    expect(localSnapshot).not.toBeNull();
    const snapshot = localSnapshot!;
    expect(
      resolveCatalogPrice(
        snapshot,
        { providerId: PROVIDER_A, modelId: MODEL_A },
        snapshot.generatedAt,
      ),
    ).toMatchObject({ providerModelKey: `${PROVIDER_A}/${MODEL_A}`, rates: { uncachedInput: 10 } });
    expect(
      resolveCatalogPrice(
        snapshot,
        { providerId: PROVIDER_B, modelId: MODEL_B },
        snapshot.generatedAt,
      ),
    ).toMatchObject({
      providerModelKey: `${PROVIDER_B}/${MODEL_B}`,
      source: { kind: 'official_vendor' },
      rates: { uncachedInput: 1 },
    });
    expect(
      resolveCatalogPrice(
        snapshot,
        { providerId: PROVIDER_B, modelId: MODEL_A },
        snapshot.generatedAt,
      ),
    ).toBeNull();
    expect(parsePlatformCatalogSnapshot('{bad json')).toBeNull();
  });

  it('does not fill unknown platform buckets from official prices; zero remains priced', () => {
    const snapshot = fixture();
    const platformPrice = resolveCatalogPrice(
      snapshot,
      { providerId: PROVIDER_A, modelId: MODEL_A },
      snapshot.generatedAt,
    )!;
    expect(platformPrice.rates.cacheRead).toBeNull();
    expect(platformPrice.rates.cacheWriteByTtl).toBeNull();

    const usage = {
      totalInput: 10,
      uncachedInput: 5,
      cacheReadInput: 0,
      cacheWriteInputByTtl: { '5m': 2 },
      totalOutput: 3,
      reasoningOutput: null,
      quality: 'upstream_final' as const,
    };
    const partial = computeUsageCost(platformPrice, usage);
    expect(partial.complete).toBe(false);
    expect(partial.unpricedUsedBuckets).toEqual(['cacheWrite:5m']);

    const free = {
      ...platformPrice,
      rates: { uncachedInput: 0, cacheRead: 0, cacheWriteByTtl: { '5m': 0 }, output: 0 },
    };
    const freeCost = computeUsageCost(free, usage);
    expect(freeCost.complete).toBe(true);
    expect(freeCost.total.micros).toBe(0);
    expect(freeCost.lineItems.every((item) => item.micros === 0)).toBe(true);
  });
});
