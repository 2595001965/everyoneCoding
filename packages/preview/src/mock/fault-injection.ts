/**
 * 故障注入：依据 MockSettings 计算延迟与错误（错误率）。纯函数，rng 可注入以便测试确定性。
 */

import type { MockSettings } from './rules';

export interface FaultPlan {
  delayMs: number;
  status: number | null;
  body: unknown;
}

/** 计算本次响应的延迟（ms）：固定值原样返回，区间则按比例落在 [min, max]。 */
export function delayFor(settings: MockSettings, rng: () => number): number {
  const d = settings.delayMs;
  if (typeof d === 'number') return d;
  return d.min + rng() * (d.max - d.min);
}

/** 是否触发故障：errorRate<=0 永不失败，>=1 必然失败，否则按概率。 */
export function shouldFail(settings: MockSettings, rng: () => number): boolean {
  if (settings.errorRate <= 0) return false;
  if (settings.errorRate >= 1) return true;
  return rng() < settings.errorRate;
}

/** 生成完整故障计划：未触发错误时 status/body 为 null（由调用方走正常生成）。 */
export function planFault(settings: MockSettings, rng: () => number): FaultPlan {
  const delayMs = delayFor(settings, rng);
  if (shouldFail(settings, rng)) {
    return {
      delayMs,
      status: settings.errorStatus,
      body: { error: 'mock-fault', code: 'MOCK_ERROR', message: 'Mock 故障注入' },
    };
  }
  return { delayMs, status: null, body: null };
}
