import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDomainEventSink,
  type DomainControlServiceHost,
  type DomainEvent,
} from '@ec/shell-api';
import { defaultChoice, type QueueState, type SplitResult } from '@ec/pipeline';

import { openBusinessDb } from '../domain/db';
import { createDomainRuntime } from '../domain/runtime';
import { createWorkspaceDomain } from '../domain/workspace';
import {
  createProductionDomains,
  type AiStackHandle,
  type DomainFactoryContext,
} from '../domain/domain-factories';

/**
 * 流水线生产运行时集成测试（T12-03 验收第 1/2/3 条）。
 *
 * 全部走真实 SQLite + 真实工程目录 + 真实域运行时 + 真实 @ec/pipeline 引擎：
 * 断言对象是磁盘上的产物文件、表里的行（document / doc_version / memory_item /
 * stage_artifact / pipeline_run）、快照文件、队列状态与跨进程返回的信封。
 * 唯一的替身是 AI 网关（本机不可能有真模型），且它只回内容、不参与任何判定。
 *
 * 覆盖：
 * 1. S1→S5 全链路（含 S3 选型阻断）+ 关停重启后续跑（断点、activeVersion、台账一致）；
 * 2. S5 单节点失败不阻塞其余节点；
 * 3. 阶段版本回看 / diff / 回退 / 下游 stale。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;

const USER_ID = 'local-user';

/** 八项要素齐全的需求文档（S1 产物样例） */
const REQUIREMENT_DOC = [
  '# 项目管理系统 需求文档',
  '## 项目背景',
  '小团队需要一个轻量项目管理系统。',
  '## 目标用户',
  '独立开发者与小团队。',
  '## 功能清单',
  '- P0：任务管理',
  '- P1：成员协作',
  '## 用户故事',
  '- 作为成员，我希望创建任务，以便跟踪进度。',
  '## 业务流程图',
  '```mermaid',
  'flowchart TD',
  '    A[创建任务] --> B[分配成员]',
  '```',
  '## 验收标准',
  '- [ ] 任务列表可加载',
  '## 非功能要求',
  '- 必须有单元测试',
  '## 风险与假设',
  '- 假设：需求以描述为准。',
].join('\n');

/**
 * 技术文档：标题约定即拆分依据。
 * - `### 页面：登录页（p-0）` 在所有 `## 功能` 之前 → 归属 null → 独立页面节点；
 * - f-2 `- 依赖：f-1` → 生成 f-2 时才会去取 f-1 的接口契约（FR-PIPE-10）。
 */
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
  '- 依赖：f-1',
  '### 页面：成员详情（p-2）',
].join('\n');

interface FakeAi {
  handle: AiStackHandle;
  counts: { s1: number; s3: number; s5: number };
  /** S5 每次生成时给模型的用户消息（断言契约注入用） */
  s5Prompts: string[];
}

/**
 * 假 AI 网关：只按提示词特征回内容。
 *
 * - S5 走 `MultiPlatformGenerator` 的提示词（含 `## 输出契约`）→ 回 JSON 文件清单；
 * - S3 提示词（系统角色含「技术架构师」）→ 回技术文档；
 * - S1（「需求分析师」）→ 回需求文档。
 * `s5FailAt` 指定第几次 S5 调用抛错（用于验证单节点失败不阻塞）。
 */
