/**
 * Git 特性（T6-01 ~ T6-04）统一出口。
 *
 * 渲染层只通过 `GitApi` 端口访问 Git；`GitClient` 属于 Node 侧入口，绝不在此转出。
 */
export {
  GitApiProvider,
  useGitApi,
  useGitApiOptional,
  readInjectedGitApi,
  GIT_API_GLOBAL_KEY,
  type GitApi,
  type GitRepoInfo,
  type GitProgressEvent,
  type RemoteTestResult,
} from './git-api';

export { changeSourceLabel, isValidBranchName, suggestedCredentialKind } from './git-helpers';

export { ChangesPanel } from './ChangesPanel';
export { FileDiff } from './FileDiff';
export { HunkSelector } from './HunkSelector';
export { CommitBox } from './CommitBox';
export { BranchTree } from './BranchTree';
export { BranchGraph, BRANCH_GRAPH_GEOMETRY } from './BranchGraph';
export { RemoteManager } from './RemoteManager';
export { HistoryTimeline, formatTime, type HistoryDetail } from './HistoryTimeline';
export { HistoryFilter, EMPTY_HISTORY_FILTER, toLogOptions, type HistoryFilterValue } from './HistoryFilter';
export { MergePanel } from './MergePanel';
export { ConflictEditor } from './ConflictEditor';
export { RollbackDialog } from './RollbackDialog';
export { StashPanel } from './StashPanel';
export { GitWorkspace } from './GitWorkspace';
