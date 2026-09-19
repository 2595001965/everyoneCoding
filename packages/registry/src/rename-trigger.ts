/**
 * 重命名触发（T7-03 要点 1/2，FR-UNI-03 / FR-UNI-11）。
 *
 * 四个触发点（PRD FR-UNI-03）：
 * 1. 设计器画布属性面板改名（`inspector`）
 * 2. 图层树重命名（`layers`）
 * 3. 页面名修改（`page`）
 * 4. 功能名修改（`feature`）
 *
 * 语义：
 * - **前置合法性校验同步执行**（保留字 / 冲突 / 非法字符 / 超长）——不通过立即回调
 *   `onBlocked` 并给出 3 个建议名，**不进入影响面分析**；
 * - 通过后按 **300ms 防抖**合并（连续输入只触发最后一次），到点回调 `onIntent`；
 * - 计时器可注入（`scheduler`），因此"300ms 防抖"在测试里是**确定性断言**而不是等真实时间。
 *
 * 本模块是纯逻辑，不写文件（写入口见 `rename-transaction`）。
 */

import { checkName, type CheckNameInput, type ConflictCheckResult } from './conflict-check';
import type { RegistryEntityType } from './registry-model';
import type { ResolvedNamingRule } from './naming/presets';

/** 四个触发点 */
export const RENAME_TRIGGER_SOURCES = ['inspector', 'layers', 'page', 'feature'] as const;
export type RenameTriggerSource = (typeof RENAME_TRIGGER_SOURCES)[number];

/** 触发点中文标签（UI 展示） */
export const TRIGGER_SOURCE_LABELS: Readonly<Record<RenameTriggerSource, string>> = {
  inspector: '画布属性面板',
  layers: '图层树重命名',
  page: '页面名',
  feature: '功能名',
};

/** 一次改名意图 */
export interface RenameIntent {
  registryId: string;
  projectId: string;
  entityType: RegistryEntityType;
  /** 稳定 ID（永不变更，FR-UNI-01） */
  entityId: string;
  oldName: string;
  newName: string;
  source: RenameTriggerSource;
  /** 触发时刻 */
  at: number;
}

/** 防抖窗口（PRD FR-UNI-03：修改后 300ms 内弹出影响面分析面板） */
export const RENAME_DEBOUNCE_MS = 300;

/** 可注入的定时器（测试用假实现，生产用 setTimeout / clearTimeout） */
export interface RenameScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export const renameScheduler: RenameScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface RenameTriggerOptions {
  /** 生效命名规则（用于合法性校验） */
  rule: ResolvedNamingRule;
  /** 产生"合法改名"时回调（应在此处启动影响面分析） */
  onIntent: (intent: RenameIntent) => void;
  /** 合法性校验不通过时回调（应在此处展示阻断提示 + 3 个建议名） */
  onBlocked: (intent: RenameIntent, result: ConflictCheckResult) => void;
  /** 符号表 / 排除项等校验上下文（可按项目动态变化） */
  checkContext?: (
    intent: RenameIntent,
  ) => Omit<CheckNameInput, 'canonicalName' | 'entityType' | 'rule'>;
  debounceMs?: number | undefined;
  scheduler?: RenameScheduler | undefined;
  /** 时钟注入，默认 `Date.now` */
  clock?: (() => number) | undefined;
}

export interface RenameTrigger {
  /** 提交一次改名（防抖） */
  trigger(intent: Omit<RenameIntent, 'at'> & { at?: number | undefined }): void;
  /** 立刻执行挂起的意图（跳过剩余防抖时间） */
  flush(): void;
  /** 当前挂起的意图（无则 null） */
  pending(): RenameIntent | null;
  /** 最近一次被阻断的校验结果（UI 用于展示建议名） */
  lastBlocked(): { intent: RenameIntent; result: ConflictCheckResult } | null;
  cancel(): void;
  dispose(): void;
}

/**
 * 创建触发器。
 *
 * 连续输入同一对象时，后一次覆盖前一次（`pending()` 只保留最新），
 * 到点后**只触发一次**——这正是属性面板 200ms/300ms 防抖合并的做法。
 */
export function createRenameTrigger(options: RenameTriggerOptions): RenameTrigger {
  const scheduler = options.scheduler ?? renameScheduler;
  const clock = options.clock ?? Date.now;
  const debounceMs = options.debounceMs ?? RENAME_DEBOUNCE_MS;
  let handle: unknown = null;
  let pendingIntent: RenameIntent | null = null;
  let blocked: { intent: RenameIntent; result: ConflictCheckResult } | null = null;

  const clear = (): void => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
  };

  const runValidation = (intent: RenameIntent): ConflictCheckResult => {
    const extra = options.checkContext?.(intent) ?? {};
    return checkName({
      canonicalName: intent.newName,
      entityType: intent.entityType,
      rule: options.rule,
      ...(extra.scope !== undefined ? { scope: extra.scope } : {}),
      ...(extra.symbols !== undefined ? { symbols: extra.symbols } : {}),
      ...(extra.exclude !== undefined ? { exclude: extra.exclude } : {}),
    });
  };

  return {
    trigger(input) {
      const intent: RenameIntent = { ...input, at: input.at ?? clock() };
      if (intent.newName === intent.oldName) {
        clear();
        pendingIntent = null;
        return;
      }
      const result = runValidation(intent);
      if (!result.ok) {
        // 阻断：立即回调，且不进入影响面分析
        clear();
        pendingIntent = null;
        blocked = { intent, result };
        options.onBlocked(intent, result);
        return;
      }
      blocked = null;
      pendingIntent = intent;
      clear();
      handle = scheduler.schedule(() => {
        handle = null;
        const target = pendingIntent;
        pendingIntent = null;
        if (target !== null) options.onIntent(target);
      }, debounceMs);
    },
    flush() {
      if (pendingIntent === null) return;
      clear();
      const target = pendingIntent;
      pendingIntent = null;
      options.onIntent(target);
    },
    pending() {
      return pendingIntent;
    },
    lastBlocked() {
      return blocked;
    },
    cancel() {
      clear();
      pendingIntent = null;
    },
    dispose() {
      clear();
      pendingIntent = null;
      blocked = null;
    },
  };
}
