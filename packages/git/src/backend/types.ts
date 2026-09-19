import type {
  ConflictFile,
  FileStatus,
  GitBranchInfo,
  GitCommit,
  GitRemote,
  GitStashEntry,
  GitTagInfo,
} from '../models';

/**
 * Git 后端契约（T6-01 要点 1、2）。
 *
 * 两个实现：
 * - `cli-backend.ts`：系统 git CLI（Windows 中文路径与编码已处理），**永远可用**
 * - `git2-backend.ts`：libgit2 绑定（Node 侧），绑定缺失时 `probe()` 返回 false
 *
 * `backend/index.ts` 负责运行时探测与选择，git2 不可用时自动回退 CLI，
 * 对上层（`GitClient`）完全透明 —— 同一套集成测试对两个后端各跑一遍。
 *
 * 所有方法在失败时抛 `GitCommandError`（携带命令参数与 stderr），
 * 由 `GitClient` 统一转换为 `GitResult` 的结构化日志与错误码。
 */

export type GitBackendId = 'git2' | 'cli';

/** 后端能力位（UI 可据此禁用入口；两个内置后端的能力集应保持一致） */
export type GitCapability =
  | 'init'
  | 'status'
  | 'add'
  | 'commit'
  | 'log'
  | 'branch'
  | 'merge'
  | 'rebase'
  | 'stash'
  | 'remote'
  | 'transfer'
  | 'diff'
  | 'blame';

export interface GitCommandErrorOptions {
  args?: readonly string[];
  stderr?: string;
  stdout?: string;
  exitCode?: number;
  /** 命令是否因冲突而失败（merge / rebase / pull 常见） */
  conflict?: boolean;
}

/** 后端命令失败（含原始参数与 stderr，供结构化日志使用；密钥不进 argv，故可安全记录） */
export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly stdout: string;
  readonly exitCode: number;
  readonly conflict: boolean;

  constructor(message: string, options: GitCommandErrorOptions = {}) {
    super(message);
    this.name = 'GitCommandError';
    this.args = options.args ?? [];
    this.stderr = options.stderr ?? '';
    this.stdout = options.stdout ?? '';
    this.exitCode = options.exitCode ?? 1;
    this.conflict = options.conflict ?? false;
    Object.setPrototypeOf(this, GitCommandError.prototype);
  }
}

/* -------------------------------------------------------------------------- */
/* 底层执行端口                                                                */
/* -------------------------------------------------------------------------- */

export interface GitRunOptions {
  cwd: string;
  /** 追加到子进程的环境变量（凭据经此注入，**不进 argv**） */
  env?: Record<string, string> | undefined;
  /** 写入 stdin 的内容 */
  input?: string | undefined;
}

export interface GitRunResult {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * 进程执行端口。
 * 生产实现：`createNodeGitRunner()`（node:child_process）；
 * 外壳也可注入基于 Shell API `process.spawn` 的实现以复用统一的进程托管与日志。
 */
export interface GitProcessRunner {
  run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult>;
}

/** 文件系统端口（.gitignore 落盘、文件体积探测、配置读取） */
export interface GitFilerPort {
  readText(path: string): Promise<string | null>;
  /** 临时文件 + 原子替换 */
  writeAtomic(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number | null>;
  remove(path: string): Promise<void>;
  /** 列出目录下的条目名（技术栈推测用），可选 */
  listNames?(path: string): Promise<string[]>;
}

/* -------------------------------------------------------------------------- */
/* 参数与中间结果                                                              */
/* -------------------------------------------------------------------------- */

export interface InitOptions {
  /** 初始分支名，默认 main */
  branch?: string;
  bare?: boolean;
}

export interface StatusEntry {
  path: string;
  oldPath: string | null;
  /** porcelain 的 index 位（X） */
  index: string;
  /** porcelain 的 worktree 位（Y） */
  worktree: string;
  status: FileStatus;
  staged: boolean;
}

export interface CommitInput {
  subject: string;
  body?: string | undefined;
  author?: { name: string; email: string } | undefined;
  allowEmpty?: boolean | undefined;
  /** 指定路径提交（为空则提交整个暂存区） */
  paths?: readonly string[] | undefined;
}

export interface LogOptions {
  limit?: number | undefined;
  skip?: number | undefined;
  ref?: string | undefined;
  /** 按文件路径过滤 */
  path?: string | undefined;
  /** 按作者（name 或 email 子串）过滤 */
  author?: string | undefined;
  /** 按 subject/body 关键词过滤 */
  keyword?: string | undefined;
  /** Unix 毫秒下界（含） */
  since?: number | undefined;
  until?: number | undefined;
}

export interface DiffOptions {
  /** 默认工作区 vs 索引 */
  from?: string | undefined;
  to?: string | undefined;
  staged?: boolean | undefined;
  path?: string | undefined;
  contextLines?: number | undefined;
  /**
   * 排除的路径（大文件不参与内容 diff）。
   * 实现为 git 的 `:(exclude)` pathspec —— 让 git 端就不生成超大 patch，
   * 而不是先生成 50MB 文本再丢掉。
   */
  excludePaths?: readonly string[] | undefined;
}

/** `git diff --name-status -z` 的一条记录（权威路径清单，重命名信息可靠） */
export interface DiffFileEntry {
  path: string;
  oldPath: string | null;
  status: FileStatus;
}

export interface MergeCommandResult {
  /** 命令是否成功（无冲突） */
  ok: boolean;
  upToDate: boolean;
  fastForward: boolean;
  conflictFiles: string[];
  stdout: string;
  stderr: string;
}

export interface PushInput {
  remote?: string | undefined;
  branch?: string | undefined;
  force?: boolean | undefined;
  /** 优先使用 --force-with-lease（比 --force 安全） */
  forceWithLease?: boolean | undefined;
  setUpstream?: boolean | undefined;
  /** 凭据注入用环境变量（**不进 argv**，见 credentials.ts 的 buildAuthEnv） */
  env?: Record<string, string> | undefined;
}

export interface FetchInput {
  remote?: string | undefined;
  prune?: boolean | undefined;
  tags?: boolean | undefined;
  /** 凭据注入用环境变量（**不进 argv**） */
  env?: Record<string, string> | undefined;
}

export interface TransferResult {
  remote: string;
  ref: string | null;
  upToDate: boolean;
  summary: string;
  /** 是否发生了强制覆盖（UI 需展示风险提示） */
  forced: boolean;
}

export interface BlameLine {
  line: number;
  sha: string;
  authorName: string;
  authoredAt: number;
  text: string;
}

/* -------------------------------------------------------------------------- */
/* 后端接口                                                                    */
/* -------------------------------------------------------------------------- */

export interface GitBackend {
  readonly id: GitBackendId;
  readonly label: string;

