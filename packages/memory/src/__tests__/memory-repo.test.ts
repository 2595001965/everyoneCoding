import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConflictError, newUlid } from '@ec/data';

import { MemoryRepo } from '../repo/memory-repo';
import { MemoryStateError } from '../domain/memory-item';
import { layerOf } from '../domain/scope';
import { ProjectMemoryService } from '../service/project-memory';
import { PageMemoryService } from '../service/page-memory';
import { FeatureMemoryService } from '../service/feature-memory';
import { IssueMemoryService } from '../service/issue-memory';
import { createEmptyDb, seedGraph, TEST_GRAPH, type TestDb } from './helpers';

let handle: TestDb;
let repo: MemoryRepo;
const USER = TEST_GRAPH.userId;

beforeEach(() => {
  handle = createEmptyDb();
  repo = new MemoryRepo(handle.db);
  // memory_item 的归属列都有外键，先铺好用户/项目/功能/页面/元素
  seedGraph(handle.db);
});

afterEach(() => {
  handle.close();
});

describe('MemoryRepo CRUD 与乐观锁', () => {
  it('五层条目均可创建并读回（结构化 / 标签 / 归属完整往返）', () => {
    const item = repo.create({
      userId: USER,
      scope: 'page',
      projectId: 'P1',
      featureId: 'F1',
      pageId: 'PG1',
      title: '登录页 /login',
      content: '卡片式布局',
      structured: { skeleton: 'Container[Card[Form]]', state: ['phone', 'password'] },
      tags: ['page', 'login'],
      sourceType: 'auto_design',
      confidence: 0.88,
      importance: 4,
    });

    const loaded = repo.findById(item.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.structured).toEqual({
      skeleton: 'Container[Card[Form]]',
      state: ['phone', 'password'],
    });
    expect(loaded?.tags).toEqual(['page', 'login']);
    expect(loaded?.importance).toBe(4);
    expect(loaded?.confidence).toBeCloseTo(0.88);
    expect(layerOf(loaded!)).toBe('page');
  });

  it('乐观锁：用过期 version 更新抛 ConflictError，用最新 version 成功', () => {
    const item = repo.create({
      userId: USER,
      scope: 'longterm',
      title: '命名规范',
      content: '小驼峰',
    });
    expect(item.version).toBe(1);

    const v2 = repo.update(item.id, { content: '小驼峰（组件用大驼峰）' }, 1);
    expect(v2.version).toBe(2);

    expect(() => repo.update(item.id, { content: '过期写入' }, 1)).toThrow(ConflictError);
    const v3 = repo.update(item.id, { content: '第三次' }, 2);
    expect(v3.version).toBe(3);
    expect(repo.findById(item.id)?.content).toBe('第三次');
  });

  it('归属不合法直接拒绝写入', () => {
    expect(() =>
      repo.create({ userId: USER, scope: 'longterm', title: '非法', projectId: 'P1' }),
    ).toThrow(/project_id 必须为空/);
    expect(() => repo.create({ userId: USER, scope: 'project', title: '缺项目' })).toThrow(
      /必须指定 project_id/,
    );
  });

  it('列表按层级/标签/关键字过滤，count 与 list 一致', () => {
    repo.create({ userId: USER, scope: 'longterm', title: '全局规范', tags: ['convention'] });
    repo.create({
      userId: USER,
      scope: 'project',
      projectId: 'P1',
      title: '路由总表',
      tags: ['routes'],
    });
    repo.create({
      userId: USER,
      scope: 'page',
      projectId: 'P1',
      pageId: 'PG1',
      title: '登录页',
      tags: ['page'],
    });
    repo.create({
      userId: USER,
      scope: 'page',
      projectId: 'P1',
      pageId: 'PG1',
      elementId: 'E1',
      title: '提交按钮',
      tags: ['page', 'element-note'],
    });

    expect(repo.count({ userId: USER })).toBe(4);
    expect(repo.list({ userId: USER, scopes: ['longterm'] })).toHaveLength(1);
    expect(repo.list({ userId: USER, layers: ['element'] })).toHaveLength(1);
    expect(repo.list({ userId: USER, layers: ['page'] })).toHaveLength(1);
    expect(repo.list({ userId: USER, tags: ['page'] })).toHaveLength(2);
    expect(repo.list({ userId: USER, text: '登录' })).toHaveLength(1);
    expect(repo.countByLayer(USER, 'P1').map((entry) => entry.layer)).toEqual([
      'longterm',
      'project',
      'page',
      'element',
    ]);
    // 不传 projectId 时只统计跨项目的长期记忆
    expect(repo.countByLayer(USER).map((entry) => entry.layer)).toEqual(['longterm']);
  });
});

