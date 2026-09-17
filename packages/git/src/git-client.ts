import type { StackId } from '@ec/core';

import { createDefaultBackendDeps, selectBackend, type BackendDeps, type BackendPreference, type SelectedBackend } from './backend';
import type { Git2Loader } from './backend/git2-backend';
import {
  GitCommandError,
  type BlameLine,
  type CommitInput,
  type DiffFileEntry,
  type FetchInput,
  type GitBackend,
  type GitFilerPort,
  type LogOptions,
  type MergeCommandResult,
  type PushInput,
} from './backend/types';
import { buildAuthEnv } from './credentials';
import { formatBytes, parseUnifiedDiff, summarizeDiff } from './diff-service';
import { detectStacksFromFiles, writeWorkspaceGitignore } from './gitignore';
import {
  BIG_FILE_THRESHOLD_BYTES,
  fail,
  isValidBranchName,
  ok,
  type ChangeSource,
  type FileStatus,
  type GitBranchInfo,
  type GitCommit,
  type GitCredential,
  type GitDiff,
  type GitDiffFile,
  type GitLogEntry,
  type GitRemote,
  type GitResult,
  type GitStashEntry,
  type GitStatusSummary,
  type GitTagInfo,
  GitLogger,
} from './models';

/**
 * Git 门面（T6-01 要点 3、5）。
 *
 * 职责：
 * - 把后端的能力包成**统一返回契约** `GitResult<T>`（含结构化日志，可直接渲染到 UI）；
 * - 维护当前仓库路径、跨调用的滚动日志、变更来源标注；
 * - 推送 / 拉取前按远程名解析凭据并把密文登记到日志脱敏表（用完即注销）；
 * - 把 `GitCommandError` 映射成机器可读错误码 + 中文说明（**绝不把 stderr 原样抛给用户**）。
 *
 * 这一层是后端无关的：CLI 与 libgit2 两种后端对它完全透明。
 */

export interface GitClientOptions {
  /** 仓库根目录（工作区绝对路径） */
  repoPath: string;
  backend: GitBackend;
  logger?: GitLogger | undefined;
  clock?: (() => number) | undefined;
  filer?: GitFilerPort | null | undefined;
  /** 按远程名解析凭据；返回 null 表示未配置（走系统 git 的默认凭据链或直接失败） */
  credentials?: ((remoteName: string) => Promise<GitCredential | null>) | null | undefined;
  /** 变更来源标注（T6-02 要点 4）：按路径返回来源，未命中返回 null */
  changeSourceOf?: ((path: string) => ChangeSource | null) | null | undefined;
  /** 大文件阈值（字节），默认 1MB */
  bigFileThresholdBytes?: number | undefined;
}

export interface CreateGitClientOptions extends Omit<GitClientOptions, 'backend'> {
  /** 后端依赖；不传则用 Node 默认（子进程 + 文件系统） */
  deps?: BackendDeps | undefined;
  preferred?: BackendPreference | undefined;
  loadGit2?: Git2Loader | undefined;
  /** 允许在尚未 init 的目录上直接创建客户端（默认允许） */
  backend?: GitBackend | undefined;
}

export interface InitResult {
  repoPath: string;
  branch: string;
  gitignorePath: string | null;
  gitignoreWritten: boolean;
  stacks: StackId[];
  gitignoreContent: string;
}

export class GitClient {
  readonly repoPath: string;
  readonly backendId: string;
  readonly requestedBackend: BackendPreference;
  /** 后端选择时的说明（进结构化日志，例如"已回退 CLI"） */
  readonly selectionNotes: readonly string[];

  private readonly backend: GitBackend;
  private readonly logger: GitLogger;
  private readonly clock: () => number;
  private readonly filer: GitFilerPort | null;
  private readonly credentials: ((remoteName: string) => Promise<GitCredential | null>) | null;
  private readonly changeSourceOf: ((path: string) => ChangeSource | null) | null;
  private readonly bigFileThreshold: number;

