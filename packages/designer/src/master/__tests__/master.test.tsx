import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createElement, createLoginPageDsl } from '../../dsl/factory';
import { findById } from '../../dsl/traverse';
import type { ElementNode, PageDsl } from '../../dsl/types';
import { MasterPanel } from '../MasterPanel';
import {
  MasterRegistry,
  collectMasterInstances,
  detachInstance,
  instantiateMaster,
  masterUsage,
  reattachInstance,
  syncInstances,
  type MasterDefinition,
} from '../master-sync';

function masterFixture(): MasterDefinition {
  return {
    id: 'M1',
    name: '登录卡片母版',
    updatedAt: 1000,
    tree: createElement({
      id: 'M1-root',
      type: 'Container',
      name: '卡片',
      style: { padding: 24, borderRadius: 12 },
      children: [
        createElement({ id: 'M1-title', type: 'Text', name: '标题', props: { text: '欢迎登录' } }),
        createElement({
          id: 'M1-submit',
          type: 'Button',
          name: '提交按钮',
          props: { text: '登录' },
        }),
      ],
    }),
  };
}

/** 页面 = 一个根容器，里面放两个母版实例 */
function pageWithInstances(): { page: PageDsl; master: MasterDefinition } {
  const base = createLoginPageDsl();
  const master = masterFixture();
  const a = instantiateMaster(master, { elementId: 'inst-a', name: '登录卡片 A' });
  const b = instantiateMaster(master, { elementId: 'inst-b', name: '登录卡片 B' });
  const tree: ElementNode = { ...base.tree, children: [a, b] };
  return { page: { ...base, tree }, master };
}

describe('T3-11 母版实例化', () => {
  it('实例化会重分配子节点 id 并保留 masterRef 关联', () => {
    const master = masterFixture();
    const instance = instantiateMaster(master, { elementId: 'inst-1', name: '实例一' });
    expect(instance.id).toBe('inst-1');
    expect(instance.name).toBe('实例一');
    expect(instance.masterRef).toEqual({ masterId: 'M1', detached: false });
    // 子节点 id 已重新分配，不与被复制的母版冲突
    expect(instance.children?.[0]?.id).not.toBe('M1-title');
    expect(instance.children?.[0]?.type).toBe('Text');
  });

  it('收集实例：可按母版过滤，且不修改原对象', () => {
    const { page: dsl } = pageWithInstances();
    const all = collectMasterInstances(dsl);
    expect(all.map((ref) => ref.elementId).sort()).toEqual(['inst-a', 'inst-b']);
    expect(all.every((ref) => ref.detached === false)).toBe(true);
    expect(collectMasterInstances(dsl, 'M-other')).toEqual([]);
  });
});

