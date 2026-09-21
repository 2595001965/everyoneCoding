/**
 * E2E-22：流水线生产运行时 —— 从一句需求走到 S5 代码产物，关停重启后从断点继续。
 *
 * 与 E2E-03/19/21 的分工：那几条验的是"阶段语义"（内存端口），这条验的是
 * **真实持久化全链路**：
 * - 真实 SQLite（`@ec/data` 迁移 + `pipeline_run` / `stage_artifact` 表）；
 * - 真实磁盘（工程目录下的产物文件、S4 split.json、S5 生成的 code/ 文件）；
 * - 真实 `@ec/pipeline` 引擎（PipelineMachine / ArtifactStore / S1 / S3 / S4 / S5 / 队列）；
 * - 真实恢复路径（`CrashRecovery` + `PipelineRecovery`：dirty 快照 → 断点）。
 *
 * 端口注入是产品装配方式（见 helpers.ts 的口径），因此这里的假 AI 只负责"回内容"，
 * 不参与任何判定；其余环节全是真件。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CrashRecovery } from '@ec/core';
import { DataClient, Migrator } from '@ec/data';
import type { ShellHost } from '@ec/shell-api';
import {
  ArtifactStore,
  GenerationQueue,
  MultiPlatformGenerator,
  PipelineMachine,
  PipelineRepo,
  PipelineRecovery,
  S1RequirementStage,
  S3TechDocStage,
  defaultChoice,
  deserializeProgress,
  parseSplitFromTechDoc,
  serializeProgress,
  toStackObject,
  validateChoice,
  type ArtifactContentFs,
  type DocumentArchivePort,
  type PipelineStageSnapshot,
  type QueueNode,
  type QueueState,
  type RequirementMemoryPort,
  type S5NodeData,
  type StageGenerationPort,
} from '@ec/pipeline';

import { IDEA_200_CHARS, REQUIREMENT_DOC } from '../helpers';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../packages/data/migrations', import.meta.url));

const TECH_DOC = [
  '# 项目管理系统 技术文档',
  '## 技术选型',
  '目标端：Web（React 18 + Vite）',
  '## 接口设计',
  '```yaml',
  'openapi: 3.0.0',
  '```',
  '### 页面：登录页（p-0）',
  '## 功能：任务管理（f-1）',
  '### 页面：任务列表（p-1）',
  '## 功能：成员协作（f-2）',
  '### 页面：成员详情（p-2）',
].join('\n');

/** 真实磁盘 fs 端口（原子的临时文件 + rename，与外壳一致） */
function diskFs(): ArtifactContentFs {
  return {
    async writeAtomic(path, content) {
      mkdirSync(join(path, '..'), { recursive: true });
      const tmp = `${path}.ec-tmp`;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(tmp, content, 'utf8');
      renameSync(tmp, path);
    },
    async readText(path) {
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
    async exists(path) {
      return existsSync(path);
    },
    async remove(path) {
      if (existsSync(path)) unlinkSync(path);
    },
  };
}

/** CrashRecovery 需要的最小 ShellHost（只用 fs 与 path.join） */
function fakeShell(): ShellHost {
  return {
    path: { join },
    fs: {
      async mkdir(dir: string, options?: { recursive?: boolean }) {
        mkdirSync(dir, options ?? {});
      },
      async writeAtomic(path: string, content: string) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(path, content, 'utf8');
      },
      async exists(path: string) {
        return existsSync(path);
      },
      async readText(path: string) {
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      },
      async remove(path: string) {
        if (existsSync(path)) unlinkSync(path);
      },
      async readdir(dir: string) {
        return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
          isFile: entry.isFile(),
          path: join(dir, entry.name),
        }));
      },
    },
  } as unknown as ShellHost;
}

interface FakeAi {
  generate: StageGenerationPort;
  counts: { s1: number; s3: number; s5: number };
}

function createFakeAi(): FakeAi {
  const counts = { s1: 0, s3: 0, s5: 0 };
  const generate: StageGenerationPort = {
    async generate(prompt) {
      if (prompt.system.includes('需求分析师')) {
        counts.s1 += 1;
        return { content: REQUIREMENT_DOC, degraded: false };
      }
      if (prompt.system.includes('技术架构师')) {
        counts.s3 += 1;
        return { content: TECH_DOC, degraded: false };
      }
      counts.s5 += 1;
      return {
        content: JSON.stringify({
          files: [
            {
              path: `src/feature/gen-${counts.s5 - 1}.ts`,
              content: `export function node${counts.s5 - 1}(): string {\n  return 'ok';\n}\n`,
            },
          ],
          summary: '生成完成',
        }),
        degraded: false,
      };
    },
  };
  return { generate, counts };
}

