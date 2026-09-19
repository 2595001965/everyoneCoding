/**
 * 全局统一重命名特性（T7-03 / T7-04 / T7-05）统一出口。
 *
 * 组件与端口的对应关系：
 * - `RenameDialog`（T7-03 触发 + 校验 + 影响面）→ `ImpactPanel` / `RiskGroup` / `ConflictWarning`
 * - `UnifiedDiffView` / `RenameProgress` / `RenameHistory`（T7-04 四栏 diff、执行进度、历史与撤销）
 * - `MigrationDialog` / `AliasCleanupPanel` / `BatchRenameDialog`（T7-05 迁移、别名清理、批处理）
 *
 * 所有组件都通过 `RenameApi` 端口工作（`RenameApiProvider` 注入），
 * 真实实现由桌面端外壳经 `globalThis.__EC_RENAME__` 装配。
 */

export {
  RenameApiProvider,
  RENAME_API_GLOBAL_KEY,
  createUnavailableRenameApi,
  readInjectedRenameApi,
  useRenameApi,
  useRenameApiOptional,
  useRenameResource,
  type RenameApi,
  type RenameTarget,
  type MigrationPlanRequest,
  type MigrationPlanError,
  type BatchPlanRequest,
} from './rename-api';

export { RenameDialog, type RenameDialogProps } from './RenameDialog';
export {
  ImpactPanel,
  defaultImpactSelection,
  filterGroups,
  type ImpactPanelProps,
} from './ImpactPanel';
export { RiskGroup, describeLocation, type RiskGroupProps } from './RiskGroup';
export { ConflictWarning, type ConflictWarningProps } from './ConflictWarning';

export { UnifiedDiffView, type UnifiedDiffViewProps } from './UnifiedDiffView';
export { RenameProgress, type RenameProgressProps } from './RenameProgress';
export { RenameHistory, type RenameHistoryProps } from './RenameHistory';
export { MigrationDialog, type MigrationDialogProps } from './MigrationDialog';
export { AliasCleanupPanel, type AliasCleanupPanelProps } from './AliasCleanupPanel';
export { BatchRenameDialog, type BatchRenameDialogProps } from './BatchRenameDialog';
export { RenameWorkspace, triggerSourceOf, type RenameWorkspaceProps } from './RenameWorkspace';