  constructor(options: GitClientOptions & { selectionNotes?: readonly string[]; requested?: BackendPreference }) {
    this.repoPath = options.repoPath;
    this.backend = options.backend;
    this.backendId = options.backend.id;
    this.requestedBackend = options.requested ?? 'auto';
    this.selectionNotes = options.selectionNotes ?? [];
    this.clock = options.clock ?? (() => Date.now());
    this.logger = options.logger ?? new GitLogger({ clock: this.clock, max: 2000 });
    this.filer = options.filer ?? null;
    this.credentials = options.credentials ?? null;
    this.changeSourceOf = options.changeSourceOf ?? null;
    this.bigFileThreshold = options.bigFileThresholdBytes ?? BIG_FILE_THRESHOLD_BYTES;
  }

  /** 建立客户端并完成后端探测 / 回退（异步，因为探针要执行进程） */
  static async create(options: CreateGitClientOptions): Promise<GitClient> {
    const deps = options.deps ?? createDefaultBackendDeps();
    let backend = options.backend;
    let selection: SelectedBackend | null = null;
    if (backend === undefined) {
      selection = await selectBackend({
        deps,
        ...(options.preferred !== undefined ? { preferred: options.preferred } : {}),
        ...(options.loadGit2 !== undefined ? { loadGit2: options.loadGit2 } : {}),
      });
      backend = selection.backend;
    }
    const client = new GitClient({
      repoPath: options.repoPath,
      backend,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      ...(options.filer !== undefined ? { filer: options.filer } : { filer: deps.filer ?? null }),
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
      ...(options.changeSourceOf !== undefined ? { changeSourceOf: options.changeSourceOf } : {}),
      ...(options.bigFileThresholdBytes !== undefined ? { bigFileThresholdBytes: options.bigFileThresholdBytes } : {}),
      ...(selection !== null ? { selectionNotes: selection.notes, requested: selection.requested } : {}),
    });
    for (const note of client.selectionNotes) client.logger.info(note);
    return client;
  }

  /** 当前生效的后端标签（UI 展示"底层用的是什么"） */
  backendLabel(): string {
    return this.backend.label;
  }

  /* ------------------------------------------------------------------ */
  /* 统一包装：后端调用 → GitResult                                      */
  /* ------------------------------------------------------------------ */

  private logsSince(mark: number): GitLogEntry[] {
    const all = this.logger.all();
    return all.slice(Math.min(mark, all.length));
  }

  private collectBackendNotes(): void {
    const drainable = this.backend as unknown as { drainNotes?: () => string[] };
    if (typeof drainable.drainNotes !== 'function') return;
    for (const note of drainable.drainNotes()) this.logger.warn(note);
  }

  private async wrap<T>(
    action: string,
    task: () => Promise<T>,
    hints: { describe?: (value: T) => string } = {},
  ): Promise<GitResult<T>> {
    const mark = this.logger.all().length;
    this.logger.debug(`开始：${action}`);
    try {
      const value = await task();
      this.collectBackendNotes();
      if (hints.describe !== undefined) this.logger.info(`${action} 完成：${hints.describe(value)}`);
      else this.logger.info(`${action} 完成`);
      return ok(value, this.logsSince(mark));
    } catch (error) {
      this.collectBackendNotes();
      if (error instanceof GitCommandError) {
        this.logger.error(
          `${action} 失败：${error.message}`,
          [error.args.join(' '), error.stderr].filter((part) => part.length > 0).join('\n'),
        );
        const code = error.conflict
          ? 'CONFLICT'
          : /not a git repository/i.test(error.stderr)
            ? 'NOT_A_REPO'
            : /already exists/i.test(error.stderr)
              ? 'ALREADY_A_REPO'
              : /could not read Username|Authentication failed|Permission denied|publickey/i.test(error.stderr)
                ? 'CREDENTIAL_MISSING'
                : /Could not resolve host|unable to access|Connection (refused|timed out)/i.test(error.stderr)
                  ? 'NETWORK'
                  : 'COMMAND_FAILED';
        return fail(code, error.message, this.logsSince(mark));
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`${action} 失败：${message}`);
      return fail('UNKNOWN', `${action} 失败：${message}`, this.logsSince(mark));
    }
  }

