import { describe, expect, it } from 'vitest';

import {
  normalizeErrorSignature,
  targetKeyOf,
  WindowQueue,
  type DebugEvent,
  type DebugEventType,
} from '../window-queue';

function makeEvent(
  at: number,
  type: DebugEventType,
  targetKey: string,
  extra: Partial<DebugEvent> = {},
): DebugEvent {
  return { at, type, targetKey, ...extra };
}

describe('targetKeyOf', () => {
  it('稳定且可读，缺省用 -，与字段顺序无关', () => {
    const a = targetKeyOf({ pageId: 'PG1', elementId: 'E1' });
    const b = targetKeyOf({ elementId: 'E1', pageId: 'PG1' });
    expect(a).toBe('page:PG1|element:E1|feature:-');
    expect(a).toBe(b);
    expect(targetKeyOf({})).toBe('page:-|element:-|feature:-');
  });
});

describe('WindowQueue 时间窗', () => {
  it('within 按时间升序返回窗口内事件，并清理过期项', () => {
    const q = new WindowQueue({ windowMs: 10000, maxEvents: 500 });
    q.push(makeEvent(1000, 'generate', 'k'));
    q.push(makeEvent(3000, 'run', 'k'));
    q.push(makeEvent(5000, 'error', 'k'));

    expect(q.within(5000).map((e) => e.at)).toEqual([1000, 3000, 5000]);
    expect(q.size(5000)).toBe(3);
  });

  it('now 前移超过 windowMs 后 within 不再包含旧事件', () => {
    const q = new WindowQueue({ windowMs: 10000, maxEvents: 500 });
    q.push(makeEvent(0, 'generate', 'k'));
    q.push(makeEvent(2000, 'run', 'k'));

    // windowMs=10000：now=12001 时 cutoff=2001，两个事件都早于 cutoff 被清理
    expect(q.within(12001).map((e) => e.at)).toEqual([]);
    // 清理后队列确实为空
    expect(q.size(12001)).toBe(0);
    expect(q.size(12001)).toBe(0);
  });

  it('窗口为半开区间：at 等于 cutoff 的事件保留，小于则过期', () => {
    const q = new WindowQueue({ windowMs: 1000 });
    q.push(makeEvent(500, 'generate', 'k'));
    q.push(makeEvent(1500, 'run', 'k'));
    // now=1500 → cutoff=500 → at=500 保留，at=1500 保留
    expect(q.within(1500).map((e) => e.at)).toEqual([500, 1500]);
    // now=2000 → cutoff=1000 → at=500 过期
    expect(q.within(2000).map((e) => e.at)).toEqual([1500]);
  });

  it('窗口为半开区间：at 等于 cutoff 的事件保留，小于则过期', () => {
    const q = new WindowQueue({ windowMs: 1000 });
    q.push(makeEvent(500, 'generate', 'k'));
    q.push(makeEvent(1500, 'run', 'k'));
    // now=1500 → cutoff=500 → at=500 保留，at=1500 保留
    expect(q.within(1500).map((e) => e.at)).toEqual([500, 1500]);
    // now=2000 → cutoff=1000 → at=500 过期
    expect(q.within(2000).map((e) => e.at)).toEqual([1500]);
  });

  it('超出 maxEvents 时丢弃最旧', () => {
    const q = new WindowQueue({ windowMs: 100000, maxEvents: 2 });
    q.push(makeEvent(1, 'generate', 'k'));
    q.push(makeEvent(2, 'run', 'k'));
    q.push(makeEvent(3, 'error', 'k'));
    expect(q.within(100000).map((e) => e.at)).toEqual([2, 3]);
  });

  it('within 是纯查询：不依赖系统时钟', () => {
    const q = new WindowQueue({ windowMs: 1000 });
    q.push(makeEvent(0, 'error', 'k'));
    // 同样的 now 多次调用结果一致，且不读取 Date.now
    expect(q.within(500)).toEqual(q.within(500));
    expect(q.size(500)).toBe(1);
  });
});

describe('normalizeErrorSignature 指纹归一化', () => {
  it('不同行号/路径/时间戳的同类错误得到同一指纹', () => {
    const a = normalizeErrorSignature(
      "TypeError: Cannot read properties of undefined (reading 'x') at /a/b.ts:12:5 timestamp=2024-01-01T10:00:00Z",
    );
    const b = normalizeErrorSignature(
      "TypeError: Cannot read properties of undefined (reading 'x') at /c/d.ts:99:1 timestamp=2024-02-02T22:22:22Z",
    );
    expect(a).toBe(b);
    expect(a).toContain('typeerror: cannot read properties of undefined (reading');
    expect(a).not.toContain('/a/b.ts');
    expect(a).not.toContain('/c/d.ts');
    expect(a).not.toContain('12:5');
    expect(a).not.toContain('99:1');
  });

  it('不同类型错误得到不同指纹', () => {
    const a = normalizeErrorSignature(
      'TypeError: Cannot read properties of undefined at /a.ts:1:1',
    );
    const b = normalizeErrorSignature('ReferenceError: foo is not defined at /b.ts:2:2');
    expect(a).not.toBe(b);
  });

  it('抹掉十六进制地址与引号内的变量值', () => {
    const a = normalizeErrorSignature('Error: boom at 0x1a2b with id "abc123"');
    const b = normalizeErrorSignature('Error: boom at 0xdead with id "zzz999"');
    expect(a).toBe(b);
    expect(a).not.toContain('abc123');
    expect(a).not.toContain('zzz999');
    expect(a).toContain('<hex>');
  });

  it('空输入返回空串', () => {
    expect(normalizeErrorSignature('')).toBe('');
  });
});