  /** 运行时探测：该后端在本机是否可用 */
  probe(): Promise<boolean>;
  capabilities(): readonly GitCapability[];

  /* 仓库 */
  init(cwd: string, options?: InitOptions): Promise<void>;
  isRepo(cwd: string): Promise<boolean>;

  /* 引用 */
  currentBranch(cwd: string): Promise<string | null>;
  headSha(cwd: string): Promise<string | null>;
  revParse(cwd: string, ref: string): Promise<string | null>;
  readConfig(cwd: string, key: string): Promise<string | null>;
  writeConfig(cwd: string, key: string, value: string): Promise<void>;

  /* 状态与暂存 */
  status(cwd: string): Promise<StatusEntry[]>;
  add(cwd: string, paths: readonly string[]): Promise<void>;
  unstage(cwd: string, paths: readonly string[]): Promise<void>;
  reset(cwd: string, target: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void>;
  /** 反向提交（回滚用）；`noCommit` 为 true 时只改工作区/索引，由调用方合并成一次提交 */
  revert(cwd: string, sha: string, options?: { noCommit?: boolean }): Promise<void>;

  /* 提交与历史 */
  commit(cwd: string, input: CommitInput): Promise<string>;
  log(cwd: string, options?: LogOptions): Promise<GitCommit[]>;
  show(cwd: string, ref: string): Promise<string>;

  /* 分支与标签 */
  branches(cwd: string): Promise<GitBranchInfo[]>;
  tags(cwd: string): Promise<GitTagInfo[]>;
  createBranch(cwd: string, name: string, startPoint?: string): Promise<void>;
  switchBranch(cwd: string, name: string, options?: { create?: boolean }): Promise<void>;
  renameBranch(cwd: string, from: string, to: string): Promise<void>;
  deleteBranch(cwd: string, name: string, options?: { force?: boolean }): Promise<void>;

  /* 合并与变基 */
  merge(
    cwd: string,
    branch: string,
    options?: { noFf?: boolean; message?: string; noCommit?: boolean },
  ): Promise<MergeCommandResult>;
  rebase(cwd: string, onto: string): Promise<MergeCommandResult>;
  abortMerge(cwd: string): Promise<void>;
  abortRebase(cwd: string): Promise<void>;
  conflictFiles(cwd: string): Promise<string[]>;

  /* Stash */
  stashPush(cwd: string, message?: string): Promise<void>;
  stashList(cwd: string): Promise<GitStashEntry[]>;
  /** `drop: true` 即 pop */
  stashApply(cwd: string, index: number, options?: { drop?: boolean }): Promise<void>;
  stashDrop(cwd: string, index: number): Promise<void>;

  /* 远程 */
  remotes(cwd: string): Promise<GitRemote[]>;
  addRemote(cwd: string, name: string, url: string): Promise<void>;
  setRemoteUrl(cwd: string, name: string, url: string): Promise<void>;
  removeRemote(cwd: string, name: string): Promise<void>;
  /** 连通性测试（`ls-remote --heads`）：返回远端分支引用，失败抛错 */
  lsRemote(
    cwd: string,
    remote: string,
    options?: { env?: Record<string, string> | undefined },
  ): Promise<string[]>;

  push(cwd: string, input: PushInput): Promise<TransferResult>;
  pull(cwd: string, input: FetchInput): Promise<MergeCommandResult>;
  fetch(cwd: string, input: FetchInput): Promise<TransferResult>;

  /* 差异与定位 */
  diff(cwd: string, options: DiffOptions): Promise<string>;
  /** 权威的文件级变更清单（含重命名识别），与 `diff` 的输出顺序一一对应 */
  diffNameStatus(cwd: string, options: DiffOptions): Promise<DiffFileEntry[]>;
  blameLite(
    cwd: string,
    path: string,
    range?: { start: number; end: number },
  ): Promise<BlameLine[]>;

  /** 文件体积（用于 >1MB 跳过内容 diff） */
  fileSize(cwd: string, path: string): Promise<number | null>;
}

/** 读取冲突文件的原始内容（三栏编辑器用） */
export type ConflictFileReader = (path: string) => Promise<string | null>;

/** 冲突解析结果的汇总 */
export interface ConflictParseResult {
  files: ConflictFile[];
  /** 存在无法解析的冲突块（例如嵌套冲突）时的说明 */
  warnings: string[];
}
