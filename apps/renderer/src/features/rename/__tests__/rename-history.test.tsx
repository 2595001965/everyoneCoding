import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { createFakeRenameApi } from '../__tests__/fake-rename';
import { RenameApiProvider } from '../rename-api';
import { RenameHistory, type RenameHistoryProps } from '../RenameHistory';
import type { RenameHistoryEntry } from '@ec/registry';

const ENTRIES: readonly RenameHistoryEntry[] = [
  {
    id: 'e1',
    oldName: 'A按钮',
    newName: 'A提交',
    at: Date.UTC(2026, 0, 1),
    commitSha: 'sha-1',
    undone: false,
    changes: 3,
    projections: [],
  },
  {
    id: 'e2',
    oldName: 'C按钮',
    newName: 'C提交',
    at: Date.UTC(2026, 0, 2),
    commitSha: 'sha-2',
    undone: true,
    changes: 2,
    projections: [],
  },
  {
    id: 'e3',
    oldName: 'E按钮',
    newName: 'E提交',
    at: Date.UTC(2026, 0, 3),
    commitSha: null,
    undone: false,
    changes: 1,
    projections: [],
  },
];

function renderHistory(props: RenameHistoryProps): ReturnType<typeof render> {
  const fake = createFakeRenameApi();
  return render(
    <RenameApiProvider api={fake}>
      <RenameHistory {...props} />
    </RenameApiProvider>,
  );
}

describe('RenameHistory', () => {
  it('按时间倒序渲染', () => {
    renderHistory({ entries: ENTRIES, onUndo: vi.fn() });
    const rows = screen.getAllByTestId('history-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('E按钮')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('C按钮')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('A按钮')).toBeInTheDocument();
  });

  it('已撤销行禁用撤销按钮并标记', () => {
    renderHistory({ entries: ENTRIES, onUndo: vi.fn() });
    const rows = screen.getAllByTestId('history-row');
    const undoneRow = rows[1]!;
    expect(within(undoneRow).getAllByText('已撤销').length).toBeGreaterThan(0);
    expect(within(undoneRow).getByTestId('history-undo')).toBeDisabled();
  });

  it('未确认时不调用 onUndo', () => {
    const onUndo = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderHistory({ entries: ENTRIES, onUndo });
    fireEvent.click(within(screen.getAllByTestId('history-row')[0]!).getByTestId('history-undo'));
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('确认后调用 onUndo 并传入 id', () => {
    const onUndo = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderHistory({ entries: ENTRIES, onUndo });
    fireEvent.click(within(screen.getAllByTestId('history-row')[0]!).getByTestId('history-undo'));
    expect(onUndo).toHaveBeenCalledWith('e3');
  });

  it('空态', () => {
    renderHistory({ entries: [], onUndo: vi.fn() });
    expect(screen.getByText('暂无重命名记录')).toBeInTheDocument();
  });
});
