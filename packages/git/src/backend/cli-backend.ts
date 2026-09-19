import type {
  GitBranchInfo,
  GitCommit,
  GitRemote,
  GitStashEntry,
  GitTagInfo,
  FileStatus,
} from '../models';
import {
  GitCommandError,
  type BlameLine,
  type CommitInput,
  type DiffFileEntry,
  type DiffOptions,
  type FetchInput,
  type GitBackend,
  type GitCapability,
  type GitFilerPort,
  type GitProcessRunner,
  type GitRunOptions,
  type GitRunResult,
  type InitOptions,
  type LogOptions,
  type MergeCommandResult,
  type PushInput,
  type StatusEntry,
  type TransferResult,
} from './types';

/**
 * 系统 Git CLI 后端（T6-01 要点 2「回退」路径，也是当前唯一可在本机真实跑通的后端）。
 *
 * 关键实现细节（Windows 上真实踩过的点）：
 * 1. 一律带 `-c core.quotepath=false`，否则中文路径在 porcelain / diff 里会被
 *    `\344\270\255` 形式转义，UI 直接显示乱码；
 * 2. 一律带 `-c i18n.logOutputEncoding=UTF-8`，提交信息按 UTF-8 解码；
 * 3. 一律带 `--no-pager`，避免管道阻塞；
 * 4. `GIT_TERMINAL_PROMPT=0`：绝不允许 git 弹终端要密码（用户永不接触命令行）；
 * 5. 解析 diff / status 用 `-z` 或自定义 0x1f/0x1e 分隔符，不靠文本对齐。
 *
 * 凭据**不进 argv**：由调用方经 `GitRunOptions.env` 注入（见 `credentials.ts`
 * 的 `buildAuthEnv`，使用 git 2.31+ 的 `GIT_CONFIG_COUNT` 机制），
 * 因此命令参数可以安全地原样进入结构化日志。
 */

const FIELD_SEP = '\u001f';
const RECORD_SEP = '\u001e';

/** 全局配置前缀：保证输出可解析、编码正确、不弹交互 */
const BASE_ARGS: readonly string[] = [
  '-c',
  'core.quotepath=false',
  '-c',
  'i18n.logOutputEncoding=UTF-8',
  '-c',
  'core.autocrlf=false',
  '--no-pager',
];

export interface CliGitBackendOptions {
  runner: GitProcessRunner;
  /** git 可执行文件路径 / 名称，默认 'git' */
  gitPath?: string;
  /** 文件体积探测（未提供时仅能读取索引中的文件大小） */
  filer?: GitFilerPort;
}

export class CliGitBackend implements GitBackend {
  readonly id = 'cli' as const;
  readonly label = '系统 Git CLI';

  private readonly runner: GitProcessRunner;
  private readonly gitPath: string;
  private readonly filer: GitFilerPort | undefined;

  constructor(options: CliGitBackendOptions) {
    this.runner = options.runner;
    this.gitPath = options.gitPath ?? 'git';
    this.filer = options.filer;
  }

  capabilities(): readonly GitCapability[] {
    return [
      'init',
      'status',
      'add',
      'commit',
      'log',
      'branch',
      'merge',
      'rebase',
      'stash',
      'remote',
      'transfer',
      'diff',
      'blame',
    ];
  }

