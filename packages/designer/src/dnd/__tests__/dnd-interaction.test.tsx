import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createElement, createLoginPageDsl } from '../../dsl/factory';
import { findById, walkElements } from '../../dsl/traverse';
import type { ElementNode } from '../../dsl/types';
import { DesignerProvider, useEditorState, useDesignerStore } from '../../store/designer-context';
import { createEditorStore } from '../../store/editor-store';
import { DndProvider, useDnd } from '../DndProvider';
import { InsertionIndicator } from '../insertion-indicator';
import type { DragResolution } from '../collision';

/** 测试用拖拽总线消费者：把四类拖拽操作暴露为按钮，便于断言几何结果与 undo 步数 */
function Harness(): JSX.Element {
  const dnd = useDnd();
  useDesignerStore();
  const undoState = useEditorState((state) => state.undoState);

  const insert = (resolution: DragResolution): void => {
    dnd.commitDrag(
      { source: 'panel', element: createElement({ id: 'new-1', type: 'Button', name: '新按钮' }) },
      resolution,
    );
  };

  return (
    <div>
      <button
        data-testid="op-insert"
        onClick={() => insert({ kind: 'insert', parentId: 'el-9', index: 0, position: 'before' })}
      >
        拖入
      </button>
      <button
        data-testid="op-move"
        onClick={() =>
          dnd.commitDrag(
            { source: 'canvas', id: 'el-15' },
            { kind: 'insert', parentId: 'el-5', index: 0, position: 'before' },
          )
        }
      >
        移动
      </button>
      <button
        data-testid="op-nest"
        onClick={() =>
          dnd.commitDrag(
            { source: 'canvas', id: 'el-7' },
            { kind: 'insert', parentId: 'el-9', index: undefined, position: 'inside' },
          )
        }
      >
        嵌套
      </button>
      <button
        data-testid="op-delete"
        onClick={() => dnd.commitDrag({ source: 'canvas', id: 'el-12' }, { kind: 'delete' })}
      >
        删除
      </button>
      <button
        data-testid="op-cycle"
        onClick={() =>
          dnd.commitDrag(
            { source: 'canvas', id: 'el-5' },
            { kind: 'insert', parentId: 'el-15', index: undefined, position: 'inside' },
          )
        }
      >
        循环拖拽
      </button>
      <button
        data-testid="op-none"
        onClick={() => dnd.commitDrag({ source: 'canvas', id: 'el-7' }, { kind: 'none' })}
      >
        无效提交
      </button>
      <button
        data-testid="op-resolve"
        onClick={() =>
          dnd.setResolution({ kind: 'insert', parentId: 'el-9', index: 2, position: 'after' })
        }
      >
        解析
      </button>
      <button data-testid="op-cancel" onClick={() => dnd.cancelDrag()}>
        取消
      </button>
      <span data-testid="undo-depth">{undoState.undoDepth}</span>
      <span data-testid="undo-label">{undoState.undoLabel ?? ''}</span>
      <span data-testid="resolution">
        {dnd.resolution === null
          ? 'none'
          : dnd.resolution.kind === 'insert'
            ? dnd.resolution.position
            : dnd.resolution.kind}
      </span>
      <span data-testid="accepts">{dnd.acceptsChildren('Button') ? 'yes' : 'no'}</span>
    </div>
  );
}

function setup() {
  const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 0 });
  render(
    <DesignerProvider store={store}>
      <DndProvider>
        <Harness />
      </DndProvider>
    </DesignerProvider>,
  );
  return store;
}

