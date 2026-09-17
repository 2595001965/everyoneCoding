import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import { createFakeRenameApi, type FakeRenameApi } from '../__tests__/fake-rename';
import { MigrationDialog } from '../MigrationDialog';

async function renderDialog(api: FakeRenameApi, open = true): Promise<{ api: FakeRenameApi; target: Awaited<ReturnType<FakeRenameApi['listTargets']>>[number] }> {
  const targets = await api.listTargets();
  const target = targets[0]!;
  render(<MigrationDialog api={api} target={target} open={open} onClose={() => {}} />);
  return { api, target };
}

describe('MigrationDialog', () => {
  it('生成 SQL 预览两栏、影响行数与默认不执行文案', async () => {
    const api = createFakeRenameApi();
    await renderDialog(api);
    const forward = await screen.findByTestId('migration-sql-forward');
    const rollback = screen.getByTestId('migration-sql-rollback');

    expect(within(forward).getByText(/ALTER TABLE users RENAME COLUMN login_button TO login_submit/)).toBeInTheDocument();
    expect(within(rollback).getByText(/ALTER TABLE users RENAME COLUMN login_submit TO login_button/)).toBeInTheDocument();
    expect(screen.getByTestId('migration-affected-rows')).toHaveTextContent('12345');
    expect(screen.getByTestId('migration-default-action')).toHaveTextContent('默认只生成脚本');
    expect(api.state.events.length).toBe(0);
  });

  it('高危操作提示（requiresSecondConfirm 为真时两段确认）', async () => {
    const api = createFakeRenameApi();
    // 强制让预览命中高危：直接改写 planMigration 返回带高危的 preview 拷贝
    const original = api.planMigration.bind(api);
    api.planMigration = async (input) => {
      const preview = (await original(input)) as Awaited<ReturnType<FakeRenameApi['planMigration']>>;
      if ('error' in preview) return preview;
      return { ...preview, requiresSecondConfirm: true, backupRecommended: true };
    };
    await renderDialog(api);

    fireEvent.click(await screen.findByTestId('migration-confirm'));
    expect(await screen.findByTestId('migration-ack')).toBeInTheDocument();
    // 未勾选时第二段确认按钮不可点
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
    fireEvent.click(screen.getByTestId('migration-ack'));
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    const finalBtn = await screen.findByTestId('migration-confirm-final');
    fireEvent.click(finalBtn);
    await screen.findByTestId('migration-result');
    expect(api.state.events.length).toBe(1);
  });

  it('未确认时 events 为 0，确认并执行后 events 为 1 且日志行出现', async () => {
    const api = createFakeRenameApi();
    await renderDialog(api);
    await screen.findByTestId('migration-sql-forward');
    expect(api.state.events.length).toBe(0);

    fireEvent.click(screen.getByTestId('migration-confirm'));
    const final = await screen.findByTestId('migration-confirm-final');
    fireEvent.click(final);

    await screen.findByTestId('migration-result');
    await waitFor(() => expect(api.state.events.length).toBe(1));
    expect(screen.getAllByTestId('migration-log-line').length).toBeGreaterThan(0);
  });

  it('planMigration 返回错误时展示错误与引导，不崩溃', async () => {
    const api = createFakeRenameApi();
    api.planMigration = async () => ({ error: '模型不可用', guidance: '请稍后重试' });
    await renderDialog(api);
    const err = await screen.findByTestId('migration-error');
    expect(err).toHaveTextContent('模型不可用');
    expect(err).toHaveTextContent('请稍后重试');
  });
});