  async probe(): Promise<boolean> {
    try {
      // 探测不依赖具体仓库，用当前工作目录即可
      const result = await this.runner.run([this.gitPath, '--version'], { cwd: processCwd() });
      return result.exitCode === 0 && /git version/i.test(result.stdout);
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 内部：命令执行                                                      */
  /* ------------------------------------------------------------------ */

  private async exec(
    cwd: string,
    args: readonly string[],
    options: {
      env?: Record<string, string> | undefined;
      input?: string | undefined;
      allowFailure?: boolean | undefined;
    } = {},
  ): Promise<GitRunResult> {
    const base: GitRunOptions = { cwd, env: { GIT_TERMINAL_PROMPT: '0' } };
    if (options.env !== undefined) base.env = { ...base.env, ...options.env };
    if (options.input !== undefined) base.input = options.input;

    const result = await this.runner.run([this.gitPath, ...BASE_ARGS, ...args], base);
    if (result.exitCode !== 0 && options.allowFailure !== true) {
      const stderr = result.stderr.trim();
      const conflictMarker = /CONFLICT|Automatic merge failed|needs merge|could not apply/i.test(
        stderr,
      );
      throw new GitCommandError(
        `git ${args[0] ?? ''} 执行失败：${stderr || `退出码 ${result.exitCode}`}`,
        {
          args: [...args],
          stderr: result.stderr,
          stdout: result.stdout,
          exitCode: result.exitCode,
          conflict: conflictMarker,
        },
      );
    }
    return result;
  }

  private async execStdout(
    cwd: string,
    args: readonly string[],
    options: { env?: Record<string, string> | undefined; allowFailure?: boolean | undefined } = {},
  ): Promise<string> {
    const result = await this.exec(cwd, args, options);
    return result.stdout;
  }

  /* ------------------------------------------------------------------ */
  /* 仓库                                                                */
  /* ------------------------------------------------------------------ */

  async init(cwd: string, options: InitOptions = {}): Promise<void> {
    const branch = options.branch ?? 'main';
    const args = ['init', '-q', '-b', branch];
    if (options.bare === true) args.push('--bare');
    args.push('.');
    await this.exec(cwd, args);
  }

  async isRepo(cwd: string): Promise<boolean> {
    const result = await this.exec(cwd, ['rev-parse', '--is-inside-work-tree'], {
      allowFailure: true,
    });
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  /* ------------------------------------------------------------------ */
  /* 引用与配置                                                          */
  /* ------------------------------------------------------------------ */

  async currentBranch(cwd: string): Promise<string | null> {
    const result = await this.exec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) return null;
    const name = result.stdout.trim();
    if (name.length === 0 || name === 'HEAD') return null;
    return name;
  }

  async headSha(cwd: string): Promise<string | null> {
    const result = await this.exec(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  async revParse(cwd: string, ref: string): Promise<string | null> {
    const result = await this.exec(cwd, ['rev-parse', '--verify', '--quiet', ref], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  async readConfig(cwd: string, key: string): Promise<string | null> {
    const result = await this.exec(cwd, ['config', '--get', key], { allowFailure: true });
    if (result.exitCode !== 0) return null;
    const value = result.stdout.replace(/\r?\n$/, '');
    return value.length > 0 ? value : null;
  }

  async writeConfig(cwd: string, key: string, value: string): Promise<void> {
    await this.exec(cwd, ['config', '--local', key, value]);
  }

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  async status(cwd: string): Promise<StatusEntry[]> {
    const stdout = await this.execStdout(cwd, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    return parsePorcelainZ(stdout);
  }

  async add(cwd: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) throw new GitCommandError('未指定要暂存的文件', { args: ['add'] });
    await this.exec(cwd, ['add', '--', ...paths]);
  }

  async unstage(cwd: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0)
      throw new GitCommandError('未指定要取消暂存的文件', { args: ['reset'] });
    const head = await this.headSha(cwd);
    if (head === null) {
      // 尚无提交：索引里没有 HEAD 可比对，只能把条目从索引移除
      await this.exec(cwd, ['rm', '--cached', '-r', '-q', '--', ...paths], { allowFailure: true });
      return;
    }
    await this.exec(cwd, ['reset', '-q', 'HEAD', '--', ...paths]);
  }

  async reset(cwd: string, target: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    const flag = mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';
    await this.exec(cwd, ['reset', flag, target]);
  }

  async revert(cwd: string, sha: string, options: { noCommit?: boolean } = {}): Promise<void> {
    const args = ['revert', '--no-edit'];
    if (options.noCommit === true) args.push('--no-commit');
    args.push(sha);
    await this.exec(cwd, args);
  }

  /* ------------------------------------------------------------------ */
  /* 提交与历史                                                          */
  /* ------------------------------------------------------------------ */

  async commit(cwd: string, input: CommitInput): Promise<string> {
    const args = ['commit', '-q', '--no-edit'];
    if (input.allowEmpty === true) args.push('--allow-empty');
    if (input.author !== undefined)
      args.push(`--author=${input.author.name} <${input.author.email}>`);
    args.push('-m', input.subject);
    if (input.body !== undefined && input.body.length > 0) args.push('-m', input.body);
    if (input.paths !== undefined && input.paths.length > 0) args.push('--', ...input.paths);
    await this.exec(cwd, args);
    const sha = await this.headSha(cwd);
    if (sha === null)
      throw new GitCommandError('提交后无法解析 HEAD', { args: ['rev-parse', 'HEAD'] });
    return sha;
  }

  async log(cwd: string, options: LogOptions = {}): Promise<GitCommit[]> {
    const format =
      ['%H', '%h', '%s', '%b', '%an', '%ae', '%at', '%P', '%D'].join(FIELD_SEP) + RECORD_SEP;
    const args = ['log', `--pretty=format:${format}`, '--date-order'];
    if (options.limit !== undefined) args.push(`-n${options.limit}`);
    if (options.skip !== undefined && options.skip > 0) args.push(`--skip=${options.skip}`);
    if (options.keyword !== undefined && options.keyword.length > 0)
      args.push('-i', `--grep=${options.keyword}`);
    if (options.author !== undefined && options.author.length > 0)
      args.push(`--author=${options.author}`);
    if (options.since !== undefined) args.push(`--since=${new Date(options.since).toISOString()}`);
    if (options.until !== undefined) args.push(`--until=${new Date(options.until).toISOString()}`);
    args.push(options.ref ?? 'HEAD');
    if (options.path !== undefined && options.path.length > 0) args.push('--', options.path);

    const result = await this.exec(cwd, args, { allowFailure: true });
    if (result.exitCode !== 0) {
      // 无提交的仓库：git log 报 fatal，这里按"空历史"处理而不是错误
      if (/does not have any commits yet|unknown revision|bad revision/i.test(result.stderr))
        return [];
      throw new GitCommandError(`git log 执行失败：${result.stderr.trim()}`, {
        args,
        stderr: result.stderr,
        stdout: result.stdout,
        exitCode: result.exitCode,
      });
    }
    return parseLog(result.stdout);
  }

  async show(cwd: string, ref: string): Promise<string> {
    return this.execStdout(cwd, ['show', '--patch', '--stat', '--no-color', ref]);
  }

  /* ------------------------------------------------------------------ */
  /* 分支与标签                                                          */
  /* ------------------------------------------------------------------ */

  async branches(cwd: string): Promise<GitBranchInfo[]> {
    const format = [
      '%(refname:short)',
      '%(HEAD)',
      '%(upstream:short)',
      '%(upstream:track)',
      '%(objectname)',
      '%(subject)',
    ].join(FIELD_SEP);
    const stdout = await this.execStdout(cwd, [
      'for-each-ref',
      `--format=${format}${RECORD_SEP}`,
      '--sort=-committerdate',
      'refs/heads',
    ]);
    return parseBranches(stdout);
  }

  async tags(cwd: string): Promise<GitTagInfo[]> {
    const stdout = await this.execStdout(cwd, [
      'for-each-ref',
      `--format=%(refname:short)${FIELD_SEP}%(objectname)${RECORD_SEP}`,
      'refs/tags',
    ]);
    return splitRecords(stdout).map((record) => {
      const [name = '', sha = ''] = record.split(FIELD_SEP);
      return { name, sha };
    });
  }

  async createBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
    const args = ['branch', name];
    if (startPoint !== undefined && startPoint.length > 0) args.push(startPoint);
    await this.exec(cwd, args);
  }

  async switchBranch(cwd: string, name: string, options: { create?: boolean } = {}): Promise<void> {
    // 用 checkout 而不是 switch：兼容更老的 git，且语义在两种情况下一致
    const args =
      options.create === true ? ['checkout', '-q', '-b', name] : ['checkout', '-q', name];
    await this.exec(cwd, args);
  }

  async renameBranch(cwd: string, from: string, to: string): Promise<void> {
    await this.exec(cwd, ['branch', '-m', from, to]);
  }

  async deleteBranch(cwd: string, name: string, options: { force?: boolean } = {}): Promise<void> {
    await this.exec(cwd, ['branch', options.force === true ? '-D' : '-d', name]);
  }

  /* ------------------------------------------------------------------ */
  /* 合并与变基                                                          */
  /* ------------------------------------------------------------------ */

  async merge(
    cwd: string,
    branch: string,
    options: { noFf?: boolean; message?: string; noCommit?: boolean } = {},
  ): Promise<MergeCommandResult> {
    const args = ['merge'];
    if (options.noFf === true) args.push('--no-ff');
    if (options.noCommit === true) args.push('--no-commit');
    if (options.message !== undefined && options.message.length > 0)
      args.push('-m', options.message);
    args.push(branch);
    return this.runMergeLike(cwd, args);
  }

  async rebase(cwd: string, onto: string): Promise<MergeCommandResult> {
    return this.runMergeLike(cwd, ['rebase', onto]);
  }

  private async runMergeLike(
    cwd: string,
    args: readonly string[],
    env?: Record<string, string> | undefined,
  ): Promise<MergeCommandResult> {
    const result = await this.exec(cwd, args, { allowFailure: true, env: env });
    const conflictFiles = await this.conflictFiles(cwd);
    const combined = `${result.stdout}\n${result.stderr}`;
    const upToDate = /Already up[ -]to[ -]date/i.test(combined);
    const fastForward = /Fast-forward/i.test(combined);
    return {
      ok: result.exitCode === 0 && conflictFiles.length === 0,
      upToDate,
      fastForward,
      conflictFiles,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async abortMerge(cwd: string): Promise<void> {
    await this.exec(cwd, ['merge', '--abort'], { allowFailure: true });
  }

  async abortRebase(cwd: string): Promise<void> {
    await this.exec(cwd, ['rebase', '--abort'], { allowFailure: true });
  }

  async conflictFiles(cwd: string): Promise<string[]> {
    const result = await this.exec(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) return [];
    return result.stdout.split('\u0000').filter((entry) => entry.length > 0);
  }

  /* ------------------------------------------------------------------ */
  /* Stash                                                               */
  /* ------------------------------------------------------------------ */

  async stashPush(cwd: string, message?: string): Promise<void> {
    const args = ['stash', 'push'];
    if (message !== undefined && message.length > 0) args.push('-m', message);
    await this.exec(cwd, args);
  }

  async stashList(cwd: string): Promise<GitStashEntry[]> {
    const stdout = await this.execStdout(
      cwd,
      ['stash', 'list', `--pretty=format:%gd${FIELD_SEP}%s${FIELD_SEP}%at${RECORD_SEP}`],
      {
        allowFailure: true,
      },
    );
    const records = splitRecords(stdout);
    const entries: GitStashEntry[] = [];
    for (const record of records) {
      const [ref = '', subject = '', at = '0'] = record.split(FIELD_SEP);
      const index = Number.parseInt(ref.replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(index)) continue;
      const { branch, message } = parseStashSubject(subject);
      const filesOut = await this.exec(
        cwd,
        ['stash', 'show', '--name-only', '-z', `stash@{${index}}`],
        { allowFailure: true },
      );
      const files = filesOut.stdout.split('\u0000').filter((entry) => entry.length > 0).length;
      entries.push({
        index,
        message: message.length > 0 ? message : subject,
        branch,
        files,
        createdAt: Number.parseInt(at, 10) * 1000,
      });
    }
    return entries;
  }

  async stashApply(cwd: string, index: number, options: { drop?: boolean } = {}): Promise<void> {
    await this.exec(cwd, ['stash', options.drop === true ? 'pop' : 'apply', `stash@{${index}}`]);
  }

  async stashDrop(cwd: string, index: number): Promise<void> {
    await this.exec(cwd, ['stash', 'drop', `stash@{${index}}`]);
  }

  /* ------------------------------------------------------------------ */
  /* 远程                                                               */
  /* ------------------------------------------------------------------ */

  async remotes(cwd: string): Promise<GitRemote[]> {
    const stdout = await this.execStdout(cwd, ['remote', '-v'], { allowFailure: true });
    const pushUrls = new Map<string, string>();
    const fetchUrls = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
      if (match === null) continue;
      const [, name = '', url = '', kind = 'fetch'] = match;
      if (kind === 'fetch') fetchUrls.set(name, url);
      else pushUrls.set(name, url);
    }
    return [...fetchUrls.entries()].map(([name, url]) => ({
      name,
      url,
      pushUrl:
        pushUrls.get(name) !== undefined && pushUrls.get(name) !== url
          ? (pushUrls.get(name) ?? null)
          : null,
      kind: classifyRemoteUrl(url),
      credentialConfigured: false,
    }));
  }

  async addRemote(cwd: string, name: string, url: string): Promise<void> {
    await this.exec(cwd, ['remote', 'add', name, url]);
  }

  async setRemoteUrl(cwd: string, name: string, url: string): Promise<void> {
    await this.exec(cwd, ['remote', 'set-url', name, url]);
  }

  async removeRemote(cwd: string, name: string): Promise<void> {
    await this.exec(cwd, ['remote', 'remove', name]);
  }

  async lsRemote(
    cwd: string,
    remote: string,
    options: { env?: Record<string, string> | undefined } = {},
  ): Promise<string[]> {
    const stdout = await this.execStdout(cwd, ['ls-remote', '--heads', remote], {
      env: options.env,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async push(cwd: string, input: PushInput = {}): Promise<TransferResult> {
    const args = ['push'];
    if (input.forceWithLease === true) args.push('--force-with-lease');
    else if (input.force === true) args.push('--force');
    if (input.setUpstream === true) args.push('-u');
    const remote = input.remote ?? (await this.defaultRemote(cwd));
    args.push(remote);
    if (input.branch !== undefined && input.branch.length > 0) args.push(input.branch);
    const result = await this.exec(cwd, args, { allowFailure: true, env: input.env });
    if (result.exitCode !== 0) {
      throw new GitCommandError(
        `推送失败：${result.stderr.trim() || `退出码 ${result.exitCode}`}`,
        {
          args,
          stderr: result.stderr,
          stdout: result.stdout,
          exitCode: result.exitCode,
        },
      );
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    return {
      remote,
      ref: input.branch ?? null,
      upToDate: /Everything up-to-date/i.test(combined),
      summary: combined.trim(),
      forced: input.force === true || input.forceWithLease === true,
    };
  }

  async pull(cwd: string, input: FetchInput = {}): Promise<MergeCommandResult> {
    const args = ['pull'];
    const remote = input.remote ?? (await this.defaultRemote(cwd));
    args.push(remote);
    return this.runMergeLike(cwd, args, input.env);
  }

  async fetch(cwd: string, input: FetchInput = {}): Promise<TransferResult> {
    const args = ['fetch'];
    if (input.prune === true) args.push('--prune');
    if (input.tags === true) args.push('--tags');
    const remote = input.remote ?? (await this.defaultRemote(cwd));
    args.push(remote);
    const result = await this.exec(cwd, args, { allowFailure: true, env: input.env });
    if (result.exitCode !== 0) {
      throw new GitCommandError(
        `抓取失败：${result.stderr.trim() || `退出码 ${result.exitCode}`}`,
        {
          args,
          stderr: result.stderr,
          stdout: result.stdout,
          exitCode: result.exitCode,
        },
      );
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    return {
      remote,
      ref: null,
      upToDate: combined.trim().length === 0,
      summary: combined.trim(),
      forced: false,
    };
  }

  private async defaultRemote(cwd: string): Promise<string> {
    const remotes = await this.remotes(cwd);
    if (remotes.some((remote) => remote.name === 'origin')) return 'origin';
    return remotes[0]?.name ?? 'origin';
  }

  /* ------------------------------------------------------------------ */
  /* 差异与定位                                                          */
  /* ------------------------------------------------------------------ */

  async diff(cwd: string, options: DiffOptions = {}): Promise<string> {
    const context = options.contextLines ?? 3;
    const args = ['diff', '--no-color', `--unified=${context}`, '--find-renames'];
    if (options.staged === true) args.push('--cached');
    if (options.from !== undefined) args.push(options.from);
    if (options.to !== undefined) args.push(options.to);
    args.push(...buildPathspecArgs(options));
    return this.execStdout(cwd, args, { allowFailure: true });
  }

  async diffNameStatus(cwd: string, options: DiffOptions = {}): Promise<DiffFileEntry[]> {
    const args = ['diff', '--name-status', '-z', '--find-renames'];
    if (options.staged === true) args.push('--cached');
    if (options.from !== undefined) args.push(options.from);
    if (options.to !== undefined) args.push(options.to);
    args.push(...buildPathspecArgs({ ...options, excludePaths: undefined }));
    const stdout = await this.execStdout(cwd, args, { allowFailure: true });
    return parseNameStatusZ(stdout);
  }

  async blameLite(
    cwd: string,
    path: string,
    range?: { start: number; end: number },
  ): Promise<BlameLine[]> {
    const args = ['blame', '--line-porcelain'];
    if (range !== undefined) args.push(`-L${range.start},${range.end}`);
    args.push('--', path);
    const stdout = await this.execStdout(cwd, args, { allowFailure: true });
    return parseBlame(stdout);
  }

  async fileSize(cwd: string, path: string): Promise<number | null> {
    // 索引中的条目优先（对已删除的工作区文件也有效）
    const result = await this.exec(cwd, ['cat-file', '-s', `:${path}`], { allowFailure: true });
    if (result.exitCode === 0) {
      const size = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isFinite(size)) return size;
    }
    if (this.filer !== undefined) {
      const abs = joinPath(cwd, path);
      return this.filer.size(abs);
    }
    return null;
  }
}

export function createCliGitBackend(options: CliGitBackendOptions): CliGitBackend {
  return new CliGitBackend(options);
}

/**
 * 组装 pathspec 参数。
 * 关键点：`path` 与 `excludePaths` **可以同时生效**（正向 path 之后接 `:(exclude)`），
 * 否则"只看某个文件"和"排除大文件"会互相覆盖，导致大文件 patch 依然被生成（真实踩过）。
 * 只有排除规则时补一个基础路径 `.`，语义更直观。
 */
export function buildPathspecArgs(options: DiffOptions): string[] {
  const hasPositivePath = options.path !== undefined && options.path.length > 0;
  const excludes = (options.excludePaths ?? []).map((path) => `:(exclude)${path}`);
  if (!hasPositivePath && excludes.length === 0) return [];
  const args = ['--'];
  if (hasPositivePath) args.push(options.path as string);
  else args.push('.');
  args.push(...excludes);
  return args;
}

/* -------------------------------------------------------------------------- */
/* 解析函数（导出便于单测）                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 按 0x1e 切记录并清理记录边界上的换行。
 *
 * **必须同时清理记录开头的换行**：git 会在每条记录末尾补一个 `\n`，
 * 于是切分后第 2 条及之后的记录都以 `\n` 开头（实测 `\x1e\nmain\x1f*...`）。
 * 只清尾部换行会让后续记录的首字段变成 `"\nmain"` —— 分支名匹配、sha 校验、
 * stash 序号都会因此错位（真实踩过，见 `splitRecords` 的回归用例）。
 */
export function splitRecords(text: string): string[] {
  return text
    .split(RECORD_SEP)
    .map((record) => record.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, ''))
    .filter((record) => record.trim().length > 0);
}

/**
 * 解析 `git status --porcelain=v1 -z`。
 * 重命名 / 复制条目在 -z 模式下是多带一个 NUL 分隔的旧路径：`XY <新>\0<旧>\0`
 * （已用真实仓库实测确认，见 T6-01 集成测试 `rename 检测` 用例）。
 */
export function parsePorcelainZ(stdout: string): StatusEntry[] {
  const tokens = stdout.split('\u0000');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.length < 4) continue;
    const x = token[0] ?? ' ';
    const y = token[1] ?? ' ';
    const path = token.slice(3);
    let oldPath: string | null = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const next = tokens[i + 1];
      if (next !== undefined && next.length > 0) {
        oldPath = next;
        i += 1;
      }
    }
    entries.push({
      path,
      oldPath,
      index: x,
      worktree: y,
      status: classifyStatus(x, y),
      staged: x !== ' ' && x !== '?' && x !== '!',
    });
  }
  return entries;
}

export function classifyStatus(x: string, y: string): FileStatus {
  if (x === '?' || y === '?') return 'untracked';
  if (x === '!' || y === '!') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'))
    return 'conflicted';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'T' || y === 'T') return 'typechange';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  if (x === 'M' || y === 'M') return 'modified';
  return 'modified';
}

export function parseLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of splitRecords(stdout)) {
    const parts = record.split(FIELD_SEP);
    const [
      sha = '',
      shortSha = '',
      subject = '',
      body = '',
      authorName = '',
      authorEmail = '',
      at = '0',
      parents = '',
      refs = '',
    ] = parts;
    if (sha.length === 0) continue;
    commits.push({
      sha,
      shortSha,
      subject,
      body: body.trim(),
      authorName,
      authorEmail,
      authoredAt: Number.parseInt(at, 10) * 1000,
      parents: parents.split(' ').filter((parent) => parent.length > 0),
      refs: refs
        .split(',')
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0),
    });
  }
  return commits;
}

export function parseBranches(stdout: string): GitBranchInfo[] {
  return splitRecords(stdout).map((record) => {
    const [name = '', head = '', upstream = '', track = '', sha = '', subject = ''] =
      record.split(FIELD_SEP);
    const ahead = Number.parseInt(/ahead (\d+)/.exec(track)?.[1] ?? '0', 10);
    const behind = Number.parseInt(/behind (\d+)/.exec(track)?.[1] ?? '0', 10);
    return {
      name,
      current: head.trim() === '*',
      upstream: upstream.length > 0 ? upstream : null,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
      lastCommitSha: sha.length > 0 ? sha : null,
      lastCommitSubject: subject.length > 0 ? subject : null,
      gone: /gone/.test(track),
    };
  });
}

/** `git stash list` 的 %s：`WIP on main: abc1234 msg` / `On main: my message` */
export function parseStashSubject(subject: string): { branch: string; message: string } {
  const wip = /^WIP on ([^:]+):\s*[0-9a-f]{6,}\s*(.*)$/.exec(subject);
  if (wip !== null) return { branch: wip[1] ?? '', message: (wip[2] ?? '').trim() };
  const on = /^On ([^:]+):\s*(.*)$/.exec(subject);
  if (on !== null) return { branch: on[1] ?? '', message: (on[2] ?? '').trim() };
  return { branch: '', message: subject };
}

export function parseBlame(stdout: string): BlameLine[] {
  const lines: BlameLine[] = [];
  let current: { sha: string; author: string; at: number; line: number } | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const header = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)/.exec(raw);
    if (header !== null) {
      current = {
        sha: header[1] ?? '',
        author: '',
        at: 0,
        line: Number.parseInt(header[3] ?? '0', 10),
      };
      continue;
    }
    const author = /^author (.+)$/.exec(raw);
    if (author !== null && current !== null) {
      current.author = author[1] ?? '';
      continue;
    }
    const time = /^author-time (\d+)$/.exec(raw);
    if (time !== null && current !== null) {
      current.at = Number.parseInt(time[1] ?? '0', 10) * 1000;
      continue;
    }
    if (raw.startsWith('\t') && current !== null) {
      lines.push({
        line: current.line,
        sha: current.sha,
        authorName: current.author,
        authoredAt: current.at,
        text: raw.slice(1),
      });
      current = null;
    }
  }
  return lines;
}