  /** 取出并清空滚动日志（面板回看用） */
  drainLogs(): GitLogEntry[] {
    return this.logger.drain();
  }

  setBackendLogNote(note: string): void {
    this.logger.info(note);
  }

  registerSecretForRedaction(secret: string): void {
    this.logger.registerSecret(secret);
  }

  /* ------------------------------------------------------------------ */
  /* 仓库初始化                                                          */
  /* ------------------------------------------------------------------ */

  async isRepo(): Promise<GitResult<boolean>> {
    return this.wrap('检测仓库', () => this.backend.isRepo(this.repoPath));
  }

  /**
   * 初始化仓库并按技术栈生成 `.gitignore`（复用 T0-11 模板）。
   * `stacks` 未指定时按项目根目录文件清单推测。
   */
  async init(
    options: { branch?: string; stacks?: StackId[]; writeGitignore?: boolean; existingGitignore?: 'merge' | 'replace' } = {},
  ): Promise<GitResult<InitResult>> {
    const branch = options.branch ?? 'main';
    return this.wrap(
      '初始化仓库',
      async (): Promise<InitResult> => {
        await this.backend.init(this.repoPath, { branch });
        const detected = options.stacks !== undefined && options.stacks.length > 0 ? null : await this.detectStacks();
        const stacks: StackId[] = options.stacks !== undefined && options.stacks.length > 0 ? options.stacks : (detected?.stacks ?? ['node']);
        let gitignorePath: string | null = null;
        let gitignoreWritten = false;
        let gitignoreContent = '';
        if (options.writeGitignore !== false) {
          const result = await writeWorkspaceGitignore({
            repoPath: this.repoPath,
            stacks,
            filer: this.filer,
            ...(options.existingGitignore !== undefined ? { existing: options.existingGitignore } : {}),
          });
          gitignoreContent = result.content;
          gitignorePath = result.path;
          gitignoreWritten = result.written;
          for (const note of result.notes) this.logger.info(note);
          if (result.error !== null) this.logger.warn(result.error);
        }
        return { repoPath: this.repoPath, branch, gitignorePath, gitignoreWritten, stacks, gitignoreContent };
      },
      { describe: (value) => `分支 ${value.branch}${value.gitignoreWritten ? '，已生成 .gitignore' : ''}` },
    );
  }

  /** 按文件清单推测技术栈（供初始化前预览） */
  async detectStacks(): Promise<{ stacks: StackId[]; evidence: string[] }> {
    if (this.filer === null || this.filer.listNames === undefined) {
      return { stacks: ['node'], evidence: ['未提供目录枚举能力，按 Node.js 模板处理'] };
    }
    const files = await this.filer.listNames(this.repoPath);
    return detectStacksFromFiles(files);
  }

  /* ------------------------------------------------------------------ */
  /* 状态与暂存                                                          */
  /* ------------------------------------------------------------------ */

  async status(): Promise<GitResult<GitStatusSummary>> {
    return this.wrap(
      '读取仓库状态',
      async (): Promise<GitStatusSummary> => {
        const entries = await this.backend.status(this.repoPath);
        const branch = await this.backend.currentBranch(this.repoPath);
        const headSha = await this.backend.headSha(this.repoPath);
        const branches = await this.backend.branches(this.repoPath);
        const current = branches.find((item) => item.current) ?? null;
        return {
          branch,
          headSha,
          upstream: current?.upstream ?? null,
          ahead: current?.ahead ?? 0,
          behind: current?.behind ?? 0,
          clean: entries.length === 0,
          changes: entries.map((entry) => ({
            path: entry.path,
            oldPath: entry.oldPath,
            status: entry.status,
            staged: entry.staged,
            additions: null,
            deletions: null,
            binary: false,
            size: null,
            source: this.changeSourceOf?.(entry.path) ?? null,
          })),
        };
      },
      { describe: (value) => (value.clean ? '工作区干净' : `${value.changes.length} 个文件变更`) },
    );
  }

