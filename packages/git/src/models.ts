import { mask } from '@ec/core';

/**
 * Git 领域模型与统一返回契约（T6-01 要点 3）。
 *
 * 上层（渲染层 / 服务层）只消费 `GitResult<T>`：
 * - `ok`：是否成功
 * - `data`：结构化结果（失败时为 null）
 * - `logs`：结构化日志，可直接渲染到 UI（FR-SET-08：用户永不接触命令行）
 * - `error`：失败时的机器可读编码 + 中文说明
 *
 * 硬约束：日志里的密钥一律脱敏（`mask` + 显式密文表），明文 Token 绝不出现在
 * `logs[].message` / `logs[].raw` 中（NFR-S-04）。
 */

/** 日志级别（分级着色由 UI 决定） */
export type GitLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface GitLogEntry {
  level: GitLogLevel;
  /** 已脱敏的中文说明 */
  message: string;
  /** 原始终端输出（已脱敏），UI 折叠展示 */
  raw?: string;
  /** Unix 毫秒 */
  at: number;
}

export type GitErrorCode =
  | 'NOT_A_REPO'
  | 'ALREADY_A_REPO'
  | 'BACKEND_UNAVAILABLE'
  | 'COMMAND_FAILED'
  | 'CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'CREDENTIAL_MISSING'
  | 'NETWORK'
  | 'UNKNOWN';

export interface GitError {
  code: GitErrorCode;
  message: string;
}

export interface GitResult<T> {
  ok: boolean;
  data: T | null;
  logs: GitLogEntry[];
  error: GitError | null;
}

export function ok<T>(data: T, logs: GitLogEntry[] = []): GitResult<T> {
  return { ok: true, data, logs, error: null };
}

export function fail<T = never>(
  code: GitErrorCode,
  message: string,
  logs: GitLogEntry[] = [],
): GitResult<T> {
  return { ok: false, data: null, logs, error: { code, message } };
}

/* -------------------------------------------------------------------------- */
/* 结构化日志（含脱敏）                                                        */
/* -------------------------------------------------------------------------- */

/** 显式密文表：命中即整体替换，兜住 `mask` 的正则覆盖不到的自定义令牌形状 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    output = output.split(secret).join('***');
  }
  return mask(output);
}

export interface GitLoggerOptions {
  clock?: (() => number) | undefined;
  /** 当前需要脱敏的密文（凭据注入时登记，操作结束后注销） */
  secrets?: readonly string[] | undefined;
  max?: number | undefined;
}

/**
 * 结构化日志收集器。
 * 每次操作产出一份独立日志（`GitResult.logs`），同时保留最近的滚动窗口供面板回看。
 */
export class GitLogger {
  private readonly clock: () => number;
  private readonly max: number;
  private readonly entries: GitLogEntry[] = [];
  private readonly secrets = new Set<string>();

  constructor(options: GitLoggerOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.max = options.max ?? 500;
    for (const secret of options.secrets ?? []) this.registerSecret(secret);
  }

  /** 登记密文（凭据注入前调用） */
  registerSecret(secret: string | null | undefined): void {
    if (typeof secret === 'string' && secret.length >= 6) this.secrets.add(secret);
  }

  unregisterSecret(secret: string | null | undefined): void {
    if (typeof secret === 'string') this.secrets.delete(secret);
  }

  /** 对任意文本脱敏（供调用方复用同一套规则） */
  redact(text: string): string {
    return redactSecrets(text, [...this.secrets]);
  }

