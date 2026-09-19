import { describe, expect, it } from 'vitest';
import { type JsonSchemaLike } from '../mock/openapi-loader';
import { MockResponseGenerator } from '../mock/response-generator';
import { createFallbackOpenApi } from '../mock/openapi-loader';
import type { MockSettings } from '../mock/rules';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('MockResponseGenerator', () => {
  it('sample 按 schema 生成示例体', () => {
    const g = new MockResponseGenerator();
    const schema: JsonSchemaLike = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        n: { type: 'number', integer: true, minimum: 1, maximum: 5 },
      },
    };
    const body = g.sample(schema) as { id: string; n: number } | null;
    expect(body).not.toBeNull();
    expect(typeof body!.id).toBe('string');
    expect(Number.isInteger(body!.n)).toBe(true);
    expect(body!.n).toBeGreaterThanOrEqual(1);
    expect(body!.n).toBeLessThanOrEqual(5);
  });

  it('相同 seed 生成可复现', () => {
    const settings: MockSettings = { rules: [], delayMs: 0, errorRate: 0, errorStatus: 500 };
    const g1 = new MockResponseGenerator({ settings, rng: mulberry32(42) });
    const g2 = new MockResponseGenerator({ settings, rng: mulberry32(42) });
    const route = createFallbackOpenApi().routes[0]!;
    const a = g1.generate({ route });
    const b = g2.generate({ route });
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    expect(a.delayMs).toBe(b.delayMs);
  });

  it('errorRate=1 触发错误响应', () => {
    const g = new MockResponseGenerator({
      settings: { rules: [], delayMs: 0, errorRate: 1, errorStatus: 503 },
    });
    const route = createFallbackOpenApi().routes[0]!;
    const r = g.generate({ route });
    expect(r.status).toBe(503);
    expect(r.ruleHits).toBe(0);
  });

  it('errorRate=0 正常响应且规则命中可计数', () => {
    const settings: MockSettings = {
      rules: [{ path: 'status', kind: 'constant', constant: 'OK' }],
      delayMs: 0,
      errorRate: 0,
      errorStatus: 500,
    };
    const g = new MockResponseGenerator({ settings });
    const route = createFallbackOpenApi().routes[0]!;
    const r = g.generate({ route });
    expect(r.status).toBe(200);
    expect(r.ruleHits).toBeGreaterThanOrEqual(1);
  });

  it('updateSettings 改变错误率行为', () => {
    const g = new MockResponseGenerator();
    g.updateSettings({ errorRate: 1, errorStatus: 500 });
    const route = createFallbackOpenApi().routes[0]!;
    expect(g.generate({ route }).status).toBe(500);
  });
});
