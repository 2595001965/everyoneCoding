import type { GitLogEntry, GitResult, MergeOutcome, MergePreview } from './models';
import type { GitClient } from './git-client';

/**
 * 合并与变基服务（T6-04 要点 1）。
 *
 * 安全前置：**任何 merge / rebase 之前都自动创建备份分支 `backup/<时间戳>`**，
 * 用户在合并前能看到将被引入的提交清单（`previewMerge`，只读不落地），
 * 合并失败进入冲突状态时把冲突文件清单原样返回，交给 `ConflictEditor` 处理。
 *
 * 时间戳来自注入的 `clock`，便于测试断言分支名（禁止在断言里依赖 Date.now）。
 */

export interface MergeServiceOptions {
  clock?: (() => number) | undefined;
}

/** `backup/20260912-073000` —— 本地时间，人类可读，便于在分支列表里排序 */
export function backupBranchName(now: number): string {
  const date = new Date(now);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `backup/${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 备份分支名是否合法（列表过滤用） */
export function isBackupBranch(name: string): boolean {
  return /^backup\/\d{8}-\d{6}$/.test(name);
}

export interface MergeExecuteOptions {
  /** 是否创建备份分支，默认 true */
  backup?: boolean;
  /** 强制产生一个合并提交（不使用快进） */
  noFf?: boolean;
  message?: string;
}

export class MergeService {
  private readonly clock: () => number;

  constructor(
    private readonly client: GitClient,
    options: MergeServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** 合并前预览（只读）：将被引入的提交、影响文件数、是否可快进 */
  async preview(
    source: string,
    target: string,
  ): Promise<GitResult<MergePreview & { backupBranch: string | null }>> {
    const result = await this.client.previewMerge(source, target);
    if (!result.ok || result.data === null) return { ...result, data: null };
    return {
      ok: true,
      error: null,
      logs: result.logs,
      data: {
        source,
        target,
        commits: result.data.commits,
        filesChanged: result.data.filesChanged,
        fastForward: result.data.fastForward,
        conflictFiles: [],
        backupBranch: null,
      },
    };
  }

  /**
   * 执行合并。步骤固定为「创建备份 → 合并 → 归类结果」，
   * 任何失败都不吞掉：调用方能拿到 `status: 'failed'` 与结构化日志。
   */
  async execute(source: string, options: MergeExecuteOptions = {}): Promise<GitResult<MergeOutcome>> {
    const logs: GitLogEntry[] = [];
    let backupBranch: string | null = null;

    if (options.backup !== false) {
      const branchName = backupBranchName(this.clock());
      const created = await this.client.createBranch(branchName);
      logs.push(...created.logs);
      if (created.ok) backupBranch = branchName;
      else logs.push({ level: 'warn', message: `备份分支创建失败，本次合并未执行：${created.error?.message ?? '未知原因'}`, at: this.clock() });
      if (!created.ok) {
        return { ok: false, data: null, logs, error: created.error };
      }
    }

    const merged = await this.client.merge(source, {
      noFf: options.noFf ?? false,
      ...(options.message !== undefined ? { message: options.message } : {}),
    });
    logs.push(...merged.logs);

    if (!merged.ok || merged.data === null) {
      return { ok: false, data: null, logs, error: merged.error };
    }

    const conflictFiles = merged.data.conflictFiles;
    const head = await this.client.headSha();
    logs.push(...head.logs);

    let status: MergeOutcome['status'];
    if (conflictFiles.length > 0) status = 'conflicted';
    else if (merged.data.upToDate) status = 'up-to-date';
    else if (merged.data.fastForward) status = 'fast-forward';
    else status = 'merged';

    const commits = await this.client.log({ limit: 50 });
    logs.push(...commits.logs);

    return {
      ok: true,
      error: null,
      logs,
      data: {
        status,
        commits: commits.data ?? [],
        conflictFiles,
        backupBranch,
        newSha: head.data ?? null,
      },
    };
  }

  /** 变基（同样先建备份分支） */
  async rebase(onto: string, options: { backup?: boolean } = {}): Promise<GitResult<MergeOutcome>> {
    const logs: GitLogEntry[] = [];
    let backupBranch: string | null = null;
    if (options.backup !== false) {
      const branchName = backupBranchName(this.clock());
      const created = await this.client.createBranch(branchName);
      logs.push(...created.logs);
      if (!created.ok) return { ok: false, data: null, logs, error: created.error };
      backupBranch = branchName;
    }
    const rebased = await this.client.rebase(onto);
    logs.push(...rebased.logs);
    if (!rebased.ok || rebased.data === null) return { ok: false, data: null, logs, error: rebased.error };

    const conflictFiles = rebased.data.conflictFiles;
    const head = await this.client.headSha();
    logs.push(...head.logs);
    return {
      ok: true,
      error: null,
      logs,
      data: {
        status: conflictFiles.length > 0 ? 'conflicted' : 'merged',
        commits: [],
        conflictFiles,
        backupBranch,
        newSha: head.data ?? null,
      },
    };
  }

  /** 备份分支列表（按时间倒序） */
  async listBackups(): Promise<GitResult<{ name: string; sha: string | null; subject: string | null }[]>> {
    const result = await this.client.branches();
    if (!result.ok || result.data === null) return { ...result, data: null };
    const backups = result.data
      .filter((branch) => isBackupBranch(branch.name))
      .sort((a, b) => (a.name < b.name ? 1 : -1))
      .map((branch) => ({ name: branch.name, sha: branch.lastCommitSha, subject: branch.lastCommitSubject }));
    return { ok: true, error: null, logs: result.logs, data: backups };
  }
}
