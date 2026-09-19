import type { CrashRecovery, SnapshotEnvelope } from '@ec/core';

import type { ArtifactStore } from './artifact-store';
import type { PipelineMachine, PipelineStageSnapshot } from './pipeline-machine';
import { blankStageState } from './pipeline-machine';
import type { PipelineRepo, PipelineRunRecord } from './persistence';
import { PIPELINE_STAGES, STAGE_ORDER, type PipelineStage } from './stage-defs';

/**
 * 断点恢复（T5-01 要点 4、5 / FR-PIPE-11 / NFR-R-01）。
 *
 * 复用 T0-09 的 CrashRecovery（20s 快照、丢失窗口 ≤30s、原子写）：
 * - 领域名固定 `pipeline:<projectId>`，快照体 = PipelineStageSnapshot；
 * - 每次**阶段状态变化后**立即 snapshotNow()（强杀丢失窗口 ≈0）+ 周期兜底（CrashRecovery.start）；
 * - 重启后 {@link recover} 走三步：
 *   1. 从 pipeline_run / stage_artifact 表重建产物台账（权威数据，不受崩溃影响）；
 *   2. 检测 dirty 快照：有 → 恢复阶段状态到断点（含"正在生成中"的 running 阶段）；
 *   3. 校验产物文件一致性：被外部删除 / 不可读的版本列出来交给 UI 提示，绝不静默吞掉。
 */

export const PIPELINE_DOMAIN_PREFIX = 'pipeline:';

export interface RecoverResult {
  /** 是否从崩溃快照恢复（false = 首次进入或上次正常退出） */
  restoredFromSnapshot: boolean;
  /** 快照保存时间（恢复时展示"丢失了多久"） */
  savedAt: number | null;
  /** 产物台账里的版本数 */
  artifactVersions: number;
  /** 一致性校验发现的问题（文件缺失 / 不可读） */
  integrityProblems: Array<{
    stage: PipelineStage;
    version: number;
    contentRef: string;
    reason: string;
  }>;
  /** 恢复后的阶段状态（UI 渲染步骤条用） */
  snapshot: PipelineStageSnapshot;
  /** 需要续生成的阶段（status=running 或 stale 的第一个），无则 null */
  resumeStage: PipelineStage | null;
}

export interface PipelineRecoveryDeps {
  projectId: string;
  machine: PipelineMachine;
  artifacts: ArtifactStore;
  repo: PipelineRepo;
  recovery: CrashRecovery;
}

export class PipelineRecovery {
  private readonly deps: PipelineRecoveryDeps;
  private readonly domain: string;
  private readonly run: PipelineRunRecord;

  constructor(deps: PipelineRecoveryDeps) {
    this.deps = deps;
    this.domain = `${PIPELINE_DOMAIN_PREFIX}${deps.projectId}`;
    this.run = deps.repo.ensureRun(deps.projectId);
    deps.recovery.register({
      domain: this.domain,
      getState: () => deps.machine.snapshot(),
      applyState: (state) => deps.machine.loadSnapshot(state as PipelineStageSnapshot),
    });
  }

  /** 阶段状态变化后调用：立即落一次快照（保证强杀丢失窗口 ≈0） */
  async checkpoint(): Promise<void> {
    await this.deps.recovery.snapshotNow();
  }

  /** 正常退出时调用：清掉 dirty 标记（不删文件，便于回看） */
  async markClean(): Promise<void> {
    await this.deps.recovery.markClean();
  }

  /** 周期兜底快照（接管 CrashRecovery.start 的注册，由外壳统一调度） */
  startPeriodicSnapshot(): void {
    this.deps.recovery.start();
  }

  stopPeriodicSnapshot(): void {
    this.deps.recovery.stop();
  }