describe('T3-03 拖拽提交（一次拖拽 = 一步 undo）', () => {
  it('从组件面板拖入：插入到指定位置并选中新元素', async () => {
    const user = userEvent.setup();
    const store = setup();

    await user.click(screen.getByTestId('op-insert'));
    expect(findById(store.getState().dsl.tree, 'el-9')?.children?.[0]?.id).toBe('new-1');
    expect(store.getState().selectedIds).toEqual(['new-1']);
    expect(screen.getByTestId('undo-depth')).toHaveTextContent('1');
  });

  it('画布内移动与跨容器嵌套各自只产生一步 undo', async () => {
    const user = userEvent.setup();
    const store = setup();

    await user.click(screen.getByTestId('op-move'));
    expect(findById(store.getState().dsl.tree, 'el-5')?.children?.[0]?.id).toBe('el-15');
    expect(store.getState().undoState.undoDepth).toBe(1);
    expect(screen.getByTestId('undo-label')).toHaveTextContent('移动元素');

    await user.click(screen.getByTestId('op-nest'));
    expect(
      findById(store.getState().dsl.tree, 'el-9')?.children?.some((child) => child.id === 'el-7'),
    ).toBe(true);
    expect(store.getState().undoState.undoDepth).toBe(2);
  });

  it('拖出画布删除元素', async () => {
    const user = userEvent.setup();
    const store = setup();
    await user.click(screen.getByTestId('op-delete'));
    expect(findById(store.getState().dsl.tree, 'el-12')).toBeNull();
    expect(walkElements(store.getState().dsl.tree)).toHaveLength(19);
    expect(store.getState().undoState.undoDepth).toBe(1);
  });

  it('循环拖拽被拒绝且不产生 undo 步', async () => {
    const user = userEvent.setup();
    const store = setup();
    const before = JSON.stringify(store.getState().dsl.tree);
    await user.click(screen.getByTestId('op-cycle'));
    expect(JSON.stringify(store.getState().dsl.tree)).toBe(before);
    expect(store.getState().undoState.undoDepth).toBe(0);
  });

  it('无效提交（kind=none）不改变任何状态', async () => {
    const user = userEvent.setup();
    const store = setup();
    const before = JSON.stringify(store.getState().dsl.tree);
    await user.click(screen.getByTestId('op-none'));
    expect(JSON.stringify(store.getState().dsl.tree)).toBe(before);
    expect(store.getState().undoState.undoDepth).toBe(0);
  });

  it('拖拽可撤销与重做（单步）', async () => {
    const user = userEvent.setup();
    const store = setup();
    const original = JSON.stringify(store.getState().dsl.tree);

    await user.click(screen.getByTestId('op-move'));
    const moved = JSON.stringify(store.getState().dsl.tree);
    expect(moved).not.toBe(original);

    act(() => {
      store.getState().undo();
    });
    expect(JSON.stringify(store.getState().dsl.tree)).toBe(original);

    act(() => {
      store.getState().redo();
    });
    expect(JSON.stringify(store.getState().dsl.tree)).toBe(moved);
  });
});

describe('T3-03 Esc 取消与插入指示', () => {
  it('解析结果落入上下文并可被取消，取消后结构不变', async () => {
    const user = userEvent.setup();
    const store = setup();
    const before = JSON.stringify(store.getState().dsl.tree);

    await user.click(screen.getByTestId('op-resolve'));
    expect(screen.getByTestId('resolution')).toHaveTextContent('after');

    await user.click(screen.getByTestId('op-cancel'));
    expect(screen.getByTestId('resolution')).toHaveTextContent('none');
    expect(JSON.stringify(store.getState().dsl.tree)).toBe(before);
    expect(store.getState().undoState.undoDepth).toBe(0);
  });

  it('容器类型判定走 CONTAINER_TYPES 白名单', () => {
    setup();
    expect(screen.getByTestId('accepts')).toHaveTextContent('no'); // Button 不接受 children
  });

  it('插入指示线三种形态：水平 / 垂直 / 容器内', () => {
    const rect = { x: 10, y: 20, width: 100, height: 40 };
    const { rerender } = render(
      <InsertionIndicator
        resolution={{ kind: 'insert', parentId: 'p', index: 1, position: 'before' }}
        targetRect={rect}
      />,
    );
    expect(screen.getByTestId('insertion-indicator')).toHaveAttribute('data-position', 'before');
    expect(screen.getByTestId('insertion-indicator').style.height).toBe('2px');

    rerender(
      <InsertionIndicator
        resolution={{ kind: 'insert', parentId: 'p', index: 1, position: 'after' }}
        targetRect={rect}
        axis="x"
      />,
    );
    expect(screen.getByTestId('insertion-indicator').style.width).toBe('2px');

    rerender(
      <InsertionIndicator
        resolution={{ kind: 'insert', parentId: 'p', index: undefined, position: 'inside' }}
        targetRect={rect}
      />,
    );
    expect(screen.getByTestId('insertion-indicator')).toHaveAttribute('data-position', 'inside');
    expect(screen.getByTestId('insertion-indicator').style.width).toBe('100px');
  });
});

describe('T3-03 8 层嵌套拖拽', () => {
  it('在最大允许深度内移动节点，移动后深度不超限', async () => {
    const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 0 });
    // 构造 8 层链：deep-0 → … → deep-7
    let node: ElementNode = createElement({ id: 'deep-7', type: 'Text' });
    for (let level = 6; level >= 0; level -= 1) {
      node = createElement({ id: `deep-${level}`, type: 'Container', children: [node] });
    }
    act(() => {
      store.getState().apply('替换树', (draft) => {
        draft.tree = node;
      });
    });
    expect(walkElements(store.getState().dsl.tree)).toHaveLength(8);

    // 把最深层节点上移到第 2 层
    act(() => {
      expect(store.getState().moveElement('deep-7', 'deep-0', 0)).toBe(true);
    });
    expect(findById(store.getState().dsl.tree, 'deep-0')?.children?.[0]?.id).toBe('deep-7');
    expect(walkElements(store.getState().dsl.tree).length).toBe(8);
  });
});
