/**
 * E2E-10：自定义中转 —— 填入第三方 OpenAI 兼容 baseUrl + Key → 测试连通 → 列出模型 → 完成一次生成。
 *
 * 装配（全真实）：本地 HTTP 服务（真实请求与 SSE 字节流）+ 内存 SQLite（真实迁移与仓库）
 * + 真实 `OpenAiAdapter` + 真实 `AiGateway`（含用量落库）。只有 baseUrl 指向本机 127.0.0.1，
 * 其余链路与生产完全一致 —— 这才叫"连通性验证"，而不是打桩。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  AiGateway,
  ApiKeyStore,
  BudgetGuard,
  FailoverController,
  ModelRepo,
  OpenAiAdapter,
  ProviderRepo,
  PurposeBindingRepo,
  RequestQueue,
  UsageRepo,
  UsageTracker,
  collect,
  createNodeHttpTransport,
} from '@ec/ai';

// 测试脚手架（不在包出口）：内存库 + 用户夹具 + 密钥环 + 本地 HTTP 服务
import {
  insertUser,
  openTestDb,
  startMockServer,
  testSecureStore,
  type MockServerHandle,
} from '../../packages/ai/src/__tests__/helpers';

const USER = 'USER0000000000000000000000';

/** OpenAI 非流式响应（连接测试用；testConnection 以 stream:false 发一次探测） */
function jsonReply(text: string, promptTokens = 2, completionTokens = 1): string {
  return JSON.stringify({
    id: 'cmpl-relay',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}

/** OpenAI 流式响应（含末帧 usage 与 [DONE]） */
function sseReply(text: string, promptTokens = 12, completionTokens = 8): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    })}\n\n` +
    'data: [DONE]\n\n'
  );
}

let server: MockServerHandle | null = null;
let db: ReturnType<typeof openTestDb> | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  if (db) {
    db.close();
    db = null;
  }
});

describe('E2E-10 自定义中转：连通测试 → 列模型 → 一次生成', () => {
  it('baseUrl 指向自定义中转时：/models 可列举、chat 可完成且用量落库', async () => {
    let lastChatBody = '';

    // 1) 真实本地中转服务（模拟第三方 OpenAI 兼容端点）
    server = await startMockServer([
      {
        method: 'GET',
        path: '/v1/models',
        status: 200,
        body: JSON.stringify({
          data: [
            { id: 'relay-model-a', object: 'model' },
            { id: 'relay-model-b', object: 'model' },
          ],
        }),
      },
      {
        method: 'POST',
        path: '/v1/chat/completions',
        status: 200,
        // 同一路径按请求体的 stream 字段分流：
        // 连接测试用 stream:false（JSON），正式生成用 stream:true（SSE）。
        // 注意：helper 已消费完请求体才调用 handler，因此必须用 capture 拿 body，
        // 不能在 handler 里再挂 req.on('end')（永远不会触发 → 挂起）。
        capture: (body) => {
          lastChatBody = body;
        },
        handler: (_req, res) => {
          const wantsStream = /"stream"\s*:\s*true/.test(lastChatBody);
          if (wantsStream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(sseReply('自定义中转可用'));
          } else {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(jsonReply('ok'));
          }
        },
      },
    ]);

    // 2) 真实内存库 + 仓库栈（密钥只进密钥环引用）
    const database = openTestDb();
    db = database;
    insertUser(database, USER);

    const providers = new ProviderRepo(database, new ApiKeyStore(testSecureStore()));
    const models = new ModelRepo(database);
    const bindings = new PurposeBindingRepo(database);
    const usageRepo = new UsageRepo(database);
    const budget = new BudgetGuard(usageRepo, USER, { monthlyUsd: null });
    const usage = new UsageTracker(usageRepo, budget);

    const gateway = new AiGateway({
      providers,
      models,
      bindings,
      usage,
      budget,
      queue: new RequestQueue(),
      failover: new FailoverController({ failureThreshold: 2 }),
      transport: createNodeHttpTransport(),
      adapterFor: () => new OpenAiAdapter(),
      retry: { maxRetries: 0 },
    });

    // 3) 用户填入自定义中转：baseUrl + Key
    const provider = await providers.create({
      userId: USER,
      name: '我的中转',
      protocol: 'openai',
      baseUrl: server.url,
    });
    await providers.saveApiKey(provider.id, 'sk-custom-relay-test-key');

    // 4) 测试连通：列出模型
    const discovery = await gateway.testConnection(provider.id);
    expect(discovery.ok).toBe(true);
    expect(discovery.models.models.map((model) => model.name)).toContain('relay-model-a');

    // 5) 绑定默认模型并完成一次生成
    const model = models.create(provider.id, 'relay-model-a');
    models.updateCapability(model.id, { inputPricePerMTok: 1, outputPricePerMTok: 1 });
    bindings.save(USER, { bindings: {}, useDefaultForAll: true, defaultModelId: model.id });

    const result = await collect(
      gateway.chat({ userId: USER, purpose: 'code', messages: [{ role: 'user', content: '你好' }] }),
    );
    expect(result.text).toBe('自定义中转可用');

    // 用量落库（FR-AI-09：成本与用量统计的数据来源）
    const row = database.prepare('SELECT * FROM usage_record').get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.['purpose']).toBe('code');
    expect(row?.['total_tokens']).toBe(20);
  });

  it('中转不可达时如实返回失败（不静默成功，E2E-11 的降级前提）', async () => {
    const database = openTestDb();
    db = database;
    insertUser(database, USER);

    const providers = new ProviderRepo(database, new ApiKeyStore(testSecureStore()));
    const models = new ModelRepo(database);
    const bindings = new PurposeBindingRepo(database);
    const usageRepo = new UsageRepo(database);
    const budget = new BudgetGuard(usageRepo, USER, { monthlyUsd: null });
    const usage = new UsageTracker(usageRepo, budget);

    const gateway = new AiGateway({
      providers,
      models,
      bindings,
      usage,
      budget,
      queue: new RequestQueue(),
      failover: new FailoverController({ failureThreshold: 2 }),
      transport: createNodeHttpTransport(),
      adapterFor: () => new OpenAiAdapter(),
      retry: { maxRetries: 0 },
    });

    // 指向一个必然不可达的端口（本机高位端口，无监听）
    const provider = await providers.create({
      userId: USER,
      name: '不可达中转',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:1',
    });
    await providers.saveApiKey(provider.id, 'sk-x');

    const discovery = await gateway.testConnection(provider.id);
    expect(discovery.ok).toBe(false);
    // 失败原因如实返回（AiError，不静默成功）
    expect(discovery.error).not.toBeNull();
  });
});