describe('状态机', () => {
  it('active → archived → active 合法；superseded → archived 被拒绝，显式声明可放行', () => {
    const item = repo.create({
      userId: USER,
      scope: 'project',
      projectId: 'P1',
      title: '架构摘要',
    });
    expect(repo.setStatus(item.id, 'archived').status).toBe('archived');
    expect(repo.setStatus(item.id, 'active').status).toBe('active');
    expect(repo.setStatus(item.id, 'superseded').status).toBe('superseded');
    expect(() => repo.setStatus(item.id, 'archived')).toThrow(MemoryStateError);
    expect(repo.setStatus(item.id, 'archived', { explicit: true }).status).toBe('archived');
  });

  it('问题记忆 unsolved → solved → mitigated 合法；solved → unsolved 需显式 reopen', () => {
    const issue = repo.create({
      userId: USER,
      scope: 'issue',
      projectId: 'P1',
      pageId: 'PG1',
      issueId: 'ISSUE-1',
      title: '刷新丢 Session',
      content: '现象：刷新后跳登录页',
      issueStatus: 'unsolved',
    });

    expect(repo.setIssueStatus(issue.id, 'solved').issueStatus).toBe('solved');
    expect(repo.setIssueStatus(issue.id, 'mitigated').issueStatus).toBe('mitigated');
    expect(() => repo.setIssueStatus(issue.id, 'unsolved')).toThrow(MemoryStateError);
    expect(repo.setIssueStatus(issue.id, 'unsolved', { explicit: true }).issueStatus).toBe(
      'unsolved',
    );
  });

  it('非问题记忆不允许设置处置状态', () => {
    const item = repo.create({
      userId: USER,
      scope: 'project',
      projectId: 'P1',
      title: '架构摘要',
    });
    expect(() => repo.setIssueStatus(item.id, 'solved')).toThrow(/不是问题记忆/);
  });

  it('解决并归档时同步把未解决落为已规避，避免"已归档仍显示未解决"', () => {
    const issue = repo.create({
      userId: USER,
      scope: 'issue',
      projectId: 'P1',
      pageId: 'PG1',
      issueId: 'ISSUE-2',
      title: '拖拽卡顿',
    });
    const archived = repo.resolveIssue(issue.id, 'unsolved', { archive: true });
    expect(archived.status).toBe('archived');
    expect(archived.issueStatus).toBe('mitigated');
  });
});

describe('上下文解析（结合数据库）', () => {
  it('resolveContext 自动携带上层并过滤其他项目', () => {
    repo.create({ userId: USER, scope: 'longterm', title: '全局规范', content: '统一 ULID 主键' });
    repo.create({
      userId: USER,
      scope: 'project',
      projectId: 'P1',
      title: '项目架构',
      content: 'React',
    });
    repo.create({
      userId: USER,
      scope: 'project',
      projectId: 'P2',
      title: '别的项目',
      content: 'Vue',
    });
    repo.create({
      userId: USER,
      scope: 'page',
      projectId: 'P1',
      pageId: 'PG1',
      title: '登录页',
      content: '卡片',
    });

    const resolved = repo.resolveContext({ projectId: 'P1', pageId: 'PG1' }, { userId: USER });
    expect(resolved.effective.map((item) => item.title).sort()).toEqual([
      '全局规范',
      '登录页',
      '项目架构',
    ]);
    expect(resolved.effective.some((item) => item.title === '别的项目')).toBe(false);
  });

  it('归档条目默认不进入上下文，includeInactive 时可见', () => {
    const archived = repo.create({
      userId: USER,
      scope: 'longterm',
      title: '过时规范',
      content: '旧',
    });
    repo.setStatus(archived.id, 'archived');
    expect(repo.resolveContext({ projectId: '' }, { userId: USER }).effective).toHaveLength(0);
    expect(
      repo.resolveContext({ projectId: '' }, { userId: USER, includeInactive: true }).effective,
    ).toHaveLength(1);
  });
});

