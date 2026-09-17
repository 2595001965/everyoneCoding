import { describe, it, expect } from 'vitest';

import { byteChunks, isDoneSignal, parseSse } from '../../adapters/shared/sse-parser';
import { firstMessage, mapHttpError, parseRetryAfter } from '../../adapters/shared/error-map';
import { AuthError, ContentFilterError, ContextLengthError, ProtocolError, ProviderUnavailableError, RateLimitError, TimeoutError } from '../../core/error';
import { openAiHeaders, buildOpenAiBody, toOpenAiMessages } from '../../adapters/openai/request-map';
import { resolveEndpoint, maskApiKey } from '../../domain/provider';

async function* bytes(...parts: Array<Uint8Array | string>): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield typeof part === 'string' ? encoder.encode(part) : part;
}

async function eventsOf(input: AsyncIterable<Uint8Array>): Promise<Array<{ event: string | null; data: string }>> {
  const out: Array<{ event: string | null; data: string }> = [];
  for await (const event of parseSse(input)) out.push(event);
  return out;
}

describe('SSE 字节级解析', () => {
  it('解析标准事件流', async () => {
    const events = await eventsOf(bytes('data: {"a":1}\n\n', 'data: {"b":2}\n\n'));
    expect(events).toEqual([
      { event: null, data: '{"a":1}' },
      { event: null, data: '{"b":2}' },
    ]);
  });

  it('跨分片粘包：一条 data 行被切成三段也能拼回', async () => {
    const raw = 'data: {"delta":"你好，世界"}\n\n';
    const parts = byteChunks(raw, 7);
    expect(parts.length).toBeGreaterThan(3);
    const events = await eventsOf(bytes(...parts));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"delta":"你好，世界"}');
  });

  it('心跳注释行与空行被忽略', async () => {
    const events = await eventsOf(bytes(': ping\n\n', '\n', 'data: ok\n\n', ': keep-alive\n\n'));
    expect(events).toEqual([{ event: null, data: 'ok' }]);
  });

  it('识别 [DONE] 终止标记', async () => {
    const events = await eventsOf(bytes('data: {"a":1}\n\n', 'data: [DONE]\n\n'));
    expect(events).toHaveLength(2);
    expect(isDoneSignal(events[1]?.data ?? '')).toBe(true);
  });

  it('兼容 CRLF 与末尾无换行的分片', async () => {
    const events = await eventsOf(bytes('data: one\r\n\r\n', 'data: two'));
    expect(events.map((item) => item.data)).toEqual(['one', 'two']);
  });

  it('多 data 行合并为单个事件（Anthropic 风格 event 名）', async () => {
    const events = await eventsOf(bytes('event: message_delta\ndata: {"a":1}\ndata: {"b":2}\n\n'));
    expect(events).toEqual([{ event: 'message_delta', data: '{"a":1}\n{"b":2}' }]);
  });
});

describe('错误映射', () => {
  it('状态码映射为对应错误类型', () => {
    expect(mapHttpError(401, '{"error":{"message":"bad key"}}')).toBeInstanceOf(AuthError);
    expect(mapHttpError(403, '')).toBeInstanceOf(AuthError);
    expect(mapHttpError(408, '')).toBeInstanceOf(TimeoutError);
    expect(mapHttpError(429, '', { headers: { 'retry-after': '2' } })).toBeInstanceOf(RateLimitError);
    expect(mapHttpError(500, '')).toBeInstanceOf(ProviderUnavailableError);
    expect(mapHttpError(400, '{}')).toBeInstanceOf(ProtocolError);
  });

  it('402 余额不足归类为不可重试的 ProviderUnavailable', () => {
    const error = mapHttpError(402, '{"error":{"message":"insufficient balance"}}');
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.retryable).toBe(false);
  });

  it('响应体关键词优先于状态码：上下文超限与内容过滤', () => {
    expect(mapHttpError(400, '{"error":{"code":"context_length_exceeded"}}')).toBeInstanceOf(ContextLengthError);
    expect(mapHttpError(400, '{"error":{"type":"content_filter"}}')).toBeInstanceOf(ContentFilterError);
  });

  it('Retry-After 支持秒数与 HTTP 日期', () => {
    expect(parseRetryAfter({ 'retry-after': '3' })).toBe(3000);
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter({ 'retry-after': future })).toBeGreaterThan(3000);
    expect(parseRetryAfter({})).toBeUndefined();
  });

  it('抽取常见错误体的可读文案', () => {
    expect(firstMessage('{"error":{"message":"boom"}}')).toBe('boom');
    expect(firstMessage('{"message":"boom2"}')).toBe('boom2');
    expect(firstMessage('not json at all')).toContain('not json');
  });
});

