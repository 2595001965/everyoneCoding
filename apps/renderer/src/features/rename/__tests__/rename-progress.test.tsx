import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { createFakeRenameApi } from '../__tests__/fake-rename';
import { RenameApiProvider } from '../rename-api';
import { RenameProgress, type RenameProgressProps } from '../RenameProgress';
import type { RenameTransactionResult } from '@ec/registry';

function renderProgress(props: RenameProgressProps): ReturnType<typeof render> {
  const fake = createFakeRenameApi();
  return render(
    <RenameApiProvider api={fake}>
      <RenameProgress {...props} />
    </RenameApiProvider>,
  );
}

function failureResult(opts: { rolledBack: boolean; failures: string[] }): RenameTransactionResult {
  return {
    ok: false,
    transactionId: 'tx-1',
    oldName: 'A',
    newName: 'B',
    segments: [],
    applied: 0,
    skipped: 0,
    failures: opts.failures,
    warnings: [],
    rollback: { performed: opts.rolledBack, steps: opts.rolledBack ? ['step-1'] : [] },
    changeset: null,
    event: null,
    commitSha: null,
    aborted: false,
    elapsedMs: 0,
  };
}

describe('RenameProgress', () => {
  it('running 态显示 Spinner 与执行中', async () => {
    renderProgress({ result: null, running: true });
    const root = await screen.findByTestId('rename-progress');
    expect(root).toHaveAttribute('data-state', 'running');
    expect(screen.getByText('执行中…')).toBeInTheDocument();
  });

  it('idle 态（result 为 null 且非 running）显示空态', () => {
    renderProgress({ result: null, running: false });
    const root = screen.getByTestId('rename-progress');
    expect(root).toHaveAttribute('data-state', 'idle');
  });

  it('成功态显示已改处数与 commit sha，并触发撤销', async () => {
    const fake = createFakeRenameApi();
    // 勾选集合必须来自真实影响面（否则事务会因"未勾选任何变更项"直接失败）
    const report = await fake.analyze({ registryId: 'reg-1', newName: '登录提交' });
    const selection = report.groups.flatMap((group) => group.items.map((item) => item.id));
    const result = await fake.execute({ registryId: 'reg-1', newName: '登录提交', selection });
    expect(result.ok).toBe(true);
    const onUndo = vi.fn();
    renderProgress({ result, running: false, onUndo });
    const root = screen.getByTestId('rename-progress');
    expect(root).toHaveAttribute('data-state', 'success');
    expect(screen.getByText(`已修改 ${result.applied} 处`)).toBeInTheDocument();
    expect(screen.getByText(`commit ${result.commitSha}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rename-undo'));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('失败且已整体回滚时显示回滚信息', () => {
    renderProgress({ result: failureResult({ rolledBack: true, failures: [] }), running: false });
    const root = screen.getByTestId('rename-progress');
    expect(root).toHaveAttribute('data-state', 'rolled-back');
    expect(screen.getByText('已整体回滚')).toBeInTheDocument();
  });

  it('失败未回滚时显示失败原因', () => {
    renderProgress({ result: failureResult({ rolledBack: false, failures: ['boom'] }), running: false });
    const root = screen.getByTestId('rename-progress');
    expect(root).toHaveAttribute('data-state', 'failed');
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});
