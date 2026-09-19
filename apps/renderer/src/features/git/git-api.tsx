/**
 * Git 渲染层端口（T6-01 要点 5）。
 *
 * 与 `PipelineApi` 同一套做法：渲染层只认这个 `GitApi` 接口，真实实现由外壳
 * 经 `globalThis.__EC_GIT__` 注入（见 `readInjectedGitApi`）。渲染层**绝不**直接
 * `import { GitClient } from '@ec/git'`（那个入口会拖入 `node:child_process`）。
 *
 * 硬约束（见任务背景）：
 * - 用户永不接触命令行：所有操作由 UI 触发，结果以 `GitResult.logs` 结构化回显；
 * - AI 是代码唯一写入口（D-04）：冲突解决的结果经 `applyResolution` / `requestAiMerge`
 *   交给写入管线落盘，UI 不直接写文件；
 * - 破坏性操作（删分支 / 强推 / 删远程 / 合并 / 变基 / 回滚 / stash drop）均由 UI 二次确认。
 */

import { createContext, useContext, type ReactNode } from 'react';

import type {
  AutoCommitPolicy,
  ChangeSource,
  CommitConvention,
  ConflictFile,
  CredentialBinding,
  GitBranchInfo,
  GitCommit,
  GitDiff,
  GitDiffFile,
  GitRemote,
  GitResult,
  GitStashEntry,
  GitStatusSummary,
  GitTagInfo,
  MergeOutcome,
  RollbackMode,
  RollbackPlan,
} from '@ec/git';

/** 仓库基本信息（UI 顶部展示） */
export interface GitRepoInfo {
  path: string;
  name: string;
  branch: string | null;
  backendLabel: string;
  clean: boolean;
  ahead: number;
  behind: number;
}

/** 远程传输进度事件（推送 / 拉取 / 抓取） */
export interface GitProgressEvent {
  phase: 'idle' | 'connecting' | 'transferring' | 'done' | 'error';
  message: string;
  percent: number | null;
}

/** 远程连通性测试结果 */
export interface RemoteTestResult {
  remote: string;
  ok: boolean;
  branches: number;
  message: string;
}

/**
 * 渲染层消费的 Git 端口（冻结契约，UI 组件只能通过它访问 Git）。
 */
export interface GitApi {
  readonly ready: boolean;
  readonly reason?: string | undefined;
  info(): Promise<GitRepoInfo | null>;
  init(options?: {
    branch?: string;
    stacks?: readonly string[];
  }): Promise<GitResult<{ branch: string; gitignoreWritten: boolean; stacks: string[] }>>;

  /* 变更与提交 */
  status(): Promise<GitResult<GitStatusSummary>>;
  stage(paths: readonly string[]): Promise<GitResult<number>>;
  unstage(paths: readonly string[]): Promise<GitResult<number>>;
  commit(input: { subject: string; body?: string | undefined }): Promise<GitResult<string>>;
  /** 基于本次 diff 生成 Conventional Commits 提交信息（外壳调 AI 的 commit-msg 用途） */
  generateCommitMessage(input: { convention: CommitConvention }): Promise<GitResult<string>>;
  diff(options?: {
    scope?: 'worktree' | 'staged' | 'range';
    from?: string | undefined;
    to?: string | undefined;
    path?: string | undefined;
    contextLines?: number | undefined;
  }): Promise<GitResult<GitDiff>>;

  /* 分支 / 历史 */
  branches(): Promise<GitResult<GitBranchInfo[]>>;
  tags(): Promise<GitResult<GitTagInfo[]>>;
  createBranch(name: string, startPoint?: string): Promise<GitResult<string>>;
  switchBranch(name: string, create?: boolean): Promise<GitResult<string>>;
  renameBranch(from: string, to: string): Promise<GitResult<string>>;
  deleteBranch(name: string, force?: boolean): Promise<GitResult<string>>;
  log(options?: {
    limit?: number | undefined;
    skip?: number | undefined;
    path?: string | undefined;
    author?: string | undefined;
    keyword?: string | undefined;
    ref?: string | undefined;
  }): Promise<GitResult<GitCommit[]>>;
  commitDetail(
    sha: string,
  ): Promise<
    GitResult<{ commit: GitCommit; files: GitDiffFile[]; additions: number; deletions: number }>
  >;

