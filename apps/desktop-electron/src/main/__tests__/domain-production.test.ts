import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDomainEventSink, type DomainControlServiceHost } from '@ec/shell-api';
import { deserializePageDsl } from '@ec/designer/dsl';

import { openBusinessDb } from '../domain/db';
import { createDomainRuntime } from '../domain/runtime';
import { createWorkspaceDomain } from '../domain/workspace';
import { createProductionDomains, type DomainFactoryContext } from '../domain/domain-factories';

/**
 * 生产端口总装集成测试（T12-01 第 6 条验收）。
 *
 * 全部走**真实** SQLite + 真实工程目录 + 真实域运行时，不做假 IO、不打桩域实现：
 * 断言对象是落盘的 DSL 文件、表里的行、快照文件与跨进程返回的信封。
 *
 * 四个必测点：
 * 1. **真实项目 ID 贯穿**：两个项目各自的设计器数据互不越界；
 * 2. **重启后可重新读取**：换一套运行时（同 dataDir/projectsDir）后数据仍在；
 * 3. **端口错误码映射**：错误经 `createDomainRuntime` 映射为可判定的 code；
 * 4. **并发项目不串数据**：交替写入后各自只看到自己的内容。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;

/** 测试用固定用户：与 `index.ts` 的单机口径一致 */
const USER_ID = 'local-user';

interface InvokeOptions {
  domain: string;
  method: string;
  params?: Record<string, unknown>;
  requestId?: string;
}

function invoke(options: InvokeOptions): Promise<{
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

/** 调一次域方法；失败时抛出带 code 的错误（与渲染层适配器的还原口径一致） */
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

/** 同步口调用（`MemoryApi` / `PipelineApi` 走的正是这条） */
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

/**
 * 装配一套完整的生产域运行时（与主进程 `buildDomainRuntime` 同构）。
 * `events` 可注入以便断言域事件信封。
 */
function buildRuntime(
  database: Database.Database,
  options: { events?: ReturnType<typeof createDomainEventSink> } = {},
): DomainControlServiceHost {
  const ctx: DomainFactoryContext = {
    db: database,
    projectsDir,
    dataDir,
    userId: USER_ID,
    aiStack: null,
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
    ...(options.events !== undefined ? { events: options.events } : {}),
    disposers: production.disposers,
  });
}

/** 建一个真实项目（走 workspace 域：同时落行 + 建工程目录） */
async function newProject(name: string): Promise<string> {
  const created = await call<{ id: string }>({
    domain: 'workspace',
    method: 'createProject',
    params: { input: { name } },
  });
  return created.id;
}

/** 建一页并把内容改成可辨识的样子（模拟"打开设计器并修改"） */
async function createAndModifyPage(
  projectId: string,
  pageName: string,
  route: string,
  marker: string,
): Promise<string> {
  const created = await call<{
    page: {
      id: string;
      name: string;
      route: string;
      platform: string;
      tree: { children: unknown[] };
      state: unknown[];
      events: unknown[];
    };
  }>({
    domain: 'designer',
    method: 'createPage',
    params: { projectId, input: { name: pageName, route, platform: 'web' } },
  });

  const page = created.page;
  page.name = `${pageName}（已修改）`;
  // 加一个可辨识的子元素：重启后据此断言"改过的内容还在"
  page.tree.children = [
    {
      id: `${page.id}-${marker}`,
      type: 'Button',
      name: marker,
      props: { text: marker },
      style: {},
      children: [],
    },
  ];

  await call({
    domain: 'designer',
    method: 'savePage',
    params: { projectId, envelope: { dslVersion: 1, page } },
  });
  // 页面结构摘要写页面记忆（真实精简器 → memory_item）。
  // `dsl` 传的是 PageDsl 本体而不是封套：condensePage 读的是 `dsl.tree`，
  // 传封套会让精简器拿到 undefined（渲染层适配器同此口径）。
  await call({
    domain: 'designer',
    method: 'writePageStructure',
    params: {
      projectId,
      input: { pageId: page.id, pageName: page.name, route: page.route, dsl: page },
    },
  });
  return page.id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-production-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'workspace', 'projects');
  db = openBusinessDb({ dataDir });
  runtime = buildRuntime(db);
});

