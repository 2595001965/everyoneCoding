import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { createFakeRenameApi, type FakeRenameApi } from '../__tests__/fake-rename';
import { RenameApiProvider } from '../rename-api';
import { BatchRenameDialog } from '../BatchRenameDialog';

async function renderDialog(api: FakeRenameApi): Promise<void> {
  const targets = await api.listTargets();
  render(
    <RenameApiProvider api={api}>
      <BatchRenameDialog api={api} targets={targets} open onClose={() => {}} />
    </RenameApiProvider>,
  );
}

describe('BatchRenameDialog', () => {
  it('批量改名：生成预览并展示各对象 diff 摘要', async () => {
    const api = createFakeRenameApi();
    await renderDialog(api);

    fireEvent.change(screen.getByLabelText('登录按钮 的新名称'), { target: { value: '登录提交' } });
    fireEvent.change(screen.getByLabelText('注册按钮 的新名称'), { target: { value: '注册提交' } });
    fireEvent.click(screen.getByTestId('batch-plan'));

    const steps = await screen.findAllByTestId('batch-step');
    expect(steps).toHaveLength(2);
    expect(screen.getByText('登录提交')).toBeInTheDocument();
    expect(screen.getByText('注册提交')).toBeInTheDocument();
    expect(screen.getByTestId('batch-execute')).not.toBeDisabled();
  });

  it('执行后更新注册表项', async () => {
    const api = createFakeRenameApi();
    await renderDialog(api);

    fireEvent.change(screen.getByLabelText('登录按钮 的新名称'), { target: { value: '登录提交' } });
    fireEvent.change(screen.getByLabelText('注册按钮 的新名称'), { target: { value: '注册提交' } });
    fireEvent.click(screen.getByTestId('batch-plan'));
    await screen.findAllByTestId('batch-step');

    fireEvent.click(screen.getByTestId('batch-execute'));
    await screen.findByTestId('batch-result');

    await waitFor(() => expect(api.state.entries.get('reg-1')!.canonicalName).toBe('登录提交'));
    expect(api.state.entries.get('reg-2')!.canonicalName).toBe('注册提交');
  });

  it('冲突对象（blocked 非空）时禁用确认执行', async () => {
    const api = createFakeRenameApi();
    await renderDialog(api);

    // reg-1 命名为 reg-2 的规范名 → 与现有投影冲突
    fireEvent.change(screen.getByLabelText('登录按钮 的新名称'), { target: { value: '注册按钮' } });
    fireEvent.click(screen.getByTestId('batch-plan'));

    const blocked = await screen.findByTestId('batch-blocked');
    expect(blocked).toBeInTheDocument();
    expect(screen.getByTestId('batch-execute')).toBeDisabled();
  });

  it('规范化模式：plan.normalize 为 true', async () => {
    const api = createFakeRenameApi();
    await renderDialog(api);

    fireEvent.click(screen.getByRole('tab', { name: '一键全项目命名规范化' }));
    fireEvent.click(screen.getByTestId('batch-plan'));

    await screen.findByText(/模式：全项目命名规范化/);
  });
});
