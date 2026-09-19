/**
 * ConflictResolver 渲染层测试（T8-03 / E2E-14）。
 *
 * 覆盖：冲突条目计数与未决策徽标、逐条三选一（保留本地/采用包内/两者都保留）
 * 默认推荐保留本地、按类型批量决策回调。不碰端口，纯组件行为断言。
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ConflictResolution, PackageDiffItem } from '../package-api';
import { ConflictResolver } from '../ConflictResolver';
import { conflictItem } from './import-fixtures';

function renderResolver(opts: {
  items: PackageDiffItem[];
  decisions?: Record<string, ConflictResolution>;
  onChange?: (id: string, r: ConflictResolution) => void;
  onBatchChange?: (type: PackageDiffItem['incoming']['type'], r: ConflictResolution) => void;
}): void {
  render(
    <ConflictResolver
      items={opts.items}
      decisions={opts.decisions ?? {}}
      onChange={opts.onChange ?? vi.fn()}
      onBatchChange={opts.onBatchChange ?? vi.fn()}
    />,
  );
}

describe('ConflictResolver', () => {
  const items = [
    conflictItem('M1', 'memory', '记忆一', 10, 5),
    conflictItem('M2', 'memory', '记忆二', 10, 5),
  ];

  it('展示冲突计数与未决策徽标（默认全部未决策）', () => {
    renderResolver({ items });
    expect(screen.getByTestId('conflict-total')).toHaveTextContent('冲突条目：2');
    expect(screen.getByTestId('conflict-undecided')).toHaveTextContent('2 项未决策');
  });

  it('已决策条目不计入未决策徽标', () => {
    renderResolver({ items, decisions: { M1: 'keepLocal' } });
    expect(screen.getByTestId('conflict-undecided')).toHaveTextContent('1 项未决策');
  });

  it('逐条"保留本地"回调 keepLocal（默认值）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderResolver({ items, onChange });
    await user.click(
      within(screen.getByTestId('conflict-M1')).getByRole('button', { name: '保留本地' }),
    );
    expect(onChange).toHaveBeenCalledWith('M1', 'keepLocal');
  });

  it('逐条"采用包内"回调 takeNew', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderResolver({ items, onChange });
    await user.click(
      within(screen.getByTestId('conflict-M2')).getByRole('button', { name: '采用包内' }),
    );
    expect(onChange).toHaveBeenCalledWith('M2', 'takeNew');
  });

  it('逐条"两者都保留"回调 keepBoth', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderResolver({ items, onChange });
    await user.click(
      within(screen.getByTestId('conflict-M1')).getByRole('button', { name: '两者都保留' }),
    );
    expect(onChange).toHaveBeenCalledWith('M1', 'keepBoth');
  });

  it('按类型批量决策回调 onBatchChange（memory → 采用包内）', async () => {
    const user = userEvent.setup();
    const onBatchChange = vi.fn();
    renderResolver({ items, onBatchChange });
    await user.click(screen.getByLabelText('memory-batch'));
    await user.click(await screen.findByRole('option', { name: '采用包内' }));
    expect(onBatchChange).toHaveBeenCalledWith('memory', 'takeNew');
  });

  it('默认推荐：undecided 项为保留本地，不自动覆盖', () => {
    renderResolver({ items });
    // 未决策时按钮均未激活（没有自动选中 takeNew/keepBoth）
    const m1 = screen.getByTestId('conflict-M1');
    expect(within(m1).getByRole('button', { name: '保留本地' })).not.toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(m1).getByRole('button', { name: '采用包内' })).not.toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(m1).getByRole('button', { name: '两者都保留' })).not.toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
