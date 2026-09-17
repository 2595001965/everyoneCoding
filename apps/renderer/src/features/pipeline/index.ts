/**
 * 开发流水线 feature 的对外入口（Wave 5 / T5-02）。
 *
 * 使用方式：
 * ```tsx
 * const api = readInjectedPipelineApi();          // 外壳注入 globalThis.__EC_PIPELINE__
 * <PipelineProvider api={api}>
 *   <PipelineWorkspace projectId="P1" userId="U-TEST" projectName="商城" />
 * </PipelineProvider>
 * ```
 * 未注入实现时页面展示装配引导（PipelinePage），而不是崩溃。
 */

export {
  PipelineProvider,
  usePipelineApi,
  usePipelineOptional,
  readInjectedPipelineApi,
  type PipelineApi,
} from './pipeline-api';
export { PipelineWorkspace, type PipelineWorkspaceProps } from './PipelineWorkspace';
export { PipelineBar, type PipelineBarProps } from './PipelineBar';
export { StagePanel, type StagePanelProps } from './StagePanel';
export { ArtifactViewer, type ArtifactViewerProps, renderMarkdownLines, extractMermaidSource } from './ArtifactViewer';
export { VersionSwitcher, type VersionSwitcherProps } from './VersionSwitcher';
export { DiffPanel, type DiffPanelProps } from './DiffPanel';
export { ModifyActions, MODIFY_ACTION_LABELS, type ModifyActionsProps, type ModifyAction } from './ModifyActions';
export { SupplementDialog, type SupplementDialogProps } from './SupplementDialog';
export { TechChoiceWizard } from './TechChoiceWizard';
export { TechDocPanel } from './TechDocPanel';
export { SplitGraph } from './SplitGraph';
export { SplitEditor } from './SplitEditor';
export { GenerationQueuePanel } from './GenerationQueuePanel';
export { NodeStatusCard } from './NodeStatusCard';