function createFakeAi(options: { s5FailAt?: number } = {}): FakeAi {
  const counts = { s1: 0, s3: 0, s5: 0 };
  const s5Prompts: string[] = [];
  const handle: AiStackHandle = {
    gateway: {
      chat(input) {
        const whole = input.messages.map((message) => message.content).join('\n');
        const system = input.messages.find((message) => message.role === 'system')?.content ?? '';
        // 按系统角色判阶段：S1/S3 与 S5 的提示词都含"输出契约"字样，不能用它区分
        const isS3 = system.includes('技术架构师');
        const isS1 = system.includes('需求分析师');
        const isS5 = system.includes('工程生成器');
        return (async function* generate() {
          if (isS5) {
            const index = counts.s5;
            counts.s5 += 1;
            s5Prompts.push(whole);
            if (options.s5FailAt === index) {
              yield { type: 'error', error: '模拟模型故障' };
              return;
            }
            yield {
              type: 'chunk',
              text: JSON.stringify({
                files: [
                  {
                    path: `src/feature/gen-${index}.ts`,
                    content: `export interface Node${index}Dto {\n  id: string;\n}\n\nexport function node${index}(input: Node${index}Dto): string {\n  return input.id;\n}\n`,
                  },
                ],
                summary: `节点 ${index} 生成完成`,
              }),
            };
            return;
          }
          if (isS3) {
            counts.s3 += 1;
            yield { type: 'chunk', text: TECH_DOC };
            return;
          }
          if (isS1) {
            counts.s1 += 1;
            yield { type: 'chunk', text: REQUIREMENT_DOC };
            return;
          }
          yield { type: 'chunk', text: '# 兜底输出' };
        })();
      },
    },
  };
  return { handle, counts, s5Prompts };
}

interface InvokeOptions {
  domain: string;
  method: string;
  params?: Record<string, unknown>;
  requestId?: string;
}

async function invoke(options: InvokeOptions): Promise<{
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}> {
  return runtime.invoke({
    requestId: options.requestId ?? 'test',
    domain: options.domain as never,
    method: options.method,
    params: options.params ?? {},
  });
}

/** 调一次异步域方法；失败时抛出带 code 的错误（与渲染层适配器还原口径一致） */
async function call<T>(options: InvokeOptions): Promise<T> {
  const response = await invoke(options);
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & {
      code?: string | undefined;
    };
    error.code = response.error?.code;
    throw error;
  }
  return response.result as T;
}

/** 同步口调用（`PipelineApi` 的同步签名方法走的正是这条） */
function callSync<T>(options: InvokeOptions): T {
  const response = runtime.invokeSync({
    requestId: options.requestId ?? 'test-sync',
    domain: options.domain as never,
    method: options.method,
    params: options.params ?? {},
  });
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & {
      code?: string | undefined;
    };
    error.code = response.error?.code;
    throw error;
  }
  return response.result as T;
}

/** 装配一套完整的生产域运行时（与主进程 `buildDomainRuntime` 同构） */
function buildRuntime(
  database: Database.Database,
  aiStack: AiStackHandle | null,
  events?: ReturnType<typeof createDomainEventSink>,
): DomainControlServiceHost {
  const ctx: DomainFactoryContext = {
    db: database,
    projectsDir,
    dataDir,
    userId: USER_ID,
    aiStack,
    // T12-04：受控进程与 DPAPI 凭据不注入（域内如实降级，不伪造成功）
    process: null,
    credentials: null,
    emit: () => {
      // 非请求来源事件（code 域外部改动监视器）在本套用例里不产生
    },
  };
  const production = createProductionDomains(ctx);
  return createDomainRuntime({
    routers: {
      workspace: createWorkspaceDomain({ db: database, dataDir, projectsDir }).router,
      ...production.routers,
    },
    syncRouters: production.syncRouters,
    ...(events !== undefined ? { events } : {}),
    disposers: production.disposers,
  });
}

async function newProject(name: string): Promise<string> {
  const created = await call<{ id: string }>({
    domain: 'workspace',
    method: 'createProject',
    params: { input: { name } },
  });
  return created.id;
}

interface PipelineCallOptions {
  projectId: string;
  method: string;
  params?: Record<string, unknown>;
}

const p = <T>(options: PipelineCallOptions): Promise<T> =>
  call<T>({
    domain: 'pipeline',
    method: options.method,
    params: { projectId: options.projectId, ...(options.params ?? {}) },
  });

const pSync = <T>(options: PipelineCallOptions): T =>
  callSync<T>({
    domain: 'pipeline',
    method: options.method,
    params: { projectId: options.projectId, ...(options.params ?? {}) },
  });

