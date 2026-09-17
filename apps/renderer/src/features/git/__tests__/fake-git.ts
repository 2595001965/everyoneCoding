/**
 * 内存假 Git 端口：不碰真实 git / 文件系统 / 网络，只驱动渲染层测试。
 *
 * 设计要点（便于断言）：
 * - `status()` 返回 4 个文件（含目录分组、已暂存、来源标签、二进制）；
 * - `diff()` 返回 2 个 hunk + 1 个超限被跳过的文件；
 * - `conflicts()` 返回 2 个未解决冲突块；
 * - `log()` 支持 `limit`，用于 1000 条虚拟滚动场景；
 * - `push()` 会把入参与进度事件记到 `calls`，便于断言 force 默认关闭与二次确认。
 */
import {
  ok,
  type AutoCommitPolicy,
  type ChangeSource,
  type CommitConvention,
  type ConflictFile,
  type CredentialBinding,
  type GitBranchInfo,
  type GitCommit,
  type GitDiff,
  type GitDiffFile,
  type GitRemote,
  type GitResult,
  type GitStashEntry,
  type GitStatusSummary,
  type GitTagInfo,
  type MergeOutcome,
  type RollbackMode,
  type RollbackPlan,
} from '@ec/git';

import type { GitApi, GitProgressEvent, GitRepoInfo, RemoteTestResult } from '../git-api';

export interface FakeGitOptions {
  /** 提交条数（默认 6；测虚拟滚动传 1000） */
  commitCount?: number;
  /** 仓库是否已初始化（false 时 info() 返回 null，页面走初始化引导） */
  repoReady?: boolean;
  /** 冲突文件（默认 1 个文件 2 个块） */
  conflicts?: readonly ConflictFile[];
}

export interface FakeGitCalls {
  push: { input: { remote?: string | undefined; force?: boolean | undefined; forceWithLease?: boolean | undefined }; progress: GitProgressEvent[] }[];
  log: { path?: string | undefined; author?: string | undefined; keyword?: string | undefined; limit?: number | undefined }[];
  applyResolution: { path: string; content: string; message: string }[];
  deleteBranch: string[];
  removeRemote: string[];
  rollbackExecute: RollbackPlan[];
}

export interface FakeGitApi extends GitApi {
  readonly calls: FakeGitCalls;
}

const SOURCE_AI: ChangeSource = { kind: 'ai-task', ref: 'T-1', label: 'AI 生成 · 登录页', jumpable: true };
const SOURCE_MIGRATION: ChangeSource = { kind: 'migration', ref: '0007_add_user.sql', label: '迁移执行', jumpable: true };

function makeCommit(index: number): GitCommit {
  return {
    sha: `sha${String(index).padStart(40, '0')}`.slice(0, 40),
    shortSha: `sha${String(index).padStart(4, '0')}`.slice(0, 7),
    subject: `feat: 第 ${index} 次提交`,
    body: '',
    authorName: index % 2 === 0 ? '小吴' : '主人',
    authorEmail: 'dev@example.com',
    authoredAt: 1_700_000_000_000 + index * 60_000,
    parents: index === 0 ? [] : [`sha${String(index - 1).padStart(40, '0')}`.slice(0, 40)],
    refs: index === 0 ? ['HEAD -> main'] : [],
  };
}