describe('分层服务', () => {
  it('项目记忆：七个分区幂等 upsert，重复写入不产生重复条目', () => {
    const service = new ProjectMemoryService(repo, USER);
    service.upsertDraft('P1', {
      stack: { frontend: 'React 18', backend: 'NestJS' },
      modules: ['auth', 'user'],
      routes: ['/login'],
      dataModels: ['User'],
      deployment: { target: 'Windows' },
    });
    service.upsertSection('P1', 'stack', {
      frontend: 'React 18',
      backend: 'NestJS',
      orm: 'Prisma',
    });

    const sections = service.get('P1');
    expect(repo.list({ userId: USER, scopes: ['project'], projectId: 'P1' })).toHaveLength(5);
    expect(sections.stack?.structured).toMatchObject({ frontend: 'React 18', orm: 'Prisma' });
    expect(sections.modules?.content).toContain('auth');

    const merged = service.mergeRoutes('P1', ['/login', '/dashboard']);
    expect(merged.item.structured?.['routes']).toEqual(['/login', '/dashboard']);

    const overview = service.overview('P1');
    expect(overview.missing).toEqual(['globalState', 'dependencies']);
  });

  it('页面记忆：增量合并分区，元素备注归入 element 层', () => {
    const service = new PageMemoryService(repo, USER);
    service.upsert({
      projectId: 'P1',
      featureId: 'F1',
      pageId: 'PG1',
      pageName: '登录页',
      route: '/login',
      structured: { skeleton: 'Container[Card[Form]]', state: ['phone', 'password'] },
    });
    service.updateSection('PG1', 'apiDeps', ['/api/auth/login']);

    const page = service.findByPage('PG1');
    expect(page?.title).toBe('登录页 /login');
    expect(page?.structured?.['skeleton']).toBe('Container[Card[Form]]');
    expect(page?.structured?.['apiDeps']).toEqual(['/api/auth/login']);

    service.upsertElementNote({
      projectId: 'P1',
      pageId: 'PG1',
      elementId: 'E1',
      elementName: '提交按钮',
      noteType: '业务规则',
      text: '连续失败 5 次弹图形验证码',
      priority: 'high',
    });
    const notes = service.listElementNotes('PG1');
    expect(notes).toHaveLength(1);
    expect(layerOf(notes[0]!)).toBe('element');
    expect(notes[0]?.structured?.['priority']).toBe('high');
  });

  it('功能记忆：错误码与接口按 code/method+path 去重，功能树可列出关联页面', () => {
    const service = new FeatureMemoryService(repo, USER);
    service.upsert({
      projectId: 'P1',
      featureId: 'F1',
      featureName: '用户登录',
      structured: {
        flow: ['输入账号密码', '调用 /api/auth/login', '跳转 Dashboard'],
        apis: [{ method: 'POST', path: '/api/auth/login' }],
      },
    });
    service.upsertErrorCode('P1', 'F1', { code: 'AUTH_1001', msg: '账号或密码错误' });
    service.upsertErrorCode('P1', 'F1', { code: 'AUTH_1001', msg: '账号或密码错误（已更新文案）' });
    service.upsertApi('P1', 'F1', { method: 'POST', path: '/api/auth/login', auth: false });
    service.appendEdgeCase('P1', 'F1', '连续失败 5 次锁定 10 分钟');
    service.appendEdgeCase('P1', 'F1', '连续失败 5 次锁定 10 分钟');

    const feature = service.findByFeature('F1');
    expect(feature?.structured?.['errors']).toEqual([
      { code: 'AUTH_1001', msg: '账号或密码错误（已更新文案）' },
    ]);
    expect(feature?.structured?.['apis']).toHaveLength(1);
    expect(feature?.structured?.['edgeCases']).toHaveLength(1);
    expect(feature?.structured?.['errors']).toHaveLength(1);

    new PageMemoryService(repo, USER).upsert({
      projectId: 'P1',
      featureId: 'F1',
      pageId: 'PG1',
      pageName: '登录页',
      route: '/login',
      structured: { skeleton: 'x' },
    });
    const tree = service.tree('P1');
    expect(tree).toHaveLength(1);
    expect(tree[0]?.pages).toHaveLength(1);
  });

  it('问题记忆：建立草稿、追加尝试去重、写结论并归档沉淀', () => {
    const service = new IssueMemoryService(repo, USER);
    const created = service.create({
      projectId: 'P1',
      pageId: 'PG1',
      elementId: 'E1',
      title: '登录后刷新页面 Session 丢失',
      phenomenon: '刷新后跳转登录页',
      reproduce: ['登录成功', '刷新页面'],
      attempts: [{ action: '调整 token 过期时间', result: '无效' }],
      codeLocations: [{ filePath: 'src/auth/session.ts', symbol: 'writeSession' }],
      commitSha: 'abc1234',
    });

    expect(created.item.scope).toBe('issue');
    expect(created.item.issueStatus).toBe('unsolved');
    expect(created.item.issueId).toMatch(/^ISSUE-/);
    expect(created.item.structured?.['commitSha']).toBe('abc1234');

    const afterDup = service.appendAttempt(created.item.id, {
      action: '调整 token 过期时间',
      result: '无效',
    });
    expect((afterDup.structured?.['attempts'] as unknown[]).length).toBe(1);
    const afterNew = service.appendAttempt(created.item.id, {
      action: '检查 Cookie SameSite',
      result: '定位到根因',
    });
    expect((afterNew.structured?.['attempts'] as unknown[]).length).toBe(2);

    const solved = service.conclude(created.item.id, '改为 SameSite=Lax + Secure', {
      status: 'solved',
      archive: true,
    });
    expect(solved.issueStatus).toBe('solved');
    expect(solved.status).toBe('archived');
    expect(service.listActive('P1')).toHaveLength(0);

    const reopened = service.reopen(created.item.id, '同日又复现');
    expect(reopened.issueStatus).toBe('unsolved');
    expect(reopened.status).toBe('archived');

    const distilled = service.distill(created.item.id, {
      scope: 'project',
      title: '会话 Cookie 约定',
    });
    expect(distilled.scope).toBe('project');
    expect(distilled.content).toContain('SameSite');
    expect(distilled.structured?.['issueId']).toBe(created.item.issueId);
  });

  it('upsert 冲突时按乐观锁拒绝并发覆盖', () => {
    const service = new ProjectMemoryService(repo, USER);
    const first = service.upsertSection('P1', 'stack', { frontend: 'React' });
    // 模拟另一个会话先改了同一条，version 被推进到 2
    const bumped = repo.update(first.item.id, { content: '并发修改' }, first.item.version);
    expect(bumped.version).toBe(2);

    // upsert 每次都读最新版本再写，因此不应抛错，且以新值合并
    expect(() => service.upsertSection('P1', 'stack', { frontend: 'Vue' })).not.toThrow();
    expect(service.get('P1').stack?.structured?.['frontend']).toBe('Vue');

    // 显式传入过期版本时才应抛 ConflictError
    expect(() => repo.update(first.item.id, { content: '旧版本写入' }, 1)).toThrow(ConflictError);
  });
});