/** 推进某阶段：开始 → 提交待确认 → 确认 */
async function runStage(projectId: string, stage: string): Promise<void> {
  await p({ projectId, method: 'startStage', params: { stage } });
  await p({ projectId, method: 'submitForReview', params: { stage } });
  await p({ projectId, method: 'confirm', params: { stage } });
}

/** 走完 S1→S4 的产物链路（S3 前完成技术选型，S5 交给调用方） */
async function prepareThroughS4(projectId: string, projectName: string): Promise<void> {
  await pSync({ projectId, method: 'initProject' });

  const s1 = await p<{ content: string }>({
    projectId,
    method: 'generateRequirement',
    params: { userId: USER_ID, projectName, description: '做一个轻量项目管理系统' },
  });
  await p({
    projectId,
    method: 'saveArtifact',
    params: {
      stage: 'S1',
      artifactType: 'requirement_doc',
      content: s1.content,
      note: '初始生成',
    },
  });
  await runStage(projectId, 'S1');
  await p({ projectId, method: 'advance', params: { from: 'S1', to: 'S2' } });

  await p({
    projectId,
    method: 'saveArtifact',
    params: {
      stage: 'S2',
      artifactType: 'design_dsl',
      content: JSON.stringify({ pages: ['p-1'] }),
    },
  });
  await runStage(projectId, 'S2');

  // 未完成选型 → 阻断进入 S3（FR-PIPE-13）
  await expect(
    p({ projectId, method: 'advance', params: { from: 'S2', to: 'S3' } }),
  ).rejects.toThrow(/技术选型/);
  expect(
    pSync<Record<string, { status: string }>>({ projectId, method: 'snapshot' })['S3']?.status,
  ).toBe('pending');

  // 选型结果写项目记忆 → 放行
  await p({ projectId, method: 'saveTechChoice', params: { choice: defaultChoice(['web']) } });
  await p({ projectId, method: 'advance', params: { from: 'S2', to: 'S3' } });

  const s3 = await p<{ content: string; title: string; version: number }>({
    projectId,
    method: 'generateTechDoc',
    params: {
      userId: USER_ID,
      projectName,
      description: '做一个轻量项目管理系统',
      choice: defaultChoice(['web']),
      requirementDoc: s1.content,
    },
  });
  await p({
    projectId,
    method: 'saveArtifact',
    params: {
      stage: 'S3',
      artifactType: 'tech_doc',
      content: s3.content,
      note: '初始生成',
    },
  });
  await runStage(projectId, 'S3');
  await p({ projectId, method: 'advance', params: { from: 'S3', to: 'S4' } });

  const split = await p<SplitResult>({
    projectId,
    method: 'generateSplit',
    params: { techDocVersion: 1 },
  });
  await p({ projectId, method: 'saveSplit', params: { split } });
  await runStage(projectId, 'S4');
  await p({ projectId, method: 'advance', params: { from: 'S4', to: 'S5' } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-pipeline-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'workspace', 'projects');
  db = openBusinessDb({ dataDir });
  runtime = buildRuntime(db, null);
});