describe('T3-11 母版同步与脱离', () => {
  it('同步更新：结构来自母版，实例 id 与显示名保留', () => {
    const { page: dsl, master } = pageWithInstances();

    // 母版改版：把按钮文案改成「立即登录」并新增一行提示
    const updated: MasterDefinition = {
      ...master,
      updatedAt: 2000,
      tree: {
        ...master.tree,
        children: [
          ...(master.tree.children ?? []).map((child) =>
            child.id === 'M1-submit' ? { ...child, props: { text: '立即登录' } } : child,
          ),
          createElement({
            id: 'M1-tip',
            type: 'Text',
            name: '提示',
            props: { text: '登录即同意用户协议' },
          }),
        ],
      },
    };

    const result = syncInstances(dsl, updated, { elementIds: ['inst-a'] });
    expect(result.synced).toEqual(['inst-a']);
    expect(result.skipped).toEqual([]);

    const synced = findById(result.dsl.tree, 'inst-a') as ElementNode;
    expect(synced.name).toBe('登录卡片 A');
    expect(synced.children?.map((child) => child.type)).toEqual(['Text', 'Button', 'Text']);
    expect(synced.children?.[1]?.props).toEqual({ text: '立即登录' });
    // 未选中的实例不受影响
    expect(findById(result.dsl.tree, 'inst-b')?.children).toHaveLength(2);
    // 原对象未被修改
    expect(findById(dsl.tree, 'inst-a')?.children).toHaveLength(2);
  });

  it('脱离后不再随母版同步', () => {
    const { page: basePage, master } = pageWithInstances();
    let dsl = basePage;

    dsl = detachInstance(dsl, 'inst-b');
    expect(
      collectMasterInstances(dsl, 'M1').find((ref) => ref.elementId === 'inst-b')?.detached,
    ).toBe(true);

    const updated: MasterDefinition = {
      ...master,
      tree: {
        ...master.tree,
        children: [{ ...(master.tree.children![0] as ElementNode), props: { text: '改版标题' } }],
      },
    };
    const result = syncInstances(dsl, updated);
    expect(result.synced).toEqual(['inst-a']);
    expect(result.skipped).toEqual(['inst-b']);
    expect(findById(result.dsl.tree, 'inst-b')?.children?.[0]?.props).toEqual({ text: '欢迎登录' });
  });

  it('可重新关联以恢复同步', () => {
    const { page, master } = pageWithInstances();
    let dsl = detachInstance(page, 'inst-a');
    dsl = reattachInstance(dsl, 'inst-a', master.id);
    expect(
      collectMasterInstances(dsl, 'M1').find((ref) => ref.elementId === 'inst-a')?.detached,
    ).toBe(false);
  });

  it('母版注册表：注册 / 更新 / 查询 / 统计使用情况', () => {
    const registry = new MasterRegistry();
    registry.register(masterFixture());
    expect(registry.get('M1')?.name).toBe('登录卡片母版');
    expect(registry.get('nope')).toBeNull();

    const updated = registry.update('M1', {
      name: '登录卡片母版 v2',
      note: '新增协议提示',
      now: 3000,
    });
    expect(updated?.name).toBe('登录卡片母版 v2');
    expect(updated?.updatedAt).toBe(3000);
    expect(registry.update('nope', { name: 'x' })).toBeNull();

    const usage = masterUsage([pageWithInstances().page], 'M1');
    expect(usage).toEqual({ total: 2, detached: 0, pages: 1 });
  });
});

describe('T3-11 母版面板', () => {
  it('列出母版与实例，可逐个脱离与同步', () => {
    const registry = new MasterRegistry();
    registry.register(masterFixture());
    const { page } = pageWithInstances();
    let dsl = page;

    const view = render(
      <MasterPanel
        registry={registry}
        page={dsl}
        onChange={(next) => {
          dsl = next;
          view.rerender(
            <MasterPanel
              registry={registry}
              page={dsl}
              onChange={(next2) => {
                dsl = next2;
              }}
            />,
          );
        }}
      />,
    );

    expect(screen.getByTestId('master-M1')).toBeInTheDocument();
    expect(screen.getByTestId('master-instance-inst-a')).toHaveAttribute('data-detached', 'false');
    expect(screen.getAllByRole('button', { name: '脱离' })).toHaveLength(2);

    // 脱离第一个实例
    fireEvent.click(screen.getAllByRole('button', { name: '脱离' })[0] as HTMLElement);
    expect(screen.getByTestId('master-instance-inst-a')).toHaveAttribute('data-detached', 'true');

    // 勾选后同步选中
    fireEvent.click(screen.getByLabelText('选择实例 inst-b'));
    fireEvent.click(screen.getByTestId('sync-selected-M1'));
    expect(findById(dsl.tree, 'inst-b')?.children?.[1]?.props).toEqual({ text: '登录' });
  });

  it('没有母版时展示空态', () => {
    render(<MasterPanel registry={new MasterRegistry()} page={createLoginPageDsl()} />);
    expect(screen.getByText('还没有母版')).toBeInTheDocument();
  });
});
