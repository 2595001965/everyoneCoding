import { describe, expect, it } from 'vitest';

import { createElement, createLoginPageDsl } from '../../dsl/factory';
import { findById } from '../../dsl/traverse';
import { createEditorStore, createDefaultElement } from '../editor-store';

function setup() {
  const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 0 });
  return store;
}

describe('编辑器内核：撤销与重做', () => {
  it('每次 apply 记录一步，可逐步撤销 / 重做', () => {
    const store = setup();
    const { updateProps } = store.getState();
    updateProps('el-7', { text: '标题 A' });
    updateProps('el-8', { text: '副标题 B' });

    expect(store.getState().undoState.undoDepth).toBe(2);
    expect(store.getState().undoState.undoLabel).toBe('修改属性');
    expect(findById(store.getState().dsl.tree, 'el-7')?.props?.['text']).toBe('标题 A');

    store.getState().undo();
    expect(findById(store.getState().dsl.tree, 'el-8')?.props?.['text']).toBe('使用手机号登录你的账号');
    expect(store.getState().undoState.redoDepth).toBe(1);

    store.getState().redo();
    expect(findById(store.getState().dsl.tree, 'el-8')?.props?.['text']).toBe('副标题 B');
  });

  it('一次拖拽（单次 apply）等于一步 undo', () => {
    const store = setup();
    store.getState().moveElement('el-15', 'el-5', 0);
    expect(store.getState().undoState.undoDepth).toBe(1);
    expect(findById(store.getState().dsl.tree, 'el-15')?.id).toBe('el-15');

    const afterMove = store.getState().dsl;
    store.getState().undo();
    expect(store.getState().dsl).not.toBe(afterMove);
    // 撤销后回到 el-9（表单）内
    expect(findById(store.getState().dsl.tree, 'el-9')?.children?.some((child) => child.id === 'el-15')).toBe(true);
  });

  it('无实际变更为空操作，不产生撤销步', () => {
    const store = setup();
    expect(store.getState().moveElement('el-7', 'el-7')).toBe(false);
    expect(store.getState().moveElement('el-9', 'el-15')).toBe(false); // 拖入自身子树
    expect(store.getState().moveElement('不存在', 'el-7')).toBe(false);
    expect(store.getState().undoState.undoDepth).toBe(0);
  });

  it('coalesceKey 合并连续输入为一步 undo', () => {
    const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 5000 });
    for (const text of ['登', '登录', '登录按']) {
      store.getState().updateProps('el-15', { text }, { coalesceKey: 'prop:el-15:text' });
    }
    expect(store.getState().undoState.undoDepth).toBe(1);
    expect(findById(store.getState().dsl.tree, 'el-15')?.props?.['text']).toBe('登录按');

    store.getState().undo();
    expect(findById(store.getState().dsl.tree, 'el-15')?.props?.['text']).toBe('登录');
  });

  it('loadDsl 清空历史且恢复干净状态', () => {
    const store = setup();
    store.getState().updateProps('el-7', { text: 'x' });
    expect(store.getState().dirty).toBe(true);
    store.getState().loadDsl(createLoginPageDsl(), { filePath: 'pages/login.dsl.json' });
    expect(store.getState().undoState.undoDepth).toBe(0);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().filePath).toBe('pages/login.dsl.json');
  });
});

describe('编辑器内核：选中与 hover（不进撤销栈）', () => {
  it('replace / add / toggle 三种选择模式', () => {
    const store = setup();
    store.getState().select(['el-7']);
    expect(store.getState().selectedIds).toEqual(['el-7']);
    store.getState().select(['el-8', 'el-10'], { mode: 'add' });
    expect(store.getState().selectedIds).toEqual(['el-7', 'el-8', 'el-10']);
    store.getState().select(['el-7'], { mode: 'toggle' });
    expect(store.getState().selectedIds).toEqual(['el-8', 'el-10']);
    store.getState().select(['el-7']);
    expect(store.getState().undoState.undoDepth).toBe(0);
  });

  it('删除元素后自动清理失效选中与 hover', () => {
    const store = setup();
    store.getState().select(['el-7', 'el-8']);
    store.getState().setHovered('el-8');
    store.getState().removeElements(['el-8']);
    expect(store.getState().selectedIds).toEqual(['el-7']);
    expect(store.getState().hoveredId).toBeNull();
  });

  it('hover / 编辑态切换不影响文档与历史', () => {
    const store = setup();
    store.getState().setHovered('el-7');
    store.getState().setEditing('el-7');
    expect(store.getState().hoveredId).toBe('el-7');
    expect(store.getState().editingElementId).toBe('el-7');
    expect(store.getState().undoState.undoDepth).toBe(0);
    expect(store.getState().dirty).toBe(false);
  });
});