  push(level: GitLogLevel, message: string, raw?: string): GitLogEntry {
    const entry: GitLogEntry = {
      level,
      message: this.redact(message),
      at: this.clock(),
      ...(raw !== undefined && raw.length > 0 ? { raw: this.redact(raw) } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    return entry;
  }

  debug(message: string, raw?: string): GitLogEntry {
    return this.push('debug', message, raw);
  }
  info(message: string, raw?: string): GitLogEntry {
    return this.push('info', message, raw);
  }
  warn(message: string, raw?: string): GitLogEntry {
    return this.push('warn', message, raw);
  }
  error(message: string, raw?: string): GitLogEntry {
    return this.push('error', message, raw);
  }

  all(): GitLogEntry[] {
    return [...this.entries];
  }

  drain(): GitLogEntry[] {
    const out = [...this.entries];
    this.entries.length = 0;
    return out;
  }

  clear(): void {
    this.entries.length = 0;
    this.secrets.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* 仓库与状态                                                                  */
/* -------------------------------------------------------------------------- */

export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typechange';

export const FILE_STATUS_LABELS: Record<FileStatus, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  untracked: '未跟踪',
  conflicted: '冲突',
  typechange: '类型变更',
};

/** 状态色（UI 用；中央色板之外仅在此声明一次） */
export const FILE_STATUS_COLORS: Record<FileStatus, string> = {
  added: 'var(--ec-color-success, #1a7f37)',
  modified: 'var(--ec-color-warning, #9a6700)',
  deleted: 'var(--ec-color-danger, #cf222e)',
  renamed: 'var(--ec-color-info, #0969da)',
  copied: 'var(--ec-color-info, #0969da)',
  untracked: 'var(--ec-color-text-secondary, #6e7781)',
  conflicted: 'var(--ec-color-danger, #cf222e)',
  typechange: 'var(--ec-color-warning, #9a6700)',
};

/**
 * 变更来源（T6-02 要点 4：变更可追溯）。
 *
 * 仓库变更只能来自 AI 生成节点 / 重命名事务 / 迁移执行（D-04），
 * 出现 `external` 说明有人绕过平台改了文件，UI 需高亮提示。
 */
export type ChangeSourceKind = 'ai-task' | 'rename' | 'migration' | 'external' | 'unknown';

export const CHANGE_SOURCE_LABELS: Record<ChangeSourceKind, string> = {
  'ai-task': 'AI 生成',
  rename: '重命名事务',
  migration: '迁移执行',
  external: '外部改动',
  unknown: '来源未知',
};

export interface ChangeSource {
  kind: ChangeSourceKind;
  /** 关联记录 id（生成任务 id / 重命名事件 id / 迁移文件名） */
  ref: string | null;
  /** 展示文案 */
  label: string;
  /** 是否可跳转到对应记录 */
  jumpable: boolean;
}

export interface GitFileChange {
  /** 工作区相对路径（正斜杠） */
  path: string;
  /** 重命名前的路径 */
  oldPath: string | null;
  status: FileStatus;
  /** 是否已进入暂存区 */
  staged: boolean;
  /** 未跟踪文件无法统计行数，为 null */
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** 文件字节数；未知为 null */
  size: number | null;
  source: ChangeSource | null;
}

export interface GitStatusSummary {
  branch: string | null;
  /** HEAD 的 sha；尚无提交时为 null */
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  changes: GitFileChange[];
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  /** Unix 毫秒 */
  authoredAt: number;
  parents: string[];
  /** 指向本提交的 ref（分支 / tag / HEAD） */
  refs: string[];
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommitSha: string | null;
  lastCommitSubject: string | null;
  /** 上游是否已删除（gone） */
  gone: boolean;
}

export type RemoteKind = 'https' | 'ssh' | 'local' | 'unknown';

export interface GitRemote {
  name: string;
  /** fetch url */
  url: string;
  /** push url（与 fetch 不同时才有值） */
  pushUrl: string | null;
  kind: RemoteKind;
  /** 是否配置了凭据（只报事实，绝不返回值） */
  credentialConfigured: boolean;
}

export interface GitTagInfo {
  name: string;
  sha: string;
}

/* -------------------------------------------------------------------------- */
/* diff                                                                       */
/* -------------------------------------------------------------------------- */

/** 超过该体积的文件跳过内容 diff，仅展示状态与提示（T6-02 要点 1） */
export const BIG_FILE_THRESHOLD_BYTES = 1024 * 1024;

export type DiffLineKind = 'context' | 'add' | 'del' | 'meta';

export interface GitDiffLine {
  kind: DiffLineKind;
  /** 不含前导 +/-/空格 的正文 */
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export interface GitDiffHunk {
  index: number;
  /** 原始 @@ 头 */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** @@ 之后的函数上下文（git 默认附带） */
  section: string | null;
  lines: GitDiffLine[];
}

export interface GitDiffFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  /** 大文件 / 二进制被跳过内容解析（此时 hunks 为空） */
  skipped: boolean;
  skipReason: string | null;
  additions: number;
  deletions: number;
  /** 文件大小（字节）；未知为 null */
  size: number | null;
  hunks: GitDiffHunk[];
}

export interface GitDiff {
  /** 旧侧 ref（工作区 diff 为 'WORKTREE'） */
  from: string;
  /** 新侧 ref */
  to: string;
  staged: boolean;
  files: GitDiffFile[];
  additions: number;
  deletions: number;
  /** 被跳过的文件数（UI 提示用） */
  skippedFiles: number;
}

/** 并排渲染行：左右各一列，缺失侧为 null */
export interface SideBySideRow {
  kind: 'context' | 'replace' | 'add' | 'del';
  left: { number: number; text: string } | null;
  right: { number: number; text: string } | null;
}

/* -------------------------------------------------------------------------- */
/* 分支 / 合并 / 冲突 / 回滚 / Stash                                          */
/* -------------------------------------------------------------------------- */

export interface BranchNode {
  sha: string;
  subject: string;
  authorName: string;
  authoredAt: number;
  /** 在提交图中的列（从 0 开始） */
  lane: number;
  /** 连到父提交的边（父 sha + 父所在列） */
  parents: { sha: string; lane: number }[];
  /** 指向本提交的分支名 */
  branches: string[];
  tags: string[];
  isHead: boolean;
  /** 本提交是否把两条以上线合并到一起（用于高亮） */
  isMerge: boolean;
}

export interface BranchGraph {
  nodes: BranchNode[];
  lanes: number;
  head: string | null;
  /** 分叉点（有多于一个子提交的提交 sha） */
  forks: string[];
  /** 合并点（父提交数 > 1） */
  merges: string[];
}

export interface MergePreview {
  source: string;
  target: string;
  /** 将被引入目标分支的提交（newest first） */
  commits: GitCommit[];
  filesChanged: number;
  fastForward: boolean;
  /** 预览阶段已知的冲突文件（`merge --no-commit --no-ff` 试算的结果） */
  conflictFiles: string[];
  backupBranch: string | null;
}

export type ConflictResolution = 'ours' | 'theirs' | 'both' | 'ai' | 'unresolved';

export interface ConflictBlock {
  /** 文件内序号，从 1 开始 */
  index: number;
  ours: string[];
  theirs: string[];
  base: string[];
  resolution: ConflictResolution;
  /** 起始行（原文件行号，1 基） */
  startLine: number;
}

export interface ConflictFile {
  path: string;
  oursLabel: string;
  theirsLabel: string;
  blocks: ConflictBlock[];
}

export interface MergeOutcome {
  status: 'merged' | 'fast-forward' | 'conflicted' | 'up-to-date' | 'failed';
  commits: GitCommit[];
  conflictFiles: string[];
  backupBranch: string | null;
  newSha: string | null;
}

export type RollbackMode = 'soft' | 'revert';

export const ROLLBACK_MODE_LABELS: Record<RollbackMode, string> = {
  soft: '软回退（保留工作区改动）',
  revert: '反向提交（保留历史，生成一条撤销提交）',
};

export interface RollbackPlan {
  mode: RollbackMode;
  /** 回退到的目标提交 sha */
  targetSha: string;
  /** 将被撤销 / 移出 HEAD 的提交 */
  affectedCommits: GitCommit[];
  /** 受影响的文件路径 */
  affectedFiles: string[];
  /** 安全快照分支名（操作前自动创建） */
  snapshotBranch: string;
  warnings: string[];
}

export interface GitStashEntry {
  /** stash@{index} */
  index: number;
  /** 用户说明（`git stash list` 的 message 部分） */
  message: string;
  branch: string;
  /** 变更文件数 */
  files: number;
  createdAt: number;
}

/* -------------------------------------------------------------------------- */
/* 凭据                                                                       */
/* -------------------------------------------------------------------------- */

export type GitCredentialKind = 'https' | 'ssh';

export interface HttpsCredential {
  kind: 'https';
  username: string;
  /** Personal Access Token —— 绝不落盘明文、绝不进 argv（经环境变量注入 git） */
  token: string;
}

export interface SshCredential {
  kind: 'ssh';
  /** ed25519 私钥路径（由用户在系统里已有，平台不复制内容） */
  privateKeyPath: string;
  /** 私钥口令；建议使用 ssh-agent，留空表示由 agent 提供 */
  passphrase: string | null;
}

export type GitCredential = HttpsCredential | SshCredential;

/** 远程名 → 凭据种类的绑定关系（值本身存密钥环） */
export interface CredentialBinding {
  remoteName: string;
  kind: GitCredentialKind;
  /** 密钥环里的键名（不是密钥本身） */
  keyRef: string;
  /** HTTPS 用户名（非敏感，可明文存） */
  username: string | null;
  /** SSH 私钥路径（非敏感路径，可明文存） */
  privateKeyPath: string | null;
}

/* -------------------------------------------------------------------------- */
/* 纯规则（放在 models 里，浏览器入口与 Node 入口共用同一份实现）              */
/* -------------------------------------------------------------------------- */

/**
 * 分支名合法性（`git check-ref-format` 的核心规则子集）。
 * 错误信息要能直接给用户看，因此只做规则判定、不抛错。
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (/[\s~^:?*[\\]/.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('.') || name.endsWith('.') || name.endsWith('/'))
    return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  return true;
}

/** 变更来源 → 展示标签（UI 直接使用） */
export function changeSourceLabel(source: ChangeSource | null): string {
  if (source === null) return '来源未知';
  return source.jumpable
    ? CHANGE_SOURCE_LABELS[source.kind]
    : `${CHANGE_SOURCE_LABELS[source.kind]}（不可跳转）`;
}