  /* 合并 / 冲突 / 回滚 / 暂存 */
  previewMerge(
    source: string,
    target: string,
  ): Promise<GitResult<{ commits: GitCommit[]; filesChanged: number; fastForward: boolean }>>;
  merge(
    source: string,
    options?: { backup?: boolean | undefined; noFf?: boolean | undefined },
  ): Promise<GitResult<MergeOutcome>>;
  rebase(
    onto: string,
    options?: { backup?: boolean | undefined },
  ): Promise<GitResult<MergeOutcome>>;
  abort(kind: 'merge' | 'rebase'): Promise<GitResult<boolean>>;
  conflicts(): Promise<GitResult<ConflictFile[]>>;
  /** 把解决结果交给 AI 写入管线落盘（UI 不直接写文件，D-04） */
  applyResolution(input: {
    path: string;
    content: string;
    message: string;
  }): Promise<GitResult<string>>;
  /** 「两侧都要 → 交给 AI 合并」的请求载荷 */
  requestAiMerge(input: {
    path: string;
    blockIndex?: number | undefined;
  }): Promise<GitResult<{ instruction: string; context: string; paths: string[] }>>;
  stashList(): Promise<GitResult<GitStashEntry[]>>;
  stashPush(message?: string): Promise<GitResult<boolean>>;
  stashApply(index: number, drop?: boolean): Promise<GitResult<number>>;
  stashDrop(index: number): Promise<GitResult<number>>;
  rollbackPlan(input: { sha: string; mode: RollbackMode }): Promise<GitResult<RollbackPlan>>;
  rollbackExecute(
    plan: RollbackPlan,
  ): Promise<GitResult<{ snapshotBranch: string; newHead: string | null }>>;
  snapshots(): Promise<GitResult<{ name: string; sha: string | null; subject: string | null }[]>>;

  /* 远程与凭据 */
  remotes(): Promise<GitResult<GitRemote[]>>;
  addRemote(name: string, url: string): Promise<GitResult<string>>;
  editRemote(name: string, url: string): Promise<GitResult<string>>;
  removeRemote(name: string): Promise<GitResult<string>>;
  testRemote(name: string): Promise<GitResult<RemoteTestResult>>;
  push(
    input: {
      remote?: string | undefined;
      branch?: string | undefined;
      force?: boolean | undefined;
      forceWithLease?: boolean | undefined;
    },
    onProgress?: (event: GitProgressEvent) => void,
  ): Promise<GitResult<{ summary: string; upToDate: boolean; forced: boolean }>>;
  pull(
    input: { remote?: string | undefined },
    onProgress?: (event: GitProgressEvent) => void,
  ): Promise<GitResult<{ conflictFiles: string[]; upToDate: boolean; fastForward: boolean }>>;
  fetch(
    input: { remote?: string | undefined; prune?: boolean | undefined },
    onProgress?: (event: GitProgressEvent) => void,
  ): Promise<GitResult<{ summary: string; upToDate: boolean }>>;
  credentialBindings(): Promise<CredentialBinding[]>;
  saveHttpsCredential(input: {
    remoteName: string;
    username: string;
    token: string;
  }): Promise<void>;
  saveSshCredential(input: {
    remoteName: string;
    privateKeyPath: string;
    passphrase?: string | null;
  }): Promise<void>;
  removeCredential(remoteName: string): Promise<void>;

  /* 自动提交策略（FR-GIT-09，默认 off） */
  autoCommitPolicy(): Promise<AutoCommitPolicy>;
  setAutoCommitPolicy(policy: AutoCommitPolicy): Promise<void>;

  /** 变更来源（path → ChangeSource），用于「来源标签点击跳转」 */
  changeSources(): Promise<Record<string, ChangeSource>>;
}

/** 全局注入键（外壳装配后写入 globalThis） */
export const GIT_API_GLOBAL_KEY = '__EC_GIT__';

const GitContext = createContext<GitApi | null>(null);

export interface GitApiProviderProps {
  api: GitApi | null;
  children: ReactNode;
}

export function GitApiProvider({ api, children }: GitApiProviderProps): JSX.Element {
  return <GitContext.Provider value={api}>{children}</GitContext.Provider>;
}

/** 必须已注入端口，否则抛错（用于明确需要能力的面板） */
export function useGitApi(): GitApi {
  const api = useContext(GitContext);
  if (api === null) throw new Error('Git 端口未初始化：请先注入 GitApi');
  return api;
}

/** 端口可能为空（页面级别降级），返回 null 时由调用方展示引导 */
export function useGitApiOptional(): GitApi | null {
  return useContext(GitContext);
}

/** 关键方法指纹：用于校验外壳注入对象确实是 GitApi 而不是别的东西 */
const REQUIRED_METHODS: readonly (keyof GitApi)[] = [
  'info',
  'status',
  'stage',
  'commit',
  'diff',
  'branches',
  'merge',
  'conflicts',
  'rollbackExecute',
  'push',
  'remotes',
];

/** 从全局读取外壳注入的实现（用 typeof 校验关键方法） */
export function readInjectedGitApi(): GitApi | null {
  const injected = (globalThis as unknown as { [GIT_API_GLOBAL_KEY]?: unknown })[
    GIT_API_GLOBAL_KEY
  ];
  if (typeof injected !== 'object' || injected === null) return null;
  const candidate = injected as Record<string, unknown>;
  const looksLikeApi = REQUIRED_METHODS.every((method) => typeof candidate[method] === 'function');
  if (!looksLikeApi) return null;
  // ready / reason 等属性可能缺失，这里只校验方法指纹
  return candidate as unknown as GitApi;
}
