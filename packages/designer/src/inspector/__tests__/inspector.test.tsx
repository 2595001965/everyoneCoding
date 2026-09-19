import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoginPageDsl } from '../../dsl/factory';
import { findById } from '../../dsl/traverse';
import type { PageDsl } from '../../dsl/types';
import { registerBuiltinComponents } from '../../components';
import { componentRegistry, ComponentRegistry } from '../../registry/component-registry';
import { defineSchema, type PropField } from '../../registry/prop-schema';
import { DesignerProvider } from '../../store/designer-context';
import { createEditorStore } from '../../store/editor-store';
import { Inspector } from '../Inspector';
import { PropFieldControl, SchemaForm } from '../SchemaForm';

afterEach(() => {
  componentRegistry.clear();
  registerBuiltinComponents();
});

/** 独立的 schema 测例：覆盖全部控件类型 */
const ALL_TYPES_SCHEMA = defineSchema([
  { key: 'text', label: '文本', type: 'text', group: '内容' },
  { key: 'area', label: '长文本', type: 'textarea', group: '内容' },
  { key: 'num', label: '数值', type: 'number', group: '内容' },
  { key: 'flag', label: '开关', type: 'boolean', group: '内容' },
  { key: 'color', label: '颜色', type: 'color', group: '外观' },
  { key: 'size', label: '尺寸', type: 'size', group: '布局' },
  { key: 'space', label: '间距', type: 'spacing', group: '间距' },
  { key: 'shadow', label: '阴影', type: 'shadow', group: '边框' },
  { key: 'border', label: '边框', type: 'border', group: '边框' },
  { key: 'data', label: '数据', type: 'json', group: '高级' },
  { key: 'cols', label: '列', type: 'columns', group: '数据' },
  { key: 'img', label: '图片', type: 'image', group: '内容' },
  { key: 'opts', label: '选项', type: 'options', group: '数据' },
  {
    key: 'mode',
    label: '模式',
    type: 'enum',
    group: '外观',
    options: [
      { value: 'a', label: '甲' },
      { value: 'b', label: '乙' },
    ],
  },
]);