const memory: RequirementMemoryPort = {
  async getPreferences() {
    return { preferences: [], forbidden: [] };
  },
  async findSimilarProjects() {
    return [];
  },
};

interface Harness {
  machine: PipelineMachine;
  artifacts: ArtifactStore;
  repo: PipelineRepo;
  recovery: PipelineRecovery;
  s1: S1RequirementStage;
  s3: S3TechDocStage;
  ai: FakeAi;
  archive: DocumentArchivePort;
}

let root: string;
let dataDir: string;
let projectRoot: string;
let client: DataClient;
let projectId: string;
let harness: Harness;

/** 装配一套真实域（工程目录 + 磁盘产物 + SQLite 台账 + 官方恢复） */
function buildHarness(existing?: Harness): Harness {
  const ai = createFakeAi();
  const db = client.raw;
  const repo = new PipelineRepo(db);
  const recoveryStore = new CrashRecovery({ shell: fakeShell(), dir: join(dataDir, 'snapshots') });
  const machine = new PipelineMachine({ projectId });
  const artifacts = new ArtifactStore({
    projectId,
    rootDir: join(projectRoot, 'pipeline'),
    fs: diskFs(),
    onVersionSaved: (saved) => repo.upsertArtifact(saved, run.id, projectId),
  });
  const run = repo.ensureRun(projectId);
  const recovery = new PipelineRecovery({
    projectId,
    machine,
    artifacts,
    repo,
    recovery: recoveryStore,
  });

  const docsDir = join(projectRoot, 'docs');
  const archive: DocumentArchivePort = {
    async saveDocument(input) {
      mkdirSync(docsDir, { recursive: true });
      const path = join(docsDir, input.title);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, input.content, 'utf8');
      const existing = db
        .prepare(`SELECT id FROM document WHERE project_id = ? AND title = ?`)
        .get(projectId, input.title) as { id: string } | undefined;
      const documentId = existing?.id ?? `doc-${input.kind}-${input.version}`;
      if (existing === undefined) {
        const now = Date.now();
        db.prepare(
          `INSERT INTO document (id, project_id, kind, title, content_ref, version, format, content_text, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'markdown', ?, ?, ?)`,
        ).run(
          documentId,
          projectId,
          input.kind,
          input.title,
          path,
          input.version,
          input.content,
          now,
          now,
        );
      }
      return { documentId, version: input.version };
    },
    async linkMemory() {
      /* 本用例不验记忆关联 */
    },
    async latestVersion() {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM document WHERE project_id = ? AND kind = ?`)
        .get(projectId, 'techdoc') as { n: number };
      return row.n;
    },
  };

  const next: Harness = {
    machine,
    artifacts,
    repo,
    recovery,
    ai,
    archive,
    s1: new S1RequirementStage({ memory, archive, generate: ai.generate }),
    s3: new S3TechDocStage({
      memory: {
        async getProjectConstraints() {
          const item = existing === undefined ? null : null;
          void item;
          return { declaredStack: null, forbidden: [] };
        },
      },
      archive,
      generate: ai.generate,
    }),
  };
  return next;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-e2e22-'));
  dataDir = join(root, 'data');
  projectRoot = join(root, 'workspace', 'projects', 'P-E2E-22');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  client = DataClient.open({ filePath: join(dataDir, 'everyonecoding.sqlite') });
  Migrator.fromDirectory(client.raw, MIGRATIONS_DIR).up();
  const now = Date.now();
  projectId = 'P-E2E-22';
  client.raw
    .prepare(
      `INSERT INTO user (id, login, display_name, role, created_at, updated_at) VALUES ('U-E2E-22', 'U-E2E-22', '本地用户', 'owner', ?, ?)`,
    )
    .run(now, now);
  client.raw
    .prepare(
      `INSERT INTO project (id, user_id, name, status, created_at, updated_at) VALUES (?, 'U-E2E-22', '项目管理系统', 'active', ?, ?)`,
    )
    .run(projectId, now, now);

  harness = buildHarness();
});

afterEach(() => {
  // beforeEach 早期失败（如原生模块 ABI 不匹配）时 client 可能尚未建成，
  // 这里不能让清理动作抛错掩盖真正的失败原因
  try {
    client.close();
  } catch {
    /* 忽略：真正的失败已由 beforeEach 报告 */
  }
  rmSync(root, { recursive: true, force: true });
});

/** 走完 S1→S4（含选型阻断） */
async function throughS4(): Promise<void> {
  harness.machine.startStage('S1');
  const s1 = await harness.s1.generate({
    userId: 'U-E2E-22',
    projectId,
    projectName: '项目管理系统',
    description: IDEA_200_CHARS,
  });
  expect(s1.completeness.missing).toEqual([]);
  await harness.artifacts.save({
    stage: 'S1',
    artifactType: 'requirement_doc',
    content: s1.content,
  });
  await harness.recovery.checkpoint();

  harness.machine.submitForReview('S1');
  harness.machine.confirm('S1');
  harness.machine.advance('S1', 'S2');
  harness.machine.submitForReview('S2');
  harness.machine.confirm('S2');

  // 未选型 → 阻断进入 S3
  harness.machine.setAdvanceGuard((from, to) =>
    from === 'S2' && to === 'S3' && !choiceSaved ? '请先完成技术选型问卷' : null,
  );
  let choiceSaved = false;
  expect(() => harness.machine.advance('S2', 'S3')).toThrow(/技术选型/);
  expect(harness.machine.statusOf('S3')).toBe('pending');

  // 选型校验通过后写项目记忆 → 放行
  const choice = defaultChoice(['web']);
  expect(validateChoice(choice).ok).toBe(true);
  const stack = toStackObject(choice);
  const now = Date.now();
  client.raw
    .prepare(
      `INSERT INTO memory_item (id, user_id, scope, project_id, title, content, structured, source_type, status, importance, confidence, version, created_at, updated_at)
       VALUES ('mem-tech-choice', 'U-E2E-22', 'project', ?, '技术选型', ?, ?, 'questionnaire', 'active', 4, 1.0, 1, ?, ?)`,
    )
    .run(
      projectId,
      stack.stack,
      JSON.stringify({ choice, stack: stack.stack, targetPlatforms: stack.targetPlatforms }),
      now,
      now,
    );
  choiceSaved = true;
  harness.machine.advance('S2', 'S3');

  const s3 = await harness.s3.generate({
    userId: 'U-E2E-22',
    projectId,
    projectName: '项目管理系统',
    description: IDEA_200_CHARS,
    choice,
    requirementDoc: s1.content,
  });
  await harness.artifacts.save({ stage: 'S3', artifactType: 'tech_doc', content: s3.content });
  harness.machine.submitForReview('S3');
  harness.machine.confirm('S3');
  harness.machine.advance('S3', 'S4');

  const split = parseSplitFromTechDoc(s3.content);
  expect(split.features).toHaveLength(2);
  mkdirSync(join(projectRoot, 'pipeline', 'S4'), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(projectRoot, 'pipeline', 'S4', 'split.json'), JSON.stringify(split), 'utf8');
  harness.machine.submitForReview('S4');
  harness.machine.confirm('S4');
  harness.machine.advance('S4', 'S5');
  // 阶段状态变化后立即落快照（外壳口径：丢失窗口 ≈0）——S5=running 即断点
  await harness.recovery.checkpoint();
}

/**
 * S5 队列：真实 MultiPlatformGenerator + 真实拓扑队列，产物写工程 code/。
 * 传 `progress` 即按已落盘的节点进度装载（断点续生成：成功节点不再调模型）。
 */
async function runS5(progress?: string): Promise<{ state: QueueState; calls: number }> {
  const db = client.raw;
  const techDoc = readFileSync(join(projectRoot, 'pipeline', 'S4', 'split.json'), 'utf8');
  const split = JSON.parse(techDoc) as {
    features: Array<{ id: string; name: string; dependsOn: string[] }>;
    pages: Array<{ id: string; name: string; route: string | null; featureId: string | null }>;
  };
  const generator = new MultiPlatformGenerator({
    generate: harness.ai.generate,
    toolchain: {
      async detect() {
        return false;
      },
      async run() {
        return { ok: false, output: '未安装工具链' };
      },
    },
  });
  const before = harness.ai.counts.s5;
  const nodes: Array<QueueNode<S5NodeData>> = [
    ...split.features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      kind: 'feature' as const,
      dependsOn: feature.dependsOn,
      status: 'pending' as const,
      attempts: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      data: { pageIds: [], platform: 'web', framework: 'react', contractsBlock: '', summary: '' },
    })),
    ...split.pages
      .filter((page) => page.featureId === null)
      .map((page) => ({
        id: page.id,
        name: page.name,
        kind: 'page' as const,
        dependsOn: [],
        status: 'pending' as const,
        attempts: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        data: {
          pageIds: [page.id],
          platform: 'web',
          framework: 'react',
          contractsBlock: '',
          summary: '',
        },
      })),
  ];
  const queue = new GenerationQueue<S5NodeData>({
    executor: async (node) => {
      const result = await generator.generateFor({
        platform: 'web',
        framework: 'react',
        projectName: '项目管理系统',
        stack: '前端：React 18 + Vite',
        requirementDoc: REQUIREMENT_DOC,
        techDoc: TECH_DOC,
        pages: [],
      });
      const codeRoot = join(projectRoot, 'code');
      for (const file of result.files) {
        const target = join(codeRoot, file.path);
        mkdirSync(join(target, '..'), { recursive: true });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(target, file.content, 'utf8');
      }
      if (node.data !== undefined) node.data.summary = `${result.files.length} 个文件`;
    },
  });
  const restored = deserializeProgress<S5NodeData>(progress ?? null, nodes);
  queue.load(restored);
  const state = await queue.run();
  void db;
  return { state, calls: harness.ai.counts.s5 - before };
}

describe('E2E-22 需求 → S1→S5 → 关停重启续跑（真实 SQLite + 真实磁盘 + 官方恢复）', () => {
  it('全链路产物落表落盘；重启后从断点继续且不重复生成已完成节点', async () => {
    await throughS4();

    // 文档入档：document 行 + docs/ 实体文件
    const docs = client.raw
      .prepare(`SELECT title, kind, content_ref FROM document WHERE project_id = ?`)
      .all(projectId) as Array<{ title: string; kind: string; content_ref: string }>;
    expect(docs.map((doc) => doc.kind).sort()).toEqual(['requirement', 'techdoc']);
    for (const doc of docs) expect(existsSync(doc.content_ref)).toBe(true);

    // S5：3 个节点（f-1 / f-2 / 独立页面 p-0）全部成功，代码落 code/ 目录
    const run = await runS5();
    expect(run.state.stats.total).toBe(3);
    expect(run.state.stats.success).toBe(3);
    expect(run.calls).toBe(3);
    const codeFiles = readdirSync(join(projectRoot, 'code', 'src', 'feature'));
    expect(codeFiles).toHaveLength(3);

    // 产物台账落 stage_artifact（S1/S3 各一版）
    const rows = client.raw
      .prepare(`SELECT stage, content_ref FROM stage_artifact WHERE project_id = ?`)
      .all(projectId) as Array<{ stage: string; content_ref: string }>;
    expect(rows.map((row) => row.stage).sort()).toEqual(['S1', 'S3']);
    for (const row of rows) expect(existsSync(row.content_ref)).toBe(true);

    // S5 进度可序列化（断点续生成的前提）
    const progress = JSON.stringify(serializeProgress(run.state));
    expect(JSON.parse(progress).nodes).toHaveLength(3);

    // ---- 正常退出（markClean）→ 重启：恢复阶段状态与台账 ----
    await harness.recovery.markClean();
    client.close();
    client = DataClient.open({ filePath: join(dataDir, 'everyonecoding.sqlite') });
    harness = buildHarness(harness);

    const recovered = await harness.recovery.recover();
    expect(recovered.restoredFromSnapshot).toBe(false); // 正常退出不算崩溃恢复
    expect(recovered.integrityProblems).toEqual([]);
    expect(recovered.artifactVersions).toBe(2);
    expect(recovered.snapshot['S1'].status).toBe('confirmed');
    expect(recovered.snapshot['S4'].status).toBe('confirmed');
    expect(recovered.snapshot['S5'].status).toBe('running');
    expect(recovered.resumeStage).toBe('S5');
    expect(harness.artifacts.list('S1')).toHaveLength(1);

    // 续生成：已完成节点直接跳过（不再调用模型）
    const resumed = deserializeProgress<S5NodeData>(progress, []);
    expect(resumed.map((node) => node.status).every((status) => status === 'success')).toBe(true);
    const resumedRuns = await runS5(progress);
    expect(resumedRuns.state.stats.success).toBe(3);
    expect(resumedRuns.calls).toBe(0);
  });

  it('强杀（未 markClean）后重启：dirty 快照恢复出断点，且找得到待续阶段', async () => {
    await throughS4();
    // 不调 markClean —— 模拟被强杀

    client.close();
    client = DataClient.open({ filePath: join(dataDir, 'everyonecoding.sqlite') });
    const snapshotBefore = harness.machine.snapshot() as PipelineStageSnapshot;
    expect(snapshotBefore['S5'].status).toBe('running');

    harness = buildHarness(harness);
    const recovered = await harness.recovery.recover();

    expect(recovered.restoredFromSnapshot).toBe(true);
    expect(recovered.savedAt).not.toBeNull();
    expect(recovered.snapshot['S1'].status).toBe('confirmed');
    expect(recovered.snapshot['S5'].status).toBe('running');
    expect(recovered.resumeStage).toBe('S5');
  });
});
