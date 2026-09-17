/**
 * 性能断言工具：机器吞吐探针 + 归一化口径（T10-02 / T10-03）。
 *
 * 为什么需要它：本仓 vitest 全量并行跑（8 worker 抢 CPU），"绝对毫秒"断言会把
 * **机器被自己的测试打满**误报成性能回归——Wave 10 首次全量基线就是这样红的
 * （工作台 100 项目首屏实测 1445ms > 1000ms 预算，同一用例单独跑只要 ~350ms）。
 *
 * 口径（与 `packages/registry/src/__tests__/occurrence.test.ts` 的 T7-02 一致）：
 *   1. 被测工作量跑 3 遍取**最小值**，剔除调度抖动；
 *   2. 再跑一段固定工作量的纯计算循环（`probeMs`）测出当前机器吞吐；
 *   3. 断言 `best * CALM_PROBE_MS / calmProbe < 预算` —— 争用与 CPU 型号的影响
 *      同时作用在两个测量上，比值因此稳定。
 *
 * 采样值 / 探针值 / 归一化值一律 `process.stdout.write` 打印（`console.info` 会被
 * vitest 拦截吞掉），供人工复核真实差距。
 */

/** 探针在本机空载时的实测耗时（毫秒）；换成别的机器按实测量一次即可。 */
export const CALM_PROBE_MS = 20;

/** 固定工作量的纯计算循环，用于量化"当前机器有多忙"。 */
export function probeMs(): number {
  const started = performance.now();
  let acc = 0;
  for (let index = 0; index < 5_000_000; index += 1) acc = (acc + index) % 1_000_003;
  if (acc < 0) throw new Error('探针异常');
  return Number((performance.now() - started).toFixed(2));
}

export interface NormalizedTiming {
  /** 各轮采样（毫秒），已四舍五入到 2 位。 */
  samples: number[];
  /** 采样最小值。 */
  best: number;
  /** 机器吞吐探针各轮结果。 */
  probes: number[];
  /** 折算到空载机器上的耗时。 */
  normalized: number;
}

/** 把各轮采样按机器吞吐归一化，返回全部中间值供打印。 */
export function normalizeTiming(samples: readonly number[]): NormalizedTiming {
  const probes = [probeMs(), probeMs(), probeMs()];
  const calmProbe = Math.min(...probes);
  const best = Math.min(...samples);
  const normalized = Number(((best * CALM_PROBE_MS) / calmProbe).toFixed(2));
  return { samples: [...samples], best, probes, normalized };
}

/** 按统一格式打印一行性能口径，便于人工复核。 */
export function reportTiming(label: string, budgetMs: number, timing: NormalizedTiming, extra = ''): void {
  const { samples, best, probes, normalized } = timing;
  process.stdout.write(
    `[perf] ${label} 3 次采样=${samples.map((s) => `${s}ms`).join(' / ')}，` +
      `取最小值 ${best}ms；机器吞吐探针=${probes.map((p) => `${p}ms`).join(' / ')}，` +
      `归一化后 ${normalized}ms（预算 ${budgetMs}ms）${extra ? `，${extra}` : ''}\n`,
  );
}