/** 判定远程 URL 类型（凭据选择与 UI 图标用） */
export function classifyRemoteUrl(url: string): GitRemote['kind'] {
  if (/^https?:\/\//i.test(url)) return 'https';
  if (/^(ssh:\/\/|git@|[^/]+:[^/])/i.test(url) && !/^[a-z]:[\\/]/i.test(url)) return 'ssh';
  if (/^([a-z]:[\\/]|\/|file:\/\/)/i.test(url)) return 'local';
  return 'unknown';
}

/** 取当前工作目录（探测命令的 cwd；无 process 环境时退回 '.'） */
function processCwd(): string {
  const g = globalThis as { process?: { cwd?: () => string } };
  return g.process?.cwd?.() ?? '.';
}

/**
 * 解析 `git diff --name-status -z`。
 * 实测格式：普通条目 `<状态>\0<路径>\0`；重命名/复制 `<状态>\0<旧路径>\0<新路径>\0`
 * （状态带相似度后缀，如 `R075`）。
 */
export function parseNameStatusZ(stdout: string): DiffFileEntry[] {
  const tokens = stdout.split('\u0000');
  const entries: DiffFileEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (code === undefined || code.length === 0) continue;
    const letter = code[0] ?? 'M';
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath === undefined || newPath === undefined) break;
      entries.push({ path: newPath, oldPath, status: letter === 'R' ? 'renamed' : 'copied' });
      i += 2;
      continue;
    }
    const path = tokens[i + 1];
    if (path === undefined) break;
    entries.push({ path, oldPath: null, status: nameStatusToFileStatus(letter) });
    i += 1;
  }
  return entries;
}

function nameStatusToFileStatus(letter: string): FileStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'T':
      return 'typechange';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

function joinPath(cwd: string, path: string): string {
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  const base = cwd.endsWith(sep) ? cwd.slice(0, -1) : cwd;
  return `${base}${sep}${path.replace(/[\\/]/g, sep)}`;
}