describe('T3-05 SchemaForm 自动表单', () => {
  it('覆盖全部 14 种控件类型', () => {
    render(
      <SchemaForm
        schema={ALL_TYPES_SCHEMA}
        values={{ mode: 'a' }}
        onChange={() => undefined}
        debounceMs={0}
      />,
    );
    for (const field of ALL_TYPES_SCHEMA.fields) {
      expect(screen.getByTestId(`prop-field-${field.key}`), `${field.type} 未渲染`).toHaveAttribute(
        'data-field-type',
        field.type,
      );
    }
    expect(screen.getByTestId('schema-form')).toBeInTheDocument();
  });

  it('分组折叠：点击分组头收起字段', () => {
    render(
      <SchemaForm
        schema={ALL_TYPES_SCHEMA}
        values={{}}
        onChange={() => undefined}
        debounceMs={0}
      />,
    );
    const head = screen.getByTestId('schema-group-内容');
    expect(head).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('prop-field-text')).toBeNull();
  });

  it('visibleWhen 条件显隐生效', () => {
    const schema = defineSchema([
      {
        key: 'variant',
        label: '风格',
        type: 'enum',
        group: '外观',
        options: [{ value: 'primary', label: '主' }],
      },
      {
        key: 'block',
        label: '撑满',
        type: 'boolean',
        group: '外观',
        visibleWhen: { field: 'variant', equals: 'primary' },
      },
    ]);
    const { rerender } = render(
      <SchemaForm
        schema={schema}
        values={{ variant: 'ghost' }}
        onChange={() => undefined}
        debounceMs={0}
      />,
    );
    expect(screen.queryByTestId('prop-field-block')).toBeNull();
    rerender(
      <SchemaForm
        schema={schema}
        values={{ variant: 'primary' }}
        onChange={() => undefined}
        debounceMs={0}
      />,
    );
    expect(screen.getByTestId('prop-field-block')).toBeInTheDocument();
  });

  it('各控件类型产出正确类型的值', () => {
    const onChange = vi.fn();
    const field = (key: string): PropField =>
      ALL_TYPES_SCHEMA.fields.find((item) => item.key === key) as PropField;

    const { rerender } = render(
      <PropFieldControl
        field={field('num')}
        value={1}
        disabled={false}
        debounceMs={0}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('数值'), { target: { value: '42' } });
    expect(onChange).toHaveBeenLastCalledWith(42);

    rerender(
      <PropFieldControl
        field={field('flag')}
        value={false}
        disabled={false}
        debounceMs={0}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('开关'));
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(
      <PropFieldControl
        field={field('mode')}
        value="a"
        disabled={false}
        debounceMs={0}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('模式'));
    fireEvent.click(screen.getByRole('option', { name: '乙' }));
    expect(onChange).toHaveBeenLastCalledWith('b');

    // JSON 字段：合法才回写，非法给告警
    rerender(
      <PropFieldControl
        field={field('data')}
        value={{ a: 1 }}
        disabled={false}
        debounceMs={0}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('数据'), { target: { value: '{ 坏 JSON' } });
    expect(screen.getByRole('alert')).toHaveTextContent('JSON 格式不正确');
    fireEvent.change(screen.getByLabelText('数据'), { target: { value: '{"b":2}' } });
    expect(onChange).toHaveBeenLastCalledWith({ b: 2 });
  });

  it('文本类输入 200ms 防抖：连续输入只提交一次', () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      render(
        <SchemaForm
          schema={defineSchema([{ key: 'text', label: '文本', type: 'text', group: '内容' }])}
          values={{ text: '' }}
          onChange={onChange}
          debounceMs={200}
        />,
      );
      const input = screen.getByLabelText('文本');
      fireEvent.change(input, { target: { value: '登' } });
      fireEvent.change(input, { target: { value: '登录' } });
      fireEvent.change(input, { target: { value: '登录页' } });
      expect(onChange).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(199);
      });
      expect(onChange).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('text', '登录页', { coalesceKey: 'prop:text' });
    } finally {
      vi.useRealTimers();
    }
  });
});

function setupInspector(reset = true) {
  if (reset) {
    componentRegistry.clear();
    registerBuiltinComponents(componentRegistry);
  }
  const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 5000 });
  render(
    <DesignerProvider store={store}>
      <Inspector store={store} debounceMs={0} />
    </DesignerProvider>,
  );
  return store;
}

