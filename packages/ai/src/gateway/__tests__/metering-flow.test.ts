import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Migrator, newUlid } from '@ec/data';
import {
  microsFromDecimal,
  priceVersionSchema,
  providerModelKeyOf,
  type PriceVersion,
} from '@ec/core';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../core/http';
import type { AttemptContext, MeteredAttempt } from '../metering-record';
import { createAiStack } from '../../service/ai-stack';
import { testSecureStore, insertUser } from '../../__tests__/helpers';
import type { Protocol } from '../../domain/provider';

const USER = 'USER0000000000000000000000';
const OTHER_USER = 'OTHER000000000000000000000';
type Fixture = { status?: number; frames: unknown[] };

/** 流夹具真实走 OpenAI/Anthropic SSE parser 与网关，不发真实网络请求。 */
class FixtureTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly fixtures: Fixture[]) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const fixture = this.fixtures.shift() ?? { status: 599, frames: [] };
    const body: HttpResponse['body'] = {
      async *[Symbol.asyncIterator]() {
        for (const frame of fixture.frames) {
          if (req.signal?.aborted) {
            const error = new Error('请求已中断') as Error & { aborted: boolean };
            error.aborted = true;
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
          yield new TextEncoder().encode(
            typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`,
          );
        }
      },
    };
    return {
      status: fixture.status ?? 200,
      statusText: 'fixture',
      headers: {},
      body,
      async text() {
        let text = '';
        for await (const bytes of body) text += new TextDecoder().decode(bytes);
        return text;
      },
    };
  }
}

function openPersistentDb(path: string): Database.Database {
  const db = new Database(path);
  Migrator.fromDirectory(db, join(process.cwd(), 'packages', 'data', 'migrations')).up();
  return db;
}

function cachePrices(providerModelKey: string): PriceVersion {
  return {
    priceVersionId: newUlid(),
    providerModelKey,
    billingMode: 'per_million_tokens',
    currency: 'CNY',
    rates: {
      uncachedInput: microsFromDecimal('CNY', '10').micros,
      cacheRead: microsFromDecimal('CNY', '1').micros,
      cacheWriteByTtl: {
        '5m': microsFromDecimal('CNY', '12.5').micros,
        '1h': microsFromDecimal('CNY', '20').micros,
        unknown: null,
      },
      output: microsFromDecimal('CNY', '30').micros,
    },
    cacheWriteRateSemantics: 'full_rate',
    source: {
      kind: 'platform_published',
      evidenceUrl: 'https://fixture.invalid/rate',
      verifiedAt: 1,
    },
    effectiveFrom: 0,
    effectiveTo: null,
    publishedAt: 1,
    version: 1,
  };
}

function openAiDelta(text: string): unknown {
  return { choices: [{ delta: { content: text } }] };
}
function openAiUsage(prompt: number, output: number, cached = 0): unknown {
  return {
    id: 'upstream-request-1',
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: output,
      prompt_tokens_details: { cached_tokens: cached },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  };
}

const dbs: Database.Database[] = [];
const dirs: string[] = [];
const stacks: Array<ReturnType<typeof createAiStack>> = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.dispose();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(protocol: Protocol, fixtures: Fixture[], configuredPrice = true) {
  const folder = mkdtempSync(join(tmpdir(), 'ec-v2-d05-'));
  dirs.push(folder);
  const db = openPersistentDb(join(folder, 'meter.sqlite'));
  dbs.push(db);
  insertUser(db, USER);
  const transport = new FixtureTransport(fixtures);
  const stack = createAiStack({
    db,
    secureStore: testSecureStore(),
    userId: USER,
    transport,
    retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    failover: { enabled: false },
    ...(configuredPrice
      ? {
          priceFor: (model, at) => {
            const route = providerModelKeyOf({ providerId: model.providerId, modelId: model.id });
            const price = cachePrices(route);
            return { ...price, effectiveFrom: Math.min(at, 1) };
          },
        }
      : {}),
  });
  stacks.push(stack);
  const provider = await stack.providers.create({
    userId: USER,
    name: '本地夹具',
    protocol,
    baseUrl: `https://fixture.invalid/${protocol === 'openai' ? 'v1' : ''}`,
  });
  const model = stack.models.create(
    provider.id,
    protocol === 'openai' ? 'fixture-chat' : 'claude-fixture',
  );
  stack.models.updateCapability(model.id, {
    contextWindow: 100_000,
    inputPricePerMTok: 10,
    outputPricePerMTok: 30,
  });
  stack.bindings.save(USER, { bindings: {}, useDefaultForAll: true, defaultModelId: model.id });
  return { db, transport, stack, provider, model };
}

const sentContext: AttemptContext = {
  kind: 'sent_estimate',
  computedAt: 1,
  estimatedNextInputTokens: 7,
  routeWindowTokens: null,
  reservedOutputTokens: 1,
  safetyMarginTokens: 1,
  measuredSentInputTokens: null,
};

function pendingAttempt(userId: string): Omit<MeteredAttempt, 'attemptId' | 'revision' | 'cost'> {
  return {
    userId,
    logicalRequestId: 'restart-request',
    providerId: null,
    modelRowId: null,
    upstreamModelName: 'unsaved',
    protocol: 'openai',
    route: null,
    routeUnavailableReason: 'unsaved_draft',
    sessionId: 'session-snapshot',
    taskId: 'task-snapshot',
    projectId: null,
    purpose: 'connection-test',
    startedAt: Date.now(),
    endedAt: null,
    status: 'streaming',
    usageSource: 'unknown',
    rawUsage: null,
    normalized: null,
    providerRequestId: null,
    priceSnapshotRef: null,
    priceSnapshot: null,
    context: sentContext,
    metrics: {
      queuedMs: 0,
      firstOutputAt: null,
      ttftMs: null,
      outputTokensPerSecond: null,
      averageOutputTokensPerSecond: null,
      rateSource: 'unknown',
      toolExecutionMs: null,
    },
    billingState: 'unknown_pending_reconciliation',
  };
}

describe('V2-D05：真实流 usage、attempt 与 SQLite 恢复', () => {
  it('OpenAI 缓存读 / 推理子集按 D00 ULID 路由存储，最终更正原子替换且重复更正幂等', async () => {
    const { db, stack, model, provider } = await setup('openai', [
      {
        frames: [
          openAiDelta('answer'),
          openAiUsage(3000, 500, 2000),
          openAiUsage(3000, 500, 2000),
          '[DONE]',
        ],
      },
    ]);
    const logicalRequestId = newUlid();
    const result = await stack.gateway.chat({
      userId: USER,
      purpose: 'code',
      logicalRequestId,
      projectId: 'nonexistent-source-project',
      sessionId: 'session-1',
      taskId: 'task-1',
      messages: [{ role: 'user', content: 'source prompt must not be stored as raw usage' }],
    });
    for await (const _chunk of result) {
      /* drain the real adapter flow */
    }
    const route = `${provider.id}/${model.id}`;
    const rows = stack.usageRepo.attempts.list(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      logicalRequestId,
      route,
      projectId: 'nonexistent-source-project',
      sessionId: 'session-1',
      taskId: 'task-1',
      purpose: 'code',
      providerRequestId: 'upstream-request-1',
      normalized: {
        totalInput: 3000,
        uncachedInput: 1000,
        cacheReadInput: 2000,
        cacheWriteInputByTtl: {},
        totalOutput: 500,
        reasoningOutput: 2,
        quality: 'upstream_final',
      },
      cost: { total: { currency: 'CNY', micros: 27_000 }, complete: true },
    });
    expect(JSON.stringify(rows[0]?.rawUsage)).not.toContain('source prompt');
    const before = stack.usageRepo.attempts.events(USER).length;
    const final = { ...rows[0]!.normalized!, totalOutput: 450 };
    const key = newUlid();
    stack.usage.correctFinal(USER, rows[0]!.attemptId, key, final, {
      prompt_tokens: 3000,
      completion_tokens: 450,
    });
    stack.usage.correctFinal(USER, rows[0]!.attemptId, key, final, {
      prompt_tokens: 3000,
      completion_tokens: 450,
    });
    expect(stack.usageRepo.attempts.find(USER, rows[0]!.attemptId)?.normalized?.totalOutput).toBe(
      450,
    );
    expect(stack.usageRepo.attempts.events(USER)).toHaveLength(before + 1);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM usage_record WHERE attempt_id IS NOT NULL').get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(
      stack.usageRepo.attempts.events(USER).every((event) => event.type === 'usage.updated'),
    ).toBe(true);
  });

  it('Anthropic 累计流 usage 不累加重复总数，并保留 5m/1h 缓存写价格分桶', async () => {
    const { stack } = await setup('anthropic', [
      {
        frames: [
          {
            type: 'message_start',
            message: {
              id: 'anthropic-request',
              usage: {
                input_tokens: 1000,
                cache_read_input_tokens: 2000,
                cache_creation_input_tokens: 150,
                cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 },
              },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 15 } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 12 },
          },
        ],
      },
    ]);
    const flow = await stack.gateway.chat({
      userId: USER,
      purpose: 'background',
      logicalRequestId: 'anthropic-logical',
      messages: [{ role: 'user', content: 'hi' }],
    });
    for await (const _chunk of flow) {
      /* consume the final message_delta */
    }
    const attempt = stack.usageRepo.attempts.list(USER)[0]!;
    expect(attempt.normalized).toMatchObject({
      totalInput: 3150,
      uncachedInput: 1000,
      cacheReadInput: 2000,
      cacheWriteInputByTtl: { '5m': 100, '1h': 50 },
      totalOutput: 12,
      quality: 'upstream_final',
    });
    expect(attempt.cost?.lineItems.map((line) => line.bucket)).toEqual([
      'uncachedInput',
      'cacheRead',
      'cacheWrite:5m',
      'cacheWrite:1h',
      'output',
    ]);
    expect(attempt.purpose).toBe('background');
  });

  it('429 重试是两条实际路由 attempt、共享逻辑请求，不把首次失败当作零消耗', async () => {
    const { stack, model, provider } = await setup('openai', [
      { status: 429, frames: [{ error: { message: 'busy' } }] },
      { frames: [openAiDelta('retry answer'), openAiUsage(5, 2), '[DONE]'] },
    ]);
    const flow = await stack.gateway.chat({
      userId: USER,
      purpose: 'code',
      logicalRequestId: 'retry-once',
      messages: [{ role: 'user', content: 'hi' }],
    });
    for await (const _chunk of flow) {
      /* consume both adapter attempts */
    }
    const attempts = stack.usageRepo.attempts.list(USER);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(2);
    expect(new Set(attempts.map((attempt) => attempt.logicalRequestId))).toEqual(
      new Set(['retry-once']),
    );
    expect(attempts[0]).toMatchObject({
      status: 'failed',
      billingState: 'unknown_pending_reconciliation',
      route: `${provider.id}/${model.id}`,
    });
    expect(attempts[1]).toMatchObject({
      status: 'succeeded',
      normalized: { totalInput: 5, totalOutput: 2 },
    });
    expect(stack.usageRepo.attempts.aggregate(USER)[0]?.totals).toMatchObject({
      attempts: 2,
      logicalRequests: 1,
    });
  });

  it('用户取消与断流缺 usage 保留估算或未知状态，不写 0 Token/0 费用', async () => {
    const cancelled = await setup('openai', [
      { frames: [openAiDelta('partial text'), openAiUsage(10, 2), '[DONE]'] },
    ]);
    const abort = new AbortController();
    const flow = cancelled.stack.gateway
      .chat({
        userId: USER,
        purpose: 'code',
        signal: abort.signal,
        messages: [{ role: 'user', content: 'cancel after first output' }],
      })
      [Symbol.asyncIterator]();
    const first = await flow.next();
    expect(first.value).toMatchObject({ type: 'delta' });
    abort.abort();
    const last = await flow.next();
    expect(last.value).toMatchObject({ type: 'done', finishReason: 'aborted' });
    const attempt = cancelled.stack.usageRepo.attempts.list(USER)[0]!;
    expect(attempt.status).toBe('cancelled');
    expect(attempt.normalized?.totalInput).toBe(7);
    expect(attempt.normalized?.totalOutput).toBeGreaterThan(0);
    expect(attempt.cost?.total.micros).toBeGreaterThanOrEqual(0);
    expect(attempt.billingState).toBe('unknown_pending_reconciliation');

    const lost = await setup('openai', [{ frames: [openAiDelta('lost stream')] }], false);
    const lostFlow = lost.stack.gateway.chat({
      userId: USER,
      purpose: 'code',
      logicalRequestId: 'lost-final',
      messages: [{ role: 'user', content: 'lost final usage' }],
    });
    for await (const _chunk of lostFlow) {
      /* EOF before final usage */
    }
    const unknown = lost.stack.usageRepo.attempts.list(USER)[0]!;
    expect(unknown).toMatchObject({
      status: 'unknown_pending_reconciliation',
      billingState: 'unknown_pending_reconciliation',
      normalized: { quality: 'stream_estimate' },
    });
    expect(unknown.normalized?.totalOutput).toBeGreaterThan(0);
    expect(unknown.priceSnapshot?.origin).toBe('local_model_capability');
    expect(unknown.priceSnapshot?.price.source.kind).toBe('local_model_capability');
    expect(priceVersionSchema.safeParse(unknown.priceSnapshot?.price).success).toBe(true);
    // 输出估算与已知单价仍能形成“不完整下限”；未上报的输入项不得补 0 或标成完整。
    expect(unknown.cost).toMatchObject({ complete: false });
    expect(unknown.cost?.total.micros).toBeGreaterThan(0);
  });

  it('进程重启会把未收尾 attempt 恢复为待对账并持久化快照游标', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ec-v2-d05-reopen-'));
    dirs.push(folder);
    const path = join(folder, 'usage.sqlite');
    const firstDb = openPersistentDb(path);
    insertUser(firstDb, USER);
    insertUser(firstDb, OTHER_USER);
    dbs.push(firstDb);
    const firstStack = createAiStack({
      db: firstDb,
      secureStore: testSecureStore(),
      userId: USER,
      transport: new FixtureTransport([]),
    });
    stacks.push(firstStack);
    firstStack.usage.beginAttempt(pendingAttempt(USER));
    const previousEventCount = firstStack.usageRepo.attempts.events(USER).length;
    firstStack.usage.beginAttempt(pendingAttempt(OTHER_USER));
    expect(firstStack.usageRepo.attempts.events(OTHER_USER).map((event) => event.sequence)).toEqual(
      [1],
    );
    stacks.pop();
    await firstStack.dispose();
    dbs.pop();
    firstDb.close();

    const secondDb = openPersistentDb(path);
    dbs.push(secondDb);
    const secondStack = createAiStack({
      db: secondDb,
      secureStore: testSecureStore(),
      userId: USER,
      transport: new FixtureTransport([]),
    });
    stacks.push(secondStack);
    const snapshot = secondStack.usageRepo.attempts.snapshot(USER);
    expect(snapshot.attempts[0]).toMatchObject({
      status: 'unknown_pending_reconciliation',
      billingState: 'unknown_pending_reconciliation',
      projectId: null,
      sessionId: 'session-snapshot',
      taskId: 'task-snapshot',
    });
    expect(snapshot.cursor).toBeGreaterThan(previousEventCount);
    expect(
      secondStack.usageRepo.attempts
        .events(USER, previousEventCount)
        .map((event) => event.sequence),
    ).toEqual([previousEventCount + 1]);
  });
});
