import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createElement, createLoginPageDsl } from '../../dsl/factory';
import { findById, walkElements } from '../../dsl/traverse';
import type { ElementNode, PageDsl } from '../../dsl/types';
import { DesignerProvider } from '../../store/designer-context';
import { createEditorStore } from '../../store/editor-store';
import { LayerTree } from '../LayerTree';
import { resolveDrop } from '../useLayerDnd';

function setup(
  patch?: (dsl: PageDsl) => void,
  props: { onRenameRequest?: (id: string, name: string) => void } = {},
) {
  const dsl = createLoginPageDsl();
  patch?.(dsl);
  const store = createEditorStore({ dsl, coalesceWindowMs: 0 });
  const view = render(
    <DesignerProvider store={store}>
      <LayerTree height={400} {...props} />
    </DesignerProvider>,
  );
  return { store, view };
}

function largePage(count = 500): PageDsl {
  const children: ElementNode[] = [];
  for (let index = 0; index < count; index += 1) {
    children.push(createElement({ id: `n-${index}`, type: 'Text', name: `节点 ${index}` }));
  }
  return {
    ...createLoginPageDsl(),
    tree: createElement({ id: 'root', type: 'Container', name: '页面', children }),
  };
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

describe('T3-06 图层树：虚拟化与检索', () => {
  it('500 节点下只渲染可视窗口内的行（虚拟化生效）', () => {
    setup((dsl) => {
      const next = largePage(500);
      dsl.tree = next.tree;
    });
    const rendered = rows().length;
    // eslint-disable-next-line no-console
    console.log(`[T3-06 基准] 500 节点图层树实际渲染行数 ${rendered}`);
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
  });

  it('按名称搜索时保留命中节点的祖先链', async () => {
    setup();
    const search = screen.getByRole('textbox');
    fireEvent.change(search, { target: { value: '忘记密码' } });
    // el-18 在 el-16 → el-5 → el-1 之下，祖先链必须保留
    expect(document.getElementById('ec-tree-el-18')).not.toBeNull();
    expect(document.getElementById('ec-tree-el-16')).not.toBeNull();
    expect(document.getElementById('ec-tree-el-5')).not.toBeNull();
    expect(document.getElementById('ec-tree-el-7')).toBeNull();
  });
});

describe('T3-06 图层树：拖拽改层级', () => {
  it('resolveDrop：拖到容器 → 追加为其子节点', () => {
    const dsl = createLoginPageDsl();
    expect(resolveDrop(dsl, 'el-7', 'el-9')).toEqual({ targetParentId: 'el-9' });
  });

  it('resolveDrop：拖到普通元素 → 作为其兄弟插到其后', () => {
    const dsl = createLoginPageDsl();
    // el-8 与 el-7 同为 el-5 的子节点（下标 1 / 2）
    const resolution = resolveDrop(dsl, 'el-18', 'el-7');
    expect(resolution).toEqual({ targetParentId: 'el-5', index: 2 });
  });

  it('resolveDrop：自身与自身子树被拒绝（循环检测）', () => {
    const dsl = createLoginPageDsl();
    expect(resolveDrop(dsl, 'el-5', 'el-5')).toBeNull();
    expect(resolveDrop(dsl, 'el-5', 'el-9')).toBeNull(); // el-9 在 el-5 内
    expect(resolveDrop(dsl, 'el-5', 'el-15')).toBeNull();
    expect(resolveDrop(dsl, 'el-5', '不存在')).toBeNull();
  });

  it('真实拖放事件 → 一步 undo，结构正确', () => {
    const { store } = setup();
    const from = document.querySelector('[data-layer-id="el-18"]') as HTMLElement;
    const to = document.getElementById('ec-tree-el-7') as HTMLElement;
    expect(from).not.toBeNull();

    const dataTransfer = {
      data: {} as Record<string, string>,
      setData(key: string, value: string) {
        this.data[key] = value;
      },
      getData(key: string) {
        return this.data[key] ?? '';
      },
      effectAllowed: '',
      dropEffect: '',
    };
    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragOver(to, { dataTransfer });
    fireEvent.drop(to, { dataTransfer });
    fireEvent.dragEnd(from, { dataTransfer });

    const card = findById(store.getState().dsl.tree, 'el-5');
    expect(card?.children?.map((child) => child.id)).toContain('el-18');
    expect(store.getState().undoState.undoDepth).toBe(1);
  });
});

describe('T3-06 图层树：锁定 / 隐藏 / 重命名', () => {
  it('锁定与隐藏显示对应标记，且 hidden 节点仍保留在 DSL 中', () => {
    setup((dsl) => {
      const title = findById(dsl.tree, 'el-7') as ElementNode;
      title.locked = true;
      const subtitle = findById(dsl.tree, 'el-8') as ElementNode;
      subtitle.hidden = true;
    });
    expect(document.querySelector('[data-layer-id="el-7"] [aria-label="已锁定"]')).not.toBeNull();
    expect(document.querySelector('[data-layer-id="el-8"] [aria-label="已隐藏"]')).not.toBeNull();
  });

  it('右键菜单可锁定 / 解锁并进入撤销栈', async () => {
    const { store } = setup();
    const row = document.getElementById('ec-tree-el-7') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    const lockItem = await screen.findByText('锁定');
    fireEvent.click(lockItem);
    expect(findById(store.getState().dsl.tree, 'el-7')?.locked).toBe(true);
    expect(store.getState().undoState.undoDepth).toBe(1);
  });

  it('双击重命名：先发 onRenameRequest 再乐观更新显示名', async () => {
    const onRenameRequest = vi.fn();
    const { store } = setup(undefined, { onRenameRequest });

    const node = document.querySelector('[data-layer-id="el-7"]') as HTMLElement;
    fireEvent.doubleClick(node);

    const input = screen.getByLabelText('重命名元素') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '登录标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameRequest).toHaveBeenCalledWith('el-7', '登录标题');
    expect(findById(store.getState().dsl.tree, 'el-7')?.name).toBe('登录标题');
  });

  it('Esc 取消重命名，不改变名称', () => {
    setup();
    fireEvent.doubleClick(document.querySelector('[data-layer-id="el-7"]') as HTMLElement);
    const input = screen.getByLabelText('重命名元素') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '不要保存' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('重命名元素')).toBeNull();
    expect(document.querySelector('[data-layer-id="el-7"]')?.textContent).toContain('标题');
  });
});

