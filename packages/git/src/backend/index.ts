import { createCliGitBackend } from './cli-backend';
import { createGit2Backend, type Git2Loader } from './git2-backend';
import { createNodeFiler, createNodeGitRunner } from './node-ports';
import type { GitBackend, GitBackendId, GitFilerPort, GitProcessRunner } from './types';

/**
 * 后端选择（T6-01 要点 1）：探针 → git2 优先 → 不可用则**自动回退 CLI**，对上层完全透明。
 *
 * 选择结果里带 `notes`：每一句都会进结构化日志，UI 上能看到
 * 「已使用 libgit2 原生后端」或「libgit2 不可用，已回退系统 Git CLI」——
 * 这满足「全部操作可视化」的硬约束：连底层的降级都要让用户看得见。
 */

export type BackendPreference = 'auto' | 'git2' | 'cli';

export interface BackendDeps {
  runner: GitProcessRunner;
  /** 文件体积 / .gitignore 落盘用；缺省时 .gitignore 只渲染不落盘 */
  filer?: GitFilerPort | undefined;
  /** git 可执行文件路径，默认 'git' */
  gitPath?: string | undefined;
}

export interface SelectBackendOptions {
  deps: BackendDeps;
  /** 默认 'auto'：能上 git2 就上，不能就 CLI */
  preferred?: BackendPreference | undefined;
  /** 注入 libgit2 加载器（测试用；生产走默认的 nodegit 探测） */
  loadGit2?: Git2Loader | undefined;
}

export interface SelectedBackend {
  backend: GitBackend;
  /** 调用方请求的偏好 */
  requested: BackendPreference;
  /** 实际生效的后端 */
  used: GitBackendId;
  /** 中文说明，直接进结构化日志 */
  notes: string[];
}

export async function selectBackend(options: SelectBackendOptions): Promise<SelectedBackend> {
  const requested = options.preferred ?? 'auto';
  const notes: string[] = [];
  const cli = createCliGitBackend({
    runner: options.deps.runner,
    ...(options.deps.gitPath !== undefined ? { gitPath: options.deps.gitPath } : {}),
    ...(options.deps.filer !== undefined ? { filer: options.deps.filer } : {}),
  });
  const cliAvailable = await cli.probe();
  if (!cliAvailable) {
    notes.push(
      '未检测到可用的系统 Git（git --version 失败），Git 能力将不可用；请安装 Git 2.40+ 后重试',
    );
  } else {
    notes.push('系统 Git CLI 可用');
  }

  if (requested === 'cli') {
    notes.push('按配置强制使用系统 Git CLI');
    return { backend: cli, requested, used: 'cli', notes };
  }

  const git2 = createGit2Backend({
    fallback: cli,
    ...(options.loadGit2 !== undefined ? { load: options.loadGit2 } : {}),
  });
  const git2Available = await git2.probe();
  const git2Notes = git2.drainNotes();

  if (git2Available) {
    notes.push('libgit2 原生后端可用，优先使用原生实现');
    notes.push(...git2Notes);
    return { backend: git2, requested, used: 'git2', notes };
  }

  notes.push('libgit2 绑定不可用，已自动回退系统 Git CLI（对上层透明，行为一致）');
  notes.push(...git2Notes);
  return { backend: cli, requested, used: 'cli', notes };
}

/** 生产默认依赖：Node 子进程 + Node 文件系统 */
export function createDefaultBackendDeps(options: { gitPath?: string } = {}): BackendDeps {
  return {
    runner: createNodeGitRunner(options.gitPath !== undefined ? { gitPath: options.gitPath } : {}),
    filer: createNodeFiler(),
    ...(options.gitPath !== undefined ? { gitPath: options.gitPath } : {}),
  };
}

export * from './types';
export { createCliGitBackend, CliGitBackend } from './cli-backend';
export { createGit2Backend, Git2GitBackend, defaultGit2Loader } from './git2-backend';
export type { Git2Binding, Git2Loader, Git2LoadResult } from './git2-backend';
export { createNodeFiler, createNodeGitRunner } from './node-ports';