function sampleDiff(): GitDiff {
  const file: GitDiffFile = {
    path: 'src/features/login/LoginPage.tsx',
    oldPath: null,
    status: 'modified',
    binary: false,
    skipped: false,
    skipReason: null,
    additions: 3,
    deletions: 1,
    size: 2048,
    hunks: [
      {
        index: 1,
        header: '@@ -1,4 +1,6 @@',
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 6,
        section: 'export function LoginPage()',
        lines: [
          { kind: 'context', text: 'import { Button } from "@ec/ui";', oldNumber: 1, newNumber: 1 },
          { kind: 'del', text: 'const title = "登录";', oldNumber: 2, newNumber: null },
          { kind: 'add', text: 'const title = "账号登录";', oldNumber: null, newNumber: 2 },
          { kind: 'add', text: 'const subtitle = "请输入账号密码";', oldNumber: null, newNumber: 3 },
          { kind: 'context', text: '', oldNumber: 3, newNumber: 4 },
          { kind: 'context', text: 'export function LoginPage() {', oldNumber: 4, newNumber: 5 },
        ],
      },
      {
        index: 2,
        header: '@@ -20,3 +22,4 @@',
        oldStart: 20,
        oldLines: 3,
        newStart: 22,
        newLines: 4,
        section: null,
        lines: [
          { kind: 'context', text: '  return (', oldNumber: 20, newNumber: 22 },
          { kind: 'add', text: '    <section aria-label="登录" />', oldNumber: null, newNumber: 23 },
          { kind: 'context', text: '  );', oldNumber: 21, newNumber: 24 },
          { kind: 'context', text: '}', oldNumber: 22, newNumber: 25 },
        ],
      },
    ],
  };

  const skipped: GitDiffFile = {
    path: 'assets/logo.png',
    oldPath: null,
    status: 'modified',
    binary: true,
    skipped: true,
    skipReason: '文件体积 3.2 MB，超过 2.0 MB 上限，已跳过内容对比',
    additions: 0,
    deletions: 0,
    size: 3_355_443,
    hunks: [],
  };

  return {
    from: 'WORKTREE',
    to: 'WORKTREE',
    staged: false,
    files: [file, skipped],
    additions: 3,
    deletions: 1,
    skippedFiles: 1,
  };
}

function sampleStatus(): GitStatusSummary {
  return {
    branch: 'main',
    headSha: 'sha0'.padEnd(40, '0').slice(0, 40),
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
    clean: false,
    changes: [
      { path: 'src/features/login/LoginPage.tsx', oldPath: null, status: 'modified', staged: false, additions: 3, deletions: 1, binary: false, size: 2048, source: SOURCE_AI },
      { path: 'src/features/login/index.ts', oldPath: null, status: 'added', staged: true, additions: 4, deletions: 0, binary: false, size: 120, source: SOURCE_AI },
      { path: 'server/migrations/0007_add_user.sql', oldPath: null, status: 'modified', staged: false, additions: 10, deletions: 2, binary: false, size: 800, source: SOURCE_MIGRATION },
      { path: 'assets/logo.png', oldPath: null, status: 'modified', staged: false, additions: null, deletions: null, binary: true, size: 3_355_443, source: null },
    ],
  };
}

const SAMPLE_CONFLICTS: readonly ConflictFile[] = [
  {
    path: 'src/features/login/LoginPage.tsx',
    oursLabel: '当前分支（main）',
    theirsLabel: '传入分支（feat/login）',
    blocks: [
      { index: 1, ours: ['const title = "账号登录";'], theirs: ['const title = "用户登录";'], base: ['const title = "登录";'], resolution: 'unresolved', startLine: 12 },
      { index: 2, ours: ['<Button>进入</Button>'], theirs: ['<Button>立即登录</Button>'], base: ['<Button>提交</Button>'], resolution: 'unresolved', startLine: 30 },
    ],
  },
];

