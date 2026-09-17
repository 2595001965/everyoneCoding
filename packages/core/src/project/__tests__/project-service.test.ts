import { describe, it, expect } from 'vitest';

import { ProjectService, rowToSummary } from '../project-service';
import { ProjectDomainError, RECYCLE_BIN_RETENTION_MS } from '../project-types';
import { FakeDuplicatePort, FakeProjectStore, createClock, createIdFactory } from './fake-store';

function setup() {
  const store = new FakeProjectStore();
  const clock = createClock();
  const service = new ProjectService({ store, clock: clock.now, newId: createIdFactory('p') });
  return { store, clock, service };
}

const DAY = 24 * 60 * 60 * 1000;

describe('ProjectService 基本 CRUD', () => {
  it('创建项目：默认值完整、lastOpenedAt 被填为当前时间', async () => {
    const { service, clock } = setup();
    const project = await service.createProject({ name: '电商后台' });
    expect(project.id).toBe('p-001');
    expect(project.name).toBe('电商后台');
    expect(project.status).toBe('active');
    expect(project.targetPlatforms).toEqual([]);
    expect(project.pinned).toBe(false);
    expect(project.deletedAt).toBeNull();
    expect(project.sourceKind).toBe('blank');
    expect(project.lastOpenedAt).toBe(clock.now());
    expect(project.techStackFingerprint).toBeNull();
  });

  it('拒绝空名称与重名', async () => {
    const { service } = setup();
    await expect(service.createProject({ name: '   ' })).rejects.toBeInstanceOf(ProjectDomainError);
    await service.createProject({ name: '重复项目' });
    await expect(service.createProject({ name: '重复项目' })).rejects.toThrowError(/已存在同名项目/);
  });

  it('回收站中的同名项目不阻塞新建', async () => {
    const { service } = setup();
    const first = await service.createProject({ name: '同名项目' });
    await service.moveToRecycleBin(first.id);
    await expect(service.createProject({ name: '同名项目' })).resolves.toBeTruthy();
  });

  it('更新项目：目标端与技术栈指纹序列化写入，更新 updated_at', async () => {
    const { service, clock, store } = setup();
    const project = await service.createProject({ name: '多端项目' });
    clock.advance(1000);
    const updated = await service.updateProject(project.id, {
      targetPlatforms: ['web', 'android', 'harmonyos'],
      techStackFingerprint: { web: 'react', android: 'flutter', harmonyos: 'arkts' },
      gitRemote: 'https://example.com/repo.git',
    });
    expect(updated?.targetPlatforms).toEqual(['web', 'android', 'harmonyos']);
    expect(updated?.techStackFingerprint).toEqual({ web: 'react', android: 'flutter', harmonyos: 'arkts' });
    expect(updated?.gitRemote).toBe('https://example.com/repo.git');
    expect(updated?.updatedAt).toBe(clock.now());

    const row = store.rows.get(project.id)!;
    expect(JSON.parse(row.target_platforms)).toEqual(['web', 'android', 'harmonyos']);
    expect(row.tech_stack_fingerprint).toContain('flutter');
  });

  it('更新时重名校验排除自身', async () => {
    const { service } = setup();
    const a = await service.createProject({ name: '项目A' });
    const b = await service.createProject({ name: '项目B' });
    await expect(service.updateProject(a.id, { name: '项目A' })).resolves.toBeTruthy();
    await expect(service.updateProject(b.id, { name: '项目A' })).rejects.toThrowError(/已存在同名项目/);
    await expect(service.updateProject('missing', { name: 'x' })).rejects.toThrowError(/项目不存在/);
  });

  it('归档与取消归档', async () => {
    const { service } = setup();
    const project = await service.createProject({ name: '待归档' });
    await service.archiveProject(project.id);
    expect((await service.getProject(project.id))?.status).toBe('archived');
    expect(await service.listProjects({ view: 'archived' })).toHaveLength(1);
    expect(await service.listProjects({ view: 'active' })).toHaveLength(0);
    await service.unarchiveProject(project.id);
    expect(await service.listProjects({ view: 'active' })).toHaveLength(1);
  });
});

