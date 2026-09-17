import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createElement, createLoginPageDsl } from '../../dsl/factory';
import { findById } from '../../dsl/traverse';
import type { ElementNode, PageDsl } from '../../dsl/types';
import { createAutoSnapshotScheduler, DEFAULT_SNAPSHOT_INTERVAL_MS, MILESTONE_LABELS } from '../auto-snapshot';
import { DiffView } from '../diff-view';
import { diffTrees, isEmptyDiff } from '../diff-ops';
import { BASELINE_EVERY, HistoryStore, applyOps, diffToOps } from '../snapshot';
import { Timeline } from '../timeline';

/** 在登录页上做一次可复现的小改动 */
function withEdit(base: PageDsl, mutate: (dsl: PageDsl) => void): PageDsl {
  const next: PageDsl = JSON.parse(JSON.stringify(base)) as PageDsl;
  mutate(next);
  return next;
}

function emptyStore() {
  return new HistoryStore({ idFactory: (() => {
    let index = 0;
    return () => `s${(index += 1)}`;
  })() });
}

describe('T3-10 结构化差异（四类识别）', () => {
  it('新增 / 删除 / 修改 被正确分类', () => {
    const base = createLoginPageDsl();
    const next = withEdit(base, (dsl) => {
      // 新增
      dsl.tree.children![2]!.children!.push(createElement({ id: 'el-21', type: 'Text', name: '新版权信息' }));
      // 删除
      dsl.tree.children![0]!.children = dsl.tree.children![0]!.children!.filter((child) => child.id !== 'el-4');
      // 修改
      const title = findById(dsl.tree, 'el-7') as ElementNode;
      title.props = { ...(title.props ?? {}), text: '欢迎回来' };
    });

    const diff = diffTrees(base, next);
    expect(diff.added.map((item) => item.id)).toEqual(['el-21']);
    expect(diff.removed.map((item) => item.id)).toEqual(['el-4']);
    expect(diff.modified.map((item) => item.id)).toEqual(['el-7']);
    expect(diff.modified[0]?.changedKeys).toContain('props');
    expect(diff.moved).toHaveLength(0);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it('移动被识别为移动，而不是删除 + 新增', () => {
    const base = createLoginPageDsl();
    const next = withEdit(base, (dsl) => {
      // 把 el-15（登录按钮）从表单移到卡片首位
      const form = findById(dsl.tree, 'el-9') as ElementNode;
      const button = form.children!.find((child) => child.id === 'el-15') as ElementNode;
      form.children = form.children!.filter((child) => child.id !== 'el-15');
      const card = findById(dsl.tree, 'el-5') as ElementNode;
      card.children = [button, ...card.children!];
    });

    const diff = diffTrees(base, next);
    // 只有跨父节点的那个元素算移动；同容器内被顶位的兄弟不算（相对顺序未变）
    expect(diff.moved.map((item) => item.id)).toEqual(['el-15']);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.moved[0]).toMatchObject({ fromParentId: 'el-9', parentId: 'el-5', index: 0 });
  });

  it('页面级变更（状态 / 事件 / 接口依赖 / 元信息）被标记', () => {
    const base = createLoginPageDsl();
    const next = withEdit(base, (dsl) => {
      dsl.name = '登录页 v2';
      dsl.state = [...dsl.state, { name: 'captcha', type: 'string' }];
      dsl.apiDeps = [...dsl.apiDeps, '/api/captcha'];
      dsl.events = [];
    });
    const diff = diffTrees(base, next);
    expect(diff.pageChanged).toContain('name');
    expect(diff.stateChanged).toBe(true);
    expect(diff.apiDepsChanged).toBe(true);
    expect(diff.eventsChanged).toBe(true);
    expect(diff.notesChanged).toBe(false);
  });
});

describe('T3-10 增量 patch 与回放', () => {
  it('diffToOps + applyOps 能无损重建目标 DSL（新增/删除/移动/修改混合）', () => {
    const base = createLoginPageDsl();
    const next = withEdit(base, (dsl) => {
      const card = findById(dsl.tree, 'el-5') as ElementNode;
      card.children!.push(createElement({ id: 'el-30', type: 'Tag', name: '新标签' }));
      const form = findById(dsl.tree, 'el-9') as ElementNode;
      form.children = form.children!.filter((child) => child.id !== 'el-12');
      const submit = findById(dsl.tree, 'el-15') as ElementNode;
      submit.props = { ...(submit.props ?? {}), text: '立即登录' };
      dsl.name = '登录页（改）';
    });

    const ops = diffToOps(base, next);
    expect(ops.length).toBeGreaterThan(0);
    expect(JSON.stringify(applyOps(base, ops))).toBe(JSON.stringify(next));
  });

  it('变更过大时退化为整体替换（仍是单条 patch）', () => {
    const base = createLoginPageDsl();
    const next = withEdit(base, (dsl) => {
      dsl.tree = createElement({
        id: 'root',
        type: 'Container',
        name: '页面',
        children: Array.from({ length: 60 }, (_item, index) => createElement({ id: `n-${index}`, type: 'Text' })),
      });
    });
    const ops = diffToOps(base, next, { maxOps: 10 });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('replaceDsl');
    expect(JSON.stringify(applyOps(base, ops))).toBe(JSON.stringify(next));
  });

  it('快照：首张为全量基线，其余为增量；回放结果与当时的 DSL 一致', () => {
    const store = emptyStore();
    const v1 = createLoginPageDsl();
    const v2 = withEdit(v1, (dsl) => {
      (findById(dsl.tree, 'el-7') as ElementNode).props = { text: '第一版改' };
    });
    const v3 = withEdit(v2, (dsl) => {
      (findById(dsl.tree, 'el-8') as ElementNode).props = { text: '第二版改' };
    });

    const s1 = store.capture({ dsl: v1, reason: 'auto', now: 1000 });
    const s2 = store.capture({ dsl: v2, reason: 'auto', now: 2000 });
    const s3 = store.capture({ dsl: v3, reason: 'auto', now: 3000 });

    expect([s1.kind, s2.kind, s3.kind]).toEqual(['base', 'delta', 'delta']);
    expect(JSON.stringify(store.materialize(s1.id))).toBe(JSON.stringify(v1));
    expect(JSON.stringify(store.materialize(s2.id))).toBe(JSON.stringify(v2));
    expect(JSON.stringify(store.materialize(s3.id))).toBe(JSON.stringify(v3));
    expect(store.size()).toBe(3);
  });

  it(`每 ${BASELINE_EVERY} 个增量落一次全量基线`, () => {
    const store = emptyStore();
    let dsl = createLoginPageDsl();
    store.capture({ dsl, reason: 'auto', now: 0 });
    for (let index = 1; index <= BASELINE_EVERY + 1; index += 1) {
      dsl = withEdit(dsl, (next) => {
        next.name = `第 ${index} 次改名`;
      });
      store.capture({ dsl, reason: 'auto', now: index });
    }
    const kinds = store.list().map((meta) => meta.kind);
    expect(kinds[0]).toBe('base');
    // 首张基线 + 20 张增量后，第 22 张再次落基线
    expect(kinds.filter((kind) => kind === 'base').length).toBe(2);
    expect(kinds.filter((kind) => kind === 'delta').length).toBe(BASELINE_EVERY);
    expect(kinds[kinds.length - 1]).toBe('base');
    // 基线后的增量链可正常回放
    expect(store.materialize(store.list()[store.list().length - 1]!.id)?.name).toBe(`第 ${BASELINE_EVERY + 1} 次改名`);
  });

  it('回滚：回滚前自动备份当前版本，可再次回滚回去', () => {
    const store = emptyStore();
    const v1 = createLoginPageDsl();
    const v2 = withEdit(v1, (dsl) => {
      dsl.name = '改过的名字';
    });
    const s1 = store.capture({ dsl: v1, reason: 'auto', now: 1000 });
    store.capture({ dsl: v2, reason: 'auto', now: 2000 });

    const restored = store.rollback(s1.id, { now: 3000 });
    expect(restored?.name).toBe('登录页');
    // 回滚产生了 2 张新快照：备份 + 回滚动作
    const labels = store.list().map((meta) => meta.label);
    expect(labels).toContain('回滚前自动备份');
    expect(labels.some((label) => label?.startsWith('回滚到'))).toBe(true);

    // 可以再次回滚到「改过的名字」那一版
    const backup = store.list().find((meta) => meta.label === '回滚前自动备份');
    expect(backup).toBeDefined();
    const again = store.rollback(backup!.id, { now: 4000 });
    expect(again?.name).toBe('改过的名字');
  });

  it('回滚到不存在的快照返回 null', () => {
    const store = emptyStore();
    store.capture({ dsl: createLoginPageDsl(), reason: 'auto', now: 0 });
    expect(store.rollback('不存在')).toBeNull();
  });

  it('体积统计：增量快照显著小于「每次全量」', () => {
    const store = emptyStore();
    let dsl = createLoginPageDsl();
    store.capture({ dsl, reason: 'auto', now: 0 });
    for (let index = 1; index <= 99; index += 1) {
      dsl = withEdit(dsl, (next) => {
        next.name = `迭代 ${index}`;
      });
      store.capture({ dsl, reason: 'auto', now: index });
    }
    const stats = store.stats();
    expect(stats.count).toBe(100);
    // eslint-disable-next-line no-console
    console.log(
      `[T3-10 基准] 100 次快照：总计 ${stats.totalBytes} B（基线 ${stats.baselineCount} 张 / 增量 ${stats.deltaCount} 张），` +
        `平均 ${stats.avgBytes} B/张，相比每次全量节省约 ${stats.savedBytes} B`,
    );
    expect(stats.deltaCount).toBeGreaterThan(stats.baselineCount);
    expect(stats.savedBytes).toBeGreaterThan(0);
    expect(stats.avgBytes).toBeLessThan(2000);
  });
});

describe('T3-10 自动快照调度', () => {
  function setup(options: { idle?: boolean } = {}) {
    const history = emptyStore();
    let dsl: PageDsl | null = createLoginPageDsl();
    let now = 1_000_000;
    const written: Array<{ path: string; content: string }> = [];
    const scheduler = createAutoSnapshotScheduler({
      history,
      getDsl: () => dsl,
      clock: () => now,
      isIdle: () => options.idle ?? true,
      files: {
        readText: async () => '',
        exists: async () => true,
        writeAtomic: async (path, data) => {
          written.push({ path, content: String(data) });
        },
      },
    });
    return {
      history,
      scheduler,
      written,
      advance: (ms: number) => {
        now += ms;
      },
      setDsl: (next: PageDsl | null) => {
        dsl = next;
      },
    };
  }

  it('默认间隔为 5 分钟', () => {
    expect(DEFAULT_SNAPSHOT_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('tick 落一张自动快照并原子落盘', async () => {
    const { scheduler, history, written } = setup();
    const meta = scheduler.tick();
    expect(meta?.reason).toBe('auto');
    expect(history.size()).toBe(1);
    await scheduler.flush();
    expect(written[0]?.path).toBe('login.history.json');
    expect(written[0]?.content).toContain('"snapshots"');
  });

  it('非空闲时不快照（不打扰用户操作）', () => {
    const { scheduler, history } = setup({ idle: false });
    expect(scheduler.tick()).toBeNull();
    expect(history.size()).toBe(0);
  });

  it('没有打开页面时不快照', () => {
    const { scheduler, history, setDsl } = setup();
    setDsl(null);
    expect(scheduler.tick()).toBeNull();
    expect(history.size()).toBe(0);
  });

  it('start / stop 管理定时器', () => {
    const handles: Array<() => void> = [];
    const history = emptyStore();
    const dsl: PageDsl | null = createLoginPageDsl();
    const scheduler = createAutoSnapshotScheduler({
      history,
      getDsl: () => dsl,
      setTimer: (handler) => {
        handles.push(handler);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearTimer: () => undefined,
    });
    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    handles[0]?.();
    expect(history.size()).toBe(1);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
    void dsl;
  });

  it('关键操作立即落一张里程碑快照', () => {
    const { scheduler, history } = setup();
    for (const kind of ['stage-confirm', 'ai-generated', 'rename-transaction', 'import', 'export'] as const) {
      const meta = scheduler.captureMilestone(kind);
      expect(meta?.reason).toBe('milestone');
      expect(meta?.label).toBe(MILESTONE_LABELS[kind]);
    }
    expect(history.size()).toBe(5);
  });

  it('手动快照带自定义说明', () => {
    const { scheduler } = setup();
    const meta = scheduler.captureManual('发布前存档');
    expect(meta?.reason).toBe('manual');
    expect(meta?.label).toBe('发布前存档');
  });
});

describe('T3-10 时间轴与差异视图', () => {
  it('时间轴列出快照、可预览历史版本（只读渲染）', () => {
    const store = emptyStore();
    const v1 = createLoginPageDsl();
    const v2 = withEdit(v1, (dsl) => {
      dsl.name = '第二版';
    });
    store.capture({ dsl: v1, reason: 'auto', now: Date.parse('2026-09-10T10:00:00Z') });
    const s2 = store.capture({ dsl: v2, reason: 'milestone', label: 'AI 生成完成', now: Date.parse('2026-09-10T10:05:00Z') });

    render(
      <Timeline
        snapshots={store.list()}
        onPreview={(id) => store.materialize(id)}
        onRollback={() => undefined}
        renderPreview={(dsl) => <div data-testid="readonly-preview">{dsl.name}</div>}
      />,
    );

    expect(document.querySelectorAll('[data-kind]').length).toBe(2);
    expect(screen.getByTestId('snapshot-label-' + s2.id)).toHaveTextContent('AI 生成完成');

    // 列表按时间倒序，最后一个「预览」按钮对应最早（v1）的版本
    const previewButtons = screen.getAllByRole('button', { name: '预览' });
    fireEvent.click(previewButtons[previewButtons.length - 1] as HTMLElement);
    expect(screen.getByTestId('timeline-preview')).toBeInTheDocument();
    expect(screen.getByTestId('readonly-preview')).toHaveTextContent('登录页');

    // 预览最新版本则显示第二版名称
    fireEvent.click(previewButtons[0] as HTMLElement);
    expect(screen.getByTestId('readonly-preview')).toHaveTextContent('第二版');
  });

  it('时间轴回滚按钮触发回调', () => {
    const store = emptyStore();
    const meta = store.capture({ dsl: createLoginPageDsl(), reason: 'auto', now: 0 });
    const onRollback = vi.fn();
    render(<Timeline snapshots={store.list()} onPreview={() => null} onRollback={onRollback} />);
    fireEvent.click(screen.getByRole('button', { name: '回滚' }));
    expect(onRollback).toHaveBeenCalledWith(meta.id);
  });

  it('差异视图分四栏展示，点击条目可定位', () => {
    const base = createLoginPageDsl();
    const next = withEdit(base, (dsl) => {
      dsl.tree.children![2]!.children!.push(createElement({ id: 'el-21', type: 'Text', name: '新元素' }));
      const form = findById(dsl.tree, 'el-9') as ElementNode;
      form.children = form.children!.filter((child) => child.id !== 'el-12');
      (findById(dsl.tree, 'el-7') as ElementNode).props = { text: '改了' };
    });
    const onLocate = vi.fn();
    render(<DiffView diff={diffTrees(base, next)} onLocate={onLocate} />);

    expect(screen.getByTestId('diff-added')).toHaveAttribute('data-count', '1');
    expect(screen.getByTestId('diff-removed')).toHaveAttribute('data-count', '1');
    expect(screen.getByTestId('diff-modified')).toHaveAttribute('data-count', '1');
    expect(screen.getByTestId('diff-moved')).toHaveAttribute('data-count', '0');

    fireEvent.click(screen.getByTestId('diff-entry-el-21'));
    expect(onLocate).toHaveBeenCalledWith('el-21');
  });

  it('无差异时展示空态', () => {
    const dsl = createLoginPageDsl();
    render(<DiffView diff={diffTrees(dsl, JSON.parse(JSON.stringify(dsl)) as PageDsl)} />);
    expect(screen.getByText('没有差异')).toBeInTheDocument();
  });

  it('时间轴无快照时展示空态', () => {
    render(<Timeline snapshots={[]} onPreview={() => null} onRollback={() => undefined} />);
    expect(screen.getByText('还没有快照')).toBeInTheDocument();
  });
});
