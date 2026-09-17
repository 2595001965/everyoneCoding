import { newUlid, nowMs, type PipelineRunRow, type Row, type StageArtifactRow } from '@ec/data';

import type { ArtifactVersion } from './artifact-store';
import { PIPELINE_STAGES, type PipelineStage, type StageStatus } from './stage-defs';
import type { PipelineStageSnapshot, StageState } from './pipeline-machine';

/**
 * 持久化（T5-01 要点 5 / FR-PIPE-11）。
 *
 * 关系与职责：
 * - `pipeline_run`：一个项目一行 run（id 即 runId），stage/status/version 记录"推进到哪儿"；
 *   这里用一个 run 承载全部七阶段（阶段明细在 stage_artifact），run.stage 表示当前活跃阶段；
 * - `stage_artifact`：产物版本台账，每版本一行，content_ref / diff_ref 指向内容文件；
 * - 内存快照（PipelineStageSnapshot）经 {@link serializeState} / {@link parseState} 落在
 *   pipeline_run 的扩展列不行（表结构固定），因此状态快照整体写入 run 行的 status 语义之外，
 *   这里选择**权威来源是两张表 + 恢复快照文件**：表负责产物台账，快照文件（CrashRecovery）
 *   负责阶段状态，二者在 recovery.ts 汇合。
 *
 * 写入全部走 prepared statement，时间戳显式传入（表无 updated_at 的列自动跳过——
 * stage_artifact 没有 updated_at，insert 时给值会被 Repository 层忽略）。
 */

export interface PipelineDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface PipelineRunRecord {
  id: string;
  projectId: string;
  stage: PipelineStage;
  status: StageStatus;
  artifactType: string;
  version: number;
  contentRef: string | null;
  diffRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export class PipelineRepo {
  private readonly db: PipelineDb;

  constructor(db: PipelineDb) {
    this.db = db;
  }

  /* ------------------------------ pipeline_run ------------------------------ */

  /** 创建（或幂等返回）项目的 run 行 */
  ensureRun(projectId: string, now = nowMs()): PipelineRunRecord {
    const existing = this.db
      .prepare('SELECT * FROM pipeline_run WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId) as PipelineRunRow | undefined;
    if (existing !== undefined) return rowToRun(existing);

    const id = newUlid(now);
    this.db
      .prepare(
        `INSERT INTO pipeline_run (id, project_id, stage, status, artifact_type, version, content_ref, diff_ref, created_at, updated_at)
         VALUES (?, ?, 'S1', 'pending', 'requirement_doc', 0, NULL, NULL, ?, ?)`,
      )
      .run(id, projectId, now, now);
    return {
      id,
      projectId,
      stage: 'S1',
      status: 'pending',
      artifactType: 'requirement_doc',
      version: 0,
      contentRef: null,
      diffRef: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getRun(runId: string): PipelineRunRecord | null {
    const row = this.db.prepare('SELECT * FROM pipeline_run WHERE id = ?').get(runId) as PipelineRunRow | undefined;
    return row === undefined ? null : rowToRun(row);
  }

  latestRunForProject(projectId: string): PipelineRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM pipeline_run WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId) as PipelineRunRow | undefined;
    return row === undefined ? null : rowToRun(row);
  }

  /** 同步 run 行的活跃阶段指针（状态本体的存储在快照文件，run 行是查询便利） */
  updateRunPointer(runId: string, stage: PipelineStage, status: StageStatus, version: number, now = nowMs()): void {
    this.db
      .prepare('UPDATE pipeline_run SET stage = ?, status = ?, version = ?, updated_at = ? WHERE id = ?')
      .run(stage, status, version, now, runId);
  }

  /* ------------------------------ stage_artifact ------------------------------ */

  /** 把产物台账写进 stage_artifact（按 id 幂等：同 id 重写说明恢复语义） */
  upsertArtifact(entry: ArtifactVersion, runId: string, projectId: string): void {
    const existing = this.db.prepare('SELECT id FROM stage_artifact WHERE id = ?').get(entryKey(entry)) as
      | { id: string }
      | undefined;
    if (existing !== undefined) {
      this.db
        .prepare(
          'UPDATE stage_artifact SET content_ref = ?, diff_ref = ?, created_at = ? WHERE id = ?',
        )
        .run(entry.contentRef, entry.diffRef, entry.createdAt, entryKey(entry));
      return;
    }
    const row: StageArtifactRow & Row = {
      id: entryKey(entry),
      run_id: runId,
      project_id: projectId,
      stage: entry.stage,
      artifact_type: entry.artifactType,
      version: entry.version,
      content_ref: entry.contentRef,
      diff_ref: entry.diffRef,
      created_at: entry.createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO stage_artifact (id, run_id, project_id, stage, artifact_type, version, content_ref, diff_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.run_id, row.project_id, row.stage, row.artifact_type, row.version, row.content_ref, row.diff_ref, row.created_at);
  }

  listArtifacts(projectId: string): ArtifactVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM stage_artifact WHERE project_id = ? ORDER BY stage ASC, version ASC')
      .all(projectId) as StageArtifactRow[];
    return rows
      .filter((row) => (PIPELINE_STAGES as readonly string[]).includes(row.stage) && row.content_ref !== null)
      .map((row) => ({
        stage: row.stage as PipelineStage,
        artifactType: row.artifact_type as ArtifactVersion['artifactType'],
        version: row.version,
        contentRef: row.content_ref as string,
        diffRef: row.diff_ref,
        createdAt: row.created_at,
        note: '',
      }));
  }

  /* ------------------------------ 状态快照 ------------------------------ */

  /**
   * 阶段状态快照与产物台账分开存：状态快照交给 CrashRecovery（20s 周期，断点续生成），
   * 台账在这里。恢复时 recovery.ts 先读表重建 artifact-store，再叠加快照里的阶段状态。
   */
  serializeState(snapshot: PipelineStageSnapshot): string {
    return JSON.stringify(snapshot);
  }

  parseState(raw: string): PipelineStageSnapshot | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return null;
      const snapshot = {} as PipelineStageSnapshot;
      for (const stage of PIPELINE_STAGES) {
        const value = (parsed as Record<string, unknown>)[stage];
        if (value === undefined || value === null || typeof value !== 'object') continue;
        const record = value as Record<string, unknown>;
        snapshot[stage] = {
          stage,
          status: typeof record['status'] === 'string' ? (record['status'] as StageStatus) : 'pending',
          activeVersion: typeof record['activeVersion'] === 'number' ? record['activeVersion'] : null,
          latestVersion: typeof record['latestVersion'] === 'number' ? record['latestVersion'] : 0,
          skippedAt: typeof record['skippedAt'] === 'number' ? record['skippedAt'] : null,
          updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : 0,
        } satisfies StageState;
      }
      return snapshot;
    } catch {
      return null;
    }
  }
}

function rowToRun(row: PipelineRunRow): PipelineRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    stage: row.stage as PipelineStage,
    status: row.status as StageStatus,
    artifactType: row.artifact_type,
    version: row.version,
    contentRef: row.content_ref,
    diffRef: row.diff_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** stage_artifact 主键：run 内 (stage, version) 唯一 */
function entryKey(entry: ArtifactVersion): string {
  return `sa-${entry.stage}-${entry.version}`;
}