describe('ProjectService 列表：排序 / 搜索 / 置顶 / 最近打开', () => {
  it('按更新时间倒序，置顶优先于时间', async () => {
    const { service, clock } = setup();
    const a = await service.createProject({ name: 'A' });
    clock.advance(1000);
    await service.createProject({ name: 'B' });
    clock.advance(1000);
    await service.createProject({ name: 'C' });

    let list = await service.listProjects({ sort: 'updatedAt' });
    expect(list.map((p) => p.name)).toEqual(['C', 'B', 'A']);

    await service.updateProject(a.id, { pinned: true });
    list = await service.listProjects({ sort: 'updatedAt' });
    expect(list.map((p) => p.name)).toEqual(['A', 'C', 'B']);
    expect(await service.listProjects({ pinnedOnly: true })).toHaveLength(1);
  });

  it('按名称排序使用中文排序规则', async () => {
    const { service } = setup();
    await service.createProject({ name: '乙项目' });
    await service.createProject({ name: '甲项目' });
    const list = await service.listProjects({ sort: 'name' });
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe('甲项目');
  });

  it('搜索按名称模糊匹配（不区分大小写）', async () => {
    const { service } = setup();
    await service.createProject({ name: 'Admin Console' });
    await service.createProject({ name: '移动端' });
    expect(await service.listProjects({ search: 'admin' })).toHaveLength(1);
    expect(await service.listProjects({ search: '移动' })).toHaveLength(1);
    expect(await service.listProjects({ search: 'zzz' })).toHaveLength(0);
  });

  it('最近打开：按 lastOpenedAt 倒序取前 N 条，忽略从未打开的项目', async () => {
    const { service, clock, store } = setup();
    const a = await service.createProject({ name: 'A' });
    const b = await service.createProject({ name: 'B' });
    const c = await service.createProject({ name: 'C' });
    // 模拟 c 从未打开（外壳可能写入 null）
    await store.update(c.id, { last_opened_at: null });

    clock.advance(10 * 60 * 1000);
    await service.markOpened(a.id);
    clock.advance(60 * 1000);
    await service.markOpened(b.id);

    const recent = await service.listProjects({ recentLimit: 2 });
    expect(recent.map((p) => p.name)).toEqual(['B', 'A']);

    const recentAll = await service.listProjects({ recentLimit: 10 });
    expect(recentAll.map((p) => p.name)).toEqual(['B', 'A']);
  });

  it('最近打开列表最多返回 10 条（FR-WSP-04 保留最近 10 条）', async () => {
    const { service } = setup();
    for (let i = 0; i < 12; i += 1) await service.createProject({ name: `项目${i}` });
    expect(await service.listProjects({ recentLimit: 10 })).toHaveLength(10);
  });
});

describe('ProjectService 回收站（保留 30 天）', () => {
  it('删除进回收站、可恢复、彻底删除', async () => {
    const { service } = setup();
    const project = await service.createProject({ name: '待删除' });

    await service.moveToRecycleBin(project.id);
    expect(await service.listProjects({ view: 'active' })).toHaveLength(0);
    const bin = await service.listProjects({ view: 'recycleBin' });
    expect(bin).toHaveLength(1);
    expect(bin[0]!.deletedAt).not.toBeNull();

    await service.restoreFromRecycleBin(project.id);
    expect(await service.listProjects({ view: 'active' })).toHaveLength(1);
    expect(await service.listProjects({ view: 'recycleBin' })).toHaveLength(0);
  });

  it('恢复未删除的项目是幂等空操作', async () => {
    const { service } = setup();
    const project = await service.createProject({ name: '未删除' });
    await service.restoreFromRecycleBin(project.id);
    expect((await service.getProject(project.id))?.deletedAt).toBeNull();
  });

  it('清理超期条目：仅删 30 天前的，未超期保留', async () => {
    const { service, clock } = setup();
    const old = await service.createProject({ name: '超期' });
    await service.moveToRecycleBin(old.id);
    clock.advance(RECYCLE_BIN_RETENTION_MS + 1);

    const fresh = await service.createProject({ name: '刚删除' });
    await service.moveToRecycleBin(fresh.id);

    const purged = await service.cleanupExpiredRecycleBin();
    expect(purged).toEqual([old.id]);
    expect(await service.getProject(old.id)).toBeNull();
    expect(await service.listProjects({ view: 'recycleBin' })).toHaveLength(1);
  });

  it('边界：恰好满 30 天即清理（>= 保留期）', async () => {
    const { service, clock } = setup();
    const project = await service.createProject({ name: '临界' });
    await service.moveToRecycleBin(project.id);
    clock.advance(RECYCLE_BIN_RETENTION_MS);
    expect(await service.cleanupExpiredRecycleBin()).toEqual([project.id]);
  });

  it('彻底删除直接移除', async () => {
    const { service } = setup();
    const project = await service.createProject({ name: '彻底删除' });
    await service.purgeProject(project.id);
    expect(await service.getProject(project.id)).toBeNull();
  });

  it('回收站保留天数可由 deletedAt 推得（UI 展示剩余天数）', async () => {
    const { service, clock } = setup();
    const project = await service.createProject({ name: '剩余天数' });
    await service.moveToRecycleBin(project.id);
    clock.advance(5 * DAY);
    const bin = await service.listProjects({ view: 'recycleBin' });
    const deletedAt = bin[0]!.deletedAt!;
    expect(clock.now() - deletedAt).toBe(5 * DAY);
    expect(RECYCLE_BIN_RETENTION_MS - (clock.now() - deletedAt)).toBe(25 * DAY);
  });
});

