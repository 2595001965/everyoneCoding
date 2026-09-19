import { createCommitMessage } from './commit-message';
import { backupBranchName, isBackupBranch } from './merge-service';
import type { GitLogEntry, GitResult, RollbackMode, RollbackPlan } from './models';
import { ROLLBACK_MODE_LABELS } from './models';
import type { GitClient } from './git-client';

/**
 * 回滚服务（T6-04 要点 3）。
 *
 * 两种模式（差异必须让用户看见，所以文案写进 `RollbackPlan.warnings`）：
 * - `soft`：`git reset --soft <sha>` —— HEAD 退回去，**工作区改动全部保留**，
 *   适合"重新生成前先撤掉上一次的产物，稍后让 AI 覆盖写入"；
 * - `revert`：为每个被撤销的提交生成反向提交，**历史保留**、可安全推送，
 *   适合已经推到远端的节点。
 *
 * 无论哪种模式，执行前都会自动创建安全快照分支（`backup/<时间戳>`），
 * 与合并共用同一套命名规则，用户在一处就能找到所有安全点。
 */

export interface RecoveryServiceOptions {
  clock?: (() => number) | undefined;
}

export class RecoveryService {
  private readonly clock: () => number;

  constructor(
    private readonly client: GitClient,
    options: RecoveryServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** 生成回滚计划（只读，不修改仓库）：受影响的提交、文件、安全快照分支名 */
  async plan(input: {
    sha: string;
    mode: RollbackMode;
    nodeLabel?: string;
  }): Promise<GitResult<RollbackPlan>> {
    const logs: GitLogEntry[] = [];
    const commits = await this.client.log({ ref: `${input.sha}..HEAD`, limit: 200 });
    logs.push(...commits.logs);
    const head = await this.client.headSha();
    logs.push(...head.logs);
    const diff = await this.client.diff({ scope: 'range', from: input.sha, to: 'HEAD' });
    logs.push(...diff.logs);

    const affected = commits.data ?? [];
    const warnings: string[] = [];
    if (affected.length === 0) warnings.push('目标提交就是当前 HEAD，无需回滚');
    if (input.mode === 'soft') {
      warnings.push('软回退会保留工作区改动，可用「重新生成」让 AI 覆盖写入产物');
    } else {
      warnings.push('反向提交会新增一条提交记录，已推送到远端的节点请优先使用此模式');
    }
    if (input.nodeLabel !== undefined && input.nodeLabel.length > 0) {
      warnings.push(`本次回滚针对生成节点：${input.nodeLabel}`);
    }

    return {
      ok: true,
      error: null,
      logs,
      data: {
        mode: input.mode,
        targetSha: input.sha,
        affectedCommits: affected,
        affectedFiles: (diff.data?.files ?? []).map((file) => file.path),
        snapshotBranch: backupBranchName(this.clock()),
        warnings,
      },
    };
  }

  /**
   * 执行回滚。
   * 破坏性操作：调用方（UI）必须先二次确认并把确认结果传进来（`confirmed: true`），
   * 否则直接拒绝执行 —— 这一层保护不依赖 UI 自觉。
   */
  async execute(
    plan: RollbackPlan,
    options: { confirmed: boolean } = { confirmed: false },
  ): Promise<
    GitResult<{
      mode: RollbackMode;
      snapshotBranch: string;
      newHead: string | null;
      commitSha: string | null;
    }>
  > {
    if (!options.confirmed) {
      return {
        ok: false,
        data: null,
        logs: [],
        error: {
          code: 'INVALID_ARGUMENT',
          message: '破坏性操作需要二次确认（confirmed: true）后才能执行',
        },
      };
    }

    const logs: GitLogEntry[] = [];
    const snapshot = await this.client.createBranch(plan.snapshotBranch);
    logs.push(...snapshot.logs);
    if (!snapshot.ok) return { ok: false, data: null, logs, error: snapshot.error };

    let commitSha: string | null = null;
    if (plan.mode === 'soft') {
      const reset = await this.client.reset(plan.targetSha, 'soft');
      logs.push(...reset.logs);
      if (!reset.ok) return { ok: false, data: null, logs, error: reset.error };
    } else {
      // 从最老的提交开始反向提交，最后合并成一条撤销提交
      const ordered = [...plan.affectedCommits].reverse();
      for (const commit of ordered) {
        const reverted = await this.client.revert(commit.sha, { noCommit: true });
        logs.push(...reverted.logs);
        if (!reverted.ok) return { ok: false, data: null, logs, error: reverted.error };
      }
      if (ordered.length > 0) {
        const message = createCommitMessage({
          type: 'revert',
          subject: `回退到生成前状态（${plan.affectedCommits.length} 个提交）`,
          body: `由 EveryoneCoding 执行反向提交回滚，模式：${ROLLBACK_MODE_LABELS.revert}。\n安全快照分支：${plan.snapshotBranch}`,
          sources: plan.affectedCommits.slice(0, 5).map((commit) => commit.subject),
        });
        const committed = await this.client.commit({
          subject: message.split('\n')[0] ?? 'revert: 回退生成产物',
        });
        logs.push(...committed.logs);
        if (!committed.ok) return { ok: false, data: null, logs, error: committed.error };
        commitSha = committed.data;
      }
    }

    const head = await this.client.headSha();
    logs.push(...head.logs);
    return {
      ok: true,
      error: null,
      logs,
      data: {
        mode: plan.mode,
        snapshotBranch: plan.snapshotBranch,
        newHead: head.data ?? null,
        commitSha,
      },
    };
  }

  /** 安全快照分支列表（回滚/合并共用） */
  async listSnapshots(): Promise<
    GitResult<{ name: string; sha: string | null; subject: string | null }[]>
  > {
    const result = await this.client.branches();
    if (!result.ok || result.data === null) return { ...result, data: null };
    return {
      ok: true,
      error: null,
      logs: result.logs,
      data: result.data
        .filter((branch) => isBackupBranch(branch.name))
        .sort((a, b) => (a.name < b.name ? 1 : -1))
        .map((branch) => ({
          name: branch.name,
          sha: branch.lastCommitSha,
          subject: branch.lastCommitSubject,
        })),
    };
  }
}
