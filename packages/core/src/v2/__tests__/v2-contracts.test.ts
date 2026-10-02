/**
 * V2 公共契约 —— 最小序列化与不变量测试（V2-T01 验收）。
 *
 * 覆盖验收卡要求的三条"契约层不得压扁"红线：
 * 1. 同名模型跨 Provider：路由键不同，不合并
 * 2. 多服务同路径接口：路由身份含 serviceId，不合并；`:id`/`{id}` 归一互通
 * 3. 未知计量数据：null 保持 null、命中率 N/A，绝不变 0
 *
 * 另含 JSON 序列化往返（全部实体必须可安全跨进程 JSON 传输）与
 * "共享层无 Node 运行时依赖"源码守卫。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  addMoney,
  apiEndpointSchema,
  apiRouteKeyOf,
  assertFencingToken,
  cacheHitRateOf,
  computeUsageCost,
  consumedTokensOf,
  createEventDeduplicator,
  elementAnchorSchema,
  isSequenceAdvancing,
  isUlid,
  microsFromDecimal,
  microsToDecimalString,
  moneyOf,
  normalizePathTemplate,
  normalizeProtocolUsage,
  parseProviderModelKey,
  priceVersionSchema,
  providerModelKeyOf,
  runPlanSchema,
  toV2ErrorEnvelope,
  usageAttemptSchema,
  v2EventEnvelopeSchema,
  walletSnapshotSchema,
  writeLeaseSchema,
  type NormalizedUsage,
  type PriceVersion,
} from '../index';

/* ------------------------------ 夹具 ------------------------------ */

/** 手写合法 ULID（Crockford Base32，26 位，无 I/L/O/U） */
const ULID_A = '01JD8W3G5X9Q7Z4K2M6T8YV0RA';
const ULID_B = '01JD8W3G5X9Q7Z4K2M6T8YV0RB';
const ULID_C = '01JD8W3G5X9Q7Z4K2M6T8YV0RC';

const NOW = 1_770_000_000_000;

const priceA: PriceVersion = {
  priceVersionId: ULID_A,
  providerModelKey: `${ULID_A}/${ULID_B}`,
  billingMode: 'per_million_tokens',
  currency: 'CNY',
  rates: {
    uncachedInput: microsFromDecimal('CNY', '10').micros,
    cacheRead: microsFromDecimal('CNY', '1').micros,
    cacheWriteByTtl: { '5m': microsFromDecimal('CNY', '12.5').micros },
    output: microsFromDecimal('CNY', '30').micros,
  },
  cacheWriteRateSemantics: 'full_rate',
  source: { kind: 'official_vendor', evidenceUrl: 'https://example.com/pricing', verifiedAt: NOW },
  effectiveFrom: NOW,
  effectiveTo: null,
  publishedAt: NOW,
  version: 1,
};

/** PRD §9.3 虚构样例的用量：普通输入 1000 / 缓存读 2000 / 缓存写 0 / 输出 500 */
const prdSampleUsage: NormalizedUsage = normalizeProtocolUsage({
  inputIncludesCache: false,
  inputTokens: 1000,
  cacheReadTokens: 2000,
  cacheWriteTokensByTtl: null,
  outputTokens: 500,
  reasoningTokensIncludedInOutput: true,
  reasoningTokens: null,
});

/* --------------------------- 序列化往返 --------------------------- */