describe('T3-05 属性面板：六类分区', () => {
  it('未选中元素时展示空态', () => {
    const store = createEditorStore({ dsl: createLoginPageDsl() });
    render(
      <DesignerProvider store={store}>
        <Inspector store={store} />
      </DesignerProvider>,
    );
    expect(screen.getByText('未选中元素')).toBeInTheDocument();
  });

  it('单选展示元素名与类型，六个分区均可切换并渲染', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-15']);
    });
    expect(screen.getByTestId('inspector-title')).toHaveTextContent('登录按钮');

    for (const [tab, label] of [
      ['content', '内容'],
      ['style', '样式'],
      ['binding', '数据'],
      ['event', '事件'],
      ['condition', '条件'],
      ['permission', '权限'],
    ] as const) {
      fireEvent.click(screen.getByRole('tab', { name: label }));
      expect(screen.getByTestId(`inspector-panel-${tab}`)).toBeInTheDocument();
    }
  });

  it('内容分区：改属性即时生效且可撤销（Ctrl+Z）', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-15']);
    });
    fireEvent.change(screen.getByLabelText('按钮文字'), { target: { value: '立即登录' } });
    expect(findById(store.getState().dsl.tree, 'el-15')?.props?.['text']).toBe('立即登录');

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(findById(store.getState().dsl.tree, 'el-15')?.props?.['text']).toBe('登录');

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(findById(store.getState().dsl.tree, 'el-15')?.props?.['text']).toBe('立即登录');
  });

  it('样式分区：改圆角即时生效，连续输入合并为一步 undo', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-5']);
    });
    fireEvent.click(screen.getByRole('tab', { name: '样式' }));
    const depthBefore = store.getState().undoState.undoDepth;

    const radius = screen.getByLabelText('圆角（px）');
    fireEvent.change(radius, { target: { value: '8' } });
    fireEvent.change(radius, { target: { value: '12' } });
    expect(findById(store.getState().dsl.tree, 'el-5')?.style?.['borderRadius']).toBe('12');
    expect(store.getState().undoState.undoDepth).toBe(depthBefore + 1);

    store.getState().undo();
    expect(findById(store.getState().dsl.tree, 'el-5')?.style?.['borderRadius']).toBe(12);
  });

  it('数据分区：绑定状态字段写入 bindings', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-15']);
    });
    fireEvent.click(screen.getByRole('tab', { name: '数据' }));
    // value 属性的数据源树里选择 loading（状态）
    const section = screen.getByTestId('binding-value');
    fireEvent.click(within(section).getByText('loading'));
    expect(findById(store.getState().dsl.tree, 'el-15')?.bindings?.['value']).toBe('loading');
  });

  it('事件分区：内嵌动作流编辑器可保存', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-15']);
    });
    fireEvent.click(screen.getByRole('tab', { name: '事件' }));
    expect(screen.getByTestId('event-panel')).toBeInTheDocument();
    expect(screen.getByText('动作流编辑器')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('palette-notify'));
    fireEvent.click(screen.getByTestId('flow-save'));
    expect((store.getState().dsl.events[0]?.actions ?? []).length).toBe(6);
  });

  it('条件分区：结构化条件树写入 DSL，不使用 eval', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-12']);
    });
    fireEvent.click(screen.getByRole('tab', { name: '条件' }));
    fireEvent.click(screen.getByRole('button', { name: '添加条件' }));
    fireEvent.change(screen.getByLabelText('字段路径'), { target: { value: 'user.role' } });
    fireEvent.change(screen.getByLabelText('比较值'), { target: { value: 'admin' } });

    const condition = findById(store.getState().dsl.tree, 'el-12')?.condition;
    expect(condition).toEqual({ op: 'eq', left: 'user.role', right: 'admin' });
    // 结构化输出（可断言、可序列化）
    expect(screen.getByTestId('condition-structured')).toHaveTextContent('"op":"eq"');
  });

  it('权限分区：角色与权限类型写入 DSL', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-12']);
    });
    fireEvent.click(screen.getByRole('tab', { name: '权限' }));
    fireEvent.change(screen.getByLabelText('允许的角色'), { target: { value: 'admin, owner' } });
    fireEvent.click(screen.getByLabelText('权限类型'));
    fireEvent.click(screen.getByRole('option', { name: '控制可编辑' }));

    const permission = findById(store.getState().dsl.tree, 'el-12')?.permission;
    expect(permission?.roles).toEqual(['admin', 'owner']);
    expect(permission?.mode).toBe('editable');
  });
});