  async stage(paths: readonly string[]): Promise<GitResult<number>> {
    return this.wrap(
      `暂存 ${paths.length} 个文件`,
      async () => {
        await this.backend.add(this.repoPath, paths);
        return paths.length;
      },
      { describe: (value) => `${value} 个文件已进入暂存区` },
    );
  }

  async unstage(paths: readonly string[]): Promise<GitResult<number>> {
    return this.wrap(
      `取消暂存 ${paths.length} 个文件`,
      async () => {
        await this.backend.unstage(this.repoPath, paths);
        return paths.length;
      },
      { describe: (value) => `${value} 个文件已移出暂存区` },
    );
  }

  /* ------------------------------------------------------------------ */
  /* 提交与历史                                                          */
  /* ------------------------------------------------------------------ */

  async commit(input: CommitInput): Promise<GitResult<string>> {
    return this.wrap(
      '提交变更',
      () => this.backend.commit(this.repoPath, input),
      { describe: (sha) => `新提交 ${sha.slice(0, 8)}` },
    );
  }

  async log(options: LogOptions = {}): Promise<GitResult<GitCommit[]>> {
    return this.wrap('读取提交历史', () => this.backend.log(this.repoPath, options), {
      describe: (commits) => `${commits.length} 条提交`,
    });
  }

  async show(ref: string): Promise<GitResult<string>> {
    return this.wrap(`查看提交 ${ref}`, () => this.backend.show(this.repoPath, ref));
  }

  /** 移动 HEAD（回滚用；破坏性，调用方必须二次确认） */
  async reset(target: string, mode: 'soft' | 'mixed' | 'hard'): Promise<GitResult<string>> {
    return this.wrap(
      `回退到 ${target}（${mode}）`,
      async () => {
        await this.backend.reset(this.repoPath, target, mode);
        return target;
      },
      { describe: (value) => `HEAD 已指向 ${value}` },
    );
  }

  /** 反向提交（保留历史；`noCommit` 时由调用方合并成一条） */
  async revert(sha: string, options: { noCommit?: boolean } = {}): Promise<GitResult<string>> {
    return this.wrap(`反向提交 ${sha.slice(0, 8)}`, async () => {
      await this.backend.revert(this.repoPath, sha, options);
      return sha;
    });
  }

  /* ------------------------------------------------------------------ */
  /* 分支与标签                                                          */
  /* ------------------------------------------------------------------ */

  async branches(): Promise<GitResult<GitBranchInfo[]>> {
    return this.wrap('读取分支列表', () => this.backend.branches(this.repoPath), {
      describe: (branches) => `${branches.length} 个分支`,
    });
  }

  async tags(): Promise<GitResult<GitTagInfo[]>> {
    return this.wrap('读取标签', () => this.backend.tags(this.repoPath));
  }

  async createBranch(name: string, startPoint?: string): Promise<GitResult<string>> {
    if (!isValidBranchName(name)) return fail('INVALID_ARGUMENT', `分支名「${name}」不合法`);
    return this.wrap(
      `创建分支 ${name}`,
      async () => {
        await this.backend.createBranch(this.repoPath, name, startPoint);
        return name;
      },
      { describe: (value) => `分支 ${value} 已创建` },
    );
  }

  async switchBranch(name: string, options: { create?: boolean } = {}): Promise<GitResult<string>> {
    return this.wrap(
      `切换分支 ${name}`,
      async () => {
        await this.backend.switchBranch(this.repoPath, name, options);
        return name;
      },
      { describe: (value) => `已切换到 ${value}` },
    );
  }