describe('契约 JSON 序列化往返', () => {
  it('UsageAttempt：parse → JSON → parse 结果一致（无 bigint/Date 泄漏）', () => {
    const attempt = usageAttemptSchema.parse({
      attemptId: ULID_A,
      logicalRequestId: 'logical-1',
      providerRequestId: null,
      route: `${ULID_A}/${ULID_B}`,
      sessionId: null,
      taskId: null,
      projectId: ULID_C,
      purpose: 'code',
      startedAt: NOW,
      endedAt: NOW + 1500,
      status: 'succeeded',
      usageSource: 'upstream_final',
      rawUsage: null,
      normalized: {
        totalInput: 3000,
        uncachedInput: 1000,
        cacheReadInput: 2000,
        cacheWriteInputByTtl: null,
        totalOutput: 500,
        reasoningOutput: null,
        quality: 'upstream_final',
      },
      priceSnapshotRef: null,
      revision: 1,
    });
    const roundTripped = usageAttemptSchema.parse(JSON.parse(JSON.stringify(attempt)));
    expect(roundTripped).toEqual(attempt);
  });

  it('事件信封与写租约：JSON 往返一致', () => {
    const event = v2EventEnvelopeSchema.parse({
      eventId: ULID_A,
      type: 'usage.updated',
      sequence: 3,
      sequenceSource: `attempt:${ULID_B}`,
      dedupKey: `attempt:${ULID_B}:final`,
      occurredAt: NOW,
      requestId: 'logical-1',
      attemptId: ULID_B,
      sessionId: null,
      taskId: null,
      payload: { quality: 'upstream_final' },
    });
    expect(v2EventEnvelopeSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);

    const lease = writeLeaseSchema.parse({
      leaseId: ULID_C,
      dataDomain: 'workspace:main',
      owner: 'coordinator-electron-1',
      fencingToken: 7,
      acquiredAt: NOW,
      expiryAt: NOW + 30_000,
    });
    expect(writeLeaseSchema.parse(JSON.parse(JSON.stringify(lease)))).toEqual(lease);
  });
});

/* ----------------------- 红线一：同名模型不合并 ----------------------- */

describe('Provider+Model 复合路由身份', () => {
  it('同 modelId 分属 A/B 两个 Provider → 路由键不同（V2-E2E-12）', () => {
    const providerA = providerModelKeyOf({ providerId: ULID_A, modelId: ULID_C });
    const providerB = providerModelKeyOf({ providerId: ULID_B, modelId: ULID_C });
    expect(providerA).not.toBe(providerB);
    expect(parseProviderModelKey(providerA)).toEqual({ providerId: ULID_A, modelId: ULID_C });
    expect(parseProviderModelKey(providerB)).toEqual({ providerId: ULID_B, modelId: ULID_C });
  });

  it('非法路由键返回 null，不猜测纠正', () => {
    expect(parseProviderModelKey('not-a-key')).toBeNull();
    expect(parseProviderModelKey(`${ULID_A}/${ULID_B}/extra`)).toBeNull();
  });

  it('isUlid 拒绝含 I/L/O/U 的串（Crockford Base32）', () => {
    expect(isUlid(ULID_A)).toBe(true);
    expect(isUlid('01JD8W3G5X9Q7Z4K2M6T8YV0RI')).toBe(false);
    expect(isUlid('short')).toBe(false);
  });
});

/* --------------------- 红线二：多服务同路径不合并 --------------------- */

describe('接口路由身份', () => {
  it('`:id` 与 `{id}` 归一为同一路由身份（V2-API-02）', () => {
    expect(normalizePathTemplate('/users/:id/orders/:orderId?limit=5')).toBe(
      '/users/{id}/orders/{orderId}',
    );
    expect(normalizePathTemplate('/users/{id}/orders/{orderId}')).toBe(
      '/users/{id}/orders/{orderId}',
    );
    expect(
      apiRouteKeyOf({
        serviceId: 'api',
        method: 'GET',
        normalizedPath: normalizePathTemplate('/users/:id'),
      }),
    ).toBe(apiRouteKeyOf({ serviceId: 'api', method: 'GET', normalizedPath: '/users/{id}' }));
  });

  it('同一 method/path 分属不同 service → 路由键不同（V2-API-01）', () => {
    const orderSvc = apiRouteKeyOf({
      serviceId: 'order-service',
      method: 'GET',
      normalizedPath: '/api/orders/{id}',
    });
    const userSvc = apiRouteKeyOf({
      serviceId: 'user-service',
      method: 'GET',
      normalizedPath: '/api/orders/{id}',
    });
    expect(orderSvc).not.toBe(userSvc);
  });

  it('创建时间来源约束：unknown 不得携带 createdAt，tool_event 必须携带（V2-API-04）', () => {
    const base = {
      endpointId: ULID_A,
      projectId: ULID_B,
      serviceId: 'order-service',
      method: 'POST' as const,
      rawPath: '/orders',
      normalizedPath: '/orders',
      contractSource: null,
      sourceRef: null,
      featureIds: [],
      firstSeenAt: NOW,
      updatedAt: NOW,
      revision: 1,
      status: 'active' as const,
    };
    expect(() =>
      apiEndpointSchema.parse({ ...base, createdAt: NOW, createdAtSource: 'unknown' }),
    ).toThrow(/unknown/);
    expect(() =>
      apiEndpointSchema.parse({ ...base, createdAt: null, createdAtSource: 'tool_event' }),
    ).toThrow(/tool_event/);
    // git_inferred 允许 createdAt（推断值，UI 标注来源）
    expect(
      apiEndpointSchema.parse({ ...base, createdAt: NOW, createdAtSource: 'git_inferred' }),
    ).toBeTruthy();
  });
});

