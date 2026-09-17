import type { GitBranchInfo, GitCommit, GitRemote, GitStashEntry, GitTagInfo } from '../models';
import type {
  BlameLine,
  CommitInput,
  DiffFileEntry,
  DiffOptions,
  FetchInput,
  GitBackend,
  GitCapability,
  InitOptions,
  LogOptions,
  MergeCommandResult,
  PushInput,
  StatusEntry,
  TransferResult,
} from './types';

/**
 * libgit2 后端（T6-01 要点 1 的「优先」路径）。
 *
 * ## 现实约束（必须如实说明）
 *
 * Node 侧要用 libgit2 只有两条路：
 * - `nodegit`：原生模块，需要 MSVC 工具链现场编译，构建重且历史上对 Node 大版本敏感；
 * - `isomorphic-git`：纯 JS 实现，但**不是** libgit2，能力与语义有差异。
 *
 * 本仓库当前**未安装任何 libgit2 绑定**（见报告"未完成/降级项"）。因此：
 *
 * 1. `probe()` 会尝试动态加载绑定；加载不到就返回 false，`backend/index.ts`
 *    记录一条"回退到 CLI"的日志并透明切换到 CLI 后端 —— 上层（GitClient / UI）无感。
 * 2. 绑定存在时，**原生覆盖** init / isRepo / 当前分支 / HEAD / status / add / commit /
 *    log / diff；其余能力（remote / transfer / merge / rebase / stash / blame）委托给
 *    注入的 CLI 后端，因为在这些能力上 CLI 语义更完整、进度与凭据处理也更成熟。
 * 3. 原生调用**失败不静默**：会把失败原因登记到 `fallbackNotes`，由 GitClient
 *    转成结构化日志；随后**自动重试 CLI** 以保证用户体验不中断。
 *
 * 注入式设计（`Git2Loader`）让"git2 可用"这条分支可以被测试覆盖：
 * 测试注入一个假绑定即可验证「原生被调用、且失败后确实回退到 CLI」。
 */

/** libgit2 绑定的最小可用面（适配层实现） */
export interface Git2Binding {
  readonly name: string;
  init(cwd: string, options: InitOptions): Promise<void>;
  isRepo(cwd: string): Promise<boolean>;
  currentBranch(cwd: string): Promise<string | null>;
  headSha(cwd: string): Promise<string | null>;
  status(cwd: string): Promise<StatusEntry[]>;
  add(cwd: string, paths: readonly string[]): Promise<void>;
  commit(cwd: string, input: CommitInput): Promise<string>;
  log(cwd: string, options: LogOptions): Promise<GitCommit[]>;
  diff(cwd: string, options: DiffOptions): Promise<string>;
}

export interface Git2LoadResult {
  binding: Git2Binding | null;
  /** 中文说明：加载成功或失败的原因（进结构化日志） */
  detail: string;
}

export type Git2Loader = () => Promise<Git2LoadResult>;

/** 动态 import：用变量形式避免打包器静态解析（绑定是可选依赖） */
const dynamicImport = (specifier: string): Promise<unknown> => import(/* @vite-ignore */ specifier);

/**
 * 默认加载器：尝试 `nodegit`。
 * 想接其它绑定（例如自研 napi-rs 封装）时，把加载器注入 `Git2GitBackend` 即可，本文件无需改动。
 */
