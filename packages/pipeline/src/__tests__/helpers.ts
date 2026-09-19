import Database from 'better-sqlite3';
import { Migrator } from '@ec/data';
import { CrashRecovery } from '@ec/core';
import type { ShellHost } from '@ec/shell-api';

import type { ArtifactVersion } from '../artifact-store';
import { ArtifactStore } from '../artifact-store';
import { PipelineMachine, blankStageState, type PipelineStageSnapshot } from '../pipeline-machine';
import { PipelineRepo } from '../persistence';
import { PipelineRecovery } from '../recovery';
import { PIPELINE_STAGES, type PipelineStage } from '../stage-defs';

/**
 * T5-01 测试夹具：内存 SQLite + 内存文件系统 + 可控时钟。
 */

export interface MemoryFs {
  files: Map<string, string>;
  writeAtomic(path: string, content: string): Promise<void>;
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export function createMemoryFs(): MemoryFs {
  const files = new Map<string, string>();
  return {
    files,
    async writeAtomic(path, content) {
      files.set(path, content);
    },
    async readText(path) {
      return files.get(path) ?? null;
    },
    async exists(path) {
      if (files.has(path)) return true;
      // 目录语义：任何文件路径的前缀都算"目录存在"。
      // 真实文件系统里 mkdir 会建目录条目；内存 fs 不建模目录，若不这样处理，
      // CrashRecovery.detectPending 的 `exists(dir)` 会误判为"快照目录不存在"而跳过恢复。
      const prefix = path.endsWith('/') ? path : `${path}/`;
      for (const key of files.keys()) if (key.startsWith(prefix)) return true;
      return false;
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

export interface Fixture {
  db: Database.Database;
  fs: MemoryFs;
  machine: PipelineMachine;
  artifacts: ArtifactStore;
  repo: PipelineRepo;
  recovery: PipelineRecovery;
  crash: CrashRecovery;
  events: string[];
  clockValue: { now: number };
  tick(ms: number): void;
  close(): void;
}

/** 满足外键：用户 + 项目 P1（与 @ec/memory 测试夹具同一做法） */
export function seedGraph(db: Database.Database): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO user (id, login, display_name, avatar_ref, role, settings_json, created_at, updated_at)
     VALUES ('U-TEST', 'u-test', '测试用户', NULL, 'owner', NULL, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT OR IGNORE INTO project (id, user_id, workspace_id, name, description, tech_stack_json, status, created_at, updated_at)
     VALUES ('P1', 'U-TEST', NULL, '商城', NULL, NULL, 'active', ?, ?)`,
  ).run(now, now);
}

export function migrationsDir(): string {
  return new URL('../../../data/migrations', import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1',
  );
}

export function createFixture(): Fixture {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  Migrator.fromDirectory(db, migrationsDir()).up();
  seedGraph(db);

  const fs = createMemoryFs();
  const clockValue = { now: 1_700_000_000_000 };
  const clock = (): number => clockValue.now;

  const machine = new PipelineMachine({ projectId: 'P1', clock });
  const repo = new PipelineRepo(db as never);
  // 外壳装配：产物版本落 stage_artifact 表（T5-01 要点 5）。
  // 真实外壳在 Wave 9/10 做同样接线；这里夹具先接上，保证"表是权威"这条断言成立。
  const run = repo.ensureRun('P1');
  const artifacts = new ArtifactStore({
    projectId: 'P1',
    rootDir: 'pipeline/P1',
    fs,
    clock,
    onVersionSaved: (entry) => repo.upsertArtifact(entry, run.id, 'P1'),
  });
  const snapshotDir = 'snapshots';
  const crash = new CrashRecovery({
    shell: {
      path: {
        join: (...parts: string[]) => parts.join('/'),
        sep: '/',
        resolve: (...parts: string[]) => parts.join('/'),
      },
      fs: {
        async exists(path: string) {
          return fs.exists(path);
        },
        async readText(path: string) {
          return (await fs.readText(path)) ?? '';
        },
        async writeAtomic(path: string, data: string | Uint8Array) {
          await fs.writeAtomic(
            path,
            typeof data === 'string' ? data : new TextDecoder().decode(data),
          );
        },
        async remove(path: string) {
          await fs.remove(path);
        },
        async readdir(path: string) {
          const prefix = `${path}/`;
          return [...fs.files.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({
              path: key,
              name: key.slice(prefix.length),
              isFile: true,
              isDirectory: false,
            }));
        },
        async mkdir() {
          return undefined;
        },
      },
    } as unknown as ShellHost,
    dir: snapshotDir,
    intervalMs: 20_000,
  });
  const recovery = new PipelineRecovery({
    projectId: 'P1',
    machine,
    artifacts,
    repo,
    recovery: crash,
  });

  const events: string[] = [];
  machine.bus.onAny('pipeline:*', (event) => {
    events.push(event);
  });

  return {
    db,
    fs,
    machine,
    artifacts,
    repo,
    recovery,
    crash,
    events,
    clockValue,
    tick(ms: number) {
      clockValue.now += ms;
    },
    close() {
      db.close();
    },
  };
}

export function blankSnapshot(): PipelineStageSnapshot {
  const snapshot = {} as PipelineStageSnapshot;
  for (const stage of PIPELINE_STAGES) snapshot[stage] = blankStageState(stage);
  return snapshot;
}

/** 走一遍 S1 生成 → 待确认的常规路径 */
export async function saveS1(
  machine: PipelineMachine,
  artifacts: ArtifactStore,
  content = '# 需求文档 v1',
): Promise<ArtifactVersion> {
  machine.startStage('S1');
  const version = await artifacts.save({
    stage: 'S1',
    artifactType: 'requirement_doc',
    content,
    note: '初始生成',
  });
  machine.submitForReview('S1');
  return version;
}

/** 确认阶段串（S1 一路 confirmed 到 upto；纯状态推进，不产生产物） */
export function confirmThrough(machine: PipelineMachine, upto: PipelineStage): void {
  let previous: PipelineStage | null = null;
  for (const stage of PIPELINE_STAGES) {
    if (previous !== null) machine.advance(previous, stage);
    machine.startStage(stage);
    machine.submitForReview(stage);
    machine.confirm(stage);
    previous = stage;
    if (stage === upto) break;
  }
}
