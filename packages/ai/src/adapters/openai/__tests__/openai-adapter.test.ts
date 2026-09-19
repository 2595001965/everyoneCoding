import { describe, it, expect, afterEach } from 'vitest';

import { OpenAiAdapter } from '../client';
import { createNodeHttpTransport } from '../../../core/node-transport';
import { collect } from '../../../core/stream';
import { runConnectionTest } from '../../../core/connection-test';
import { AuthError, RateLimitError, TimeoutError } from '../../../core/error';
import type { Provider } from '../../../domain/provider';
import { sse, startMockServer, type MockServerHandle } from '../../../__tests__/helpers';

let server: MockServerHandle | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

function provider(baseUrl: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p-openai',
    userId: 'u1',
    name: '测试 OpenAI',
    protocol: 'openai',
    baseUrl,
    keyRef: 'ref',
    headers: {},
    timeoutMs: 5_000,
    supportsStream: true,
    supportsTools: true,
    supportsVision: false,
    enabled: true,
    order: 0,
    manualModels: [],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('OpenAI 兼容适配器（本地 mock 服务，真实 HTTP）', () => {
  it('非流式：完整响应映射为内部消息', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      },
    ]);

    const adapter = new OpenAiAdapter();
    const result = await collect(
      adapter.chat(
        {
          provider: provider(server.url),
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        },
        { transport: createNodeHttpTransport(), apiKey: 'sk-test' },
      ),
    );

    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    const sent = JSON.parse(server.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sent['model']).toBe('gpt-4o');
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer sk-test');
  });

  it('流式：分片下发也能无损重组（含粘包）', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        chunks: [
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好，"}}]}\n\ndata: {"choices":[{"delta":{"content":"世界"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":3}}\n\n',
          'data: [DONE]\n\n',
        ],
      },
    ]);

    const adapter = new OpenAiAdapter();
    const result = await collect(
      adapter.chat(
        {
          provider: provider(server.url),
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { transport: createNodeHttpTransport(), apiKey: 'sk-test' },
      ),
    );
    expect(result.text).toBe('你好，世界');
    expect(result.usage?.totalTokens).toBe(6);
    expect(result.partial).toBe(false);
  });

  it('工具调用：tool_calls 映射为内部 tool_use', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"上海"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      },
    ]);

    const adapter = new OpenAiAdapter();
    const result = await collect(
      adapter.chat(
        {
          provider: provider(server.url),
          model: 'gpt-4o',
          messages: [{ role: 'user', content: '天气' }],
          stream: false,
        },
        { transport: createNodeHttpTransport(), apiKey: 'sk-test' },
      ),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'get_weather',
      arguments: { city: '上海' },
    });
  });

  it('错误映射：401 / 429 / 超时分别归类', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        status: 401,
        body: '{"error":{"message":"bad key"}}',
      },
    ]);
    const adapter = new OpenAiAdapter();
    await expect(
      collect(
        adapter.chat(
          {
            provider: provider(server.url),
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
          },
          { transport: createNodeHttpTransport(), apiKey: 'sk-test' },
        ),
      ),
    ).rejects.toBeInstanceOf(AuthError);

    await server.close();
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        status: 429,
        headers: { 'retry-after': '2' },
        body: '{"error":{"message":"slow down"}}',
      },
    ]);
    const limited = await collect(
      adapter.chat(
        {
          provider: provider(server.url),
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        },
        { transport: createNodeHttpTransport(), apiKey: 'sk-test' },
      ),
    ).catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(RateLimitError);
    expect((limited as RateLimitError).retryAfterMs).toBe(2000);

    await server.close();
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        status: 408,
        body: '{"error":{"message":"timeout"}}',
      },
    ]);
    await expect(
      collect(
        adapter.chat(
          {
            provider: provider(server.url),
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
          },
          { transport: createNodeHttpTransport(), apiKey: 'sk-test' },
        ),
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('列举模型：/models 可用时返回 remote 来源', async () => {
    server = await startMockServer([
      {
        method: 'GET',
        path: '/v1/models',
        body: JSON.stringify({
          data: [{ id: 'gpt-4o', context_window: 128000 }, { id: 'gpt-4o-mini' }],
        }),
      },
    ]);
    const adapter = new OpenAiAdapter();
    const discovery = await adapter.listModels(provider(server.url), {
      transport: createNodeHttpTransport(),
      apiKey: 'sk-test',
    });
    expect(discovery.source).toBe('remote');
    expect(discovery.models.map((model) => model.name)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(discovery.models[0]?.capability.contextWindow).toBe(128000);
  });

  it('列举模型：/models 不可用时回退手填列表', async () => {
    server = await startMockServer([
      { method: 'GET', path: '/v1/models', status: 403, body: '{"error":{"message":"forbidden"}}' },
    ]);
    const adapter = new OpenAiAdapter();
    const discovery = await adapter.listModels(
      provider(server.url, { manualModels: ['my-model'] }),
      {
        transport: createNodeHttpTransport(),
        apiKey: 'sk-test',
      },
    );
    expect(discovery.source).toBe('manual');
    expect(discovery.models.map((model) => model.name)).toEqual(['my-model']);
  });

  it('连接测试：列出模型 + 一次最小对话（max_tokens=1）', async () => {
    server = await startMockServer([
      { method: 'GET', path: '/v1/models', body: JSON.stringify({ data: [{ id: 'gpt-4o' }] }) },
      {
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1 },
        }),
      },
    ]);

    const result = await runConnectionTest(new OpenAiAdapter(), provider(server.url), {
      transport: createNodeHttpTransport(),
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(true);
    expect(result.models.models[0]?.name).toBe('gpt-4o');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const probe = JSON.parse(server.requests[1]?.body ?? '{}') as Record<string, unknown>;
    expect(probe['max_tokens']).toBe(1);
  });

  it('连接测试：对话不可用时返回失败与建议', async () => {
    server = await startMockServer([
      { method: 'GET', path: '/v1/models', body: JSON.stringify({ data: [{ id: 'gpt-4o' }] }) },
      {
        method: 'POST',
        path: '/v1/chat/completions',
        status: 401,
        body: '{"error":{"message":"bad key"}}',
      },
    ]);
    const result = await runConnectionTest(new OpenAiAdapter(), provider(server.url), {
      transport: createNodeHttpTransport(),
      apiKey: 'sk-test',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(AuthError);
    // 即便对话失败，模型列表仍然返回，便于 UI 提示"模型可见但不可调用"
    expect(result.models.models).toHaveLength(1);
  });

  it('SSE 中的心跳注释行不影响解析', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        body: sse([
          '{"choices":[{"delta":{"content":"A"}}]}',
          '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        ]),
      },
    ]);
    const adapter = new OpenAiAdapter();
    const result = await collect(
      adapter.chat(
        {
          provider: provider(server.url),
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { transport: createNodeHttpTransport(), apiKey: 'sk-test' },
      ),
    );
    expect(result.text).toBe('A');
  });
});
