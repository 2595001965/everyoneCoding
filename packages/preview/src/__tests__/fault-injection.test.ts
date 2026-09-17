import { describe, expect, it } from 'vitest';
import { type MockSettings } from '../mock/rules';
import { delayFor, planFault, shouldFail } from '../mock/fault-injection';

const BASE: MockSettings = { rules: [], delayMs: 0, errorRate: 0, errorStatus: 500 };

describe('shouldFail 错误率', () => {
  it('errorRate=0 永不失败', () => {
    expect(shouldFail({ ...BASE, errorRate: 0 }, () => 0.9)).toBe(false);
    expect(shouldFail({ ...BASE, errorRate: 0 }, () => 0.1)).toBe(false);
  });

  it('errorRate=1 必然失败', () => {
    expect(shouldFail({ ...BASE, errorRate: 1 }, () => 0.1)).toBe(true);
    expect(shouldFail({ ...BASE, errorRate: 1 }, () => 0.9)).toBe(true);
  });

  it('errorRate 在 (0,1) 按 rng 决定', () => {
    expect(shouldFail({ ...BASE, errorRate: 0.5 }, () => 0.3)).toBe(true);
    expect(shouldFail({ ...BASE, errorRate: 0.5 }, () => 0.7)).toBe(false);
  });
});

describe('delayFor 延迟', () => {
  it('固定值原样返回', () => {
    expect(delayFor({ ...BASE, delayMs: 100 }, () => 0)).toBe(100);
  });

  it('区间按比例落在 [min,max]', () => {
    const d = delayFor({ ...BASE, delayMs: { min: 10, max: 20 } }, () => 0.5);
    expect(d).toBe(15);
    const d2 = delayFor({ ...BASE, delayMs: { min: 10, max: 20 } }, () => 0);
    expect(d2).toBe(10);
    const d3 = delayFor({ ...BASE, delayMs: { min: 10, max: 20 } }, () => 0.99);
    expect(d3).toBeLessThanOrEqual(20);
  });
});

describe('planFault 故障计划', () => {
  it('不触发错误时 status/body 为 null', () => {
    const plan = planFault({ ...BASE, errorRate: 0 }, () => 0.5);
    expect(plan.status).toBeNull();
    expect(plan.body).toBeNull();
  });

  it('触发错误时返回 errorStatus 与错误体', () => {
    const plan = planFault({ ...BASE, errorRate: 1, errorStatus: 503 }, () => 0.5);
    expect(plan.status).toBe(503);
    expect(plan.body).not.toBeNull();
  });

  it('延迟确定性由注入 rng 决定', () => {
    const plan = planFault({ ...BASE, errorRate: 0, delayMs: { min: 0, max: 100 } }, () => 0.25);
    expect(plan.delayMs).toBe(25);
  });
});