afterEach(async () => {
  await runtime.dispose();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('createPage 产出的是渲染层可装载的合法 DSL', () => {
  it('信封能通过 @ec/designer 的 deserializePageDsl 校验（zod 全字段）', async () => {
    const a = await newProject('DSL 合法性');
    const envelope = await call<unknown>({
      domain: 'designer',
      method: 'createPage',
      params: { projectId: a, input: { name: '首页', route: '/', platform: 'web' } },
    });

    // 渲染层装载页面的唯一入口：失败就会被静默跳过，最终报「没有可用的页面 DSL」
    const { dsl } = deserializePageDsl(JSON.stringify(envelope));
    expect(dsl.projectId).toBe(a);
    expect(dsl.name).toBe('首页');
    expect(dsl.route).toBe('/');
    expect(dsl.platform).toBe('web');
    expect(dsl.state).toEqual([]);
    expect(dsl.events).toEqual([]);
    expect(dsl.apiDeps).toEqual([]);
    expect(dsl.notes).toEqual([]);
    expect(dsl.anchors).toEqual({});
    expect(dsl.viewport.width).toBeGreaterThan(0);

    // 落盘内容与返回值逐字一致（渲染层不会再读一次文件）
    const file = join(projectsDir, a, 'design', 'pages', `${dsl.id}.dsl.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(envelope)));
  });
});

describe('真实项目 ID 贯穿', () => {
  it('两个项目各自的 DSL 落盘、页面行与页面记忆都归属自己', async () => {
    const a = await newProject('项目甲');
    const b = await newProject('项目乙');

    const pageA = await createAndModifyPage(a, '首页', '/', 'MARKER-A');
    const pageB = await createAndModifyPage(b, '订单页', '/orders', 'MARKER-B');

    // 文件落在各自的工程目录，不越界
    const fileA = join(projectsDir, a, 'design', 'pages', `${pageA}.dsl.json`);
    const fileB = join(projectsDir, b, 'design', 'pages', `${pageB}.dsl.json`);
    expect(existsSync(fileA)).toBe(true);
    expect(existsSync(fileB)).toBe(true);
    expect(existsSync(join(projectsDir, a, 'design', 'pages', `${pageB}.dsl.json`))).toBe(false);

    const envelopeA = JSON.parse(readFileSync(fileA, 'utf8')) as {
      page: { projectId: string; name: string };
    };
    expect(envelopeA.page.projectId).toBe(a);
    expect(envelopeA.page.name).toBe('首页（已修改）');

    // listPages 只列自己项目的页面
    const pagesA = await call<Array<{ pageId: string }>>({
      domain: 'designer',
      method: 'listPages',
      params: { projectId: a },
    });
    expect(pagesA.map((item) => item.pageId)).toEqual([pageA]);

    // 页面行归属正确
    const rows = db.prepare(`SELECT project_id, id FROM page ORDER BY project_id`).all() as Array<{
      project_id: string;
      id: string;
    }>;
    expect(rows).toEqual([
      { project_id: a, id: pageA },
      { project_id: b, id: pageB },
    ]);

    // 页面记忆按 project_id + page_id 归属
    const memories = db
      .prepare(`SELECT project_id, page_id, scope FROM memory_item ORDER BY project_id`)
      .all() as Array<{ project_id: string; page_id: string; scope: string }>;
    expect(memories).toEqual([
      { project_id: a, page_id: pageA, scope: 'page' },
      { project_id: b, page_id: pageB, scope: 'page' },
    ]);
  });

  it('路由总表按项目隔离（模块级 upsertRoutes 走 merge 语义）', async () => {
    const a = await newProject('路由甲');
    const b = await newProject('路由乙');

    await call({
      domain: 'designer',
      method: 'upsertRoutes',
      params: { projectId: a, routes: ['/', '/orders'] },
    });
    await call({
      domain: 'designer',
      method: 'upsertRoutes',
      params: { projectId: b, routes: ['/login'] },
    });

    expect(
      await call<string[]>({ domain: 'designer', method: 'readRoutes', params: { projectId: a } }),
    ).toEqual(['/', '/orders']);
    expect(
      await call<string[]>({ domain: 'designer', method: 'readRoutes', params: { projectId: b } }),
    ).toEqual(['/login']);
  });
});

describe('重启后可重新读取', () => {
  it('设计器 DSL、页面记忆与流水线阶段在换运行时之后依然存在且互不串', async () => {
    const a = await newProject('持久甲');
    const b = await newProject('持久乙');
    const pageA = await createAndModifyPage(a, '首页', '/', 'KEEP-A');
    const pageB = await createAndModifyPage(b, '首页', '/', 'KEEP-B');

    // 只推进 A 的流水线：S1 跑完并确认
    await call({ domain: 'pipeline', method: 'startStage', params: { projectId: a, stage: 'S1' } });
    await call({
      domain: 'pipeline',
      method: 'submitForReview',
      params: { projectId: a, stage: 'S1' },
    });
    await call({ domain: 'pipeline', method: 'confirm', params: { projectId: a, stage: 'S1' } });

    // —— 模拟进程重启：换一套运行时（同一 dataDir / projectsDir）——
    await runtime.dispose();
    db.close();
    db = openBusinessDb({ dataDir });
    runtime = buildRuntime(db);

    // DSL 仍在，且是"改过"的那份
    const reloadedA = await call<{
      page: { name: string; tree: { children: Array<{ name: string }> } };
    }>({ domain: 'designer', method: 'loadPage', params: { projectId: a, pageId: pageA } });
    expect(reloadedA.page.name).toBe('首页（已修改）');
    expect(reloadedA.page.tree.children.map((child) => child.name)).toEqual(['KEEP-A']);

    const reloadedB = await call<{ page: { tree: { children: Array<{ name: string }> } } }>({
      domain: 'designer',
      method: 'loadPage',
      params: { projectId: b, pageId: pageB },
    });
    expect(reloadedB.page.tree.children.map((child) => child.name)).toEqual(['KEEP-B']);

    // 页面记忆按项目重新读得到（同步口）
    const memoriesA = callSync<Array<{ projectId: string }>>({
      domain: 'memory',
      method: 'list',
      params: { userId: USER_ID, projectId: a, query: {} },
    });
    expect(memoriesA).toHaveLength(1);
    expect(memoriesA[0]?.projectId).toBe(a);

    // 流水线阶段从快照恢复：A 停在 S1 confirmed，B 未开始
    const snapshotA = callSync<{ S1: { status: string } }>({
      domain: 'pipeline',
      method: 'snapshot',
      params: { projectId: a },
    });
    expect(snapshotA.S1.status).toBe('confirmed');

    const snapshotB = callSync<{ S1: { status: string } }>({
      domain: 'pipeline',
      method: 'snapshot',
      params: { projectId: b },
    });
    expect(snapshotB.S1.status).toBe('pending');
  });
});

describe('端口错误码映射（经域运行时）', () => {
  it('未知方法映射为 INVALID_ARGUMENT', async () => {
    const response = await invoke({ domain: 'designer', method: '不存在的放法' });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('缺少 projectId 与项目不存在分别映射 INVALID_ARGUMENT / NOT_FOUND', async () => {
    await expect(
      call({ domain: 'designer', method: 'listPages', params: {} }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await expect(
      call({ domain: 'designer', method: 'listPages', params: { projectId: 'no-such-project' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('页面不存在映射为 NOT_FOUND', async () => {
    const a = await newProject('错误码');
    await expect(
      call({ domain: 'designer', method: 'loadPage', params: { projectId: a, pageId: 'nope' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('AI 栈未装配时生成类方法如实报 NOT_SUPPORTED（不伪造结果）', async () => {
    const a = await newProject('无AI栈');
    await expect(
      call({
        domain: 'designer',
        method: 'generatePage',
        params: { projectId: a, request: { prompt: '登录页' } },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });

    await expect(
      call({
        domain: 'pipeline',
        method: 'generateRequirement',
        params: { projectId: a, description: '一个商城' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('memory 的 importCommit 在没有预览缓存时报 NOT_FOUND（不静默成功）', async () => {
    await expect(
      call({
        domain: 'memory',
        method: 'importCommit',
        params: { userId: USER_ID, decisions: [] },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('同步域通道（invokeSync）', () => {
  it('memory / pipeline 的同步方法经同步口返回真实数据', async () => {
    const a = await newProject('同步口');
    await createAndModifyPage(a, '首页', '/', 'SYNC-OK');

    const listed = callSync<Array<{ projectId: string }>>({
      domain: 'memory',
      method: 'list',
      params: { userId: USER_ID, projectId: a, query: {} },
    });
    expect(listed).toHaveLength(1);

    const snapshot = callSync<{ S1: { status: string } }>({
      domain: 'pipeline',
      method: 'snapshot',
      params: { projectId: a },
    });
    expect(snapshot.S1.status).toBe('pending');

    // 同步写后立刻同步读：拿到的必须是新状态（这正是同步端口存在的理由）
    callSync({ domain: 'pipeline', method: 'startStage', params: { projectId: a, stage: 'S1' } });
    expect(
      callSync<{ S1: { status: string } }>({
        domain: 'pipeline',
        method: 'snapshot',
        params: { projectId: a },
      }).S1.status,
    ).toBe('running');
  });

  it('同步口只放行白名单方法：未登记同步口的域与异步生成类都如实拒绝', async () => {
    const a = await newProject('同步白名单');

    // pipeline 域有同步口，但 generateRequirement 不在同步白名单内 → INVALID_ARGUMENT
    const gated = runtime.invokeSync({
      requestId: 's1',
      domain: 'pipeline',
      method: 'generateRequirement',
      params: { projectId: a, description: 'x' },
    });
    expect(gated.ok).toBe(false);
    expect(gated.error?.code).toBe('INVALID_ARGUMENT');
    expect(gated.error?.message).toContain('同步白名单');

    // designer 域整体没有同步白名单条目 → 同样拒绝（不会退化成"随便调哪个方法都行"）
    const noSync = runtime.invokeSync({
      requestId: 's2',
      domain: 'designer',
      method: 'listPages',
      params: { projectId: a },
    });
    expect(noSync.ok).toBe(false);
    expect(noSync.error?.code).toBe('INVALID_ARGUMENT');
    expect(noSync.error?.message).toContain('designer');
  });

  it('白名单内但未装配同步路由的域报 NOT_SUPPORTED（渲染层据此不注入同步端口）', async () => {
    // 刻意不传 syncRouters：模拟"域装配了、同步口没装配"的外壳
    const withoutSync = createDomainRuntime({
      routers: { workspace: createWorkspaceDomain({ db, dataDir, projectsDir }).router },
    });
    const response = withoutSync.invokeSync({
      requestId: 's3',
      domain: 'memory',
      method: 'list',
      params: { userId: USER_ID, projectId: null, query: {} },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('NOT_SUPPORTED');
    await withoutSync.dispose();
  });

  it('经同步口产生的状态变化事件仍按 requestId 下发（sync 路由拿到 ctx）', async () => {
    const a = await newProject('同步事件');
    const events = createDomainEventSink();
    const seen: Array<{ requestId: string; payload: unknown }> = [];
    events.register('sync-req-1', (event) =>
      seen.push({ requestId: event.requestId, payload: event.payload }),
    );

    await runtime.dispose();
    runtime = buildRuntime(db, { events });

    const response = runtime.invokeSync({
      requestId: 'sync-req-1',
      domain: 'pipeline',
      method: 'startStage',
      params: { projectId: a, stage: 'S1' },
    });
    expect(response.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toMatchObject({ type: 'pipeline:stage-event', event: 'start' });
  });
});

describe('并发项目不串数据', () => {
  it('交替写入两个项目：目录、台账、阶段产物与记忆各归其主', async () => {
    const a = await newProject('并发甲');
    const b = await newProject('并发乙');

    // 交替保存产物与页面
    const pageA = await createAndModifyPage(a, '甲页', '/a', 'CONC-A');
    const pageB = await createAndModifyPage(b, '乙页', '/b', 'CONC-B');

    await call({
      domain: 'pipeline',
      method: 'saveArtifact',
      params: { projectId: a, stage: 'S1', artifactType: 'requirement_doc', content: 'A 的需求' },
    });
    await call({
      domain: 'pipeline',
      method: 'saveArtifact',
      params: { projectId: b, stage: 'S1', artifactType: 'requirement_doc', content: 'B 的需求' },
    });
    await call({
      domain: 'pipeline',
      method: 'saveArtifact',
      params: {
        projectId: a,
        stage: 'S1',
        artifactType: 'requirement_doc',
        content: 'A 的需求 v2',
      },
    });

    // 台账条数各自独立
    const artifactsA = callSync<Array<{ version: number }>>({
      domain: 'pipeline',
      method: 'listArtifacts',
      params: { projectId: a, stage: 'S1' },
    });
    const artifactsB = callSync<Array<{ version: number }>>({
      domain: 'pipeline',
      method: 'listArtifacts',
      params: { projectId: b, stage: 'S1' },
    });
    expect(artifactsA).toHaveLength(2);
    expect(artifactsB).toHaveLength(1);

    // 内容不串：A 读到的是自己的 v2
    const contentA = await call<string>({
      domain: 'pipeline',
      method: 'readArtifact',
      params: { projectId: a, stage: 'S1', version: 2 },
    });
    expect(contentA).toBe('A 的需求 v2');
    const contentB = await call<string>({
      domain: 'pipeline',
      method: 'readArtifact',
      params: { projectId: b, stage: 'S1', version: 1 },
    });
    expect(contentB).toBe('B 的需求');

    // 产物文件物理上也在各自的工程目录。
    // 真实布局是「平坦 + 阶段前缀」：`<projectId>/pipeline/s1-<前缀>-v<n>.md`，
    // 不按阶段分子目录（ArtifactStore.contentPath 的口径，改布局会破坏已生成产物）。
    const dirA = join(projectsDir, a, 'pipeline');
    const dirB = join(projectsDir, b, 'pipeline');
    const markdownA = readdirSync(dirA).filter(
      (name) => name.startsWith('s1-') && name.endsWith('.md'),
    );
    const markdownB = readdirSync(dirB).filter(
      (name) => name.startsWith('s1-') && name.endsWith('.md'),
    );
    expect(markdownA).toHaveLength(2);
    expect(markdownB).toHaveLength(1);
    // 内容不跨项目：A 的目录里不会出现 B 的文本
    expect(
      markdownA
        .map((name) => readFileSync(join(dirA, name), 'utf8'))
        .some((text) => text.includes('B 的需求')),
    ).toBe(false);

    // 只推进 A：B 不受影响。
    // 合法序列是 running → awaiting_confirm → confirmed（confirm 不接受 running，
    // 这是状态机的真实约束，不是可以顺手放宽的实现细节）。
    callSync({ domain: 'pipeline', method: 'startStage', params: { projectId: a, stage: 'S1' } });
    callSync({
      domain: 'pipeline',
      method: 'submitForReview',
      params: { projectId: a, stage: 'S1' },
    });
    callSync({ domain: 'pipeline', method: 'confirm', params: { projectId: a, stage: 'S1' } });
    expect(
      callSync<{ S1: { status: string } }>({
        domain: 'pipeline',
        method: 'snapshot',
        params: { projectId: a },
      }).S1.status,
    ).toBe('confirmed');
    expect(
      callSync<{ S1: { status: string } }>({
        domain: 'pipeline',
        method: 'snapshot',
        params: { projectId: b },
      }).S1.status,
    ).toBe('pending');

    // 记忆各一条（页面记忆）
    const memoriesA = callSync<Array<{ pageId: string | null }>>({
      domain: 'memory',
      method: 'list',
      params: { userId: USER_ID, projectId: a, query: {} },
    });
    const memoriesB = callSync<Array<{ pageId: string | null }>>({
      domain: 'memory',
      method: 'list',
      params: { userId: USER_ID, projectId: b, query: {} },
    });
    expect(memoriesA.map((item) => item.pageId)).toEqual([pageA]);
    expect(memoriesB.map((item) => item.pageId)).toEqual([pageB]);
  });
});

describe('describe 如实上报', () => {
  it('已装配的域报 available=true，未装配的域带原因报 false', async () => {
    const descriptors = await runtime.describe();
    const byKind = new Map(descriptors.map((item) => [item.kind, item]));

    for (const kind of [
      'workspace',
      'memory',
      'pipeline',
      'git',
      'preview',
      'rename',
      'package',
      'usage',
      'ai-context',
      'code',
      'nav',
      'designer',
    ]) {
      expect(byKind.get(kind as never)?.available, `${kind} 应装配`).toBe(true);
    }

    // 本套运行时没有装配 docs / auth / settings：必须如实报不可用并给出原因
    for (const kind of ['docs', 'auth', 'settings']) {
      const descriptor = byKind.get(kind as never);
      expect(descriptor?.available).toBe(false);
      expect(descriptor?.reason).toBeTruthy();
    }
  });
});
