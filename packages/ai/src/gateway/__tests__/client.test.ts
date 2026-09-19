import { describe, it, expect, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createServer, type Server } from 'node:http';

import { ApiKeyStore } from '../../secure/api-key-store';
import { ProviderRepo } from '../../repo/provider-repo';
import { ModelRepo } from '../../repo/model-repo';
import { PurposeBindingRepo } from '../../repo/purpose-binding-repo';
import { UsageRepo } from '../../repo/usage-repo';
import { createNodeHttpTransport } from '../../core/node-transport';
import { OpenAiAdapter } from '../../adapters/openai/client';
import { BudgetGuard } from '../../gateway/budget';
import { UsageTracker } from '../../gateway/usage-tracker';
import { RequestQueue } from '../../gateway/queue';
import { FailoverController } from '../../gateway/failover';
import { AiGateway } from '../../gateway/client';
import { collect } from '../../core/stream';
import {
  insertUser,
  openTestDb,
  testSecureStore,
  type MockServerHandle,
} from '../../__tests__/helpers';

const USER = 'USER0000000000000000000000';
const SSE_HEADERS = { 'content-type': 'text/event-stream' };

/** 构造一条 OpenAI 流式响应（含末帧 usage 与 [DONE]） */
function sseReply(
  text: string,
  promptTokens = 100,
  completionTokens = 20,
): { status: number; body: string; headers: Record<string, string> } {
  return {
    status: 200,
    headers: SSE_HEADERS,
    body:
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      })}\n\n` +
      'data: [DONE]\n\n',
  };
}

let db: Database;
let server: MockServerHandle | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

/** 可编排响应的本地服务：handler 自行决定每次返回什么 */
async function startScripted(
  respond: (
    req: { url: string; body: string },
    callIndex: number,
  ) => { status: number; body: string; headers?: Record<string, string> },
): Promise<MockServerHandle> {
  let calls = 0;
  const httpServer: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const index = calls;
      calls += 1;
      const result = respond(
        { url: req.url ?? '/', body: Buffer.concat(chunks).toString('utf8') },
        index,
      );
      res.writeHead(result.status, {
        'content-type': 'application/json',
        ...(result.headers ?? {}),
      });
      res.end(result.body);
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: [],
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

interface StackOptions {
  maxRetries?: number;
  failureThreshold?: number;
  monthlyUsd?: number | null;
}

function buildStack(options: StackOptions = {}) {
  db = openTestDb();
  insertUser(db, USER);
  const providers = new ProviderRepo(db, new ApiKeyStore(testSecureStore()));
  const models = new ModelRepo(db);
  const bindings = new PurposeBindingRepo(db);
  const usageRepo = new UsageRepo(db);
  const budget = new BudgetGuard(usageRepo, USER, { monthlyUsd: options.monthlyUsd ?? null });
  const usage = new UsageTracker(usageRepo, budget);
  const queue = new RequestQueue();
  const failover = new FailoverController({ failureThreshold: options.failureThreshold ?? 2 });
  const gateway = new AiGateway({
    providers,
    models,
    bindings,
    usage,
    budget,
    queue,
    failover,
    transport: createNodeHttpTransport(),
    adapterFor: () => new OpenAiAdapter(),
    retry: { maxRetries: options.maxRetries ?? 0 },
  });
  return { providers, models, bindings, usage, gateway, failover, db };
}

async function seedTwoProviders(
  stack: ReturnType<typeof buildStack>,
  primaryUrl: string,
  backupUrl: string | null,
): Promise<{ primaryModelId: string; backupModelId: string | null }> {
  const primary = await stack.providers.create({
    userId: USER,
    name: '主服务',
    protocol: 'openai',
    baseUrl: primaryUrl,
  });
  const primaryModel = stack.models.create(primary.id, 'gpt-primary');
  stack.models.updateCapability(primaryModel.id, { inputPricePerMTok: 1, outputPricePerMTok: 1 });

  let backupModelId: string | null = null;
  if (backupUrl) {
    const backup = await stack.providers.create({
      userId: USER,
      name: '备用服务',
      protocol: 'openai',
      baseUrl: backupUrl,
      order: 1,
    });
    const backupModel = stack.models.create(backup.id, 'gpt-backup');
    backupModelId = backupModel.id;
  }

  stack.bindings.save(USER, {
    bindings: {},
    useDefaultForAll: true,
    defaultModelId: primaryModel.id,
  });

  return { primaryModelId: primaryModel.id, backupModelId };
}

describe('AI Gateway 统一出口', () => {
  it('按用途选模型 → 请求 → 用量落库', async () => {
    server = await startScripted(() => sseReply('生成完成'));
    const stack = buildStack();
    await seedTwoProviders(stack, server.url, null);

    const result = await collect(
      stack.gateway.chat({
        userId: USER,
        purpose: 'code',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(result.text).toBe('生成完成');
    const row = stack.db.prepare('SELECT * FROM usage_record').get() as
      Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.['purpose']).toBe('code');
    expect(row?.['total_tokens']).toBe(120);
    expect(row?.['cost']).toBeCloseTo(0.00012, 8);
  });

  it('429 → 排队重试 → 成功', async () => {
    server = await startScripted((_req, index) =>
      index === 0
        ? {
            status: 429,
            body: '{"error":{"message":"slow down"}}',
            headers: { 'retry-after': '0' },
          }
        : sseReply('重试后成功', 1, 1),
    );
    const stack = buildStack({ maxRetries: 2 });
    await seedTwoProviders(stack, server.url, null);

    const events: string[] = [];
    stack.gateway.onEvent((event) => events.push(event.type));

    const result = await collect(
      stack.gateway.chat({
        userId: USER,
        purpose: 'code',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result.text).toBe('重试后成功');
    expect(events).toContain('retry');
    expect(events).toContain('provider-selected');
  });

  it('连续失败 → 自动切备用 Provider', async () => {
    // 主服务固定 500，备用固定 200
    const primaryServer = await startScripted(() => ({
      status: 500,
      body: '{"error":{"message":"boom"}}',
    }));
    const backupServer = await startScripted(() => sseReply('备用接管', 0, 0));
    server = primaryServer;

    const stack = buildStack({ maxRetries: 0, failureThreshold: 1 });
    await seedTwoProviders(stack, primaryServer.url, backupServer.url);

    const events: Array<{ type: string; fromProviderId?: string; toProviderId?: string }> = [];
    stack.gateway.onEvent((event) => events.push(event as never));

    const result = await collect(
      stack.gateway.chat({
        userId: USER,
        purpose: 'code',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(result.text).toBe('备用接管');
    expect(events.some((event) => event.type === 'failover')).toBe(true);

    await primaryServer.close();
    await backupServer.close();
    server = null;
  });

  it('中断保留已生成内容', async () => {
    server = await startScripted(() => ({
      status: 200,
      headers: SSE_HEADERS,
      body:
        'data: {"choices":[{"delta":{"content":"已生成"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"的第二段"}}]}\n\n' +
        'data: [DONE]\n\n',
    }));
    const stack = buildStack();
    await seedTwoProviders(stack, server.url, null);

    const controller = new AbortController();
    const iterator = stack.gateway
      .chat({
        userId: USER,
        purpose: 'code',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    controller.abort();

    // 中断后流应当结束，且第一段内容已经拿到
    let text = first.value && first.value.type === 'delta' ? first.value.text : '';
    let finished = false;
    for (let i = 0; i < 5 && !finished; i += 1) {
      const next = await iterator.next();
      if (next.done) {
        finished = true;
        break;
      }
      if (next.value.type === 'delta') text += next.value.text;
    }
    expect(text.length).toBeGreaterThan(0);
  });

  it('预算超限时拒绝请求并给出明确提示', async () => {
    server = await startScripted(() => sseReply('ok'));
    const stack = buildStack({ monthlyUsd: 0 });
    await seedTwoProviders(stack, server.url, null);

    const result = await collect(
      stack.gateway.chat({
        userId: USER,
        purpose: 'code',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('本月预算已用尽');
    expect(result.partial).toBe(true);
  });

  it('未配置任何模型时给出可操作提示而不是抛异常', async () => {
    const stack = buildStack();
    const result = await collect(
      stack.gateway.chat({
        userId: USER,
        purpose: 'code',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result.error?.message).toContain('尚未配置可用模型');
  });
});