export function createFakeGitApi(options: FakeGitOptions = {}): FakeGitApi {
  const commitCount = options.commitCount ?? 6;
  const repoReady = options.repoReady ?? true;
  const conflictFiles = [...(options.conflicts ?? SAMPLE_CONFLICTS)];

  const commits: GitCommit[] = Array.from({ length: commitCount }, (_, index) => makeCommit(index)).reverse();
  let branches: GitBranchInfo[] = [
    { name: 'main', current: true, upstream: 'origin/main', ahead: 2, behind: 1, lastCommitSha: commits[0]?.sha ?? null, lastCommitSubject: commits[0]?.subject ?? null, gone: false },
    { name: 'feat/login', current: false, upstream: null, ahead: 0, behind: 0, lastCommitSha: commits[1]?.sha ?? null, lastCommitSubject: commits[1]?.subject ?? null, gone: false },
    { name: 'fix/bug/utf8', current: false, upstream: 'origin/fix/bug/utf8', ahead: 0, behind: 0, lastCommitSha: commits[2]?.sha ?? null, lastCommitSubject: commits[2]?.subject ?? null, gone: true },
  ];
  let remotes: GitRemote[] = [
    { name: 'origin', url: 'https://example.com/group/repo.git', pushUrl: null, kind: 'https', credentialConfigured: false },
  ];
  let bindings: CredentialBinding[] = [];
  let stashEntries: GitStashEntry[] = [
    { index: 0, message: 'WIP 登录页样式', branch: 'main', files: 3, createdAt: 1_700_000_100_000 },
  ];
  let policy: AutoCommitPolicy = { trigger: 'off', convention: 'angular' };

  const calls: FakeGitCalls = {
    push: [],
    log: [],
    applyResolution: [],
    deleteBranch: [],
    removeRemote: [],
    rollbackExecute: [],
  };

  const api: FakeGitApi = {
    ready: true,
    calls,

    async info(): Promise<GitRepoInfo | null> {
      if (!repoReady) return null;
      return { path: 'D:/demo/shop', name: 'shop', branch: 'main', backendLabel: 'Git CLI 2.55', clean: false, ahead: 2, behind: 1 };
    },
    async init() {
      return ok({ branch: 'main', gitignoreWritten: true, stacks: ['node'] });
    },

    async status() {
      return ok(sampleStatus());
    },
    async stage(paths) {
      return ok(paths.length);
    },
    async unstage(paths) {
      return ok(paths.length);
    },
    async commit() {
      return ok('newcommitsha');
    },
    async generateCommitMessage(input: { convention: CommitConvention }) {
      return ok(`feat(login): 新增账号登录表单\n\n由 AI 生成（${input.convention}）`);
    },
    async diff() {
      return ok(sampleDiff());
    },

    async branches() {
      return ok(branches);
    },
    async tags(): Promise<GitResult<GitTagInfo[]>> {
      return ok([{ name: 'v0.1.0', sha: commits[0]?.sha ?? '', subject: '首个可用版本' }]);
    },
    async createBranch(name) {
      branches = [
        ...branches,
        { name, current: false, upstream: null, ahead: 0, behind: 0, lastCommitSha: null, lastCommitSubject: null, gone: false },
      ];
      return ok(name);
    },
    async switchBranch(name) {
      return ok(name);
    },
    async renameBranch(_from, to) {
      return ok(to);
    },
    async deleteBranch(name) {
      calls.deleteBranch.push(name);
      branches = branches.filter((branch) => branch.name !== name);
      return ok(name);
    },
    async log(input) {
      calls.log.push(input ?? {});
      const limit = input?.limit ?? commits.length;
      return ok(commits.slice(0, limit));
    },
    async commitDetail(sha) {
      const commit = commits.find((item) => item.sha === sha) ?? commits[0];
      if (commit === undefined) return { ok: false, data: null, logs: [], error: { code: 'UNKNOWN', message: '未找到该提交' } };
      const diff = sampleDiff();
      return ok({ commit, files: diff.files, additions: diff.additions, deletions: diff.deletions });
    },

    async previewMerge() {
      return ok({ commits: commits.slice(0, 2), filesChanged: 4, fastForward: false });
    },
    async merge(): Promise<GitResult<MergeOutcome>> {
      return ok({ status: 'conflicted', commits: [], conflictFiles: ['src/features/login/LoginPage.tsx'], backupBranch: 'backup/20260912-1', newSha: null });
    },
    async rebase(): Promise<GitResult<MergeOutcome>> {
      return ok({ status: 'merged', commits: [], conflictFiles: [], backupBranch: 'backup/20260912-1', newSha: 'shaX' });
    },
    async abort() {
      return ok(true);
    },
    async conflicts() {
      return ok(conflictFiles);
    },
    async applyResolution(input) {
      calls.applyResolution.push(input);
      return ok(input.path);
    },
    async requestAiMerge(input) {
      return ok({
        instruction: `请合并 ${input.path} 两侧改动，保留行为并统一命名`,
        context: '### 冲突块 1\n当前：const title = "账号登录";\n传入：const title = "用户登录";',
        paths: [input.path],
      });
    },
    async stashList() {
      return ok(stashEntries);
    },
    async stashPush(message) {
      stashEntries = [
        { index: 0, message: message ?? 'WIP', branch: 'main', files: 1, createdAt: 1_700_000_200_000 },
        ...stashEntries.map((entry) => ({ ...entry, index: entry.index + 1 })),
      ];
      return ok(true);
    },
    async stashApply(index) {
      return ok(index);
    },
    async stashDrop(index) {
      stashEntries = stashEntries.filter((entry) => entry.index !== index);
      return ok(index);
    },
    async rollbackPlan(input: { sha: string; mode: RollbackMode }): Promise<GitResult<RollbackPlan>> {
      return ok({
        mode: input.mode,
        targetSha: input.sha,
        affectedCommits: commits.slice(0, 2),
        affectedFiles: ['src/features/login/LoginPage.tsx', 'src/features/login/index.ts'],
        snapshotBranch: 'backup/20260912-2',
        warnings: ['该提交之后存在 2 个尚未推送的提交，软回退会保留它们在工作区'],
      });
    },
    async rollbackExecute(plan) {
      calls.rollbackExecute.push(plan);
      return ok({ snapshotBranch: plan.snapshotBranch, newHead: plan.targetSha });
    },
    async snapshots() {
      return ok([{ name: 'backup/20260912-2', sha: commits[0]?.sha ?? null, subject: commits[0]?.subject ?? null }]);
    },

    async remotes() {
      return ok(remotes);
    },
    async addRemote(name, url) {
      remotes = [
        ...remotes,
        {
          name,
          url,
          pushUrl: null,
          kind: url.startsWith('https') ? 'https' : 'ssh',
          credentialConfigured: false,
        },
      ];
      return ok(name);
    },
    async editRemote(name, url) {
      remotes = remotes.map((remote) => (remote.name === name ? { ...remote, url } : remote));
      return ok(name);
    },
    async removeRemote(name) {
      calls.removeRemote.push(name);
      remotes = remotes.filter((remote) => remote.name !== name);
      return ok(name);
    },
    async testRemote(name): Promise<GitResult<RemoteTestResult>> {
      return ok({ remote: name, ok: true, branches: 3, message: '连通正常' });
    },
    async push(input, onProgress) {
      const progress: GitProgressEvent[] = [
        { phase: 'connecting', message: '正在连接远程…', percent: null },
        { phase: 'transferring', message: '正在传输对象…', percent: 60 },
        { phase: 'done', message: '推送完成', percent: 100 },
      ];
      for (const event of progress) onProgress?.(event);
      calls.push.push({ input, progress });
      return ok({ summary: '推送完成', upToDate: false, forced: input.forceWithLease === true || input.force === true });
    },
    async pull(_input, onProgress) {
      onProgress?.({ phase: 'done', message: '拉取完成', percent: 100 });
      return ok({ conflictFiles: [], upToDate: false, fastForward: true });
    },
    async fetch(_input, onProgress) {
      onProgress?.({ phase: 'done', message: '抓取完成', percent: 100 });
      return ok({ summary: '抓取完成', upToDate: false });
    },
    async credentialBindings() {
      return bindings;
    },
    async saveHttpsCredential(input) {
      bindings = [
        ...bindings.filter((item) => item.remoteName !== input.remoteName),
        { remoteName: input.remoteName, kind: 'https', keyRef: `git-credential/${input.remoteName}:token`, username: input.username, privateKeyPath: null },
      ];
    },
    async saveSshCredential(input) {
      bindings = [
        ...bindings.filter((item) => item.remoteName !== input.remoteName),
        { remoteName: input.remoteName, kind: 'ssh', keyRef: `git-credential/${input.remoteName}:key`, username: null, privateKeyPath: input.privateKeyPath },
      ];
    },
    async removeCredential(remoteName) {
      bindings = bindings.filter((item) => item.remoteName !== remoteName);
    },

    async autoCommitPolicy() {
      return policy;
    },
    async setAutoCommitPolicy(next) {
      policy = next;
    },

    async changeSources(): Promise<Record<string, ChangeSource>> {
      return { 'src/features/login/LoginPage.tsx': SOURCE_AI };
    },
  };

  return api;
}

/** 便于测试构造提交列表 */
export function makeCommits(count: number): GitCommit[] {
  return Array.from({ length: count }, (_, index) => makeCommit(index));
}

/** 便于测试直接拿到示例 diff（含被跳过的二进制文件） */
export { sampleDiff as makeSampleDiff };
