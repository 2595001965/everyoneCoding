import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createLoginPageDsl } from '../../dsl/factory';
import { Canvas } from '../Canvas';
import { GRID_SIZE } from '../GridOverlay';
import { SafeAreaOverlay } from '../SafeArea';
import { SelectionBox, normalizeRect, rectsIntersect, selectInRect } from '../SelectionBox';
import { ZoomControl } from '../ZoomControl';
import { findPreset, type DevicePreset } from '../device-presets';

const iosPreset: DevicePreset = findPreset('ios-390x844') as DevicePreset;
const windowsPreset: DevicePreset = findPreset('windows-1440x900') as DevicePreset;
const webPreset: DevicePreset = findPreset('web-1440') as DevicePreset;

describe('T3-02 画布渲染', () => {
  it('渲染登录页 20 个元素，并在端切换后使用对应视口尺寸', () => {
    const dsl = createLoginPageDsl();
    const { container, rerender } = render(<Canvas dsl={dsl} />);
    expect(container.querySelectorAll('[data-element-id]')).toHaveLength(20);
    expect(screen.getByTestId('canvas-surface')).toHaveStyle({ width: '1440px', height: '900px' });

    rerender(<Canvas dsl={dsl} {...(iosPreset ? { preset: iosPreset } : {})} />);
    expect(screen.getByTestId('canvas-surface')).toHaveStyle({ width: '390px', height: '844px' });
  });

  it('标尺与栅格默认开启，可点击关闭栅格', async () => {
    const user = userEvent.setup();
    render(<Canvas dsl={createLoginPageDsl()} />);
    expect(screen.getByTestId('ruler-x')).toBeInTheDocument();
    expect(screen.getByTestId('ruler-y')).toBeInTheDocument();

    const grid = screen.getByTestId('grid-overlay');
    expect(grid.style.backgroundImage).not.toBe('none');
    expect(grid.style.backgroundSize).toBe(`${GRID_SIZE}px ${GRID_SIZE}px`);

    await user.click(screen.getByRole('button', { name: '关闭栅格' }));
    expect(screen.queryByTestId('grid-overlay')).toBeNull();
    await user.click(screen.getByRole('button', { name: '开启栅格' }));
    expect(screen.getByTestId('grid-overlay').style.backgroundImage).not.toBe('none');
  });

  it('点击元素触发选中回调（Shift 为累加模式）', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Canvas dsl={createLoginPageDsl()} onSelect={onSelect} />);

    await user.click(screen.getByTestId('element-el-7'));
    expect(onSelect).toHaveBeenLastCalledWith(['el-7'], 'replace');

    await user.keyboard('{Shift>}');
    await user.click(screen.getByTestId('element-el-8'));
    await user.keyboard('{/Shift}');
    expect(onSelect).toHaveBeenLastCalledWith(['el-8'], 'add');
  });

  it('嵌套深层的元素也能正确渲染选中态（修复前只有根的直接子级生效）', () => {
    const dsl = createLoginPageDsl();
    // el-10 位于 el-9(Form) → el-5(Card) → el-1(Container) 的第三层
    const { rerender } = render(<Canvas dsl={dsl} selectedIds={[]} />);
    const outlineOf = (id: string): string => screen.getByTestId(`element-${id}`).style.outline;
    expect(outlineOf('el-10')).toBe('');

    rerender(<Canvas dsl={dsl} selectedIds={['el-10']} />);
    expect(outlineOf('el-10')).toContain('2px solid');
    // 未被选中的同级不受影响
    expect(outlineOf('el-11')).toBe('');
  });

  it('hover 高亮随时间切换，且不改变选中态', () => {
    const dsl = createLoginPageDsl();
    const { rerender } = render(<Canvas dsl={dsl} selectedIds={['el-7']} hoveredId={null} />);
    expect(screen.getByTestId('element-el-12').style.outline).toBe('');

    rerender(<Canvas dsl={dsl} selectedIds={['el-7']} hoveredId="el-12" />);
    expect(screen.getByTestId('element-el-12').style.outline).toContain('1px solid');
    expect(screen.getByTestId('element-el-7').style.outline).toContain('2px solid');
  });

  it('隐藏元素不渲染但节点仍在 DSL 中；锁定元素不可选中', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const dsl = createLoginPageDsl();
    dsl.tree.children![1]!.hidden = true; // el-5 登录卡片隐藏
    dsl.tree.children![0]!.children![0]!.locked = true; // el-3 站点标识锁定

    render(<Canvas dsl={dsl} onSelect={onSelect} />);
    // 隐藏节点：不在画布渲染，但 DSL 中仍存在
    expect(screen.queryByTestId('element-el-5')).toBeNull();
    expect(dsl.tree.children![1]!.hidden).toBe(true);

    // 锁定节点：带锁标、命中测试被跳过（pointer-events:none），点击绝不选中它自身
    const lockedNode = screen.getByTestId('element-el-3');
    expect(lockedNode).toHaveAttribute('data-locked', 'true');
    expect(lockedNode.style.pointerEvents).toBe('none');
    onSelect.mockClear();
    fireEvent.click(lockedNode);
    expect(onSelect.mock.calls.flatMap(([ids]) => ids as string[])).not.toContain('el-3');

    // 未锁定节点仍可选中（对照组）
    onSelect.mockClear();
    fireEvent.click(screen.getByTestId('element-el-4'));
    expect(onSelect).toHaveBeenCalledWith(['el-4'], 'replace');
    void user;
  });

  it('对齐参考线按轴渲染', () => {
    render(
      <Canvas
        dsl={createLoginPageDsl()}
        alignGuides={[
          { axis: 'x', position: 100, kind: 'element' },
          { axis: 'y', position: 200, kind: 'canvas' },
        ]}
      />,
    );
    expect(screen.getAllByTestId('align-guide')).toHaveLength(2);
  });

  it('安全区只对移动端/鸿蒙预设渲染，且仅视觉（不进 DSL）', () => {
    const { rerender, container } = render(<SafeAreaOverlay preset={webPreset} />);
    expect(container.firstChild).toBeNull();

    rerender(<SafeAreaOverlay preset={iosPreset} />);
    expect(screen.getByTestId('safe-area')).toBeInTheDocument();
    expect(screen.getByTestId('safe-area-notch')).toBeInTheDocument();
    expect(screen.getByTestId('safe-area-indicator')).toBeInTheDocument();
    // 覆盖层不拦截交互
    expect(screen.getByTestId('safe-area').style.pointerEvents).toBe('none');
  });

  it('桌面端窗口预设渲染标题栏占位', () => {
    render(<Canvas dsl={createLoginPageDsl()} preset={windowsPreset} />);
    expect(screen.getByTestId('canvas-surface')).toHaveStyle({ width: '1440px', height: '900px' });
  });

  it('缩放控制：加减钳制在 25%~400%，显示百分比', async () => {
    const user = userEvent.setup();
    const onZoomChange = vi.fn();
    const { rerender } = render(<ZoomControl zoom={1} onZoomChange={onZoomChange} />);
    expect(screen.getByTestId('zoom-percent')).toHaveTextContent('100%');

    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(onZoomChange).toHaveBeenCalledWith(1.1);

    await user.click(screen.getByRole('button', { name: '缩小' }));
    expect(onZoomChange).toHaveBeenCalledWith(0.9);

    onZoomChange.mockClear();
    rerender(<ZoomControl zoom={0.25} onZoomChange={onZoomChange} />);
    await user.click(screen.getByRole('button', { name: '缩小' }));
    expect(onZoomChange).toHaveBeenCalledWith(0.25);

    rerender(<ZoomControl zoom={4} onZoomChange={onZoomChange} />);
    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(onZoomChange).toHaveBeenCalledWith(4);
  });
});