  async renameBranch(from: string, to: string): Promise<GitResult<string>> {
    if (!isValidBranchName(to)) return fail('INVALID_ARGUMENT', `分支名「${to}」不合法`);
    return this.wrap(`重命名分支 ${from} → ${to}`, async () => {
      await this.backend.renameBranch(this.repoPath, from, to);
      return to;
    });
  }

  async deleteBranch(name: string, options: { force?: boolean } = {}): Promise<GitResult<string>> {
    return this.wrap(
      `删除分支 ${name}`,
      async () => {
        await this.backend.deleteBranch(this.repoPath, name, options);
        return name;
      },
      { describe: (value) => `分支 ${value} 已删除` },
    );
  }

  /* ------------------------------------------------------------------ */
  /* 合并 / 变基                                                        */
  /* ------------------------------------------------------------------ */

  /** 合并前预览影响提交（不修改仓库，只读） */
  async previewMerge(
    source: string,
    target: string,
  ): Promise<GitResult<{ commits: GitCommit[]; filesChanged: number; fastForward: boolean }>> {
    return this.wrap(
      `预览合并 ${source} → ${target}`,
      async () => {
        const commits = await this.backend.log(this.repoPath, { ref: `${target}..${source}`, limit: 500 });
        const targetOnly = await this.backend.log(this.repoPath, { ref: `${source}..${target}`, limit: 1 });
        const diff = await this.backend.diff(this.repoPath, { from: target, to: source });
        const files = parseUnifiedDiff(diff).files.length;
        // 目标分支没有 source 之外的提交 → 可以快进
        return { commits, filesChanged: files, fastForward: commits.length > 0 && targetOnly.length === 0 };
      },
      { describe: (value) => `${value.commits.length} 个提交，${value.filesChanged} 个文件` },
    );
  }

  async merge(branch: string, options: { noFf?: boolean; message?: string } = {}): Promise<GitResult<MergeCommandResult>> {
    return this.wrap('合并分支', () => this.backend.merge(this.repoPath, branch, options), {
      describe: (value) => (value.conflictFiles.length > 0 ? `存在 ${value.conflictFiles.length} 个冲突文件` : '合并成功'),
    });
  }

  async rebase(onto: string): Promise<GitResult<MergeCommandResult>> {
    return this.wrap('变基', () => this.backend.rebase(this.repoPath, onto));
  }

  async abortMerge(): Promise<GitResult<boolean>> {
    return this.wrap('中止合并', async () => {
      await this.backend.abortMerge(this.repoPath);
      return true;
    });
  }

  async abortRebase(): Promise<GitResult<boolean>> {
    return this.wrap('中止变基', async () => {
      await this.backend.abortRebase(this.repoPath);
      return true;
    });
  }

  async conflictFiles(): Promise<GitResult<string[]>> {
    return this.wrap('读取冲突文件', () => this.backend.conflictFiles(this.repoPath));
  }

  /* ------------------------------------------------------------------ */
  /* Stash                                                              */
  /* ------------------------------------------------------------------ */

  async stashPush(message?: string): Promise<GitResult<boolean>> {
    return this.wrap('暂存工作区改动', async () => {
      await this.backend.stashPush(this.repoPath, message);
      return true;
    });
  }

  async stashList(): Promise<GitResult<GitStashEntry[]>> {
    return this.wrap('读取暂存列表', () => this.backend.stashList(this.repoPath), {
      describe: (entries) => `${entries.length} 条暂存`,
    });
  }

  async stashApply(index: number, options: { drop?: boolean } = {}): Promise<GitResult<number>> {
    return this.wrap(`恢复暂存 stash@{${index}}`, async () => {
      await this.backend.stashApply(this.repoPath, index, options);
      return index;
    });
  }