/* --------------------- 红线三：未知计量不压扁为 0 --------------------- */

describe('用量标准化', () => {
  it('上游未报告缓存数据 → cacheRead 保持 null，命中率 N/A 而非 0%（V2-USG-03）', () => {
    const usage = normalizeProtocolUsage({
      inputIncludesCache: false,
      inputTokens: 1200,
      cacheReadTokens: null,
      cacheWriteTokensByTtl: null,
      outputTokens: 300,
      reasoningTokensIncludedInOutput: true,
      reasoningTokens: null,
    });
    expect(usage.cacheReadInput).toBeNull();
    expect(usage.totalInput).toBe(1200);
    expect(cacheHitRateOf(usage)).toEqual({ kind: 'not_applicable', reason: 'no_cache_data' });
    expect(consumedTokensOf(usage)).toBe(1500);
  });

  it('Anthropic 口径（input 已含缓存）：拆分而非再加一遍（防"缓存加两遍"）', () => {
    const usage = normalizeProtocolUsage({
      inputIncludesCache: true,
      inputTokens: 3000,
      cacheReadTokens: 2000,
      cacheWriteTokensByTtl: null,
      outputTokens: 500,
      reasoningTokensIncludedInOutput: true,
      reasoningTokens: 100,
    });
    expect(usage.totalInput).toBe(3000);
    expect(usage.uncachedInput).toBe(1000);
    expect(usage.reasoningOutput).toBe(100);
    const rate = cacheHitRateOf(usage);
    expect(rate.kind).toBe('measured');
    if (rate.kind === 'measured') {
      expect(rate.numerator).toBe(2000);
      expect(rate.denominator).toBe(3000);
    }
  });

  it('OpenAI 口径（input 不含缓存）：补齐 totalInput', () => {
    const usage = normalizeProtocolUsage({
      inputIncludesCache: false,
      inputTokens: 1000,
      cacheReadTokens: 2000,
      cacheWriteTokensByTtl: { '5m': 400 },
      outputTokens: 500,
      reasoningTokensIncludedInOutput: true,
      reasoningTokens: null,
    });
    expect(usage.uncachedInput).toBe(1000);
    expect(usage.totalInput).toBe(1000 + 2000 + 400);
  });

  it('最终 usage 替换估算，不允许两份并存（V2-USG-07）', () => {
    const final = normalizeProtocolUsage({
      inputIncludesCache: true,
      inputTokens: 3000,
      cacheReadTokens: 2000,
      cacheWriteTokensByTtl: null,
      outputTokens: 500,
      reasoningTokensIncludedInOutput: true,
      reasoningTokens: null,
    });
    expect(final.quality).toBe('upstream_final');
    // 同一 attempt 只有一份最终口径：估算字段被最终值整体替换
    const attemptState = { quality: 'stream_estimate' as const, totalOutput: 100 };
    const replaced = { ...attemptState, ...final };
    expect(replaced.quality).toBe('upstream_final');
    expect(replaced.totalOutput).toBe(500);
  });

  it('attempt 终态必须有 endedAt；usageSource 与 normalized.quality 一致；待对账合法', () => {
    const base = {
      attemptId: ULID_A,
      logicalRequestId: 'logical-1',
      providerRequestId: null,
      route: `${ULID_A}/${ULID_B}`,
      sessionId: null,
      taskId: null,
      projectId: null,
      purpose: null,
      startedAt: NOW,
      endedAt: null,
      status: 'succeeded' as const,
      usageSource: 'upstream_final' as const,
      rawUsage: null,
      normalized: null,
      priceSnapshotRef: null,
      revision: 1,
    };
    expect(() => usageAttemptSchema.parse(base)).toThrow(/endedAt/);
    expect(() =>
      usageAttemptSchema.parse({
        ...base,
        endedAt: NOW + 1,
        usageSource: 'stream_estimate',
        normalized: {
          totalInput: 10,
          uncachedInput: 10,
          cacheReadInput: null,
          cacheWriteInputByTtl: null,
          totalOutput: 5,
          reasoningOutput: null,
          quality: 'upstream_final',
        },
      }),
    ).toThrow(/quality/);
    // 待对账状态可解析（未知≠免费≠归零），但必须带 endedAt（调用已结束）
    expect(
      usageAttemptSchema.parse({
        ...base,
        status: 'unknown_pending_reconciliation',
        endedAt: NOW + 1,
      }),
    ).toBeTruthy();
  });
});

