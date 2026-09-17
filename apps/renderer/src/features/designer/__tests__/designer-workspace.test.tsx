import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DesignerPage } from '../../../pages/DesignerPage';

/**
 * 设计器工作区集成测试（Wave 3 出口检查 E2E-04 的自动化替身）。
 *
 * 覆盖：20 元素登录页渲染、组件面板拖入、三向联动、撤销/重做、快照存档、分区切换。
 */
describe('设计器工作区', () => {
  it('渲染登录页 20 个元素与三栏布局', () => {
    const { container } = render(<DesignerPage />);
    expect(screen.getByTestId('designer-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('designer-left')).toBeInTheDocument();
    expect(screen.getByTestId('designer-center')).toBeInTheDocument();
    expect(screen.getByTestId('designer-right')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-element-id]')).toHaveLength(20);
    expect(screen.getByText(/元素 20 个/)).toBeInTheDocument();
  });

  it('组件面板按分组列出 15 类内置组件', () => {
    render(<DesignerPage />);
    const palette = screen.getByTestId('component-palette');
    expect(within(palette).getAllByRole('button').length).toBe(15);
    expect(screen.getByTestId('palette-item-Button')).toBeInTheDocument();
    expect(screen.getByTestId('palette-item-ListPageTemplate')).toBeInTheDocument();
  });

  it('从组件面板加入元素：进入 DSL、选中新元素、可撤销', () => {
    const { container } = render(<DesignerPage />);
    fireEvent.click(screen.getByTestId('palette-item-Button'));
    expect(container.querySelectorAll('[data-element-id]')).toHaveLength(21);
    expect(screen.getByText(/已选 1 个/)).toBeInTheDocument();

    // 工具栏与属性面板各有一个「撤销」按钮，取工具栏那个
    fireEvent.click(screen.getAllByRole('button', { name: '撤销' })[0] as HTMLElement);
    expect(container.querySelectorAll('[data-element-id]')).toHaveLength(20);
  });

  it('三向联动：点选画布元素后属性面板同步展示', () => {
    render(<DesignerPage />);
    fireEvent.click(screen.getByTestId('element-el-15'));
    expect(screen.getByTestId('inspector-title')).toHaveTextContent('登录按钮');
  });

  it('图层树可切换并展示元素层级', () => {
    render(<DesignerPage />);
    fireEvent.click(screen.getByTestId('left-tab-layers'));
    expect(document.querySelector('[data-layer-id="el-15"]')).not.toBeNull();
  });

  it('右栏可在属性 / 状态 / 历史 / 一致性之间切换', () => {
    render(<DesignerPage />);
    fireEvent.click(screen.getByTestId('right-tab-state'));
    expect(screen.getByText('页面状态')).toBeInTheDocument();
    expect(screen.getByTestId('state-phone')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('right-tab-history'));
    expect(screen.getByTestId('timeline')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('right-tab-consistency'));
    expect(screen.getByTestId('consistency-panel')).toBeInTheDocument();
  });

  it('存档按钮生成快照并跳转到历史时间轴', () => {
    render(<DesignerPage />);
    fireEvent.click(screen.getByTestId('capture-snapshot'));
    expect(screen.getByTestId('timeline')).toBeInTheDocument();
    expect(screen.getByText('手动快照')).toBeInTheDocument();
  });

  it('栅格开关与断点切换条可用', () => {
    render(<DesignerPage />);
    expect(screen.getByTestId('grid-overlay')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '切换栅格' }));
    expect(screen.queryByTestId('grid-overlay')).toBeNull();

    expect(screen.getByTestId('breakpoint-1440')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('breakpoint-375'));
    expect(screen.getByTestId('breakpoint-375')).toHaveAttribute('aria-checked', 'true');
  });

  it('切换目标端机型后画布尺寸跟随变化', () => {
    render(<DesignerPage />);
    expect(screen.getByTestId('canvas-surface')).toHaveStyle({ width: '1440px' });
    fireEvent.click(screen.getByLabelText('目标端与机型'));
    fireEvent.click(screen.getByRole('option', { name: 'iPhone 15' }));
    expect(screen.getByTestId('canvas-surface')).toHaveStyle({ width: '390px' });
  });
});
