import { describe, expect, it } from 'vitest';
import { runConnectionTest } from '../connection-test';
import { ProtocolError } from '../error';
import type { ProviderAdapter } from '../adapter';
import type { Provider } from '../../domain/provider';

const provider: Provider = {
  id: 'probe',
  userId: 'local',
  name: '测试',
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1',
  headers: {},
  keyRef: null,
  timeoutMs: 1000,
  supportsStream: true,
  supportsTools: false,
  supportsVision: false,
  enabled: true,
  order: 0,
  manualModels: ['local-model'],
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};
const context = {
  apiKey: null,
  transport: {
    request: async (): Promise<never> => {
      throw new Error('不应调用');
    },
  },
};

describe('连接测试回归', () => {
  it('发现模型抛错而手填模型对话成功时返回成功', async () => {
    const adapter: ProviderAdapter = {
      protocol: 'openai',
      listModels: async () => {
        throw new ProtocolError('无模型列表');
      },
      countTokens: () => ({ tokens: 0, estimated: true, margin: 0 }),
      async *chat(request) {
        expect(request.model).toBe('local-model');
        expect(request.maxTokens).toBe(1);
        yield { type: 'delta', text: '好' };
        yield { type: 'done', finishReason: 'length', partial: false };
      },
    };
    const result = await runConnectionTest(adapter, provider, context);
    expect(result.ok).toBe(true);
    expect(result.models.source).toBe('manual');
  });

  it('主动取消或不完整响应不能被报告为连通成功', async () => {
    const adapter: ProviderAdapter = {
      protocol: 'openai',
      listModels: async () => ({ models: [], source: 'manual' }),
      countTokens: () => ({ tokens: 0, estimated: true, margin: 0 }),
      async *chat() {
        yield { type: 'done', finishReason: 'aborted', partial: true };
      },
    };
    expect((await runConnectionTest(adapter, provider, context)).ok).toBe(false);
  });

  it('错误消息、片段和序列化结果不暴露常见Key，cause不保留', () => {
    const key = 'sk-this-is-a-secret-key-12345';
    const error = new ProtocolError(`服务异常 ${key}`, {
      snippet: `api_key=${key}`,
      cause: new Error(key),
    });
    expect(error.message).not.toContain(key);
    expect(error.stack).not.toContain(key);
    expect(JSON.stringify(error.toJSON())).not.toContain(key);
    expect(error.cause).toBeUndefined();
  });
});