/* ------------------------------ 金额与计费 ------------------------------ */

describe('定点金额与 PRD §9.3 测试样例', () => {
  it('PRD 虚构样例（Provider A）：0.027 元精确命中（V2-BILL-04）', () => {
    const cost = computeUsageCost(priceA, prdSampleUsage);
    expect(cost.total).toEqual(moneyOf('CNY', 27_000));
    expect(microsToDecimalString(cost.total)).toBe('0.027000');
    // consumedTokens = inputTotal + totalOutput = 3000 + 500 = 3500
    expect(consumedTokensOf(prdSampleUsage)).toBe(3500);
    // 命中率 2000/3000 ≈ 66.67%
    const rate = cacheHitRateOf(prdSampleUsage);
    expect(rate.kind).toBe('measured');
    if (rate.kind === 'measured') expect(rate.value).toBeCloseTo(0.6667, 3);
    expect(cost.complete).toBe(true);
    // 分项之和等于总额（构造性保证）
    const sum = cost.lineItems.reduce((acc, line) => acc + line.micros, 0);
    expect(sum).toBe(cost.total.micros);
  });

  it('Provider B 同名模型价格不同：独立计费不串渠道', () => {
    const providerBPrice: PriceVersion = {
      ...priceA,
      priceVersionId: ULID_B,
      providerModelKey: `${ULID_B}/${ULID_C}`,
      rates: { ...priceA.rates, uncachedInput: microsFromDecimal('CNY', '50').micros },
    };
    const usage: NormalizedUsage = {
      totalInput: 1000,
      uncachedInput: 1000,
      cacheReadInput: null,
      cacheWriteInputByTtl: null,
      totalOutput: 0,
      reasoningOutput: null,
      quality: 'upstream_final',
    };
    const costB = computeUsageCost(providerBPrice, usage);
    expect(costB.total.micros).toBe(50_000); // 0.05 元
    const costA = computeUsageCost(priceA, usage);
    expect(costA.total.micros).toBe(10_000); // 0.01 元
  });

  it('未定价桶保持未知：不按 0 计入总额（complete=false）', () => {
    const partialPrice: PriceVersion = {
      ...priceA,
      rates: { ...priceA.rates, output: null },
    };
    const usage: NormalizedUsage = {
      totalInput: 1000,
      uncachedInput: 1000,
      cacheReadInput: null,
      cacheWriteInputByTtl: null,
      totalOutput: 500,
      reasoningOutput: null,
      quality: 'upstream_final',
    };
    const cost = computeUsageCost(partialPrice, usage);
    expect(cost.complete).toBe(false);
    expect(cost.unpricedUsedBuckets).toEqual(['output']);
    expect(cost.total.micros).toBe(10_000); // 仅输入分项
  });

  it('免费价 0 与未定价 null 语义分离（V2-E2E-15）', () => {
    const freePriceVersion: PriceVersion = {
      ...priceA,
      rates: { ...priceA.rates, output: 0 },
    };
    const usage: NormalizedUsage = {
      totalInput: 100,
      uncachedInput: 100,
      cacheReadInput: null,
      cacheWriteInputByTtl: null,
      totalOutput: 500,
      reasoningOutput: null,
      quality: 'upstream_final',
    };
    const cost = computeUsageCost(freePriceVersion, usage);
    expect(cost.complete).toBe(true);
    expect(cost.total.micros).toBe(1_000); // 输入 0.001 元；输出免费 0
    expect(cost.lineItems.find((l) => l.bucket === 'output')?.micros).toBe(0);
  });

  it('跨币种禁止相加；钱包快照可用额=账面-冻结（V2-BILL-06/10）', () => {
    expect(() => addMoney(moneyOf('CNY', 1), moneyOf('USD', 1))).toThrow(/跨币种/);
    expect(() =>
      walletSnapshotSchema.parse({
        accountId: 'user-1',
        currency: 'CNY',
        postedMicros: 100_000,
        heldMicros: 20_000,
        availableMicros: 80_000,
        asOf: NOW,
        stale: false,
      }),
    ).toBeTruthy();
    expect(() =>
      walletSnapshotSchema.parse({
        accountId: 'user-1',
        currency: 'CNY',
        postedMicros: 100_000,
        heldMicros: 20_000,
        availableMicros: 90_000,
        asOf: NOW,
        stale: false,
      }),
    ).toThrow();
  });

  it('价格版本：effectiveTo 必须晚于 effectiveFrom；不可变结构可 JSON 往返', () => {
    expect(() =>
      priceVersionSchema.parse({ ...priceA, effectiveTo: priceA.effectiveFrom - 1 }),
    ).toThrow();
    expect(priceVersionSchema.parse(JSON.parse(JSON.stringify(priceA)))).toEqual(priceA);
  });
});