describe('T3-06 三向联动（共享 selection store）', () => {
  it('点击行 → 选中同步到 store；多选修饰键为累加', () => {
    const { store } = setup();
    fireEvent.click(document.querySelector('[data-layer-id="el-7"]') as HTMLElement);
    expect(store.getState().selectedIds).toEqual(['el-7']);

    // 修饰键在 mousedown 阶段记录（mousedown 先于 click）
    const second = document.querySelector('[data-layer-id="el-8"]') as HTMLElement;
    fireEvent.mouseDown(second, { shiftKey: true });
    fireEvent.click(second, { shiftKey: true });
    expect(store.getState().selectedIds).toEqual(['el-7', 'el-8']);
  });

  it('hover 行 → store.hoveredId 更新（供画布描边）', () => {
    const { store } = setup();
    fireEvent.mouseOver(document.querySelector('[data-layer-id="el-12"]') as HTMLElement);
    expect(store.getState().hoveredId).toBe('el-12');
  });

  it('画布侧改选中 → 图层树高亮同步（同一份状态）', () => {
    const { store } = setup();
    act(() => {
      store.getState().select(['el-15']);
    });
    const row = document.getElementById('ec-tree-el-15') as HTMLElement;
    expect(row.getAttribute('aria-selected')).toBe('true');
  });

  it('删除元素后树中节点消失且选中被清理', () => {
    const { store } = setup();
    act(() => {
      store.getState().select(['el-12']);
      store.getState().removeElements(['el-12']);
    });
    expect(document.getElementById('ec-tree-el-12')).toBeNull();
    expect(store.getState().selectedIds).toEqual([]);
    expect(walkElements(store.getState().dsl.tree)).toHaveLength(19);
  });
});