  async stashDrop(index: number): Promise<GitResult<number>> {
    return this.wrap(`删除暂存 stash@{${index}}`, async () => {
      await this.backend.stashDrop(this.repoPath, index);
      return index;
    });
  }

  /* ------------------------------------------------------------------ */
  /* 远程                                                               */
  /* ------------------------------------------------------------------ */

  async remotes(): Promise<GitResult<GitRemote[]>> {
    return this.wrap(
      '读取远程仓库',
      async () => {
        const remotes = await this.backend.remotes(this.repoPath);
        const enriched: GitRemote[] = [];
        for (const remote of remotes) {
          const credential = this.credentials !== null ? await this.credentials(remote.name) : null;
          enriched.push({ ...remote, credentialConfigured: credential !== null });
        }
        return enriched;
      },
      { describe: (remotes) => `${remotes.length} 个远程` },
    );
  }

  async addRemote(name: string, url: string): Promise<GitResult<string>> {
    return this.wrap(`添加远程 ${name}`, async () => {
      await this.backend.addRemote(this.repoPath, name, url);
      return name;
    });
  }

  async setRemoteUrl(name: string, url: string): Promise<GitResult<string>> {
    return this.wrap(`修改远程地址 ${name}`, async () => {
      await this.backend.setRemoteUrl(this.repoPath, name, url);
      return name;
    });
  }

  async removeRemote(name: string): Promise<GitResult<string>> {
    return this.wrap(`删除远程 ${name}`, async () => {
      await this.backend.removeRemote(this.repoPath, name);
      return name;
    });
  }

  /** 连通性测试（`ls-remote --heads`），失败时把原因结构化返回而不是抛错 */
  async testRemote(name: string): Promise<GitResult<string[]>> {
    return this.wrap(
      `测试远程连通性 ${name}`,
      async () => {
        const auth = await this.authEnvFor(name);
        try {
          return await this.backend.lsRemote(this.repoPath, name, { env: auth.env });
        } finally {
          this.releaseSecrets(auth.secrets);
        }
      },
      { describe: (refs) => `连通正常，远端 ${refs.length} 个分支` },
    );
  }

  async push(input: PushInput = {}): Promise<GitResult<{ summary: string; upToDate: boolean; forced: boolean }>> {
    const remoteName = input.remote ?? 'origin';
    return this.wrap(
      `推送到 ${remoteName}`,
      async () => {
        const auth = await this.authEnvFor(remoteName);
        try {
          const result = await this.backend.push(this.repoPath, { ...input, env: auth.env });
          return { summary: result.summary, upToDate: result.upToDate, forced: result.forced };
        } finally {
          this.releaseSecrets(auth.secrets);
        }
      },
      { describe: (value) => (value.upToDate ? '远端已是最新' : '推送完成') },
    );
  }

  async pull(input: FetchInput = {}): Promise<GitResult<MergeCommandResult>> {
    const remoteName = input.remote ?? 'origin';
    return this.wrap(`从 ${remoteName} 拉取`, async () => {
      const auth = await this.authEnvFor(remoteName);
      try {
        return await this.backend.pull(this.repoPath, { ...input, env: auth.env });
      } finally {
        this.releaseSecrets(auth.secrets);
      }
    });
  }

  async fetch(input: FetchInput = {}): Promise<GitResult<{ summary: string; upToDate: boolean }>> {
    const remoteName = input.remote ?? 'origin';
    return this.wrap(`从 ${remoteName} 抓取`, async () => {
      const auth = await this.authEnvFor(remoteName);
      try {
        const result = await this.backend.fetch(this.repoPath, { ...input, env: auth.env });
        return { summary: result.summary, upToDate: result.upToDate };
      } finally {
        this.releaseSecrets(auth.secrets);
      }
    });
  }

