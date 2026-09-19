import { describe, expect, it, vi } from 'vitest';

import { emptyDocument, textToSpans, type Note } from '../note-model';
import { NoteRepository, changedFieldsBetween, type NotePersistencePort } from '../note-repo';

/** 可控时钟 + 可预期 id，保证断言稳定 */
function makeRepo(options: { clock?: () => number; persistence?: NotePersistencePort } = {}): {
  repo: NoteRepository;
  tick: (ms: number) => void;
  now: () => number;
} {
  let current = 1_000;
  const clock = options.clock ?? (() => current);
  let counter = 0;
  const repo = new NoteRepository({
    projectId: 'P1',
    clock,
    idFactory: (prefix) => `${prefix}-${(counter += 1)}`,
    ...(options.persistence !== undefined ? { persistence: options.persistence } : {}),
  });
  return {
    repo,
    tick: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

describe('NoteRepository CRUD（T4-01）', () => {
  it('三级备注均可创建，字段与版本号正确', () => {
    const { repo } = makeRepo();
    const element = repo.create({
      targetType: 'element',
      targetId: 'el-btn',
      title: '需校验图形验证码',
      text: '登录按钮',
    });
    const page = repo.create({ targetType: 'page', targetId: 'page-login', title: '页面备注' });
    const feature = repo.create({
      targetType: 'feature',
      targetId: 'feat-auth',
      title: '功能备注',
    });

    expect([element.targetType, page.targetType, feature.targetType]).toEqual([
      'element',
      'page',
      'feature',
    ]);
    expect(element.version).toBe(1);
    expect(element.status).toBe('open');
    expect(repo.list()).toHaveLength(3);
    expect(repo.listForTarget('element', 'el-btn')).toHaveLength(1);
  });

  it('更新递增版本、写入历史、记录字段级变更，且历史不含当前版本', () => {
    const { repo, tick } = makeRepo();
    const note = repo.create({
      targetType: 'element',
      targetId: 'el-1',
      title: '初稿',
      text: '正文',
    });

    tick(50);
    const updated = repo.update(note.id, { title: '改后标题' });
    expect(updated?.version).toBe(2);
    expect(updated?.updatedAt).toBe(1_050);
    expect(updated?.history).toHaveLength(1);
    expect(updated?.history[0]?.version).toBe(1);
    expect(updated?.history[0]?.title).toBe('初稿');
    expect(updated?.history[0]?.changedFields).toEqual(['title']);
    expect(repo.historyOf(note.id).map((revision) => revision.version)).toEqual([1]);
  });

  it('无实际变更的更新不产生新版本（避免污染历史）', () => {
    const { repo } = makeRepo();
    const note = repo.create({ targetType: 'element', targetId: 'el-1', title: 'A' });
    const same = repo.update(note.id, { title: 'A' });
    expect(same?.version).toBe(1);
    expect(repo.historyOf(note.id)).toHaveLength(0);
  });

  it('删除后可查询为空；不存在的 id 返回 null', () => {
    const { repo } = makeRepo();
    const note = repo.create({ targetType: 'element', targetId: 'el-1', title: 'A' });
    expect(repo.remove(note.id)?.id).toBe(note.id);
    expect(repo.get(note.id)).toBeNull();
    expect(repo.update(note.id, { title: 'B' })).toBeNull();
  });

  it('历史容量超限时丢弃最旧版本', () => {
    const { repo, tick } = makeRepo();
    const repoSmall = repo;
    const note = repoSmall.create({ targetType: 'element', targetId: 'el-1', title: 'v1' });
    for (let index = 2; index <= 60; index += 1) {
      tick(1);
      repoSmall.update(note.id, { title: `v${index}` });
    }
    const history = repoSmall.historyOf(note.id);

    expect(history.length).toBeLessThanOrEqual(50);
    expect(history.at(-1)?.title).toBe('v59');
  });
});

describe('NoteRepository 状态与清单（T4-01）', () => {
  it('解决 / 重开维护 resolvedAt', () => {
    const { repo, tick } = makeRepo();
    const note = repo.create({ targetType: 'element', targetId: 'el-1', title: 'A' });
    tick(30);
    const resolved = repo.resolve(note.id);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedAt).toBe(1_030);
    expect(repo.unresolvedCount()).toBe(0);

    tick(30);
    const reopened = repo.reopen(note.id);
    expect(reopened?.status).toBe('open');
    expect(reopened?.resolvedAt).toBeNull();
    expect(repo.unresolvedCount()).toBe(1);
  });

  it('勾选清单项写回并留痕', () => {
    const { repo } = makeRepo();
    const note = repo.create({
      targetType: 'element',
      targetId: 'el-1',
      title: 'A',
      checklists: [{ id: 'c1', text: '检查', checked: false }],
    });
    const toggled = repo.toggleChecklistItem(note.id, 'c1');
    expect(toggled?.checklists[0]?.checked).toBe(true);
    expect(toggled?.history[0]?.changedFields).toEqual(['checklists']);
  });

  it('可回退到历史版本，且回退本身也留痕', () => {
    const { repo, tick } = makeRepo();
    const note = repo.create({ targetType: 'element', targetId: 'el-1', title: '第一版' });
    tick(10);
    repo.update(note.id, { title: '第二版' });
    tick(10);
    const restored = repo.restore(note.id, 1);
    expect(restored?.title).toBe('第一版');
    expect(restored?.version).toBe(3);
    expect(repo.historyOf(note.id).map((revision) => revision.title)).toEqual(['第一版', '第二版']);
    expect(repo.restore(note.id, 999)).toBeNull();
  });
});

describe('备注上下文注入（T4-01 要点 5）', () => {
  it('getNotesForContext 聚合元素 / 页面 / 功能三级且只取未解决项', () => {
    const { repo } = makeRepo();
    repo.create({
      targetType: 'element',
      targetId: 'el-btn',
      title: '元素备注',
      text: '需校验图形验证码',
    });
    repo.create({ targetType: 'page', targetId: 'page-login', title: '页面备注' });
    repo.create({ targetType: 'feature', targetId: 'feat-auth', title: '功能备注' });
    const resolvedNote = repo.create({
      targetType: 'element',
      targetId: 'el-btn',
      title: '已解决备注',
    });
    repo.resolve(resolvedNote.id);

    const context = repo.getNotesForContext({
      projectId: 'P1',
      elementId: 'el-btn',
      pageId: 'page-login',
      featureId: 'feat-auth',
    });

    expect(context.map((note) => note.title)).toEqual(['元素备注', '页面备注', '功能备注']);
    expect(context.some((note) => note.title === '已解决备注')).toBe(false);
  });

  it('禁止事项在上下文中置顶，并带强约束前缀', () => {
    const { repo } = makeRepo();
    repo.create({ targetType: 'element', targetId: 'el-1', type: 'validation', title: '校验要求' });
    repo.create({
      targetType: 'element',
      targetId: 'el-1',
      type: 'forbidden',
      title: '不得明文存 Key',
    });
    repo.create({
      targetType: 'element',
      targetId: 'el-1',
      type: 'business_rule',
      title: '业务规则',
    });

    const context = repo.getNotesForContext({ projectId: 'P1', elementId: 'el-1' });
    expect(context[0]?.title).toBe('不得明文存 Key');
    expect(context[0]?.mustFollow).toBe(true);
    expect(context[0]?.text.startsWith('【禁止】')).toBe(true);
    expect(context.slice(1).map((note) => note.title)).toEqual(['校验要求', '业务规则']);
  });

  it('无任何目标时返回空数组（优雅降级）', () => {
    const { repo } = makeRepo();
    repo.create({ targetType: 'element', targetId: 'el-1', title: 'A' });
    expect(repo.getNotesForContext({ projectId: 'P1' })).toEqual([]);
  });

  it('hasNoteUpdatedSince 能对比出「备注已更新」', () => {
    const { repo, tick, now } = makeRepo();
    const note = repo.create({
      targetType: 'element',
      targetId: 'el-btn',
      title: '需校验图形验证码',
    });
    const generatedAt = now();

    expect(repo.hasNoteUpdatedSince({ projectId: 'P1', elementId: 'el-btn' }, generatedAt)).toBe(
      false,
    );
    expect(repo.noteIdsUpdatedSince({ projectId: 'P1', elementId: 'el-btn' }, generatedAt)).toEqual(
      [],
    );

    tick(20);
    repo.update(note.id, { title: '需校验图形验证码（滑动）' });

    expect(repo.hasNoteUpdatedSince({ projectId: 'P1', elementId: 'el-btn' }, generatedAt)).toBe(
      true,
    );
    expect(repo.noteIdsUpdatedSince({ projectId: 'P1', elementId: 'el-btn' }, generatedAt)).toEqual(
      [note.id],
    );
    expect(repo.isNoteUpdatedSince(note.id, generatedAt)).toBe(true);
    expect(repo.isNoteUpdatedSince(note.id, now() + 10)).toBe(false);
  });

  it('页面备注的更新同样算作元素上下文已更新', () => {
    const { repo, tick, now } = makeRepo();
    repo.create({ targetType: 'element', targetId: 'el-btn', title: 'A' });
    const pageNote = repo.create({ targetType: 'page', targetId: 'page-login', title: 'B' });
    const since = now();
    tick(5);
    repo.update(pageNote.id, { title: 'B2' });
    expect(
      repo.hasNoteUpdatedSince(
        { projectId: 'P1', elementId: 'el-btn', pageId: 'page-login' },
        since,
      ),
    ).toBe(true);
  });
});

describe('备注统计与角标（T4-01 要点 3）', () => {
  it('badgeMap 只统计未解决项并标记禁止事项', () => {
    const { repo } = makeRepo();
    repo.create({ targetType: 'element', targetId: 'el-1', type: 'todo', title: 'A' });
    repo.create({ targetType: 'element', targetId: 'el-1', type: 'forbidden', title: 'B' });
    repo.create({ targetType: 'element', targetId: 'el-2', type: 'validation', title: 'C' });
    const resolved = repo.create({
      targetType: 'element',
      targetId: 'el-2',
      type: 'todo',
      title: 'D',
    });
    repo.resolve(resolved.id);

    const map = repo.badgeMap('element');
    expect(map['el-1']).toEqual({ count: 2, types: ['todo', 'forbidden'], hasMustFollow: true });
    expect(map['el-2']).toEqual({ count: 1, types: ['validation'], hasMustFollow: false });
  });

  it('countsByType 与 unresolvedCount 供项目仪表盘使用', () => {
    const { repo } = makeRepo();
    repo.create({ targetType: 'element', targetId: 'el-1', type: 'todo', title: 'A' });
    repo.create({ targetType: 'element', targetId: 'el-1', type: 'todo', title: 'B' });
    repo.create({ targetType: 'page', targetId: 'p1', type: 'forbidden', title: 'C' });
    const updated = repo.create({
      targetType: 'page',
      targetId: 'p1',
      type: 'question',
      title: 'D',
    });
    repo.resolve(updated.id);

    expect(repo.countsByType().todo).toBe(2);
    expect(repo.countsByType().question).toBe(1);
    expect(repo.unresolvedCount()).toBe(3);
    expect(repo.unresolvedCount({ targetType: 'element' })).toBe(2);
  });

  it('订阅在每次写操作后触发', () => {
    const { repo } = makeRepo();
    const listener = vi.fn();
    const unsubscribe = repo.subscribe(listener);
    const note = repo.create({ targetType: 'element', targetId: 'el-1', title: 'A' });
    repo.update(note.id, { title: 'B' });
    repo.remove(note.id);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(repo.getRevision()).toBe(3);
    unsubscribe();
    repo.create({ targetType: 'element', targetId: 'el-1', title: 'C' });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('备注持久化端口（T4-01）', () => {
  it('写操作通过端口落盘，load 可回读', async () => {
    const stored: Note[] = [];
    const port: NotePersistencePort = {
      load: () => stored,
      save: ({ notes }) => {
        stored.splice(0, stored.length, ...notes);
      },
    };
    const { repo } = makeRepo({ persistence: port });
    const note = repo.create({
      targetType: 'element',
      targetId: 'el-1',
      title: '需校验图形验证码',
    });
    expect(stored).toHaveLength(1);

    const second = new NoteRepository({ projectId: 'P1', persistence: port });
    expect(await second.load()).toBe(1);
    expect(second.get(note.id)?.title).toBe('需校验图形验证码');
  });

  it('无持久化端口时纯内存工作，load 返回 0 而不是抛错', async () => {
    const { repo } = makeRepo();
    repo.create({ targetType: 'element', targetId: 'el-1', title: 'A' });
    await expect(repo.load()).resolves.toBe(0);
  });

  it('hydrate 只接收本项目备注', () => {
    const { repo } = makeRepo();
    const foreign: Note = {
      id: 'x1',
      projectId: 'P2',
      targetType: 'element',
      targetId: 'el-9',
      type: 'todo',
      title: '其他项目',
      content: emptyDocument(),
      checklists: [],
      codeBlocks: [],
      status: 'open',
      priority: 2,
      manualPriority: null,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      resolvedAt: null,
      createdBy: 'user',
      history: [],
    };
    repo.hydrate([foreign]);
    expect(repo.list()).toHaveLength(0);
  });
});

describe('changedFieldsBetween（T4-01）', () => {
  it('准确列出发生变化的字段', () => {
    const { repo } = makeRepo();
    const note = repo.create({ targetType: 'element', targetId: 'el-1', title: 'A', text: '正文' });
    const next: Note = {
      ...note,
      title: 'B',
      content: { type: 'doc', blocks: [{ type: 'paragraph', spans: textToSpans('新正文') }] },
      status: 'resolved',
    };
    expect(changedFieldsBetween(note, next)).toEqual(['title', 'content', 'status']);
  });
});