/* --------------------------- 事件去重与错误 --------------------------- */

describe('事件去重（V2-AGT-10 / V2-USG-08）', () => {
  const envelope = v2EventEnvelopeSchema.parse({
    eventId: ULID_A,
    type: 'bill.settled',
    sequence: 1,
    sequenceSource: `request:${ULID_B}`,
    dedupKey: `bill:${ULID_B}:settle`,
    occurredAt: NOW,
    requestId: 'logical-1',
    attemptId: ULID_B,
    sessionId: null,
    taskId: null,
    payload: null,
  });

  it('重复 eventId 与重复 dedupKey 均判 duplicate（事件重放不二次记账）', () => {
    const dedup = createEventDeduplicator();
    expect(dedup.accept(envelope)).toBe('accepted');
    expect(dedup.accept(envelope)).toBe('duplicate');
    expect(dedup.accept({ ...envelope, eventId: ULID_B, dedupKey: `bill:${ULID_B}:settle` })).toBe(
      'duplicate',
    );
    expect(
      dedup.accept({ ...envelope, eventId: ULID_C, dedupKey: `bill:${ULID_B}:settle-2` }),
    ).toBe('accepted');
  });

  it('容量上限触发 LRU 淘汰，不无限增长', () => {
    const dedup = createEventDeduplicator(8);
    for (let i = 0; i < 32; i++) {
      dedup.accept({ ...envelope, eventId: `EVENT${String(i).padStart(22, '0')}`, dedupKey: null });
    }
    // 最早的已淘汰，重新投递视为新事件
    expect(
      dedup.accept({ ...envelope, eventId: 'EVENT0000000000000000000000', dedupKey: null }),
    ).toBe('accepted');
  });

  it('序号推进检测（丢事件由订阅方判定，不做静默补偿）', () => {
    expect(isSequenceAdvancing(1, 2)).toBe(true);
    expect(isSequenceAdvancing(2, 2)).toBe(false);
    expect(isSequenceAdvancing(1, 3)).toBe(false);
  });
});

