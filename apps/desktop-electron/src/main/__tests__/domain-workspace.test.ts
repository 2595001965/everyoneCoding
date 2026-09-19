import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findTemplate, type RequirementDigest } from '@ec/core';
import type { DomainControlServiceHost } from '@ec/shell-api';

import { openBusinessDb } from '../domain/db';
import { createDomainRuntime } from '../domain/runtime';
import { createWorkspaceDomain, validateProjectLayout } from '../domain/workspace';

/**
 * workspace 域运行时测试（真实 SQLite + 真实工程目录，不做假 IO）。
 *
 * 覆盖真实语义而非渲染结果：建项目要同时落行与建目录、回收站是软删除、
 * 彻底删除要级联清行并删目录、复制要真的搬行与搬文件、仪表盘要真的从表里聚合。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await runtime.invoke({ requestId: 'test', domain: 'workspace', method, params });
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & { code?: string | undefined };
    error.code = response.error?.code;
    throw error;
  }
  return response.result as T;
}

async function newProject(name: string): Promise<{ id: string; name: string }> {
  return call('createProject', { input: { name } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-workspace-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'workspace', 'projects');
  db = openBusinessDb({ dataDir });
  runtime = createDomainRuntime({
    routers: { workspace: createWorkspaceDomain({ db, dataDir, projectsDir }).router },
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('项目 CRUD 与工程目录', () => {
  it('createProject 同时落库行与建出工程目录结构', async () => {
    const created = await newProject('演示项目');
    expect(created.id).toBeTruthy();

    const layout = validateProjectLayout(projectsDir, created.id);
    expect(layout.ok).toBe(true);
    expect(layout.missing).toEqual([]);

    const listed = await call<Array<{ id: string }>>('listProjects', { query: { view: 'active' } });
    expect(listed.map((item) => item.id)).toEqual([created.id]);
  });

  it('同名项目被拒（ALREADY_EXISTS）', async () => {
    await newProject('重名');
    await expect(newProject('重名')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('空名被拒（INVALID_ARGUMENT）', async () => {
    await expect(newProject('   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('getProject 不存在时返回 null（不是抛错）', async () => {
    await expect(call('getProject', { id: 'missing' })).resolves.toBeNull();
  });

  it('updateProject 改名；改成已存在的名字被拒', async () => {
    const a = await newProject('项目A');
    await newProject('项目B');
    const renamed = await call<{ name: string }>('updateProject', { id: a.id, patch: { name: '项目A2' } });
    expect(renamed.name).toBe('项目A2');
    await expect(call('updateProject', { id: a.id, patch: { name: '项目B' } })).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });

  it('markOpened 刷新最近打开时间，可被 recentLimit 取到', async () => {
    const a = await newProject('甲');
    await newProject('乙');
    await call('markOpened', { id: a.id });
    const recent = await call<Array<{ id: string }>>('listProjects', { query: { recentLimit: 1 } });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.id).toBe(a.id);
  });

  it('listProjects 支持搜索', async () => {
    await newProject('登陆页改造');
    await newProject('支付流程');
    const found = await call<Array<{ name: string }>>('listProjects', { query: { search: '支付' } });
    expect(found.map((item) => item.name)).toEqual(['支付流程']);
  });
});

describe('归档与回收站', () => {
  it('归档后从 active 消失、出现在 archived', async () => {
    const a = await newProject('待归档');
    await call('archiveProject', { id: a.id });
    expect(await call<unknown[]>('listProjects', { query: { view: 'active' } })).toHaveLength(0);
    expect(await call<unknown[]>('listProjects', { query: { view: 'archived' } })).toHaveLength(1);

    await call('unarchiveProject', { id: a.id });
    expect(await call<unknown[]>('listProjects', { query: { view: 'active' } })).toHaveLength(1);
  });

  it('删除是软删除：进回收站，可恢复', async () => {
    const a = await newProject('要删的');
    await call('moveToRecycleBin', { id: a.id });
    expect(await call<unknown[]>('listProjects', { query: { view: 'active' } })).toHaveLength(0);
    expect(await call<unknown[]>('listProjects', { query: { view: 'recycleBin' } })).toHaveLength(1);
    // 仍能按 id 查到（软删除不丢行）
    expect(await call<{ id: string } | null>('getProject', { id: a.id })).not.toBeNull();

    await call('restoreFromRecycleBin', { id: a.id });
    expect(await call<unknown[]>('listProjects', { query: { view: 'active' } })).toHaveLength(1);
  });

  it('purgeProject 级联清行并删掉工程目录', async () => {
    const a = await newProject('彻底删除');
    const now = Date.now();
    db.prepare(
      `INSERT INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at)
       VALUES ('p1', ?, NULL, '首页', '/', NULL, ?, ?)`,
    ).run(a.id, now, now);
    db.prepare(
      `INSERT INTO element (id, page_id, parent_id, type, name, props_json, style_json, feature_ref, note_id, order_index, anchor_json, created_at, updated_at)
       VALUES ('e1', 'p1', NULL, 'Button', '主按钮', NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
    ).run(now, now);
    expect(existsSync(join(projectsDir, a.id))).toBe(true);

    await call('purgeProject', { id: a.id });

    expect(await call('getProject', { id: a.id })).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM page WHERE project_id = ?`).get(a.id)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM element WHERE id = 'e1'`).get()).toEqual({ n: 0 });
    expect(existsSync(join(projectsDir, a.id))).toBe(false);
  });

  it('cleanupExpiredRecycleBin 只清超期项，返回清理数量', async () => {
    const expired = await newProject('超期');
    const fresh = await newProject('刚删');
    await call('moveToRecycleBin', { id: expired.id });
    await call('moveToRecycleBin', { id: fresh.id });
    // 把其中一条的删除时间改到 31 天前。
    // 注意：ProjectService 内部有行缓存，绕开它直接改库后必须换一个**新实例**再清，
    // 否则服务读到的仍是旧缓存（这不是缺陷，是缓存的正常语义）。
    db.prepare(`UPDATE project SET deleted_at = ? WHERE id = ?`).run(Date.now() - 31 * 24 * 60 * 60 * 1000, expired.id);
    const freshRuntime = createDomainRuntime({
      routers: { workspace: createWorkspaceDomain({ db, dataDir, projectsDir }).router },
    });
    const cleanup = async (): Promise<number> => {
      const response = await freshRuntime.invoke({
        requestId: 't2',
        domain: 'workspace',
        method: 'cleanupExpiredRecycleBin',
        params: {},
      });
      return response.result as number;
    };

    await expect(cleanup()).resolves.toBe(1);
    expect(await call('getProject', { id: expired.id })).toBeNull();
    expect(await call('getProject', { id: fresh.id })).not.toBeNull();
  });
});

describe('复制项目', () => {
  it('按选项搬运设计/记忆/文档/代码，并回传各项计数', async () => {
    const source = await newProject('原件');
    const now = Date.now();
    const sourceDir = join(projectsDir, source.id);
    mkdirSync(join(sourceDir, 'code', 'src'), { recursive: true });
    writeFileSync(join(sourceDir, 'code', 'src', 'index.ts'), 'export const a = 1;');
    mkdirSync(join(sourceDir, 'design', 'pages'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'design', 'pages', 'home.dsl.json'),
      JSON.stringify({ dslVersion: 1, page: { platform: 'web' } }),
    );

    db.prepare(
      `INSERT INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at)
       VALUES ('pg1', ?, NULL, '首页', '/', NULL, ?, ?)`,
    ).run(source.id, now, now);
    db.prepare(
      `INSERT INTO element (id, page_id, parent_id, type, name, props_json, style_json, feature_ref, note_id, order_index, anchor_json, created_at, updated_at)
       VALUES ('el1', 'pg1', NULL, 'Button', '提交', NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO memory_item (id, user_id, scope, project_id, title, content, tags, source_type, confidence, importance, status, pinned, version, created_at, updated_at)
       VALUES ('m1', 'local-user', 'project', ?, '技术选型', '用 React', '[]', 'manual', 1.0, 3, 'active', 0, 1, ?, ?)`,
    ).run(source.id, now, now);
    db.prepare(
      `INSERT INTO document (id, project_id, kind, title, content_ref, version, created_at, updated_at, format, content_text, sections_json, source_ref, deleted_at, ignored_version)
       VALUES ('d1', ?, 'requirement', '需求文档', NULL, 1, ?, ?, 'markdown', '正文', NULL, NULL, NULL, NULL)`,
    ).run(source.id, now, now);

    const result = await call<{ project: { id: string; name: string }; copied: Record<string, number> }>(
      'duplicateProject',
      { id: source.id, options: { includeDesign: true, includeMemory: true, includeDocs: true, includeCode: true } },
    );

    expect(result.project.name).toBe('原件-副本');
    expect(result.copied).toEqual({ design: 2, memory: 1, docs: 1, codeFiles: 1 });
    expect(existsSync(join(projectsDir, result.project.id, 'code', 'src', 'index.ts'))).toBe(true);
    expect(validateProjectLayout(projectsDir, result.project.id).ok).toBe(true);
  });

  it('不勾选任何资源时只复制项目行', async () => {
    const source = await newProject('空复制');
    const result = await call<{ copied: Record<string, number> }>('duplicateProject', {
      id: source.id,
      options: { includeDesign: false, includeMemory: false, includeDocs: false, includeCode: false },
    });
    expect(result.copied).toEqual({ design: 0, memory: 0, docs: 0, codeFiles: 0 });
  });
});

describe('文档摘要导入（createFromDigest）', () => {
  const digest: RequirementDigest = {
    title: '登录系统需求',
    summary: '支持邮箱登录与找回密码',
    features: [
      { name: '邮箱登录', description: '支持大小写不敏感', line: 3, section: '功能' },
      { name: '找回密码', description: '邮件验证码', line: 4, section: '功能' },
    ],
    pageCandidates: [{ name: '登录页', route: '/login', line: 6, section: '页面' }],
    nonFunctional: ['响应时间 < 1s'],
    memoryDrafts: [{ scope: 'project', title: '登录约定', content: '邮箱不区分大小写', tags: ['登录'] }],
    warnings: [],
  };

  it('落项目 + 功能 + 页面 + 项目记忆，并标记来源为 doc_import', async () => {
    const created = await call<{ id: string; sourceKind: string }>('createFromDigest', {
      input: { digest, name: '登录系统' },
    });
    expect(created.sourceKind).toBe('doc_import');

    expect(db.prepare(`SELECT COUNT(*) AS n FROM feature WHERE project_id = ?`).get(created.id)).toEqual({ n: 2 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM page WHERE project_id = ?`).get(created.id)).toEqual({ n: 1 });
    const memory = db
      .prepare(`SELECT scope, title FROM memory_item WHERE project_id = ?`)
      .all(created.id) as Array<{ scope: string; title: string }>;
    expect(memory).toEqual([{ scope: 'project', title: '登录约定' }]);
    expect(validateProjectLayout(projectsDir, created.id).ok).toBe(true);
  });
});

describe('仪表盘聚合', () => {
  it('五项指标从表里真实聚合；无数据时为 0 而不是崩', async () => {
    const created = await newProject('看板');
    const metrics = await call<{
      memory: { total: number; byScope: Record<string, number> };
      pages: { total: number; byPlatform: Record<string, number> };
      features: { done: number; total: number; completion: number };
      usage: { periodTokens: number; totalTokens: number };
      git: { recent: unknown[] };
      computeMs: number;
    }>('getDashboardMetrics', { projectId: created.id });

    expect(metrics.memory).toEqual({ total: 0, byScope: {} });
    expect(metrics.pages).toEqual({ total: 0, byPlatform: {} });
    expect(metrics.features).toEqual({ done: 0, total: 0, completion: 0 });
    expect(metrics.usage.totalTokens).toBe(0);
    expect(metrics.git.recent).toEqual([]);
    expect(metrics.computeMs).toBeGreaterThanOrEqual(0);
  });

  it('记忆按 scope 分组、功能完成度按 done 计算、页面按 DSL 平台分组、用量按模型聚合', async () => {
    const created = await newProject('有数据');
    const now = Date.now();
    const insertMemory = db.prepare(
      `INSERT INTO memory_item (id, user_id, scope, project_id, title, content, tags, source_type, confidence, importance, status, pinned, version, created_at, updated_at)
       VALUES (?, 'local-user', ?, ?, 't', 'c', '[]', 'manual', 1.0, 3, 'active', 0, 1, ?, ?)`,
    );
    insertMemory.run('m1', 'project', created.id, now, now);
    insertMemory.run('m2', 'project', created.id, now, now);
    insertMemory.run('m3', 'longterm', null, now, now);

    const insertFeature = db.prepare(
      `INSERT INTO feature (id, project_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    );
    insertFeature.run('f1', created.id, '已完成', 'done', now, now);
    insertFeature.run('f2', created.id, '未开始', 'planned', now, now);

    db.prepare(
      `INSERT INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at) VALUES ('pg1', ?, NULL, '首页', '/', NULL, ?, ?)`,
    ).run(created.id, now, now);
    const designDir = join(projectsDir, created.id, 'design', 'pages');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'home.dsl.json'), JSON.stringify({ dslVersion: 1, page: { platform: 'web' } }));
    writeFileSync(join(designDir, 'list.dsl.json'), JSON.stringify({ dslVersion: 1, page: { platform: 'android' } }));
    // 非法平台名不应被计入（避免把脏数据当端）
    writeFileSync(join(designDir, 'x.dsl.json'), JSON.stringify({ dslVersion: 1, page: { platform: '往坏里写' } }));

    // model_id 是外键，这里不造 provider/model 行，走"未标注"分组（同时验证 COALESCE 分支）
    db.prepare(
      `INSERT INTO usage_record (id, user_id, provider_id, model_id, project_id, prompt_tokens, completion_tokens, total_tokens, cost, created_at)
       VALUES ('u1', 'local-user', NULL, NULL, ?, 10, 20, 30, 0.5, ?)`,
    ).run(created.id, now);

    const metrics = await call<{
      memory: { total: number; byScope: Record<string, number> };
      pages: { total: number; byPlatform: Record<string, number> };
      features: { done: number; total: number; completion: number };
      usage: { periodTokens: number; totalTokens: number; totalCost: number; byModel: Array<{ modelId: string }> };
    }>('getDashboardMetrics', { projectId: created.id });

    expect(metrics.memory.total).toBe(2);
    expect(metrics.memory.byScope).toEqual({ project: 2 });
    expect(metrics.pages.total).toBe(1);
    expect(metrics.pages.byPlatform).toEqual({ web: 1, android: 1 });
    expect(metrics.features).toEqual({ done: 1, total: 2, completion: 0.5 });
    expect(metrics.usage.totalTokens).toBe(30);
    expect(metrics.usage.periodTokens).toBe(30);
    expect(metrics.usage.totalCost).toBeCloseTo(0.5);
    expect(metrics.usage.byModel.map((row) => row.modelId)).toEqual(['未标注']);
  });

  it('getMetricDetail 按指标给出可下钻的行', async () => {
    const created = await newProject('下钻');
    const now = Date.now();
    db.prepare(
      `INSERT INTO feature (id, project_id, name, description, status, created_at, updated_at) VALUES ('f1', ?, '登录', NULL, 'planned', ?, ?)`,
    ).run(created.id, now, now);

    const detail = await call<{ key: string; title: string; rows: Array<{ label: string; refId?: string }> }>(
      'getMetricDetail',
      { projectId: created.id, key: 'features' },
    );
    expect(detail.key).toBe('features');
    expect(detail.rows).toEqual([{ label: '登录', value: 'planned', refId: 'f1' }]);

    // git 明细当前如实为空（git 能力未装配）
    await expect(call('getMetricDetail', { projectId: created.id, key: 'git' })).resolves.toEqual({
      key: 'git',
      title: '最近提交',
      rows: [],
    });
  });
});

describe('阶段与缩略图', () => {
  it('无流水线记录时 getProjectStage 返回 null', async () => {
    const created = await newProject('未进流水线');
    await expect(call('getProjectStage', { projectId: created.id })).resolves.toBeNull();
  });

  it('有流水线记录时回传阶段与确认计数', async () => {
    const created = await newProject('在流水线');
    const now = Date.now();
    const insertRun = db.prepare(
      `INSERT INTO pipeline_run (id, project_id, stage, status, artifact_type, version, content_ref, diff_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'doc', 1, NULL, NULL, ?, ?)`,
    );
    insertRun.run('r1', created.id, 'S1', 'confirmed', now, now);
    insertRun.run('r2', created.id, 'S2', 'running', now + 1, now + 1);

    await expect(call('getProjectStage', { projectId: created.id })).resolves.toEqual({
      stage: 'S2',
      status: 'running',
      confirmed: 1,
      total: 2,
    });
  });

  it('getThumbnailUrl 如实返回 null（未装配缩略图生成器）', async () => {
    const created = await newProject('缩略图');
    await expect(call('getThumbnailUrl', { projectId: created.id })).resolves.toBeNull();
  });
});

describe('按模板新建项目（createFromTemplate）', () => {
  it('用真实模板建项目：来源/目标端/技术栈来自模板，页面数与模板一致', async () => {
    const template = findTemplate('tpl-web-admin');
    expect(template, '模板常量里应有 tpl-web-admin').not.toBeNull();

    const created = await call<{
      id: string;
      sourceKind: string;
      sourceRef: string | null;
      targetPlatforms: string[];
    }>('createFromTemplate', { input: { templateId: 'tpl-web-admin', name: '后台管理' } });

    expect(created.sourceKind).toBe('template');
    expect(created.sourceRef).toBe('tpl-web-admin');
    expect(created.targetPlatforms).toEqual(template?.targetPlatforms);

    // 页面数与模板一致，且都指向 DSL 文件
    const pages = db
      .prepare(`SELECT id, name, route, dsl_ref FROM page WHERE project_id = ?`)
      .all(created.id) as Array<{ id: string; name: string; route: string; dsl_ref: string }>;
    expect(pages).toHaveLength(template?.pages.length ?? 0);
    for (const page of pages) {
      expect(page.dsl_ref).toBe(`${page.id}.dsl.json`);
    }
    expect(validateProjectLayout(projectsDir, created.id).ok).toBe(true);
  });

  it('初始 DSL 是设计器可解析的真 DSL（封套 + 平台 + 元素树），且文件确实落盘', async () => {
    const created = await call<{ id: string }>('createFromTemplate', {
      input: { templateId: 'tpl-landing', name: '落地页' },
    });

    const pagesDir = join(projectsDir, created.id, 'design', 'pages');
    const files = readdirSync(pagesDir).filter((name) => name.endsWith('.dsl.json'));
    const pages = db.prepare(`SELECT COUNT(*) AS n FROM page WHERE project_id = ?`).get(created.id) as { n: number };
    expect(files.length).toBe(pages.n);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const envelope = JSON.parse(readFileSync(join(pagesDir, file), 'utf8')) as {
        dslVersion: number;
        page: { id: string; projectId: string; platform: string; route: string; tree: { children?: unknown[] } };
      };
      // 封套与版本号：设计器 load 回来必须认
      expect(envelope.dslVersion).toBeGreaterThan(0);
      expect(envelope.page.projectId).toBe(created.id);
      // 平台必须是七端之一（脏值会让仪表盘的按端分组漏计）
      expect(['web', 'android', 'ios', 'harmonyos', 'windows', 'linux', 'macos']).toContain(envelope.page.platform);
      // 树上有元素（模板页面不是空的）
      expect((envelope.page.tree.children?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it('模板记忆草稿与页面备注都落成记忆条目', async () => {
    const template = findTemplate('tpl-mobile-app');
    expect(template).not.toBeNull();
    const created = await call<{ id: string }>('createFromTemplate', {
      input: { templateId: 'tpl-mobile-app', name: '移动端应用' },
    });

    const memories = db
      .prepare(`SELECT scope, title FROM memory_item WHERE project_id = ?`)
      .all(created.id) as Array<{ scope: string; title: string }>;
    const expectedDrafts = template?.memoryDrafts.length ?? 0;
    const notedPages = (template?.pages ?? []).filter((page) => page.note.trim().length > 0).length;
    // 页面级备注（scope='page'）+ 模板草稿（scope='project'/'feature'）
    expect(memories.length).toBe(expectedDrafts + notedPages);
    expect(memories.filter((item) => item.scope === 'page').length).toBe(notedPages);
  });

  it('模板不存在时如实报 NOT_FOUND', async () => {
    await expect(call('createFromTemplate', { input: { templateId: 'no-such', name: 'x' } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(call('createFromTemplate', { input: { templateId: 'no-such', name: 'x' } })).rejects.toThrowError(
      /模板不存在/,
    );
  });
});

describe('暂未实现的方法如实报错', () => {
  it('（已全部实现）保留此分组以便后续新增归口说明', () => {
    expect(true).toBe(true);
  });
});
