import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { createFakeRenameApi } from '../__tests__/fake-rename';
import { RenameApiProvider } from '../rename-api';
import { UnifiedDiffView } from '../UnifiedDiffView';
import { DIFF_COLUMNS, type UnifiedDiff } from '@ec/registry';

async function setup(
  diff: UnifiedDiff,
  props: Record<string, unknown> = {},
): Promise<ReturnType<typeof render>> {
  const fake = createFakeRenameApi();
  return render(
    <RenameApiProvider api={fake}>
      <UnifiedDiffView diff={diff} {...props} />
    </RenameApiProvider>,
  );
}

describe('UnifiedDiffView', () => {
  it('四栏渲染条数与 diff.columns[].entries.length 一致', async () => {
    const fake = createFakeRenameApi();
    const diff = await fake.buildDiff({ registryId: 'reg-1', newName: '登录提交' });
    const { container } = await setup(diff);

    const columns = screen.getAllByTestId('diff-column');
    expect(columns).toHaveLength(DIFF_COLUMNS.length);

    for (const column of DIFF_COLUMNS) {
      const columnEl = container.querySelector(
        `[data-testid="diff-column"][data-column="${column}"]`,
      ) as HTMLElement;
      expect(columnEl).not.toBeNull();
      const entries = within(columnEl).getAllByTestId('diff-entry');
      const expected = diff.columns.find((view) => view.column === column)?.entries.length ?? 0;
      expect(entries.length).toBe(expected);
    }
  });

  it('warn 区条目默认未勾选（FR-UNI-04）', async () => {
    const fake = createFakeRenameApi();
    const diff = await fake.buildDiff({ registryId: 'reg-1', newName: '登录提交' });
    await setup(diff);

    const warnBadge = screen.getByText('警告区（默认不改）');
    const article = warnBadge.closest('article') as HTMLElement;
    const checkbox = article.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeChecked();
  });

  it('整栏全选后该栏条目被勾选（summary 变化）', async () => {
    const fake = createFakeRenameApi();
    const diff = await fake.buildDiff({ registryId: 'reg-1', newName: '登录提交' });
    const { container } = await setup(diff);

    const warnBadge = screen.getByText('警告区（默认不改）');
    const article = warnBadge.closest('article') as HTMLElement;
    const warnCheckbox = article.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(warnCheckbox).not.toBeChecked();

    const before = container.querySelectorAll('input[type="checkbox"]:checked').length;
    fireEvent.click(screen.getByLabelText('全选代码'));
    const after = container.querySelectorAll('input[type="checkbox"]:checked').length;

    expect(after).toBeGreaterThan(before);
    expect(warnCheckbox).toBeChecked();
  });

  it('检索过滤生效（展示层，不改 diff）', async () => {
    const fake = createFakeRenameApi();
    const diff = await fake.buildDiff({ registryId: 'reg-1', newName: '登录提交' });
    await setup(diff);

    // 定位文本是「refPath · file:line:col」的一个文本节点，用正则做包含匹配
    const testFile = /src\/__tests__\/login\.test\.tsx/;
    expect(screen.getAllByText(testFile).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('检索定位'), { target: { value: 'LoginService' } });
    expect(screen.queryAllByText(testFile)).toHaveLength(0);
    expect(screen.getAllByText(/src\/service\/LoginService\.ts/).length).toBeGreaterThan(0);
  });

  it('可展开查看 ±3 行上下文', async () => {
    const fake = createFakeRenameApi();
    const occs = fake.state.occurrences.get('reg-1') ?? [];
    const targetOcc = occs.find((o) => o.kind === 'code');
    expect(targetOcc).toBeDefined();
    fake.state.occurrences.set(
      'reg-1',
      occs.map((o) =>
        o.id === targetOcc!.id
          ? ({
              ...o,
              context: {
                startLine: 1,
                before: ['const a = 1;'],
                line: 'const b = 2;',
                after: ['const c = 3;'],
              },
            } as unknown as typeof o)
          : o,
      ),
    );
    const diff = await fake.buildDiff({ registryId: 'reg-1', newName: '登录提交' });
    await setup(diff);

    fireEvent.click(screen.getByRole('button', { name: '上下文 ±3 行' }));
    const ctx = await screen.findByTestId('diff-context');
    expect(ctx).toHaveTextContent('const b = 2;');
    expect(ctx).toHaveTextContent('const a = 1;');
  });

  it('scopeNotice 原样展示', async () => {
    const fake = createFakeRenameApi();
    const diff = await fake.buildDiff({ registryId: 'reg-1', newName: '登录提交' });
    await setup(diff);
    expect(screen.getByTestId('diff-scope-notice')).toHaveTextContent(diff.scopeNotice);
  });

  it('onExecute 收到的 selection 与勾选一致', async () => {
    const fake = createFakeRenameApi();
    const diff = await fake.buildDiff({ registryId: 'reg-1', newName: '登录提交' });
    const onExecute = vi.fn();
    await setup(diff, { onExecute });

    fireEvent.click(screen.getByRole('button', { name: /执行重命名/ }));
    expect(onExecute).toHaveBeenCalledTimes(1);
    const captured = onExecute.mock.calls[0]![0] as ReadonlySet<string>;
    const expected = new Set(
      diff.columns.flatMap((column) => column.entries.filter((e) => e.selected).map((e) => e.id)),
    );
    expect([...captured].sort()).toEqual([...expected].sort());
  });
});
