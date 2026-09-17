/**
 * 设计稿快照与历史（T3-10）公共 API。
 * 主会话据此接线 `packages/designer/src/index.ts`。
 *
 * 与流水线阶段产物（T5-01 StageArtifact）**相互独立**：本模块不写 pipeline 相关表。
 */
export {
  describeDiff,
  diffSize,
  diffTrees,
  isEmptyDiff,
  locateInDsl,
  type AddedEntry,
  type DslTreeDiff,
  type ElementRef,
  type ModifiedEntry,
  type MovedEntry,
  type RemovedEntry,
} from './diff-ops';

export {
  BASELINE_EVERY,
  HistoryStore,
  applyOps,
  deepCloneSubtree,
  diffToOps,
  sameDsl,
  type CaptureInput,
  type DslOp,
  type HistoryStats,
  type HistoryStoreOptions,
  type SnapshotMeta,
  type SnapshotReason,
} from './snapshot';

export {
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  MILESTONE_KINDS,
  MILESTONE_LABELS,
  REASON_LABELS,
  createAutoSnapshotScheduler,
  serializeHistory,
  type AutoSnapshotOptions,
  type AutoSnapshotScheduler,
  type MilestoneKind,
} from './auto-snapshot';

export { Timeline, type TimelineProps } from './timeline';
export { DiffView, type DiffViewProps } from './diff-view';