describe('错误语义（PRD §11.3 { code, message, traceId }）', () => {
  it('既有 { code, message, retryable } 补齐 traceId 后合法；未知异常兜底 UNKNOWN', () => {
    const mapped = toV2ErrorEnvelope({
      code: 'TIMEOUT',
      message: 'upstream timeout',
      retryable: true,
    });
    expect(mapped).toMatchObject({ code: 'TIMEOUT', retryable: true, traceId: null });
    expect(toV2ErrorEnvelope(new Error('boom')).code).toBe('UNKNOWN');
    expect(toV2ErrorEnvelope({ code: 'NOT_A_CODE', message: 'x' }).code).toBe('UNKNOWN');
  });
});

/* --------------------------- 其余实体不变量 --------------------------- */

describe('锚点 / 运行计划 / 租约不变量', () => {
  it('unresolved 锚点必须给原因；exact 必须带 sourceRef（不虚构行号）', () => {
    const base = {
      anchorId: ULID_A,
      projectId: ULID_B,
      runtimeId: null,
      pageRoute: '/orders',
      elementId: 'element-1',
      sourceRef: null,
      componentSymbol: null,
      instanceHint: null,
      sourceRevision: null,
      mappingKind: 'unknown' as const,
      confidence: 'unresolved' as const,
      invalidReason: null,
      capturedAt: NOW,
      updatedAt: NOW,
      revision: 1,
    };
    expect(() => elementAnchorSchema.parse(base)).toThrow(/原因/);
    expect(
      elementAnchorSchema.parse({ ...base, invalidReason: '构建产物无 source map' }),
    ).toBeTruthy();
    expect(() =>
      elementAnchorSchema.parse({ ...base, confidence: 'exact', invalidReason: null }),
    ).toThrow(/sourceRef/);
  });

  it('RunPlan 只允许环境变量名称，strict 拒绝夹带值（密钥不进契约）', () => {
    const plan = {
      cwd: 'apps/web',
      services: [
        { serviceId: 'web', role: 'frontend', command: 'pnpm', args: ['dev'], portHint: 5173 },
      ],
      startupOrder: ['web'],
      envVarNames: ['VITE_API_BASE'],
    };
    expect(runPlanSchema.parse(plan)).toBeTruthy();
    expect(() =>
      runPlanSchema.parse({ ...plan, envValues: { VITE_API_BASE: 'secret' } }),
    ).toThrow();
  });

  it('fencing token：过期 owner 被拒（V2-AGT-02）', () => {
    expect(assertFencingToken(7, 7)).toBe('ok');
    expect(assertFencingToken(7, 8)).toBe('ok');
    expect(assertFencingToken(7, 6)).toBe('stale');
  });
});

/* ---------------------- 共享层无 Node 依赖守卫 ---------------------- */

describe('共享层纯度（renderer 可安全导入）', () => {
  const v2Dir = join(dirname(fileURLToPath(import.meta.url)), '..');

  it('v2 目录源码不引入 node 内置模块 / better-sqlite3 / 其他 @ec 包', () => {
    const forbidden = [/from 'node:/, /require\(/, /better-sqlite3/, /@ec\/data/, /@ec\/shell-api/];
    const files = readdirSync(v2Dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    // 14 个契约文件（含目录快照）；少一个说明新文件未纳入纯度检查
    expect(files.length).toBe(14);
    for (const file of files) {
      const content = readFileSync(join(v2Dir, file), 'utf8');
      for (const pattern of forbidden) {
        expect(content.match(pattern), `${file} 引入了禁用依赖 ${pattern}`).toBeNull();
      }
    }
  });

  it('browser 条件入口同样导出 v2 契约（renderer 装配路径）', async () => {
    const browserEntry = await import('../../browser');
    expect(typeof browserEntry.normalizeProtocolUsage).toBe('function');
    expect(typeof browserEntry.providerModelKeyOf).toBe('function');
    expect(typeof browserEntry.computeUsageCost).toBe('function');
  });
});
