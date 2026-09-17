import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { NOW, createFakeRenameApi } from '../__tests__/fake-rename';
import { RenameApiProvider } from '../rename-api';
import { AliasCleanupPanel, type AliasCleanupPanelProps } from '../AliasCleanupPanel';
import type { PendingCleanupItem } from '@ec/registry';

const DAY = 24 * 60 * 60 * 1000;

async function seedAlias(
  cleanupDueAt: number | null,
): Promise<{ fake: ReturnType<typeof createFakeRenameApi>; items: readonly PendingCleanupItem[] }> {
  const fake = createFakeRenameApi();
  const now = fake.state.entries.get('reg-1')!.createdAt;
  const entry = fake.state.entries.get('reg-1')!;
  fake.state.entries.set('reg-1', {
    ...entry,
    aliases: [
      { name: '登录按钮', kind: 'code', createdAt: now, deprecatedAt: now, cleanupDueAt, note: null },
    ],
  });
  return { fake, items: await fake.pendingCleanup() };
}

function renderPanel(
  items: readonly PendingCleanupItem[],
  props: Partial<AliasCleanupPanelProps> = {},
): ReturnType<typeof render> {
  const fake = createFakeRenameApi();
  return render(
    <RenameApiProvider api={fake}>
      <AliasCleanupPanel items={items} onClean={() => undefined} now={NOW} {...props} />
    </RenameApiProvider>,
  );
}

describe('AliasCleanupPanel', () => {
  it('渲染待清理清单与剩余天数文案', async () => {
    const { items } = await seedAlias(NOW + 5 * DAY);
    renderPanel(items);
    const row = screen.getByTestId('alias-row');
    expect(within(row).getAllByText('登录按钮').length).toBeGreaterThan(0);
    expect(within(row).getByText('代码 alias 导出')).toBeInTheDocument();
    expect(within(row).getByText(/剩余 5 天/)).toBeInTheDocument();
    expect(within(row).getByText('兼容期')).toBeInTheDocument();
  });

  it('已过期显示「已过期 n 天」', async () => {
    const { items } = await seedAlias(NOW - 1 * DAY);
    renderPanel(items);
    expect(screen.getByText(/已过期 1 天/)).toBeInTheDocument();
  });

  it('长期保留（无期限）', async () => {
    const { items } = await seedAlias(null);
    renderPanel(items);
    expect(screen.getAllByText(/长期保留/).length).toBeGreaterThan(0);
  });

  it('选中后一键清理调用 onClean', async () => {
    const { items } = await seedAlias(NOW + 5 * DAY);
    const onClean = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel(items, { onClean });

    const row = screen.getByTestId('alias-row');
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('alias-clean'));

    expect(onClean).toHaveBeenCalledTimes(1);
    expect(onClean).toHaveBeenCalledWith([{ registryId: 'reg-1', kind: 'code', name: '登录按钮' }]);
  });

  it('未确认不调用 onClean', async () => {
    const { items } = await seedAlias(NOW + 5 * DAY);
    const onClean = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPanel(items, { onClean });
    const row = screen.getByTestId('alias-row');
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('alias-clean'));
    expect(onClean).not.toHaveBeenCalled();
  });

  it('空态', () => {
    renderPanel([]);
    expect(screen.getByText('暂无需清理的别名')).toBeInTheDocument();
  });
});