describe('T3-05 属性面板：多选批量修改', () => {
  it('多选只展示公共属性，修改批量应用且只占一步 undo', () => {
    const store = setupInspector();
    // el-10 / el-11 都是 Input，且 props 不同（placeholder / inputType 不同）
    act(() => {
      store.getState().select(['el-10', 'el-11']);
    });
    expect(screen.getByTestId('inspector-title')).toHaveTextContent('已选 2 个元素');

    // 两者的公共属性只有 required（placeholder / inputType 不同）
    const depthBefore = store.getState().undoState.undoDepth;
    // 布尔字段：FieldShell 是 label，内层 Checkbox 自身也可能是 label，直接按 role 取控件
    fireEvent.click(screen.getByRole('checkbox'));
    const required = (id: string): unknown =>
      findById(store.getState().dsl.tree, id)?.props?.['required'];
    // 夹具中两者 required 均为 true，点击后同时变为 false
    expect(required('el-10')).toBe(false);
    expect(required('el-11')).toBe(false);
    expect(store.getState().undoState.undoDepth).toBe(depthBefore + 1);
  });

  it('多选时非公共属性不出现在表单里', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-10', 'el-11']);
    });
    // placeholder 在两者上不同，因此不作为公共属性展示
    expect(screen.queryByTestId('prop-field-placeholder')).toBeNull();
  });

  it('未选中任何元素时批量修改不产生撤销步', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select([]);
    });
    expect(store.getState().undoState.undoDepth).toBe(0);
  });
});

describe('T3-05 三向联动', () => {
  it('画布 / 图层树改选中后，属性面板同步展示该元素', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-8']);
    });
    expect(screen.getByTestId('inspector-title')).toHaveTextContent('副标题');

    act(() => {
      store.getState().select(['el-19']);
    });
    expect(screen.getByTestId('inspector-title')).toHaveTextContent('页脚');
  });

  it('元素被删后属性面板回到空态', () => {
    const store = setupInspector();
    act(() => {
      store.getState().select(['el-12']);
    });
    expect(screen.getByTestId('inspector-title')).toHaveTextContent('密码可见切换');
    act(() => {
      store.getState().removeElements(['el-12']);
    });
    expect(screen.getByText('未选中元素')).toBeInTheDocument();
  });
});

describe('T3-05 未注册组件的兜底', () => {
  it('未注册类型可切到 JSON 编辑 props', () => {
    const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 0 });
    act(() => {
      const dsl = store.getState().dsl;
      const next: PageDsl = {
        ...dsl,
        tree: {
          ...dsl.tree,
          children: [
            ...(dsl.tree.children ?? []),
            { id: 'unknown-1', type: 'Widget', props: { a: 1 } },
          ],
        },
      };
      store.getState().loadDsl(next);
    });
    render(
      <DesignerProvider store={store}>
        <Inspector store={store} debounceMs={0} />
      </DesignerProvider>,
    );
    act(() => {
      store.getState().select(['unknown-1']);
    });
    expect(screen.getByText('未注册的组件')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toggle-raw-props'));
    fireEvent.change(screen.getByLabelText('属性（JSON）'), { target: { value: '{"b":2}' } });
    expect(findById(store.getState().dsl.tree, 'unknown-1')?.props).toEqual({ b: 2 });
  });

  it('自定义注册组件后属性面板能自动生成表单', () => {
    componentRegistry.clear();
    const registry = new ComponentRegistry();
    registerBuiltinComponents(registry);
    registry.register({
      meta: {
        type: 'MyBadge',
        displayName: '我的徽标',
        group: '自定义',
        icon: 'badge',
        defaultProps: { text: '徽标' },
        defaultStyle: {},
        acceptsChildren: false,
        propSchema: defineSchema([{ key: 'text', label: '文本', type: 'text', group: '内容' }]),
      },
    });
    // 把自定义注册表内容搬到全局单例（组件面板与属性面板都读全局）
    for (const meta of registry.list()) componentRegistry.override({ meta });

    const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 0 });
    act(() => {
      const dsl = store.getState().dsl;
      store.getState().loadDsl({
        ...dsl,
        tree: {
          ...dsl.tree,
          children: [...(dsl.tree.children ?? []), { id: 'badge-1', type: 'MyBadge' }],
        },
      });
      store.getState().select(['badge-1']);
    });
    render(
      <DesignerProvider store={store}>
        <Inspector store={store} debounceMs={0} />
      </DesignerProvider>,
    );
    expect(screen.getByTestId('prop-field-text')).toBeInTheDocument();
  });
});
