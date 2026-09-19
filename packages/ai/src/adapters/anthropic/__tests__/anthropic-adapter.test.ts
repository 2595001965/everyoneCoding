import { describe, it, expect, afterEach } from 'vitest';

import { AnthropicAdapter } from '../client';
import { createNodeHttpTransport } from '../../../core/node-transport';
import { collect } from '../../../core/stream';
import { RateLimitError, AuthError } from '../../../core/error';
import type { Provider } from '../../../domain/provider';
import { startMockServer, type MockServerHandle } from '../../../__tests__/helpers';

let server: MockServerHandle | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

function provider(baseUrl: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p-anthropic',
    userId: 'u1',
    name: '测试 Anthropic',
    protocol: 'anthropic',
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

describe('Anthropic 兼容适配器（本地 mock 服务，真实 HTTP）', () => {
  it('system 置于顶层字段，认证用 x-api-key', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/messages',
        body: JSON.stringify({
          content: [{ type: 'text', text: '收到' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
      },
    ]);

    const adapter = new AnthropicAdapter();
    const result = await collect(
      adapter.chat(
        {
          provider: provider(server.url),
          model: 'claude-3-5-sonnet',
          messages: [
            { role: 'system', content: '你是助手' },
            { role: 'user', content: 'hi' },
          ],
          stream: false,
        },
        { transport: createNodeHttpTransport(), apiKey: 'sk-ant' },
      ),
    );

    expect(result.text).toBe('收到');
    const sent = JSON.parse(server.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sent['system']).toBe('你是助手');
    expect(sent['messages']).toHaveLength(1);
    expect(sent['max_tokens']).toBeGreaterThan(0);
    expect(server.requests[0]?.headers['x-api-key']).toBe('sk-ant');
    expect(server.requests[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('流式：多 content block 按 index 累积（文本 + 工具调用交错）', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/messages',
        chunks: [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"正在"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"查询"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"weather"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"上海\\"}"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ],
      },
    ]);

    const adapter = new AnthropicAdapter();
    const result = await collect(
      adapter.chat(
        {
          provider: provider(server.url),
          model: 'claude-3-5-sonnet',
          messages: [{ role: 'user', content: '天气' }],
        },
        { transport: createNodeHttpTransport(), apiKey: 'sk-ant' },
      ),
    );

    expect(result.text).toBe('正在查询');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'tool_1',
      name: 'weather',
      arguments: { city: '上海' },
    });
    expect(result.finishReason).toBe('tool_use');
    expect(result.usage?.promptTokens).toBe(10);
    expect(result.usage?.completionTokens).toBe(7);
  });

  it('tool_result 放在 user 消息的 content 块中', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/messages',
        body: JSON.stringify({ content: [{ type: 'text', text: '晴' }], stop_reason: 'end_turn' }),
      },
    ]);

    const adapter = new AnthropicAdapter();
    await collect(
      adapter.chat(
        {
          provider: provider(server.url),
          model: 'claude-3-5-sonnet',
          messages: [
            { role: 'user', content: '天气' },
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'tool_1', name: 'weather', input: { city: '上海' } },
              ],
            },
            {
              role: 'tool',
              content: [{ type: 'tool_result', toolUseId: 'tool_1', output: '晴 28℃' }],
            },
          ],
          stream: false,
        },
        { transport: createNodeHttpTransport(), apiKey: 'sk-ant' },
      ),
    );

    const sent = JSON.parse(server.requests[0]?.body ?? '{}') as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const last = sent.messages[sent.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content[0]?.['type']).toBe('tool_result');
    expect(last?.content[0]?.['tool_use_id']).toBe('tool_1');
  });

  it('错误映射复用同一套错误类型（429 / 401）', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/messages',
        status: 429,
        headers: { 'retry-after': '1' },
        body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
      },
    ]);
    const adapter = new AnthropicAdapter();
    const limited = await collect(
      adapter.chat(
        {
          provider: provider(server.url),
          model: 'claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        },
        { transport: createNodeHttpTransport(), apiKey: 'sk-ant' },
      ),
    ).catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(RateLimitError);
    expect((limited as RateLimitError).retryAfterMs).toBe(1000);

    await server.close();
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/messages',
        status: 401,
        body: '{"type":"error","error":{"message":"invalid x-api-key"}}',
      },
    ]);
    await expect(
      collect(
        adapter.chat(
          {
            provider: provider(server.url),
            model: 'claude-3-5-sonnet',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
          },
          { transport: createNodeHttpTransport(), apiKey: 'sk-ant' },
        ),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('流式错误事件（overloaded）转为 ProviderUnavailable', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/messages',
        chunks: [
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
        ],
      },
    ]);
    const adapter = new AnthropicAdapter();
    await expect(
      collect(
        adapter.chat(
          {
            provider: provider(server.url),
            model: 'claude-3-5-sonnet',
            messages: [{ role: 'user', content: 'hi' }],
          },
          { transport: createNodeHttpTransport(), apiKey: 'sk-ant' },
        ),
      ),
    ).rejects.toThrow();
  });

  it('/models 不可用时回退手填列表', async () => {
    server = await startMockServer([
      { method: 'GET', path: '/v1/models', status: 404, body: '{}' },
    ]);
    const adapter = new AnthropicAdapter();
    const discovery = await adapter.listModels(
      provider(server.url, { manualModels: ['claude-3-5-sonnet'] }),
      {
        transport: createNodeHttpTransport(),
        apiKey: 'sk-ant',
      },
    );
    expect(discovery.source).toBe('manual');
    expect(discovery.models.map((model) => model.name)).toEqual(['claude-3-5-sonnet']);
  });
});