describe('编辑器内核：结构变更', () => {
  it('insertElement 支持指定下标并自动选中', () => {
    const store = setup();
    const element = createDefaultElement('Button', () => 'el-new');
    expect(store.getState().insertElement('el-9', element, { index: 0 })).toBe(true);
    expect(store.getState().selectedIds).toEqual(['el-new']);
    expect(findById(store.getState().dsl.tree, 'el-9')?.children?.[0]?.id).toBe('el-new');
  });

  it('insertElement 到不存在的父节点返回 false', () => {
    const store = setup();
    expect(store.getState().insertElement('nope', createDefaultElement('Button', () => 'x'))).toBe(false);
    expect(store.getState().undoState.undoDepth).toBe(0);
  });

  it('duplicateElement 复制子树并追加到原节点之后', () => {
    const store = setup();
    const newId = store.getState().duplicateElement('el-13', { idFactory: (() => {
      let index = 0;
      return () => `copy-${(index += 1)}`;
    })() });
    expect(newId).toBe('copy-1');
    const form = findById(store.getState().dsl.tree, 'el-9');
    const ids = form?.children?.map((child) => child.id) ?? [];
    expect(ids[ids.indexOf('el-13') + 1]).toBe('copy-1');
  });

  it('removeElements 统计实际删除数量，根节点不可删', () => {
    const store = setup();
    expect(store.getState().removeElements(['el-7', 'el-1', '不存在'])).toBe(1);
    expect(findById(store.getState().dsl.tree, 'el-1')).not.toBeNull();
  });

  it('moveElement 跨容器嵌套成功', () => {
    const store = setup();
    expect(store.getState().moveElement('el-15', 'el-links-missing')).toBe(false);
    expect(store.getState().moveElement('el-15', 'el-5', 0)).toBe(true);
    expect(findById(store.getState().dsl.tree, 'el-5')?.children?.[0]?.id).toBe('el-15');
  });
});

describe('编辑器内核：属性 / 样式 / 绑定 / 元信息', () => {
  it('updateProps 浅合并，setProps 整体替换', () => {
    const store = setup();
    store.getState().updateProps('el-15', { variant: 'danger' });
    expect(findById(store.getState().dsl.tree, 'el-15')?.props?.['text']).toBe('登录');
    store.getState().setProps('el-15', { text: '立即登录' });
    expect(findById(store.getState().dsl.tree, 'el-15')?.props).toEqual({ text: '立即登录' });
  });

  it('setBindings 传 null 删除绑定，全删后移除字段', () => {
    const store = setup();
    store.getState().setBindings('el-15', { disabled: null });
    expect(findById(store.getState().dsl.tree, 'el-15')?.bindings).toBeUndefined();
    store.getState().setBindings('el-15', { disabled: 'loading', loading: 'loading' });
    expect(findById(store.getState().dsl.tree, 'el-15')?.bindings).toEqual({ disabled: 'loading', loading: 'loading' });
  });

  it('updateMeta 支持重命名 / 锁定 / 隐藏', () => {
    const store = setup();
    store.getState().updateMeta('el-12', { name: '密码可见性', locked: true, hidden: true });
    const node = findById(store.getState().dsl.tree, 'el-12');
    expect(node?.name).toBe('密码可见性');
    expect(node?.locked).toBe(true);
    expect(node?.hidden).toBe(true);
  });

  it('setResponsive 写入断点差异属性，传 null 删除', () => {
    const store = setup();
    store.getState().setResponsive('el-5', '768', { width: 320 });
    expect(findById(store.getState().dsl.tree, 'el-5')?.responsive).toEqual({ '768': { width: 320 } });
    store.getState().setResponsive('el-5', '768', null);
    expect(findById(store.getState().dsl.tree, 'el-5')?.responsive).toBeUndefined();
  });

  it('页面级写入：元信息 / 状态 / 事件 / 接口依赖 / 锚点', () => {
    const store = setup();
    store.getState().updatePageMeta({ name: '登录（新版）', route: '/signin' });
    expect(store.getState().dsl.name).toBe('登录（新版）');
    expect(store.getState().dsl.route).toBe('/signin');

    store.getState().setPageStateVars([{ name: 'a', type: 'string' }]);
    expect(store.getState().dsl.state).toEqual([{ name: 'a', type: 'string' }]);

    store.getState().setPageEvents([]);
    expect(store.getState().dsl.events).toEqual([]);

    store.getState().setApiDeps(['/api/a', '/api/a', '/api/b']);
    expect(store.getState().dsl.apiDeps).toEqual(['/api/a', '/api/b']);

    store.getState().setAnchors({});
    expect(store.getState().dsl.anchors).toEqual({});
    expect(store.getState().undoState.undoDepth).toBe(5);
  });

  it('markSaved 清除脏标记但不影响历史', () => {
    const store = setup();
    store.getState().updateProps('el-7', { text: 'x' });
    store.getState().markSaved();
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().undoState.undoDepth).toBe(1);
  });
});

describe('编辑器内核：选中元素读写辅助', () => {
  it('apply 是通用入口，可直接改 draft', () => {
    const store = setup();
    store.getState().select(['el-1']);
    store.getState().apply('注入根节点样式', (draft) => {
      draft.tree.style = { ...(draft.tree.style ?? {}), padding: 24 };
    });
    expect(store.getState().dsl.tree.style?.['padding']).toBe(24);
  });

  it('createDefaultElement 产出可插入的最小节点', () => {
    const node = createDefaultElement('Text', () => 'el-t');
    expect(node).toEqual(createElement({ id: 'el-t', type: 'Text' }));
  });
});
