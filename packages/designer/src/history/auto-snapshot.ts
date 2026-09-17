import type { DslStorePort } from '../dsl/serialize';
import type { PageDsl } from '../dsl/types';
import type { HistoryStore} from './snapshot';
import { type SnapshotMeta, type SnapshotReason } from './snapshot';

/**
 * 自动快照调度（T3-10 要点 2）。
 *
 * 触发时机：
 * - **定时**：默认每 5 分钟一次，且仅在「空闲」时执行（`isIdle` 返回 false 则跳过，不补做）；
 * - **关键操作**：阶段确认 / AI 生成完成 / 重命名事务 / 导入导出等里程碑，由
 *   `captureMilestone()` 立即落一张 `reason: 'milestone'` 的快照。
 *
 * 落盘（可选）：注入 `DslStorePort` 后，快照会以原子写方式写到
 * `<pageId>.history.json`，避免半截文件（NFR-R-02）。
 */

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/** 关键操作类型（与任务卡一致） */
export const MILESTONE_KINDS = [
  'stage-confirm',
  'ai-generated',
  'rename-transaction',
  'import',
  'export',
] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

export const MILESTONE_LABELS: Record<MilestoneKind, string> = {
  'stage-confirm': '流水线阶段确认',
  'ai-generated': 'AI 生成完成',
  'rename-transaction': '统一重命名事务',
  import: '记忆 / 工程导入',
  export: '工程导出',
};

export interface AutoSnapshotOptions {
  history: HistoryStore;
  /** 取当前 DSL（通常来自 editor store） */
  getDsl: () => PageDsl | null;
  /** 时钟注入（测试可控） */
  clock?: () => number;
  /** 空闲判定；默认始终空闲 */
  isIdle?: () => boolean;
  intervalMs?: number;
  /** 落盘端口（可选） */
  files?: DslStorePort;
  /** 落盘路径生成器；默认 `<pageId>.history.json` */
  pathFor?: (pageId: string) => string;
  /** 定时器注入（测试用假定时器） */
  setTimer?: (handler: () => void, timeout: number) => ReturnType<typeof setInterval>;
  clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface AutoSnapshotScheduler {
  /** 启动定时器（幂等） */
  start(): void;
  /** 停止定时器 */
  stop(): void;
  /** 是否运行中 */
  isRunning(): boolean;
  /** 立即执行一次定时检查（测试直接调用，避免依赖真实定时器） */
  tick(): SnapshotMeta | null;
  /** 关键操作快照 */
  captureMilestone(kind: MilestoneKind, dsl?: PageDsl): SnapshotMeta | null;
  /** 手动快照 */
  captureManual(label: string, dsl?: PageDsl): SnapshotMeta | null;
  /** 落盘历史（若注入了 files） */
  flush(): Promise<void>;
}

export function createAutoSnapshotScheduler(options: AutoSnapshotOptions): AutoSnapshotScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const clock = options.clock ?? ((): number => Date.now());
  const isIdle = options.isIdle ?? ((): boolean => true);
  const pathFor = options.pathFor ?? ((pageId: string): string => `${pageId}.history.json`);
  const setTimer = options.setTimer ?? ((handler, timeout) => setInterval(handler, timeout));
  const clearTimer = options.clearTimer ?? ((handle) => clearInterval(handle));

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRunAt = 0;

  const persist = async (): Promise<void> => {
    const files = options.files;
    if (files === undefined) return;
    const dsl = options.getDsl();
    if (dsl === null) return;
    const payload = JSON.stringify({ pageId: dsl.id, snapshots: options.history.list(dsl.id) }, null, 2);
    await files.writeAtomic(pathFor(dsl.id), payload);
  };

  const tick = (): SnapshotMeta | null => {
    // 定时快照只在空闲时执行（避免打断用户正在进行的拖拽 / 输入）
    if (!isIdle()) return null;
    const dsl = options.getDsl();
    if (dsl === null) return null;
    lastRunAt = clock();
    const meta = options.history.capture({ dsl, reason: 'auto', label: '定时自动快照', now: lastRunAt });
    void persist();
    return meta;
  };

  return {
    start: () => {
      if (timer !== null) return;
      timer = setTimer(() => {
        tick();
      }, intervalMs);
    },
    stop: () => {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    },
    isRunning: () => timer !== null,
    tick,
    captureMilestone: (kind, dsl) => {
      const current = dsl ?? options.getDsl();
      if (current === null) return null;
      const meta = options.history.capture({
        dsl: current,
        reason: 'milestone',
        label: MILESTONE_LABELS[kind],
        now: clock(),
      });
      void persist();
      return meta;
    },
    captureManual: (label, dsl) => {
      const current = dsl ?? options.getDsl();
      if (current === null) return null;
      const meta = options.history.capture({ dsl: current, reason: 'manual', label, now: clock() });
      void persist();
      return meta;
    },
    flush: persist,
  };
}

/** 快照原因的中文标签（时间轴展示） */
export const REASON_LABELS: Record<SnapshotReason, string> = {
  auto: '自动',
  manual: '手动',
  milestone: '关键操作',
};

/** 序列化快照为可落盘文本（便于外壳直接原子写） */
export function serializeHistory(pageId: string, snapshots: readonly SnapshotMeta[]): string {
  return JSON.stringify({ pageId, snapshots }, null, 2);
}
