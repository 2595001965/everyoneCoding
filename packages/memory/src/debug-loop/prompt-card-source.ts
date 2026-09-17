/**
 * 提示卡数据源（事件驱动、非模态语义的领域层实现）。
 *
 * 本类不依赖任何 UI / 渲染框架，只负责：在检测到反复调试后生成 {PromptDecision}，
 * 并通过 `on(listener)` 暴露事件订阅；同时管理"稍后"（snooze）与"不再提示"（持久忽略）。
 *
 * 非模态语义由渲染层保证（不抢焦点、可关闭），但本类必须保证：
 * - 不阻塞（evaluate 同步、轻量）；
 * - 不抛错（监听回调异常被吞掉，绝不影响主流程）；
 * - 可被忽略 / 静默（snooze / neverShow）。
 */

import type { DebugLoopDetector } from './detector';

/** 一次提示决策（渲染层据此展示非模态卡片） */
export interface PromptDecision {
  /** 归属键，便于渲染层去重与回调 */
  targetKey: string;
  /** 可读标题（不含 targetKey） */
  title: string;
  /** 固定文案：检测到正在反复调试「<标题>」，是否建立专门的问题记忆？ */
  message: string;
  /** 决策生成时间 */
  at: number;
}

/** 忽略存储（持久化实现由上层注入，T2-02 会接到设置项） */
export interface IgnoreStore {
  /** 该 target 是否已被持久忽略 */
  isIgnored(targetKey: string): boolean;
  /** 持久忽略该 target */
  ignore(targetKey: string): void;
}

/** 进程内忽略存储（默认实现；持久化请注入实现了 IgnoreStore 的设置项存储） */
export class InMemoryIgnoreStore implements IgnoreStore {
  private readonly ignored = new Set<string>();

  isIgnored(targetKey: string): boolean {
    return this.ignored.has(targetKey);
  }

  ignore(targetKey: string): void {
    this.ignored.add(targetKey);
  }
}

/** PromptCardSource 构造依赖 */
export interface PromptCardSourceDeps {
  detector: DebugLoopDetector;
  ignoreStore: IgnoreStore;
  /** 稍后静默时长（毫秒），默认 30 分钟 */
  snoozeMs?: number;
  /** 时钟注入（默认 Date.now） */
  clock?: () => number;
}

/** 从 suggestedTitle（形如 `反复调试「<可读部分>」`）抽取不含 targetKey 的可读标题 */
function extractReadableTitle(suggestedTitle: string): string {
  const matched = suggestedTitle.match(/「(.+?)」/);
  return matched?.[1] ?? suggestedTitle;
}

const PROMPT_MESSAGE = (readable: string): string =>
  `检测到正在反复调试「${readable}」，是否建立专门的问题记忆？`;

export class PromptCardSource {
  private readonly detector: DebugLoopDetector;
  private readonly ignoreStore: IgnoreStore;
  private readonly snoozeMs: number;
  private readonly clock: () => number;
  private readonly listeners = new Set<(decision: PromptDecision) => void>();
  /** targetKey → 静默到期时间（绝对毫秒） */
  private readonly snoozedUntil = new Map<string, number>();
  /** 本次会话内已派发过的 targetKey（避免同一命中重复弹卡） */
  private readonly emitted = new Set<string>();

  constructor(deps: PromptCardSourceDeps) {
    this.detector = deps.detector;
    this.ignoreStore = deps.ignoreStore;
    this.snoozeMs = deps.snoozeMs ?? 30 * 60 * 1000;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * 注册监听；返回取消订阅函数。
   * 监听回调中抛错不会影响 evaluate 的其余逻辑（错误被吞掉，仅记录）。
   */
  on(listener: (decision: PromptDecision) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 事件驱动：每次记录事件后调用。命中且未被忽略 / 未在静默期时才派发决策。
   * @returns 本次实际派发的决策列表（供非 UI 调用方同步获取）
   */
  evaluate(): PromptDecision[] {
    const now = this.clock();
    const results = this.detector.inspect(now);

    // 清理已不在当前检测中的 target 的"已派发"标记，使窗口清空后可再次提示
    const activeKeys = new Set(results.map((r) => r.targetKey));
    for (const key of [...this.emitted]) {
      if (!activeKeys.has(key)) this.emitted.delete(key);
    }

    const decisions: PromptDecision[] = [];
    for (const result of results) {
      if (this.ignoreStore.isIgnored(result.targetKey)) continue;
      if (this.isSnoozed(result.targetKey, now)) continue;
      if (this.emitted.has(result.targetKey)) continue;

      const readable = extractReadableTitle(result.suggestedTitle);
      const decision: PromptDecision = {
        targetKey: result.targetKey,
        title: readable,
        message: PROMPT_MESSAGE(readable),
        at: now,
      };
      decisions.push(decision);
      this.emitted.add(result.targetKey);
      this.dispatch(decision);
    }
    return decisions;
  }

  /** 用户点「稍后」：在 snoozeMs 内不再派发该 target */
  snooze(targetKey: string): void {
    const now = this.clock();
    this.snoozedUntil.set(targetKey, now + this.snoozeMs);
  }

  /** 用户点「不再提示此项」：经 IgnoreStore 持久忽略该 target */
  neverShow(targetKey: string): void {
    this.ignoreStore.ignore(targetKey);
  }

  /** 该 target 是否处于静默期 */
  isSnoozed(targetKey: string, now?: number): boolean {
    const until = this.snoozedUntil.get(targetKey);
    if (until === undefined) return false;
    const t = now ?? this.clock();
    return t < until;
  }

  /** 监听派发（吞掉回调异常，保证主流程不抛错） */
  private dispatch(decision: PromptDecision): void {
    for (const listener of this.listeners) {
      try {
        listener(decision);
      } catch {
        // 渲染层回调异常不应影响领域层
      }
    }
  }
}