afterEach(async () => {
  await runtime.dispose();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('S3 阻断与选型落库', () => {
  it('未完成技术选型不得进入 S3；选型结果写进项目记忆（重启后仍生效）', async () => {
    const ai = createFakeAi();
    runtime = buildRuntime(db, ai.handle);
    const projectId = await newProject('选型阻断');
    await prepareThroughS4(projectId, '选型阻断');

    // 选型进 memory_item（scope=project，title=技术选型，structured 内含 choice/stack）
    const row = db
      .prepare(
        `SELECT title, scope, content, structured FROM memory_item
         WHERE project_id = ? AND title = '技术选型' AND status = 'active'`,
      )
      .get(projectId) as
      { title: string; scope: string; content: string; structured: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.scope).toBe('project');
    expect(JSON.parse(row?.structured ?? '{}')).toMatchObject({
      targetPlatforms: ['web'],
    });
    // 同步口读回的选型与写入一致（渲染层就是这么读的）
    const choice = pSync<{ targets: string[]; frontend: string } | null>({
      projectId,
      method: 'getTechChoice',
    });
    expect(choice?.targets).toEqual(['web']);

    // 重启后 guard 依然认得这次选型
    await runtime.dispose();
    db.close();
    db = openBusinessDb({ dataDir });
    runtime = buildRuntime(db, createFakeAi().handle);
    expect(
      pSync<{ targets: string[] } | null>({ projectId, method: 'getTechChoice' })?.targets,
    ).toEqual(['web']);
  });
});

describe('S1→S5 全链路 + 关停重启续跑', () => {
  it('产物落官方位置、台账可回看，重启后从上次阶段继续且不重复生成已完成节点', async () => {
    const events = createDomainEventSink();
    const ai = createFakeAi();
    runtime = buildRuntime(db, ai.handle, events);
    const seen: DomainEvent[] = [];
    events.register('test', (event) => seen.push(event));

    const projectId = await newProject('流水线甲');
    await prepareThroughS4(projectId, '流水线甲');

    // ---- 文档入档：document / doc_version 行 + docs/<title> 实体文件 ----
    const docs = db
      .prepare(`SELECT title, kind, version, content_ref FROM document WHERE project_id = ?`)
      .all(projectId) as Array<{
      title: string;
      kind: string;
      version: number;
      content_ref: string;
    }>;
    expect(docs.some((doc) => doc.kind === 'requirement')).toBe(true);
    expect(docs.some((doc) => doc.kind === 'techdoc')).toBe(true);
    for (const doc of docs) {
      expect(existsSync(doc.content_ref)).toBe(true);
    }
    expect(readdirSync(join(projectsDir, projectId, 'docs')).length).toBeGreaterThanOrEqual(2);

    // ---- 产物台账落 stage_artifact（走官方 PipelineRepo）----
    const artifacts = db
      .prepare(`SELECT stage, version, content_ref FROM stage_artifact WHERE project_id = ?`)
      .all(projectId) as Array<{ stage: string; version: number; content_ref: string }>;
    expect(artifacts.map((row) => row.stage).sort()).toEqual(['S1', 'S2', 'S3', 'S4']);
    for (const row of artifacts) expect(existsSync(row.content_ref)).toBe(true);

    // ---- S5：真实多端生成器 + 队列，产物写工程 code/ 目录 ----
    const requirementDoc = await p<string>({
      projectId,
      method: 'readArtifact',
      params: { stage: 'S1', version: 1 },
    });
    const techDoc = await p<string>({
      projectId,
      method: 'readArtifact',
      params: { stage: 'S3', version: 1 },
    });
    const split = pSync<SplitResult>({ projectId, method: 'getSplit' });
    const run = await p<{ state: QueueState; results: Record<string, { status: string }> }>({
      projectId,
      method: 'runGeneration',
      params: {
        projectName: '流水线甲',
        choice: defaultChoice(['web']),
        requirementDoc,
        techDoc,
        split,
      },
    });

    // 3 个节点 = 功能 f-1 / 功能 f-2 / 独立页面 p-0
    expect(run.state.stats.total).toBe(3);
    expect(run.state.stats.success).toBe(3);
    expect(run.state.stats.failed).toBe(0);
    for (const node of run.state.nodes) {
      expect(run.results[node.id]?.status).toBe('success');
      // 编译校验：web 框架无内置工具链定义 → 如实标注"未编译校验"，不假装通过
      const summary = (node.data as { summary?: string } | undefined)?.summary ?? '';
      expect(summary).toContain('个文件');
      expect(summary).toContain('未编译校验');
    }

    const codeDir = join(projectsDir, projectId, 'code');
    const generated = readdirSync(join(codeDir, 'src', 'feature'));
    expect(generated.length).toBe(3);

    // 域事件进度：至少一条 pipeline:progress 描述了节点完成
    expect(
      seen.some(
        (event) =>
          (event.payload as { type?: string; message?: string }).type === 'pipeline:progress' &&
          /完成（\d+ 个文件/.test(String((event.payload as { message?: string }).message ?? '')),
      ),
    ).toBe(true);

    // ---- 契约注入（FR-PIPE-10）：依赖 f-1 的 f-2 提示词里出现 f-1 的接口签名，且不含函数体 ----
    // 注意：契约块标题恒存在（无契约时写明"无已生成依赖"），所以按签名定位而不是按标题
    const downstreamPrompt = ai.s5Prompts.find((prompt) =>
      prompt.includes('export function node0'),
    );
    expect(downstreamPrompt).toBeDefined();
    expect(downstreamPrompt).toContain('## 依赖接口契约');
    expect(downstreamPrompt).toContain('export function node0(input: Node0Dto): string');
    // 只注入签名，不注入实现
    expect(downstreamPrompt).not.toContain('return input.id;');
    // 无依赖的节点（首个 executed 的 f-1）拿不到自己的契约
    expect(ai.s5Prompts[0]).not.toContain('export function node0');

    const progressBeforeRestart = pSync<{ s5Progress: string | null; resumeStage: string | null }>({
      projectId,
      method: 'getResumeProgress',
    });
    expect(progressBeforeRestart.s5Progress).not.toBeNull();
    expect(progressBeforeRestart.resumeStage).toBe('S5');

    // ---- 关停 → 重启（换一套 runtime，同 dataDir / projectsDir）----
    await runtime.dispose();
    db.close();
    db = openBusinessDb({ dataDir });
    const revivedAi = createFakeAi();
    runtime = buildRuntime(db, revivedAi.handle);

    const recovered = await p<{
      snapshot: Record<string, { status: string; activeVersion: number | null }>;
      resumeStage: string | null;
      integrityProblems: unknown[];
      unexpectedExit: boolean;
      artifactVersions: number;
    }>({ projectId, method: 'recoverProject' });

    expect(recovered.integrityProblems).toEqual([]);
    // 正常关停（dispose 把快照标干净）不该被当成异常退出
    expect(recovered.unexpectedExit).toBe(false);
    expect(recovered.artifactVersions).toBe(4);
    expect(recovered.resumeStage).toBe('S5');
    expect(recovered.snapshot['S1']?.status).toBe('confirmed');
    expect(recovered.snapshot['S4']?.status).toBe('confirmed');
    // activeVersion 必须与关停前一致
    expect(recovered.snapshot['S3']?.activeVersion).toBe(1);

    // 断点进度重启后可取回（否则"续生成"无从谈起）
    const resumedProgress = pSync<{ s5Progress: string | null }>({
      projectId,
      method: 'getResumeProgress',
    });
    expect(resumedProgress.s5Progress).toBe(progressBeforeRestart.s5Progress);

    // ---- 从断点续跑：已完成节点不再调用模型 ----
    const secondRun = await p<{ state: QueueState }>({
      projectId,
      method: 'runGeneration',
      params: {
        projectName: '流水线甲',
        choice: defaultChoice(['web']),
        requirementDoc,
        techDoc,
        split,
        resumeProgress: resumedProgress.s5Progress,
      },
    });
    expect(secondRun.state.stats.success).toBe(3);
    expect(revivedAi.counts.s5).toBe(0);

    // 重启后版本可回看（读的是磁盘上的产物文件）
    expect(
      await p<string>({ projectId, method: 'readArtifact', params: { stage: 'S1', version: 1 } }),
    ).toBe(requirementDoc);
  });
});

describe('S5 单节点失败不阻塞其余节点', () => {
  it('第 2 个节点生成失败，其余节点照常产出并落盘', async () => {
    const ai = createFakeAi({ s5FailAt: 1 });
    runtime = buildRuntime(db, ai.handle);
    const projectId = await newProject('节点隔离');
    await prepareThroughS4(projectId, '节点隔离');

    const run = await p<{ state: QueueState }>({
      projectId,
      method: 'runGeneration',
      params: {
        projectName: '节点隔离',
        choice: defaultChoice(['web']),
        requirementDoc: REQUIREMENT_DOC,
        techDoc: TECH_DOC,
        split: pSync<SplitResult>({ projectId, method: 'getSplit' }),
      },
    });

    expect(run.state.stats.failed).toBe(1);
    expect(run.state.stats.success).toBe(2);
    const failed = run.state.nodes.find((node) => node.status === 'failed');
    expect(failed?.error).toContain('模拟模型故障');
    // 失败的节点可单独重试（重试后补齐）
    const afterRetry = await p<QueueState>({
      projectId,
      method: 'retryNode',
      params: { nodeId: failed?.id },
    });
    expect(afterRetry.stats.success).toBe(3);
    expect(afterRetry.stats.failed).toBe(0);
  });
});

describe('阶段版本回看 / diff / 回退 / 下游 stale', () => {
  it('同阶段多版本可回看与回退，回退后下游标记 stale', async () => {
    runtime = buildRuntime(db, createFakeAi().handle);
    const projectId = await newProject('版本回看');
    // 先走完 S1→S4（下游非 pending 才有"stale 可标记"的前提）
    await prepareThroughS4(projectId, '版本回看');

    await p({
      projectId,
      method: 'saveArtifact',
      params: {
        stage: 'S1',
        artifactType: 'requirement_doc',
        content: `${REQUIREMENT_DOC}\n\n## 追加要求\n- P2：甘特图`,
        note: '追加要求：补 P2',
      },
    });

    const versions = pSync<Array<{ version: number; note: string }>>({
      projectId,
      method: 'listArtifacts',
      params: { stage: 'S1' },
    });
    expect(versions.map((entry) => entry.version)).toEqual([1, 2]);

    // v2 相对 v1 的 diff 可读；v1 没有 diff
    const diff = await p<string | null>({
      projectId,
      method: 'readDiff',
      params: { stage: 'S1', version: 2 },
    });
    expect(diff).toContain('+ ## 追加要求');
    expect(
      await p<string | null>({
        projectId,
        method: 'readDiff',
        params: { stage: 'S1', version: 1 },
      }),
    ).toBeNull();

    // 回退到 v1：只改生效指针，历史版本不删除
    pSync({ projectId, method: 'switchVersion', params: { stage: 'S1', version: 1 } });
    const snapshot = pSync<Record<string, { activeVersion: number | null; latestVersion: number }>>(
      {
        projectId,
        method: 'snapshot',
      },
    );
    expect(snapshot['S1']?.activeVersion).toBe(1);
    expect(snapshot['S1']?.latestVersion).toBe(2);
    expect(
      pSync<unknown[]>({ projectId, method: 'listArtifacts', params: { stage: 'S1' } }).length,
    ).toBe(2);

    // 下游 stale：S2 起全部标记 stale（回退的可见后果）
    const stale = pSync<string[]>({
      projectId,
      method: 'applyDownstreamStale',
      params: { stage: 'S1' },
    });
    expect(stale).toContain('S2');
    const after = pSync<Record<string, { status: string }>>({ projectId, method: 'snapshot' });
    expect(after['S2']?.status).toBe('stale');
    expect(after['S1']?.status).not.toBe('stale');
  });
});

describe('异常退出识别（dirty 快照语义）', () => {
  it('未经 dispose 的关停留下 dirty 快照 → 恢复时如实标记上次异常退出', async () => {
    const ai = createFakeAi();
    runtime = buildRuntime(db, ai.handle);
    const projectId = await newProject('异常退出');
    await prepareThroughS4(projectId, '异常退出');

    // 模拟崩溃：直接丢弃运行时与库连接，不给 dispose 机会（快照仍是 dirty）
    db.close();
    db = openBusinessDb({ dataDir });
    runtime = buildRuntime(db, null);

    const recovered = await p<{ unexpectedExit: boolean; resumeStage: string | null }>({
      projectId,
      method: 'recoverProject',
    });
    expect(recovered.unexpectedExit).toBe(true);
    // 断点仍然准确：异常退出不丢阶段状态
    expect(recovered.resumeStage).toBe('S5');
  });
});