export const defaultGit2Loader: Git2Loader = async () => {
  try {
    const mod = await dynamicImport('nodegit');
    const binding = adaptNodegit(mod);
    if (binding === null) {
      return { binding: null, detail: '已找到 nodegit，但接口形态不匹配（版本不受支持）' };
    }
    return { binding, detail: '已加载 nodegit（libgit2 原生绑定）' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { binding: null, detail: `未安装 libgit2 绑定，将使用系统 Git CLI：${message}` };
  }
};

/**
 * nodegit → Git2Binding 适配。
 *
 * 注意：本机未安装 nodegit，这段适配**未在真实绑定上验证过**，属"已接线待验证"。
 * 一旦绑定可用，`probe()` 会走通并接管原生能力；此处的 try/catch 保证任何形态差异
 * 都会退化成 `null`（即"用不了就老实回退 CLI"），不会把应用带崩。
 */
function adaptNodegit(mod: unknown): Git2Binding | null {
  const git = mod as {
    Repository?: {
      init(path: string, bare: number): Promise<unknown>;
      open(path: string): Promise<unknown>;
    };
    RepositoryInitOptions?: new () => { initialHead?: string };
  };
  if (typeof git.Repository?.init !== 'function' || typeof git.Repository?.open !== 'function') return null;
  const Repository = git.Repository;

  const open = (cwd: string): Promise<unknown> => Repository.open(cwd);

  return {
    name: 'nodegit',
    async init(cwd, options) {
      const repo = (await Repository.init(cwd, options.bare === true ? 1 : 0)) as {
        setHead?: (ref: string) => Promise<void>;
        free?: () => void;
      };
      if (options.branch !== undefined && options.branch !== 'master' && typeof repo.setHead === 'function') {
        await repo.setHead(`refs/heads/${options.branch}`);
      }
      repo.free?.();
    },
    async isRepo(cwd) {
      try {
        const repo = (await open(cwd)) as { free?: () => void };
        repo.free?.();
        return true;
      } catch {
        return false;
      }
    },
    async currentBranch(cwd) {
      const repo = (await open(cwd)) as {
        head?: () => Promise<{ shorthand?: () => string }>;
        free?: () => void;
      };
      try {
        const ref = await repo.head?.();
        return ref?.shorthand?.() ?? null;
      } finally {
        repo.free?.();
      }
    },
    async headSha(cwd) {
      const repo = (await open(cwd)) as {
        head?: () => Promise<{ target?: () => { tostr?: () => string } }>;
        free?: () => void;
      };
      try {
        const ref = await repo.head?.();
        return ref?.target?.().tostr?.() ?? null;
      } finally {
        repo.free?.();
      }
    },
    // status / add / commit / log / diff 的原生映射同样依赖 nodegit 具体 API，
    // 这里抛"未实现"以便在绑定可用但适配未完成时**明确回退 CLI**，而不是给出错误结果。
    async status() {
      throw new Error('nodegit 适配层尚未实现 status，已回退 CLI');
    },
    async add() {
      throw new Error('nodegit 适配层尚未实现 add，已回退 CLI');
    },
    async commit() {
      throw new Error('nodegit 适配层尚未实现 commit，已回退 CLI');
    },
    async log() {
      // 空数组会让 UI 显示"无历史"，属于错误结果，因此也抛错回退
      throw new Error('nodegit 适配层尚未实现 log，已回退 CLI');
    },
    async diff() {
      throw new Error('nodegit 适配层尚未实现 diff，已回退 CLI');
    },
  };
}

export interface Git2GitBackendOptions {
  /** 非原生能力的委托目标（通常是 CLI 后端） */
  fallback: GitBackend;
  load?: Git2Loader;
}

export class Git2GitBackend implements GitBackend {
  readonly id = 'git2' as const;
  readonly label = 'libgit2 原生';

  private readonly fallback: GitBackend;
  private readonly load: Git2Loader;
  private loaded: Promise<Git2LoadResult> | null = null;
  private readonly notes: string[] = [];
  private nativeCalls = 0;
  private fallbackCalls = 0;

  constructor(options: Git2GitBackendOptions) {
    this.fallback = options.fallback;
    this.load = options.load ?? defaultGit2Loader;
  }

  /** 原生调用次数（测试用：证明"优先走 git2"） */
  get nativeCallCount(): number {
    return this.nativeCalls;
  }

  /** 因原生失败 / 未实现而落到 CLI 的次数 */
  get fallbackCallCount(): number {
    return this.fallbackCalls;
  }

  /** 取出待上报的说明（由 GitClient 转为结构化日志） */
  drainNotes(): string[] {
    const out = [...this.notes];
    this.notes.length = 0;
    return out;
  }

  private async binding(): Promise<Git2Binding | null> {
    if (this.loaded === null) {
      this.loaded = this.load().catch((error: unknown) => ({
        binding: null,
        detail: `libgit2 绑定加载异常：${error instanceof Error ? error.message : String(error)}`,
      }));
    }
    const result = await this.loaded;
    if (result.detail.length > 0 && !this.notes.includes(result.detail)) this.notes.push(result.detail);
    return result.binding;
  }

  async probe(): Promise<boolean> {
    const binding = await this.binding();
    return binding !== null;
  }

  capabilities(): readonly GitCapability[] {
    return this.fallback.capabilities();
  }

  /** 原生优先，失败退 CLI（并把原因登记下来） */
  private async native<T>(op: string, run: (binding: Git2Binding) => Promise<T>, viaCli: () => Promise<T>): Promise<T> {
    const binding = await this.binding();
    if (binding === null) {
      this.fallbackCalls += 1;
      return viaCli();
    }
    try {
      this.nativeCalls += 1;
      return await run(binding);
    } catch (error) {
      this.fallbackCalls += 1;
      this.notes.push(`libgit2 的 ${op} 失败，已自动回退系统 Git CLI：${error instanceof Error ? error.message : String(error)}`);
      return viaCli();
    }
  }

  /* ---------------- 原生覆盖的能力 ---------------- */

  init(cwd: string, options: InitOptions = {}): Promise<void> {
    return this.native('init', (binding) => binding.init(cwd, options), () => this.fallback.init(cwd, options));
  }

  isRepo(cwd: string): Promise<boolean> {
    return this.native('isRepo', (binding) => binding.isRepo(cwd), () => this.fallback.isRepo(cwd));
  }

  currentBranch(cwd: string): Promise<string | null> {
    return this.native('currentBranch', (binding) => binding.currentBranch(cwd), () => this.fallback.currentBranch(cwd));
  }

  headSha(cwd: string): Promise<string | null> {
    return this.native('headSha', (binding) => binding.headSha(cwd), () => this.fallback.headSha(cwd));
  }

  status(cwd: string): Promise<StatusEntry[]> {
    return this.native('status', (binding) => binding.status(cwd), () => this.fallback.status(cwd));
  }

  add(cwd: string, paths: readonly string[]): Promise<void> {
    return this.native('add', (binding) => binding.add(cwd, paths), () => this.fallback.add(cwd, paths));
  }

  commit(cwd: string, input: CommitInput): Promise<string> {
    return this.native('commit', (binding) => binding.commit(cwd, input), () => this.fallback.commit(cwd, input));
  }

  log(cwd: string, options: LogOptions = {}): Promise<GitCommit[]> {
    return this.native('log', (binding) => binding.log(cwd, options), () => this.fallback.log(cwd, options));
  }

  diff(cwd: string, options: DiffOptions = {}): Promise<string> {
    return this.native('diff', (binding) => binding.diff(cwd, options), () => this.fallback.diff(cwd, options));
  }

  /** 权威清单交给 CLI（原生适配未覆盖，避免给出错误的路径顺序） */
  diffNameStatus(cwd: string, options: DiffOptions = {}): Promise<DiffFileEntry[]> {
    this.fallbackCalls += 1;
    return this.fallback.diffNameStatus(cwd, options);
  }

  /* ---------------- 委托 CLI 的能力 ---------------- */

  revParse(cwd: string, ref: string): Promise<string | null> {
    return this.fallback.revParse(cwd, ref);
  }
  readConfig(cwd: string, key: string): Promise<string | null> {
    return this.fallback.readConfig(cwd, key);
  }
  writeConfig(cwd: string, key: string, value: string): Promise<void> {
    return this.fallback.writeConfig(cwd, key, value);
  }
  unstage(cwd: string, paths: readonly string[]): Promise<void> {
    return this.fallback.unstage(cwd, paths);
  }
  reset(cwd: string, target: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    return this.fallback.reset(cwd, target, mode);
  }
  revert(cwd: string, sha: string, options: { noCommit?: boolean } = {}): Promise<void> {
    return this.fallback.revert(cwd, sha, options);
  }
  show(cwd: string, ref: string): Promise<string> {
    return this.fallback.show(cwd, ref);
  }
  branches(cwd: string): Promise<GitBranchInfo[]> {
    return this.fallback.branches(cwd);
  }
  tags(cwd: string): Promise<GitTagInfo[]> {
    return this.fallback.tags(cwd);
  }
  createBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
    return this.fallback.createBranch(cwd, name, startPoint);
  }
  switchBranch(cwd: string, name: string, options: { create?: boolean } = {}): Promise<void> {
    return this.fallback.switchBranch(cwd, name, options);
  }
  renameBranch(cwd: string, from: string, to: string): Promise<void> {
    return this.fallback.renameBranch(cwd, from, to);
  }
  deleteBranch(cwd: string, name: string, options: { force?: boolean } = {}): Promise<void> {
    return this.fallback.deleteBranch(cwd, name, options);
  }
  merge(cwd: string, branch: string, options: { noFf?: boolean; message?: string; noCommit?: boolean } = {}): Promise<MergeCommandResult> {
    return this.fallback.merge(cwd, branch, options);
  }
  rebase(cwd: string, onto: string): Promise<MergeCommandResult> {
    return this.fallback.rebase(cwd, onto);
  }
  abortMerge(cwd: string): Promise<void> {
    return this.fallback.abortMerge(cwd);
  }
  abortRebase(cwd: string): Promise<void> {
    return this.fallback.abortRebase(cwd);
  }
  conflictFiles(cwd: string): Promise<string[]> {
    return this.fallback.conflictFiles(cwd);
  }
  stashPush(cwd: string, message?: string): Promise<void> {
    return this.fallback.stashPush(cwd, message);
  }
  stashList(cwd: string): Promise<GitStashEntry[]> {
    return this.fallback.stashList(cwd);
  }
  stashApply(cwd: string, index: number, options: { drop?: boolean } = {}): Promise<void> {
    return this.fallback.stashApply(cwd, index, options);
  }
  stashDrop(cwd: string, index: number): Promise<void> {
    return this.fallback.stashDrop(cwd, index);
  }
  remotes(cwd: string): Promise<GitRemote[]> {
    return this.fallback.remotes(cwd);
  }
  addRemote(cwd: string, name: string, url: string): Promise<void> {
    return this.fallback.addRemote(cwd, name, url);
  }
  setRemoteUrl(cwd: string, name: string, url: string): Promise<void> {
    return this.fallback.setRemoteUrl(cwd, name, url);
  }
  removeRemote(cwd: string, name: string): Promise<void> {
    return this.fallback.removeRemote(cwd, name);
  }
  lsRemote(cwd: string, remote: string, options: { env?: Record<string, string> | undefined } = {}): Promise<string[]> {
    return this.fallback.lsRemote(cwd, remote, options);
  }
  push(cwd: string, input: PushInput = {}): Promise<TransferResult> {
    return this.fallback.push(cwd, input);
  }
  pull(cwd: string, input: FetchInput = {}): Promise<MergeCommandResult> {
    return this.fallback.pull(cwd, input);
  }
  fetch(cwd: string, input: FetchInput = {}): Promise<TransferResult> {
    return this.fallback.fetch(cwd, input);
  }
  blameLite(cwd: string, path: string, range?: { start: number; end: number }): Promise<BlameLine[]> {
    return this.fallback.blameLite(cwd, path, range);
  }
  fileSize(cwd: string, path: string): Promise<number | null> {
    return this.fallback.fileSize(cwd, path);
  }
}

export function createGit2Backend(options: Git2GitBackendOptions): Git2GitBackend {
  return new Git2GitBackend(options);
}