  /**
   * 重启恢复主入口。
   * 产物台账从表重建（SQLite 本身就是崩溃安全的），阶段状态从快照恢复。
   */
  async recover(): Promise<RecoverResult> {
    // 1) 产物台账：表 → artifact-store（幂等，重复调用整体覆盖）
    const ledger = this.deps.repo.listArtifacts(this.deps.projectId);
    this.deps.artifacts.hydrate(ledger, {});
    for (const stage of PIPELINE_STAGES) {
      const state = this.deps.machine.stageState(stage);
      const activeVersion = state.activeVersion ?? this.deps.artifacts.activeVersion(stage);
      if (activeVersion > 0) {
        this.deps.machine.restoreStageState({
          ...state,
          activeVersion,
          latestVersion: this.deps.artifacts.latestVersion(stage),
        });
      }
    }

    // 2) 阶段状态：崩溃快照（dirty）优先于干净快照
    const pending = await this.deps.recovery.detectPending();
    const mine = pending.find((envelope) => envelope.domain === this.domain);
    let restoredFromSnapshot = false;
    let savedAt: number | null = null;
    if (mine !== undefined) {
      const applied = this.applyEnvelope(mine);
      restoredFromSnapshot = applied;
      savedAt = applied ? mine.savedAt : null;
    } else {
      // 干净快照（上次正常退出）：仍然恢复进度，但**不算崩溃恢复** ——
      // restoredFromSnapshot 表示"上次是异常退出、存在待恢复的脏快照"，
      // 正常退出若也置 true，UI 会误报"检测到异常退出"。
      await this.deps.recovery.restore(this.domain);
    }

    // 3) 产物文件一致性校验
    const integrityProblems = await this.deps.artifacts.verifyIntegrity();

    const snapshot = this.deps.machine.snapshot();
    const resumeStage = findResumeStage(snapshot);

    // 同步 run 指针行，方便外部查询"这个项目跑到哪儿了"
    const current = this.deps.machine.currentStage();
    this.deps.repo.updateRunPointer(
      this.run.id,
      current,
      snapshot[current].status,
      snapshot[current].activeVersion ?? 0,
    );

    return {
      restoredFromSnapshot,
      savedAt,
      artifactVersions: ledger.length,
      integrityProblems,
      snapshot,
      resumeStage,
    };
  }

  /** 恢复后由 UI 决定丢弃快照（用户选择"重新开始"） */
  async discardSnapshot(): Promise<void> {
    await this.deps.recovery.discard(this.domain);
  }

  private applyEnvelope(envelope: SnapshotEnvelope): boolean {
    const state = envelope.state;
    if (state === null || typeof state !== 'object') return false;
    const snapshot = {} as PipelineStageSnapshot;
    for (const stage of PIPELINE_STAGES) {
      const value = (state as Record<string, unknown>)[stage];
      if (value === undefined || value === null || typeof value !== 'object') {
        snapshot[stage] = blankStageState(stage);
        continue;
      }
      const record = value as Record<string, unknown>;
      snapshot[stage] = {
        stage,
        status:
          typeof record['status'] === 'string'
            ? (record['status'] as PipelineStageSnapshot['S1']['status'])
            : 'pending',
        activeVersion: typeof record['activeVersion'] === 'number' ? record['activeVersion'] : null,
        latestVersion: typeof record['latestVersion'] === 'number' ? record['latestVersion'] : 0,
        skippedAt: typeof record['skippedAt'] === 'number' ? record['skippedAt'] : null,
        updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : 0,
      };
    }
    this.deps.machine.loadSnapshot(snapshot);
    return true;
  }
}

/** 第一个待续生成的阶段：running 优先（断点），其次 stale（重新生成），再次 awaiting_confirm */
function findResumeStage(snapshot: PipelineStageSnapshot): PipelineStage | null {
  for (const stage of STAGE_ORDER) {
    if (snapshot[stage].status === 'running') return stage;
  }
  for (const stage of STAGE_ORDER) {
    if (snapshot[stage].status === 'awaiting_confirm' || snapshot[stage].status === 'stale')
      return stage;
  }
  return null;
}