describe('ProjectService 复制项目（FR-WSP-05）', () => {
  it('按选项复制资源，名称自动去重', async () => {
    const store = new FakeProjectStore();
    const duplicate = new FakeDuplicatePort();
    const service = new ProjectService({
      store,
      clock: createClock().now,
      newId: createIdFactory('cp'),
      duplicate,
    });
    const source = await service.createProject({ name: '原项目' });

    const result = await service.duplicateProject(source.id, {
      includeDesign: true,
      includeMemory: true,
      includeDocs: false,
      includeCode: true,
    });
    expect(result.project.name).toBe('原项目-副本');
    expect(result.copied).toEqual({ design: 3, memory: 5, docs: 0, codeFiles: 7 });
    expect(duplicate.calls[0]).toMatchObject({ sourceId: source.id, targetId: result.project.id });

    const second = await service.duplicateProject(source.id, {
      includeDesign: false,
      includeMemory: false,
      includeDocs: false,
      includeCode: false,
    });
    expect(second.project.name).toBe('原项目-副本(2)');
    expect(second.copied).toEqual({ design: 0, memory: 0, docs: 0, codeFiles: 0 });
  });

  it('复制继承目标端与技术栈指纹', async () => {
    const service = new ProjectService({
      store: new FakeProjectStore(),
      clock: createClock().now,
      newId: createIdFactory('cp'),
      duplicate: new FakeDuplicatePort(),
    });
    const source = await service.createProject({ name: '多端' });
    await service.updateProject(source.id, {
      targetPlatforms: ['web', 'macos'],
      techStackFingerprint: { web: 'react', macos: 'tauri2' },
    });
    const { project } = await service.duplicateProject(source.id, {
      includeDesign: false,
      includeMemory: false,
      includeDocs: false,
      includeCode: false,
    });
    expect(project.targetPlatforms).toEqual(['web', 'macos']);
    expect(project.techStackFingerprint).toEqual({ web: 'react', macos: 'tauri2' });
  });

  it('未装配复制端口时如实报错（不静默成功）', async () => {
    const { service } = setup();
    const project = await service.createProject({ name: '无端口' });
    await expect(
      service.duplicateProject(project.id, {
        includeDesign: true,
        includeMemory: true,
        includeDocs: true,
        includeCode: true,
      }),
    ).rejects.toThrowError(/复制端口未装配/);
  });

  it('复制不存在的项目报错', async () => {
    const service = new ProjectService({
      store: new FakeProjectStore(),
      clock: createClock().now,
      newId: createIdFactory('cp'),
      duplicate: new FakeDuplicatePort(),
    });
    await expect(
      service.duplicateProject('missing', {
        includeDesign: false,
        includeMemory: false,
        includeDocs: false,
        includeCode: false,
      }),
    ).rejects.toThrowError(/项目不存在/);
  });
});

describe('行 ↔ 领域对象映射的健壮性', () => {
  const baseRow = {
    id: 'x',
    user_id: 'u',
    workspace_id: null,
    name: '项目',
    description: null,
    tech_stack_json: null,
    status: 'active',
    target_platforms: '[]',
    tech_stack_fingerprint: null,
    git_remote: null,
    pinned: 0 as const,
    last_opened_at: null,
    deleted_at: null,
    source_kind: 'blank',
    source_ref: null,
    created_at: 1,
    updated_at: 1,
  };

  it('非法平台值被过滤（防止脏数据进画布）', () => {
    const summary = rowToSummary({ ...baseRow, target_platforms: '["web","nintendo","android"]' });
    expect(summary.targetPlatforms).toEqual(['web', 'android']);
  });

  it('坏 JSON 不抛异常，退化为空数组 / null', () => {
    const summary = rowToSummary({
      ...baseRow,
      target_platforms: '{broken',
      tech_stack_fingerprint: '{broken',
    });
    expect(summary.targetPlatforms).toEqual([]);
    expect(summary.techStackFingerprint).toBeNull();
  });

  it('未知来源与未知状态回落到安全值', () => {
    const summary = rowToSummary({ ...baseRow, source_kind: 'telepathy', status: 'weird' });
    expect(summary.sourceKind).toBe('blank');
    expect(summary.status).toBe('active');
  });
});
