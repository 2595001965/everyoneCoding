import { describe, expect, it } from 'vitest';
import { applyFieldRules, type FieldRule, randomString } from '../mock/rules';

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

describe('字段规则：random-string', () => {
  it('生成指定长度的随机字符串', () => {
    const value = { name: '' };
    const rules: FieldRule[] = [{ path: 'name', kind: 'random-string', length: 5 }];
    const out = applyFieldRules(value, rules, mulberry32(1)) as { name: string };
    expect(out.name).toHaveLength(5);
  });

  it('相同 seed 结果可复现', () => {
    const rules: FieldRule[] = [{ path: 'name', kind: 'random-string', length: 8 }];
    const a = applyFieldRules({ name: '' }, rules, mulberry32(7)) as { name: string };
    const b = applyFieldRules({ name: '' }, rules, mulberry32(7)) as { name: string };
    expect(a.name).toBe(b.name);
  });
});

describe('字段规则：random-number', () => {
  it('落在 [min,max] 且为整数', () => {
    const rules: FieldRule[] = [
      { path: 'n', kind: 'random-number', min: 10, max: 20, integer: true },
    ];
    const out = applyFieldRules({ n: 0 }, rules, mulberry32(3)) as { n: number };
    expect(out.n).toBeGreaterThanOrEqual(10);
    expect(out.n).toBeLessThanOrEqual(20);
    expect(Number.isInteger(out.n)).toBe(true);
  });
});

describe('字段规则：enum', () => {
  it('结果落在枚举值内', () => {
    const rules: FieldRule[] = [{ path: 'role', kind: 'enum', values: ['a', 'b', 'c'] }];
    const out = applyFieldRules({ role: '' }, rules, mulberry32(5)) as { role: string };
    expect(['a', 'b', 'c']).toContain(out.role);
  });
});

describe('字段规则：date', () => {
  it('生成 YYYY-MM-DD 且落在范围内', () => {
    const rules: FieldRule[] = [
      { path: 'd', kind: 'date', from: '2020-01-01', to: '2020-12-31', format: 'date' },
    ];
    const out = applyFieldRules({ d: '' }, rules, mulberry32(9)) as { d: string };
    expect(out.d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.d >= '2020-01-01').toBe(true);
    expect(out.d <= '2020-12-31').toBe(true);
  });
});

describe('字段规则：reference', () => {
  it('引用同响应内其它字段', () => {
    const rules: FieldRule[] = [{ path: 'b', kind: 'reference', refPath: 'a' }];
    const out = applyFieldRules({ a: 'X', b: '' }, rules, mulberry32(1)) as {
      a: string;
      b: string;
    };
    expect(out.b).toBe('X');
  });

  it('reference 支持 transform', () => {
    const rules: FieldRule[] = [{ path: 'b', kind: 'reference', refPath: 'a', transform: 'upper' }];
    const out = applyFieldRules({ a: 'abc', b: '' }, rules, mulberry32(1)) as { b: string };
    expect(out.b).toBe('ABC');
  });
});

describe('字段规则：array-length', () => {
  it('生成指定长度的数组', () => {
    const rules: FieldRule[] = [{ path: 'list', kind: 'array-length', count: 3 }];
    const out = applyFieldRules({ list: [] }, rules, mulberry32(1)) as { list: unknown[] };
    expect(Array.isArray(out.list)).toBe(true);
    expect(out.list).toHaveLength(3);
  });
});

describe('字段规则：constant', () => {
  it('写入常量值', () => {
    const rules: FieldRule[] = [{ path: 'k', kind: 'constant', constant: 'FIXED' }];
    const out = applyFieldRules({ k: '' }, rules, mulberry32(1)) as { k: string };
    expect(out.k).toBe('FIXED');
  });
});

describe('randomString 工具', () => {
  it('长度可控且可复现', () => {
    expect(randomString(mulberry32(11), 6)).toHaveLength(6);
    expect(randomString(mulberry32(11), 6)).toBe(randomString(mulberry32(11), 6));
  });
});