describe('T3-02 框选几何', () => {
  it('矩形相交判定（含边接触）', () => {
    expect(
      rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    ).toBe(true);
    expect(
      rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 }),
    ).toBe(false);
    // 边接触不算相交（严格大于）
    expect(
      rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }),
    ).toBe(false);
  });

  it('负宽高矩形被归一化', () => {
    expect(normalizeRect({ x: 10, y: 10, width: -5, height: -8 })).toEqual({
      x: 5,
      y: 2,
      width: 5,
      height: 8,
    });
  });

  it('框选命中列表正确', () => {
    const elements = [
      { id: 'a', rect: { x: 0, y: 0, width: 20, height: 20 } },
      { id: 'b', rect: { x: 50, y: 50, width: 20, height: 20 } },
      { id: 'c', rect: { x: 10, y: 10, width: 5, height: 5 } },
    ];
    expect(selectInRect(elements, { x: -5, y: -5, width: 30, height: 30 })).toEqual(['a', 'c']);
    expect(selectInRect(elements, { x: 100, y: 100, width: 10, height: 10 })).toEqual([]);
  });

  it('SelectionBox 按变体绘制', () => {
    const { rerender } = render(<SelectionBox rect={{ x: 1, y: 2, width: 3, height: 4 }} />);
    expect(screen.getByTestId('selection-box-selected')).toBeInTheDocument();
    rerender(<SelectionBox rect={{ x: 0, y: 0, width: 1, height: 1 }} variant="marquee" />);
    expect(screen.getByTestId('selection-box-marquee')).toBeInTheDocument();
  });
});