describe('OpenAI 请求映射与端点拼接', () => {
  it('system 独立成消息，tool 结果拆为独立 tool 消息', () => {
    const messages = toOpenAiMessages([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: '上海' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', output: '晴 28℃' }] },
    ]);

    expect(messages[0]).toEqual({ role: 'system', content: '你是助手' });
    const assistant = messages[2];
    expect(assistant?.tool_calls?.[0]?.function?.name).toBe('weather');
    expect(JSON.parse(assistant?.tool_calls?.[0]?.function?.arguments ?? '{}')).toEqual({ city: '上海' });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '晴 28℃' });
  });

  it('BaseUrl 拼接容错：带不带 /v1、尾斜杠都能得到正确端点', () => {
    expect(resolveEndpoint('https://api.openai.com', 'openai', 'chat')).toBe('https://api.openai.com/v1/chat/completions');
    expect(resolveEndpoint('https://api.openai.com/v1', 'openai', 'chat')).toBe('https://api.openai.com/v1/chat/completions');
    expect(resolveEndpoint('https://api.openai.com/v1/', 'openai', 'chat')).toBe('https://api.openai.com/v1/chat/completions');
    expect(resolveEndpoint('https://relay.example.com/api/v3', 'openai', 'chat')).toBe('https://relay.example.com/api/v3/chat/completions');
    expect(resolveEndpoint('https://relay.example.com/v1/chat/completions', 'openai', 'chat')).toBe(
      'https://relay.example.com/v1/chat/completions',
    );
    expect(resolveEndpoint('https://one.example.com', 'openai', 'models')).toBe('https://one.example.com/v1/models');
  });

  it('Anthropic 端点固定为 /messages', () => {
    expect(resolveEndpoint('https://api.anthropic.com', 'anthropic', 'chat')).toBe('https://api.anthropic.com/v1/messages');
    expect(resolveEndpoint('https://api.anthropic.com/v1', 'anthropic', 'chat')).toBe('https://api.anthropic.com/v1/messages');
  });

  it('自定义请求头透传，Key 走 Authorization', () => {
    const headers = openAiHeaders({ headers: { 'x-custom': '1' } }, 'sk-test');
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(headers['x-custom']).toBe('1');
    expect(openAiHeaders({ headers: {} }, null)['authorization']).toBeUndefined();
  });

  it('请求体包含流式与用量开关', () => {
    const body = JSON.parse(
      buildOpenAiBody(
        { provider: providerFixture(), model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 },
        { stream: true, includeUsage: true },
      ),
    ) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o');
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
    expect(body['max_tokens']).toBe(16);
  });

  it('UI 掩码：前 4 后 4', () => {
    expect(maskApiKey('sk-abcdefghijklmnop')).toBe('sk-a••••••mnop');
    expect(maskApiKey('short')).toBe('•••••');
  });
});

function providerFixture() {
  return {
    id: 'p1',
    userId: 'u1',
    name: '测试',
    protocol: 'openai' as const,
    baseUrl: 'https://api.openai.com/v1',
    keyRef: null,
    headers: {},
    timeoutMs: 30_000,
    supportsStream: true,
    supportsTools: true,
    supportsVision: false,
    enabled: true,
    order: 0,
    manualModels: [],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}
