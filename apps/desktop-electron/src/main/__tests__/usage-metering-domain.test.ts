import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptContext, GatewayContextPreviewRequest } from '@ec/ai';
import { createUsageDomain } from '../domain/domains/usage-domain';

const context: AttemptContext = {
  kind: 'next_request_estimate',
  computedAt: 1,
  estimatedNextInputTokens: 16,
  routeWindowTokens: 32_000,
  reservedOutputTokens: 512,
  safetyMarginTokens: 4,
  measuredSentInputTokens: null,
};

describe('V2-D05 usage domain 上下文估算', () => {
  it('调用 gateway 对当前完整请求做瞬时估算，并拒绝超大载荷', async () => {
    const db = new Database(':memory:');
    const previewContext = vi.fn((_request: GatewayContextPreviewRequest) => context);
    const router = createUsageDomain({ db, userId: 'USER0000000000000000000000', previewContext });
    const request = {
      purpose: 'code',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'request' },
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', output: 'result' }] },
      ],
      tools: [{ name: 'inspect', parameters: { type: 'object' } }],
      maxTokens: 512,
    };
    const ctx = { requestId: 'preview-1', emit: vi.fn() };

    await expect(router('previewContext', { request }, ctx)).resolves.toEqual(context);
    expect(previewContext).toHaveBeenCalledWith(request);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_attempt'")
        .get(),
    ).toBeUndefined();

    await expect(
      router(
        'previewContext',
        {
          request: { ...request, messages: [{ role: 'user', content: 'x'.repeat(2_000_001) }] },
        },
        ctx,
      ),
    ).rejects.toThrow('上下文估算请求无效');
    db.close();
  });
});
