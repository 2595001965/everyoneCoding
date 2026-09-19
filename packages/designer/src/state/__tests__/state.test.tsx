import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createLoginPageDsl } from '../../dsl/factory';
import { findById } from '../../dsl/traverse';
import { getDataSources } from '../../shared/data-source';
import { DesignerProvider } from '../../store/designer-context';
import { createEditorStore } from '../../store/editor-store';
import {
  BindingPicker,
  expandStateShape,
  listAllBindingPaths,
  valueToField,
} from '../BindingPicker';
import { StateEditor, validateStateVar, type StateVarDraft } from '../StateEditor';
import { StatePanel } from '../StatePanel';
import { StateStore } from '../StateStore';

/** @ec/ui 的 Select 是自绘组合框：先点开再选选项 */
function selectOption(ariaLabel: string, optionLabel: string): void {
  fireEvent.click(screen.getByLabelText(ariaLabel));
  fireEvent.click(screen.getByRole('option', { name: optionLabel }));
}

describe('T3-08 运行时 StateStore', () => {
  it('按路径读写，支持对象与数组下标', () => {
    const store = new StateStore({ user: { list: [{ name: '张三' }] }, count: 1 });
    expect(store.get('user.list[0].name')).toBe('张三');
    store.set('user.list[0].name', '李四');
    expect(store.get('user.list[0].name')).toBe('李四');
    store.set('count', 2);
    expect(store.get('count')).toBe(2);
  });

  it('中间层缺失时自动补全容器', () => {
    const store = new StateStore();
    store.set('user.profile.tags[0]', 'vip');
    expect(store.get('user.profile.tags[0]')).toBe('vip');
  });

  it('订阅 / 取消订阅 / 重置', () => {
    const store = new StateStore({ a: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set('a', 2);
    expect(listener).toHaveBeenCalledWith({ a: 2 });

    unsubscribe();
    store.set('a', 3);
    expect(listener).toHaveBeenCalledTimes(1);

    const seen = vi.fn();
    store.subscribe(seen);
    store.reset({ b: 9 });
    expect(store.snapshot()).toEqual({ b: 9 });
    expect(seen).toHaveBeenCalledWith({ b: 9 });

    store.reset();
    expect(store.snapshot()).toEqual({});
  });

  it('patch 浅合并顶层字段', () => {
    const store = new StateStore({ a: 1, b: 2 });
    store.patch({ b: 3, c: 4 });
    expect(store.snapshot()).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('初始值深拷贝：外部对象改动不会污染运行时状态', () => {
    const initial = { list: [{ name: 'a' }] };
    const store = new StateStore(initial);
    initial.list[0]!.name = '改过了';
    expect(store.get('list[0].name')).toBe('a');
    expect(store.snapshot()).not.toBe(initial);
  });

  it('非法路径被忽略且不通知（不抛异常）', () => {
    const store = new StateStore({ a: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set('', 1);
    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual({ a: 1 });
  });
});

describe('T3-08 状态变量校验', () => {
  const base: StateVarDraft = {
    name: 'count',
    type: 'number',
    source: 'local',
    apiRef: '',
    description: '',
    initialRaw: '0',
  };

  it('名称必填 / 合法字符 / 不允许重名', () => {
    expect(validateStateVar({ ...base, name: '  ' }, [])).toMatchObject({
      name: '状态名称不能为空',
    });
    expect(validateStateVar({ ...base, name: '1abc' }, [])).toMatchObject({
      name: expect.stringContaining('字母或中文开头'),
    });
    expect(validateStateVar({ ...base, name: 'count' }, ['count'])).toMatchObject({
      name: '状态名称已存在，请更换一个',
    });
    expect(validateStateVar(base, [])).toEqual({});
  });

  it('来源为接口时必须选关联接口', () => {
    expect(validateStateVar({ ...base, source: 'api' }, [])).toMatchObject({
      apiRef: '来源为接口时必须选择关联接口',
    });
    expect(validateStateVar({ ...base, source: 'api', apiRef: '/api/x' }, [])).toEqual({});
  });

  it('类型与初值必须匹配（覆盖 string/number/boolean/object/array）', () => {
    expect(validateStateVar({ ...base, type: 'number', initialRaw: 'abc' }, [])).toMatchObject({
      initial: '初值必须为合法数字',
    });
    expect(validateStateVar({ ...base, type: 'number', initialRaw: '' }, [])).toMatchObject({
      initial: '请填写数字初值',
    });
    expect(validateStateVar({ ...base, type: 'object', initialRaw: '[1]' }, [])).toMatchObject({
      initial: '初值必须是合法 JSON 对象',
    });
    expect(validateStateVar({ ...base, type: 'object', initialRaw: '{"a":1}' }, [])).toEqual({});
    expect(validateStateVar({ ...base, type: 'array', initialRaw: '{"a":1}' }, [])).toMatchObject({
      initial: '初值必须是合法 JSON 数组',
    });
    expect(validateStateVar({ ...base, type: 'array', initialRaw: '[1,2]' }, [])).toEqual({});
    expect(validateStateVar({ ...base, type: 'string', initialRaw: '文本' }, [])).toEqual({});
    expect(validateStateVar({ ...base, type: 'boolean', initialRaw: 'true' }, [])).toEqual({});
  });
});

describe('T3-08 数据源与绑定路径', () => {
  it('expandStateShape 展开 object / array 结构为字段树', () => {
    expect(expandStateShape({ name: 'count', type: 'number', initial: 0 })).toMatchObject({
      name: 'count',
      type: 'number',
    });
    const obj = expandStateShape({ name: 'form', type: 'object', initial: { phone: '', age: 0 } });
    expect(obj?.children?.map((child) => child.name)).toEqual(['phone', 'age']);

    const arr = expandStateShape({ name: 'list', type: 'array', initial: [{ id: 1 }] });
    expect(arr?.children?.length).toBeGreaterThan(0);
  });

  it('valueToField 依据运行时值推断类型', () => {
    expect(valueToField('a', 'x')).toMatchObject({ type: 'string' });
    expect(valueToField('b', 1)).toMatchObject({ type: 'number' });
    expect(valueToField('c', true)).toMatchObject({ type: 'boolean' });
    expect(valueToField('d', [])).toMatchObject({ type: 'array' });
    expect(valueToField('e', {})).toMatchObject({ type: 'object' });
  });

  it('listAllBindingPaths 汇总状态与接口路径', () => {
    const paths = listAllBindingPaths(getDataSources(createLoginPageDsl()));
    expect(paths).toContain('phone');
    expect(paths).toContain('loading');
  });

  it('BindingPicker 选择路径后回调 onBind；非法手输路径给中文错误', async () => {
    const onBind = vi.fn();
    const catalog = getDataSources(createLoginPageDsl());
    render(<BindingPicker catalog={catalog} property="value" value="" onBind={onBind} />);

    // 数据源树以「属性名 数据源」为 aria-label
    fireEvent.click(screen.getByText('phone'));
    expect(onBind).toHaveBeenCalledWith('value', 'phone');

    const manual = screen.getByLabelText('手动输入绑定路径');
    fireEvent.change(manual, { target: { value: 'a..b' } });
    fireEvent.click(screen.getByRole('button', { name: '绑定' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/路径|非法|格式/);
    expect(onBind).toHaveBeenCalledTimes(1);

    // 合法路径可绑定
    fireEvent.change(manual, { target: { value: 'user.list[0].name' } });
    fireEvent.click(screen.getByRole('button', { name: '绑定' }));
    expect(onBind).toHaveBeenLastCalledWith('value', 'user.list[0].name');
    expect(onBind).toHaveBeenCalledTimes(2);
  });

  it('已绑定时显示回显并提供清除绑定', () => {
    const onUnbind = vi.fn();
    const catalog = getDataSources(createLoginPageDsl());
    render(
      <BindingPicker
        catalog={catalog}
        property="value"
        value="phone"
        onBind={() => undefined}
        onUnbind={onUnbind}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(onUnbind).toHaveBeenCalledWith('value');
  });
});

describe('T3-08 属性面板的绑定分区与引用检查', () => {
  function setup() {
    const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 0 });
    render(
      <DesignerProvider store={store}>
        <StatePanel />
      </DesignerProvider>,
    );
    return store;
  }

  it('列出全部页面状态并可新增（进撤销栈）', () => {
    const store = setup();
    expect(screen.getByTestId('state-phone')).toBeInTheDocument();
    expect(screen.getByTestId('state-loading')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^state-/).length).toBe(5);

    fireEvent.click(screen.getByRole('button', { name: '新增状态' }));
    fireEvent.change(screen.getByLabelText('状态名称'), { target: { value: 'captcha' } });
    selectOption('状态类型', '文本');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(store.getState().dsl.state.map((item) => item.name)).toContain('captcha');
    expect(store.getState().undoState.undoDepth).toBeGreaterThan(0);
  });

  it('编辑器保存后清空绑定无关字段：类型不匹配时不落库', () => {
    const store = setup();
    fireEvent.click(screen.getByRole('button', { name: '新增状态' }));
    fireEvent.change(screen.getByLabelText('状态名称'), { target: { value: 'num' } });
    selectOption('状态类型', '数字');
    fireEvent.change(screen.getByLabelText('初值'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    // number 类型的原生 input 会丢弃非数字输入，因此报"请填写数字初值"
    expect(screen.getByRole('alert')).toHaveTextContent(/初值/);
    expect(store.getState().dsl.state.map((item) => item.name)).not.toContain('num');
  });

  it('删除未被引用的状态直接生效（无警告弹窗）', () => {
    const store = setup();
    // 先新增一个没有任何元素引用的状态
    fireEvent.click(screen.getByRole('button', { name: '新增状态' }));
    fireEvent.change(screen.getByLabelText('状态名称'), { target: { value: 'tempUnused' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(store.getState().dsl.state.map((item) => item.name)).toContain('tempUnused');

    fireEvent.click(screen.getByLabelText('删除 tempUnused'));
    expect(store.getState().dsl.state.map((item) => item.name)).not.toContain('tempUnused');
    expect(screen.queryByTestId('reference-warning')).toBeNull();
  });

  it('编辑已有状态时不会因为「与自身重名」被拒', () => {
    const store = setup();
    fireEvent.click(screen.getByLabelText('编辑 phone'));
    fireEvent.change(screen.getByLabelText('状态描述'), { target: { value: '手机号' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    const phone = store.getState().dsl.state.find((item) => item.name === 'phone');
    expect(phone?.description).toBe('手机号');
  });

  it('删除被引用的状态：先警告并列出引用元素，可点击跳转，确认后清理绑定', () => {
    const store = setup();
    // el-15（登录按钮）的 disabled 绑定到 loading
    expect(findById(store.getState().dsl.tree, 'el-15')?.bindings).toEqual({ disabled: 'loading' });

    fireEvent.click(screen.getByLabelText('删除 loading'));
    expect(screen.getByTestId('reference-warning')).toBeInTheDocument();
    expect(store.getState().dsl.state.map((item) => item.name)).toContain('loading');

    // 引用元素可点击跳转（选中）
    fireEvent.click(screen.getByTestId('ref-item-el-15'));
    expect(store.getState().selectedIds).toEqual(['el-15']);

    fireEvent.click(screen.getByTestId('confirm-delete'));
    expect(store.getState().dsl.state.map((item) => item.name)).not.toContain('loading');
    expect(findById(store.getState().dsl.tree, 'el-15')?.bindings).toBeUndefined();
  });

  it('StateEditor 单独使用：取消不回调，保存回调草稿', () => {
    const onChange = vi.fn();
    const onCancel = vi.fn();
    render(<StateEditor existingNames={[]} onChange={onChange} onCancel={onCancel} />);
    fireEvent.change(screen.getByLabelText('状态名称'), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'ok', type: 'string' }));
  });
});
