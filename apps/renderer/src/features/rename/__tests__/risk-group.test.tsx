/**
 * T7-03 渲染层测试：影响面单组（RiskGroup）。
 *
 * 断言：组头计数与半选态、整组全选 / 全不选、条目勾选、±3 行上下文展开。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createFakeRenameApi } from './fake-rename';
import { RiskGroup, describeLocation } from '../RiskGroup';

async function groupOf(level: 'auto' | 'confirm' | 'warn') {
  const fake = createFakeRenameApi();
  const report = await fake.analyze({ registryId: 'reg-1', newName: '登录提交' });
  const group = report.groups.find((item) => item.level === level);
  if (group === undefined) throw new Error(`夹具缺少 ${level} 组`);
  return { fake, report, group };
}

describe('RiskGroup', () => {
  it('渲染组名、计数与提示，默认展开时列出条目', async () => {
    const { group } = await groupOf('auto');
    render(
      <RiskGroup
        group={group}
        selection={new Set(group.items.map((item) => item.id))}
        expanded
        onToggleExpand={() => undefined}
        onToggleItem={() => undefined}
        onToggleAll={() => undefined}
      />,
    );
    expect(screen.getByTestId('risk-group').getAttribute('data-level')).toBe('auto');
    expect(screen.getByTestId('risk-group-count')).toHaveTextContent(
      `已选 ${group.items.length} / ${group.items.length}`,
    );
    expect(screen.getAllByTestId('impact-item')).toHaveLength(group.items.length);
    expect(screen.getByText(group.hint)).toBeInTheDocument();
  });

  it('收起时不渲染条目，点击展开按钮触发回调', async () => {
    const user = userEvent.setup();
    const onToggleExpand = vi.fn();
    const { group } = await groupOf('auto');
    render(
      <RiskGroup
        group={group}
        selection={new Set()}
        expanded={false}
        onToggleExpand={onToggleExpand}
        onToggleItem={() => undefined}
        onToggleAll={() => undefined}
      />,
    );
    expect(screen.queryAllByTestId('impact-item')).toHaveLength(0);
    expect(screen.getByTestId('risk-group-toggle')).toHaveTextContent('展开');
    await user.click(screen.getByTestId('risk-group-toggle'));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('部分勾选时组头复选框为半选态（indeterminate）', async () => {
    const { group } = await groupOf('auto');
    const first = group.items[0]!;
    const { container } = render(
      <RiskGroup
        group={group}
        selection={new Set([first.id])}
        expanded
        onToggleExpand={() => undefined}
        onToggleItem={() => undefined}
        onToggleAll={() => undefined}
      />,
    );
    const headerCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(headerCheckbox?.indeterminate).toBe(true);
    expect(headerCheckbox?.checked).toBe(false);
  });

  it('勾选条目与整组全选分别回调', async () => {
    const user = userEvent.setup();
    const onToggleItem = vi.fn();
    const onToggleAll = vi.fn();
    const { group } = await groupOf('warn');
    render(
      <RiskGroup
        group={group}
        selection={new Set()}
        expanded
        onToggleExpand={() => undefined}
        onToggleItem={onToggleItem}
        onToggleAll={onToggleAll}
      />,
    );
    const item = group.items[0]!;
    await user.click(screen.getByLabelText(`选择 ${item.id}`));
    expect(onToggleItem).toHaveBeenCalledWith(item.id, true);

    await user.click(screen.getByLabelText(`全选警告区（默认不改）`));
    expect(onToggleAll).toHaveBeenCalledWith(true);
  });

  it('条目可展开 ±3 行上下文（仅代码侧有上下文时）', async () => {
    const user = userEvent.setup();
    const onToggleItemContext = vi.fn();
    const { group } = await groupOf('auto');
    const withContext = group.items.find((item) => item.context !== null);
    render(
      <RiskGroup
        group={group}
        selection={new Set(group.items.map((item) => item.id))}
        expanded
        expandedItems={new Set(withContext === undefined ? [] : [withContext.id])}
        onToggleExpand={() => undefined}
        onToggleItem={() => undefined}
        onToggleAll={() => undefined}
        onToggleItemContext={onToggleItemContext}
      />,
    );
    if (withContext !== undefined) {
      expect(screen.getAllByTestId('impact-context').length).toBeGreaterThan(0);
      await user.click(screen.getAllByTestId('impact-context-toggle')[0]!);
      expect(onToggleItemContext).toHaveBeenCalledTimes(1);
    } else {
      expect(screen.queryAllByTestId('impact-context')).toHaveLength(0);
    }
  });

  it('空组展示占位文案', async () => {
    const { group } = await groupOf('confirm');
    render(
      <RiskGroup
        group={{ ...group, items: [] }}
        selection={new Set()}
        expanded
        onToggleExpand={() => undefined}
        onToggleItem={() => undefined}
        onToggleAll={() => undefined}
      />,
    );
    expect(screen.getByTestId('risk-group-empty')).toBeInTheDocument();
  });

  it('describeLocation 按来源给出可读位置', async () => {
    const { group } = await groupOf('auto');
    const code = group.items.find((item) => item.kind === 'code');
    const logic = group.items.find((item) => item.kind === 'logic');
    expect(code === undefined ? '' : describeLocation(code)).toMatch(/:\d+:\d+$/);
    expect(logic === undefined ? '' : describeLocation(logic)).toContain(logic?.refPath ?? '');
  });
});