describe('层级移动（记忆中心批量"移动层级"）', () => {
  it('长期记忆 → 项目层：写入归属并保持可读', () => {
    const item = repo.create({
      userId: USER,
      scope: 'longterm',
      title: '项目架构',
      content: 'React',
    });
    const moved = repo.moveLayer(item.id, { scope: 'project', projectId: 'P1' });
    expect(moved.scope).toBe('project');
    expect(moved.projectId).toBe('P1');
    expect(repo.list({ userId: USER, scopes: ['project'], projectId: 'P1' })).toHaveLength(1);
  });

  it('移动到非法归属组合时被拒绝，且不产生半截变更', () => {
    const item = repo.create({
      userId: USER,
      scope: 'project',
      projectId: 'P1',
      title: '路由总表',
    });
    // 页面记忆必须带 page_id
    expect(() => repo.moveLayer(item.id, { scope: 'page', projectId: 'P1' })).toThrow(
      /必须指定 page_id/,
    );
    // 长期记忆不得带 project_id
    expect(() => repo.moveLayer(item.id, { scope: 'longterm', projectId: 'P1' })).toThrow(
      /project_id 必须为空/,
    );
    expect(repo.findById(item.id)?.scope).toBe('project');
  });

  it('移动到问题层自动补 issueStatus，移出时清空', () => {
    const item = repo.create({
      userId: USER,
      scope: 'page',
      projectId: 'P1',
      pageId: 'PG1',
      title: '登录页问题',
    });
    const asIssue = repo.moveLayer(item.id, { scope: 'issue', projectId: 'P1', pageId: 'PG1' });
    expect(asIssue.scope).toBe('issue');
    expect(asIssue.issueStatus).toBe('unsolved');
    expect(asIssue.issueId).toMatch(/^ISSUE-/);

    const backToPage = repo.moveLayer(item.id, { scope: 'page', projectId: 'P1', pageId: 'PG1' });
    expect(backToPage.issueStatus).toBeNull();
    expect(backToPage.issueId).toBeNull();
  });

  it('移动支持乐观锁：过期版本被拒', () => {
    const item = repo.create({ userId: USER, scope: 'longterm', title: '命名规范' });
    repo.moveLayer(item.id, { scope: 'project', projectId: 'P1' }, 1);
    expect(() => repo.moveLayer(item.id, { scope: 'project', projectId: 'P1' }, 1)).toThrow(
      ConflictError,
    );
  });
});