  private async authEnvFor(remoteName: string): Promise<{ env: Record<string, string>; secrets: string[] }> {
    const credential = this.credentials !== null ? await this.credentials(remoteName) : null;
    const auth = buildAuthEnv(credential);
    for (const secret of auth.secrets) this.logger.registerSecret(secret);
    for (const note of auth.notes) this.logger.info(note);
    return { env: auth.env, secrets: auth.secrets };
  }

  private releaseSecrets(secrets: readonly string[]): void {
    for (const secret of secrets) this.logger.unregisterSecret(secret);
  }

  /* ------------------------------------------------------------------ */
  /* diff                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * 变更 diff。
   *
   * 顺序很关键：先用 `--name-status -z` 拿**权威路径清单**（重命名无歧义），
   * 再探测文件体积把大文件排除出 patch 请求（git 端就不生成超大文本），
   * 最后按位置把 patch 块与清单对齐；体积超限的文件以 `skipped` + 中文提示返回。
   */
  async diff(
    options: {
      scope?: 'worktree' | 'staged' | 'range';
      from?: string;
      to?: string;
      path?: string;
      contextLines?: number;
    } = {},
  ): Promise<GitResult<GitDiff>> {
    const scope = options.scope ?? 'worktree';
    return this.wrap(
      '读取差异',
      async (): Promise<GitDiff> => {
        const diffOptions = {
          ...(options.from !== undefined ? { from: options.from } : {}),
          ...(options.to !== undefined ? { to: options.to } : {}),
          staged: scope === 'staged',
          ...(options.path !== undefined ? { path: options.path } : {}),
          ...(options.contextLines !== undefined ? { contextLines: options.contextLines } : {}),
        };
        const entries = await this.backend.diffNameStatus(this.repoPath, diffOptions);

        const sizes: Record<string, number | null> = {};
        const oversized: DiffFileEntry[] = [];
        for (const entry of entries) {
          if (entry.status === 'deleted') continue;
          const size = await this.backend.fileSize(this.repoPath, entry.path);
          sizes[entry.path] = size;
          if (size !== null && size > this.bigFileThreshold) oversized.push(entry);
        }

        const oversizedPaths = oversized.map((entry) => entry.path);
        const oversizedSet = new Set(oversizedPaths);
        // 请求的就是被排除的那个文件时，直接不发 patch 请求（git 端不生成超大文本）
        const patchSkippedEntirely = options.path !== undefined && oversizedSet.has(options.path);
        let patch = '';
        if (!patchSkippedEntirely) {
          patch =
            oversizedPaths.length > 0
              ? await this.backend.diff(this.repoPath, { ...diffOptions, excludePaths: oversizedPaths })
              : await this.backend.diff(this.repoPath, diffOptions);
        }

        const smallEntries = entries.filter((entry) => !oversizedSet.has(entry.path));
        const parsed = parseUnifiedDiff(patch, { entries: smallEntries, sizes, skipThresholdBytes: this.bigFileThreshold });

        // 防御：patch 块数与清单数不一致时（极少数形态，如子模块 / 改名+改类型同时发生），
        // 退回按 git 头解析，宁可少信息也不给错位的信息
        const sizeGuarded = parsed.files.filter((file) => !oversizedSet.has(file.path));
        if (sizeGuarded.length !== smallEntries.length && smallEntries.length > 0) {
          this.logger.warn(
            `diff 块数（${sizeGuarded.length}）与文件清单（${smallEntries.length}）不一致，已回退按 git 头解析路径`,
          );
          const fallback = parseUnifiedDiff(patch, { sizes, skipThresholdBytes: this.bigFileThreshold });
          const skippedFiles = oversized.map((entry) => buildSkippedFile(entry, sizes[entry.path] ?? null, this.bigFileThreshold));
          const files = [...fallback.files.filter((file) => !oversizedSet.has(file.path)), ...skippedFiles].sort(
            compareFiles(entries),
          );
          for (const entry of oversized) this.logger.warn(`已跳过 ${entry.path} 的内容对比（体积超限）`);
          return {
            from: scope === 'staged' ? 'HEAD' : (options.from ?? 'WORKTREE'),
            to: options.to ?? (scope === 'staged' ? 'INDEX' : 'WORKTREE'),
            staged: scope === 'staged',
            files,
            additions: fallback.additions,
            deletions: fallback.deletions,
            skippedFiles: files.filter((file) => file.skipped).length,
          };
        }

        const skippedFiles = oversized.map((entry) => buildSkippedFile(entry, sizes[entry.path] ?? null, this.bigFileThreshold));
        for (const entry of oversized) {
          this.logger.warn(`已跳过 ${entry.path} 的内容对比：文件体积 ${formatBytes(sizes[entry.path] ?? 0)} 超过上限`);
        }
        const files = [...sizeGuarded, ...skippedFiles].sort(compareFiles(entries));

        return {
          from: scope === 'staged' ? 'HEAD' : (options.from ?? 'WORKTREE'),
          to: options.to ?? (scope === 'staged' ? 'INDEX' : 'WORKTREE'),
          staged: scope === 'staged',
          files,
          additions: parsed.additions,
          deletions: parsed.deletions,
          skippedFiles: files.filter((file) => file.skipped).length,
        };
      },
      { describe: (value) => summarizeDiff({ files: value.files, additions: value.additions, deletions: value.deletions, skippedFiles: value.skippedFiles }) },
    );
  }

