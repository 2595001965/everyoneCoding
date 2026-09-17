/**
 * Debug 循环检测器（纯本地计算，无任何网络 / 数据库调用）。
 *
 * 两种命中规则：
 * 1. 循环：同一 targetKey 在窗口内出现 ≥ cycleThreshold 次
 *    「生成 → 运行 → 报错/不满意」循环（用状态机扫描，而非简单计数）；
 * 2. 连续错误：同一 errorSignature 在窗口内**连续**出现 ≥ repeatedErrorThreshold 次。
 *
 * 命中后通过"已上报集合"抑制重复触发，直到 consume(targetKey) 重置。
 */

import {
  readableTarget,
  type DebugEvent,
  type WindowQueue,
} from './window-queue';

/** 命中结果 */
export interface DetectionResult {
  /** 归属键 */
  targetKey: string;
  /** 命中的完整循环次数 */
  cycles: number;
  /** 窗口内出现的全部错误指纹（去重、稳定排序） */
  errorSignatures: string[];
  /** 建议标题，形如 `反复调试「页面PG1 / 元素E1」` */
  suggestedTitle: string;
  /** 命中原因 */
  reason: 'cycles' | 'repeated-error';
  pageId: string | null;
  elementId: string | null;
  featureId: string | null;
  /** 该 target 最早事件时间 */
  firstAt: number;
  /** 该 target 最晚事件时间 */
  lastAt: number;
}

/** DebugLoopDetector 构造依赖 */
export interface DebugLoopDetectorDeps {
  /** 事件队列（时间窗由它负责） */
  queue: WindowQueue;
  /** 循环阈值，默认 3 */
  cycleThreshold?: number;
  /** 连续错误阈值，默认 2 */
  repeatedErrorThreshold?: number;
  /** 时钟注入（默认 Date.now），用于 record 时取"当前"做窗口裁剪 */
  clock?: () => number;
}

/**
 * 统计「生成 → 运行 → 报错/不满意」完整循环次数。
 *
 * 状态机：idle → (generate) → generated → (run) → ran → (error|negative-feedback) → 完成一次循环，
 * 完成后回到 idle 等待下一次 generate。仅对 type 属于调试四态的事件做状态推进，
 * 其它类型忽略（保持状态不变）。
 */
function countCycles(events: readonly DebugEvent[]): number {
  let state: 'idle' | 'generated' | 'ran' = 'idle';
  let cycles = 0;
  for (const event of events) {
    switch (event.type) {
      case 'generate':
        state = 'generated';
        break;
      case 'run':
        if (state === 'generated') state = 'ran';
        break;
      case 'error':
      case 'negative-feedback':
        if (state === 'ran') {
          cycles++;
          state = 'idle';
        }
        break;
      default:
        break;
    }
  }
  return cycles;
}

/**
 * 找出"同一 errorSignature 连续出现 ≥ threshold 次"的指纹集合。
 *
 * 「连续」定义（写进 TSDoc 并供测试断言）：
 * 以同一 targetKey 的事件序列（按时间升序）为准，先抽出其中全部 type==='error' 的子序列，
 * 在该子序列里**位置相邻**（即中间不隔任何其它 error 事件）且 errorSignature 相同的两次即为"连续一次"。
 * 因此一次成功的 generate/run 夹在两个 error 之间，并不会打断这两个 error 的相邻关系——
 * 它们仍算连续。把每个签名的最长连续段长度算出来，>= threshold 的签名入选。
 */
function consecutiveErrorSignatures(events: readonly DebugEvent[], threshold: number): string[] {
  const errors = events.filter((e) => e.type === 'error' && e.errorSignature);
  const longest = new Map<string, number>();
  let runSig: string | null = null;
  let runLen = 0;
  for (const event of errors) {
    const sig = event.errorSignature!;
    if (sig === runSig) {
      runLen++;
    } else {
      runSig = sig;
      runLen = 1;
    }
    const prev = longest.get(sig) ?? 0;
    if (runLen > prev) longest.set(sig, runLen);
  }
  const result: string[] = [];
  for (const [sig, len] of longest) {
    if (len >= threshold) result.push(sig);
  }
  return result.sort();
}

/** 从事件序列里取某归属字段的第一个非空值 */
function firstNonNull<T>(values: (T | null | undefined)[]): T | null {
  for (const v of values) {
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export class DebugLoopDetector {
  private readonly queue: WindowQueue;
  private readonly cycleThreshold: number;
  private readonly repeatedErrorThreshold: number;
  private readonly clock: () => number;
  /** 已上报的 targetKey：命中后写入，record 不再重复返回，直到 consume 重置 */
  private readonly reported = new Set<string>();

  constructor(deps: DebugLoopDetectorDeps) {
    this.queue = deps.queue;
    this.cycleThreshold = deps.cycleThreshold ?? 3;
    this.repeatedErrorThreshold = deps.repeatedErrorThreshold ?? 2;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * 记录一条事件并做检测。
   * @returns 命中且尚未被 consume 时返回 DetectionResult，否则 null
   */
  record(event: DebugEvent): DetectionResult | null {
    this.queue.push(event);
    if (this.reported.has(event.targetKey)) return null;
    const now = this.clock();
    const events = this.queue.within(now).filter((e) => e.targetKey === event.targetKey);
    const result = this.detectOne(event.targetKey, events);
    if (!result) return null;
    this.reported.add(event.targetKey);
    return result;
  }

  /**
   * 查看当前窗口内所有命中（快照，不受 consume 抑制影响）。
   * @param now 当前时间；缺省用注入的时钟
   */
  inspect(now: number = this.clock()): DetectionResult[] {
    const all = this.queue.within(now);
    const byTarget = new Map<string, DebugEvent[]>();
    for (const event of all) {
      const arr = byTarget.get(event.targetKey) ?? [];
      arr.push(event);
      byTarget.set(event.targetKey, arr);
    }
    const results: DetectionResult[] = [];
    for (const [key, events] of byTarget) {
      const result = this.detectOne(key, events);
      if (result) results.push(result);
    }
    return results;
  }

  /** 重置全部状态（队列 + 抑制集合） */
  reset(): void {
    this.queue.clear();
    this.reported.clear();
  }

  /** 消费某个 target 的命中：清除抑制，使其后续可再次触发 */
  consume(targetKey: string): void {
    this.reported.delete(targetKey);
  }

  /** 针对单个 target 的已排序事件做检测 */
  private detectOne(targetKey: string, rawEvents: readonly DebugEvent[]): DetectionResult | null {
    if (rawEvents.length === 0) return null;
    const events = [...rawEvents].sort((a, b) => a.at - b.at);

    const cycles = countCycles(events);
    const allSigs = [...new Set(events.filter((e) => e.errorSignature).map((e) => e.errorSignature!))].sort();
    const repeated = consecutiveErrorSignatures(events, this.repeatedErrorThreshold);

    let reason: DetectionResult['reason'] | null = null;
    if (cycles >= this.cycleThreshold) reason = 'cycles';
    else if (repeated.length > 0) reason = 'repeated-error';
    if (!reason) return null;

    const pageId = firstNonNull(events.map((e) => e.pageId));
    const elementId = firstNonNull(events.map((e) => e.elementId));
    const featureId = firstNonNull(events.map((e) => e.featureId));
    const readable = readableTarget({ pageId, elementId, featureId });

    return {
      targetKey,
      cycles,
      errorSignatures: allSigs,
      suggestedTitle: `反复调试「${readable}」`,
      reason,
      pageId,
      elementId,
      featureId,
      firstAt: events[0]!.at,
      lastAt: events[events.length - 1]!.at,
    };
  }
}