describe('层级移动（记忆中心批量"移动层级"）', () => {
  it('长期记忆 → 项目层：写入归属并保持可读', () => {
    const item = repo.create({
      userId: USER,
      scope: 'longterm',
      title: '项目架构',
      content: 'React',
    });
    const moved = repo.moveLayer(item.id, { scope: 'project', projectId: 'P1' });
    expect(moved.scope).toBe('project');
    expect(moved.projectId).toBe('P1');
    expect(repo.list({ userId: USER, scopes: ['project'], projectId: 'P1' })).toHaveLength(1);
  });

  it('移动到非法归属组合时被拒绝，且不产生半截变更', () => {
    const item = repo.create({
      userId: USER,
      scope: 'project',
      projectId: 'P1',
      title: '路由总表',
    });
    // 页面记忆必须带 page_id
    expect(() => repo.moveLayer(item.id, { scope: 'page', projectId: 'P1' })).toThrow(
      /必须指定 page_id/,
    );
    // 长期记忆不得带 project_id
    expect(() => repo.moveLayer(item.id, { scope: 'longterm', projectId: 'P1' })).toThrow(
      /project_id 必须为空/,
    );
    expect(repo.findById(item.id)?.scope).toBe('project');
  });

  it('移动到问题层自动补 issueStatus，移出时清空', () => {
    const item = repo.create({
      userId: USER,
      scope: 'page',
      projectId: 'P1',
      pageId: 'PG1',
      title: '登录页问题',
    });
    const asIssue = repo.moveLayer(item.id, { scope: 'issue', projectId: 'P1', pageId: 'PG1' });
    expect(asIssue.scope).toBe('issue');
    expect(asIssue.issueStatus).toBe('unsolved');
    expect(asIssue.issueId).toMatch(/^ISSUE-/);

    const backToPage = repo.moveLayer(item.id, { scope: 'page', projectId: 'P1', pageId: 'PG1' });
    expect(backToPage.issueStatus).toBeNull();
    expect(backToPage.issueId).toBeNull();
  });

  it('移动支持乐观锁：过期版本被拒', () => {
    const item = repo.create({ userId: USER, scope: 'longterm', title: '命名规范' });
    repo.moveLayer(item.id, { scope: 'project', projectId: 'P1' }, 1);
    expect(() => repo.moveLayer(item.id, { scope: 'project', projectId: 'P1' }, 1)).toThrow(
      ConflictError,
    );
  });
});

describe('变更日志与结构变更历史', () => {
  it('变更日志按时间倒序可查，appendUndo 生成反向记录且保留原记录', () => {
    const item = repo.create({
      userId: USER,
      scope: 'longterm',
      title: '命名规范',
      content: '小驼峰',
    });
    const record = repo.changes.append({
      userId: USER,
      memoryId: item.id,
      action: 'auto_write',
      policy: 'confirm',
      sourceConversationId: 'CONV-1',
      sourceSnippet: '以后都用小驼峰命名',
      after: { title: item.title, content: item.content },
    });
    expect(repo.changes.count({ memoryId: item.id })).toBe(1);

    const undo = repo.changes.appendUndo(record, USER);
    expect(undo.action).toBe('undo');
    expect((undo.detail as { undoOf: string }).undoOf).toBe(record.id);
    const list = repo.changes.list({ memoryId: item.id });
    expect(list).toHaveLength(2);
    expect(list[0]?.action).toBe('undo');
    expect(list[0]?.sourceSnippet).toBe('以后都用小驼峰命名');
  });

  it('结构变更历史只保留最近 5 次，revision 递增', () => {
    const item = repo.create({
      userId: USER,
      scope: 'page',
      projectId: 'P1',
      pageId: 'PG1',
      title: '登录页',
    });
    for (let index = 1; index <= 7; index += 1) {
      repo.revisions.append({
        memoryId: item.id,
        pageId: 'PG1',
        summary: { skeleton: `v${index}` },
        tokenEstimate: 100 * index,
      });
    }
    const recent = repo.revisions.list(item.id);
    expect(recent).toHaveLength(5);
    expect(recent[0]?.revision).toBe(7);
    expect(recent[4]?.revision).toBe(3);
    expect(repo.revisions.recent(item.id).map((entry) => entry.revision)).toEqual([3, 4, 5, 6, 7]);
    expect(repo.revisions.latest(item.id)?.tokenEstimate).toBe(700);
  });

  it('无需依赖 seed：newUlid 生成的主键满足长度约束', () => {
    expect(newUlid()).toHaveLength(26);
  });
});