  async blame(path: string, range?: { start: number; end: number }): Promise<GitResult<BlameLine[]>> {
    return this.wrap(`查看 ${path} 的作者信息`, () => this.backend.blameLite(this.repoPath, path, range));
  }

  /* ------------------------------------------------------------------ */
  /* 杂项                                                               */
  /* ------------------------------------------------------------------ */

  async currentBranch(): Promise<GitResult<string | null>> {
    return this.wrap('读取当前分支', () => this.backend.currentBranch(this.repoPath));
  }

  async headSha(): Promise<GitResult<string | null>> {
    return this.wrap('读取 HEAD', () => this.backend.headSha(this.repoPath));
  }

  async setIdentity(name: string, email: string): Promise<GitResult<boolean>> {
    return this.wrap('设置提交身份', async () => {
      await this.backend.writeConfig(this.repoPath, 'user.name', name);
      await this.backend.writeConfig(this.repoPath, 'user.email', email);
      return true;
    });
  }

  async readIdentity(): Promise<GitResult<{ name: string | null; email: string | null }>> {
    return this.wrap('读取提交身份', async () => {
      const name = await this.backend.readConfig(this.repoPath, 'user.name');
      const email = await this.backend.readConfig(this.repoPath, 'user.email');
      return { name, email };
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 辅助                                                                        */
/* -------------------------------------------------------------------------- */

function buildSkippedFile(entry: DiffFileEntry, size: number | null, threshold: number): GitDiffFile {
  return {
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status as FileStatus,
    binary: false,
    skipped: true,
    skipReason:
      size === null
        ? `无法读取文件体积，已跳过内容差异`
        : `文件体积 ${formatBytes(size)}，超过 ${formatBytes(threshold)} 上限，已跳过内容差异`,
    additions: 0,
    deletions: 0,
    size,
    hunks: [],
  };
}

/** 按权威清单顺序排序（保证 UI 顺序与 `git status` / `git diff` 一致） */
function compareFiles(entries: readonly DiffFileEntry[]): (a: GitDiffFile, b: GitDiffFile) => number {
  const order = new Map(entries.map((entry, index) => [entry.path, index]));
  return (a, b) => (order.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.path) ?? Number.MAX_SAFE_INTEGER);
}

/** 分支名合法性与变更来源标签统一定义在 `models.ts`（浏览器入口与 Node 入口共用） */
export { changeSourceLabel, isValidBranchName } from './models';

export type { MergeOutcome } from './models';
