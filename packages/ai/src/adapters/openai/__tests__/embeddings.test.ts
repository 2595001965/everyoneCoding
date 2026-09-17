/**
 * OpenAI 兼容协议 /embeddings 适配测试（T10-03 补齐：embeddings.ts 原覆盖 0%）。
 *
 * 覆盖：请求体构造（含/不含 dimensions）、响应解析、乱序 index 的向量重排、
 * 空输入/HTTP 404/非法 JSON/条数不一致的不可用降级（绝不抛错）。
 */

import { describe, it, expect, afterEach } from 'vitest';

import { OpenAiAdapter } from '../client';
import { createNodeHttpTransport } from '../../../core/node-transport';
import type { Provider } from '../../../domain/provider';
import { startMockServer, type MockServerHandle } from '../../../__tests__/helpers';
import {
  buildOpenAiEmbeddingBody,
  embedWithOpenAi,
  parseOpenAiEmbeddingResponse,
  vectorsFromEmbeddingResponse,
} from '../embeddings';

let server: MockServerHandle | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

function provider(baseUrl: string): Provider {
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
  };
}

function context(_baseUrl: string) {
  return { transport: createNodeHttpTransport(), apiKey: 'sk-test', timeoutMs: 5_000 };
}

describe('请求体与响应解析（纯函数）', () => {
  it('buildOpenAiEmbeddingBody：默认不含 dimensions；显式传入时包含', () => {
    const without = JSON.parse(buildOpenAiEmbeddingBody('text-embed', ['a', 'b'])) as {
      dimensions?: number;
      encoding_format: string;
    };
    expect(without.dimensions).toBeUndefined();
    expect(without.encoding_format).toBe('float');

    const withDims = JSON.parse(buildOpenAiEmbeddingBody('text-embed', ['a'], 128)) as { dimensions?: number };
    expect(withDims.dimensions).toBe(128);
    // null 与 undefined 同样省略（exactOptionalPropertyTypes 口径）
    expect(JSON.parse(buildOpenAiEmbeddingBody('m', ['a'], null))as { dimensions?: number }).not.toHaveProperty('dimensions');
  });

  it('parseOpenAiEmbeddingResponse：合法/缺 data/非 JSON', () => {
    expect(parseOpenAiEmbeddingResponse('{"data":[{"embedding":[0.1]}]}')).not.toBeNull();
    expect(parseOpenAiEmbeddingResponse('{"model":"x"}')).toBeNull(); // 缺 data 数组
    expect(parseOpenAiEmbeddingResponse('not-json')).toBeNull();
    expect(parseOpenAiEmbeddingResponse('null')).toBeNull();
  });

  it('vectorsFromEmbeddingResponse：乱序 index 重排、条数校验、空向量拒绝', () => {
    const response = {
      data: [
        { embedding: [2, 2], index: 1 },
        { embedding: [1, 1], index: 0 },
      ],
    };
    expect(vectorsFromEmbeddingResponse(response, 2)).toEqual([[1, 1], [2, 2]]);
    // 条数不一致
    expect(vectorsFromEmbeddingResponse(response, 3)).toBeNull();
    // 空向量
    expect(vectorsFromEmbeddingResponse({ data: [{ embedding: [], index: 0 }] }, 1)).toBeNull();
  });
});

describe('embedWithOpenAi（本地 mock 服务，真实 HTTP）', () => {
  it('成功路径：向量与用量回传', async () => {
    server = await startMockServer([
      {
        method: 'POST',
        path: '/v1/embeddings',
        body: JSON.stringify({
          data: [
            { embedding: [0.1, 0.2], index: 0 },
            { embedding: [0.3, 0.4], index: 1 },
          ],
          model: 'text-embed',
          usage: { prompt_tokens: 6, total_tokens: 6 },
        }),
      },
    ]);
    const result = await embedWithOpenAi({
      provider: provider(server.url),
      model: { id: 'm1', providerId: 'p-openai', name: 'text-embed', createdAt: 0, updatedAt: 0 } as never,
      inputs: ['你好', '世界'],
      context: context(server.url),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
      expect(result.dimensions).toBe(2);
      expect(result.usage?.totalTokens).toBe(6);
      expect(result.model).toBe('text-embed');
    }
  });

  it('空输入：直接不可用，不发请求', async () => {
    const result = await embedWithOpenAi({
      provider: provider('http://localhost:0'),
      model: { id: 'm1', providerId: 'p', name: 'text-embed', createdAt: 0, updatedAt: 0 } as never,
      inputs: [],
      context: context('http://localhost:0'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('没有需要向量化的文本');
  });

  it('HTTP 404：归类为"该中转不提供 embeddings"（unsupported-model 而非 failed）', async () => {
    server = await startMockServer([{ method: 'POST', path: '/v1/embeddings', status: 404, body: 'not found' }]);
    const result = await embedWithOpenAi({
      provider: provider(server.url),
      model: { id: 'm1', providerId: 'p', name: 'text-embed', createdAt: 0, updatedAt: 0 } as never,
      inputs: ['a'],
      context: context(server.url),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsupported-model');
      expect(result.reason).toContain('404');
    }
  });

  it('HTTP 401：failed 且带映射后的错误信息', async () => {
    server = await startMockServer([{ method: 'POST', path: '/v1/embeddings', status: 401, body: 'unauthorized' }]);
    const result = await embedWithOpenAi({
      provider: provider(server.url),
      model: { id: 'm1', providerId: 'p', name: 'text-embed', createdAt: 0, updatedAt: 0 } as never,
      inputs: ['a'],
      context: context(server.url),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('failed');
  });

  it('非法 JSON 响应：failed 且不抛错（映射为协议错误文案）', async () => {
    server = await startMockServer([{ method: 'POST', path: '/v1/embeddings', body: 'not-json-at-all' }]);
    const result = await embedWithOpenAi({
      provider: provider(server.url),
      model: { id: 'm1', providerId: 'p', name: 'text-embed', createdAt: 0, updatedAt: 0 } as never,
      inputs: ['a'],
      context: context(server.url),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('failed');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('响应条数与输入不一致：忽略本次结果', async () => {
    server = await startMockServer([
      { method: 'POST', path: '/v1/embeddings', body: JSON.stringify({ data: [{ embedding: [1], index: 0 }] }) },
    ]);
    const result = await embedWithOpenAi({
      provider: provider(server.url),
      model: { id: 'm1', providerId: 'p', name: 'text-embed', createdAt: 0, updatedAt: 0 } as never,
      inputs: ['a', 'b'],
      context: context(server.url),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('条数与输入不一致');
  });

  it('transport 抛 TransportError（连接拒绝）：failed 且不抛错', async () => {
    const result = await embedWithOpenAi({
      provider: provider('http://127.0.0.1:1'), // 无人监听端口
      model: { id: 'm1', providerId: 'p', name: 'text-embed', createdAt: 0, updatedAt: 0 } as never,
      inputs: ['a'],
      context: context('http://127.0.0.1:1'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('failed');
  });
});

describe('OpenAiAdapter 的嵌入入口', () => {
  it('适配器实例可构造且暴露 chat 能力（嵌入走 embedWithOpenAi 独立函数）', () => {
    const adapter = new OpenAiAdapter();
    expect(typeof adapter.chat).toBe('function');
  });
});
