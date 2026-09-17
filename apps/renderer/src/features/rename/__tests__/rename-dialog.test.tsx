/**
 * T7-03 渲染层测试：重命名对话框（RenameDialog）。
 *
 * 端到端串起触发 → 校验 → 300ms 防抖（测试里用 0ms）→ 影响面 → 二次确认 → 事务执行，
 * 并直接断言假端口的状态（文件 / 注册表 / 事件），而不是只看渲染文本。
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RenameApiProvider, type RenameTarget } from '../rename-api';
import { RenameDialog } from '../RenameDialog';
import { createFakeRenameApi } from './fake-rename';

async function setup(options: { open?: boolean } = {}) {
  const fake = createFakeRenameApi();
  const targets = await fake.listTargets();
  const target = targets.find((item) => item.registryId === 'reg-1') as RenameTarget;
  const onClose = vi.fn();
  const onExecuted = vi.fn();

  const utils = render(
    <RenameApiProvider api={fake}>
      <RenameDialog
        open={options.open ?? true}
        target={target}
        onClose={onClose}
        onExecuted={onExecuted}
        debounceMs={0}
      />
    </RenameApiProvider>,
  );
  return { fake, target, onClose, onExecuted, ...utils };
}

describe('RenameDialog', () => {
  it('open 为 false 时不渲染', () => {
    const fake = createFakeRenameApi();
    render(
      <RenameApiProvider api={fake}>
        <RenameDialog open={false} target={null} onClose={() => undefined} debounceMs={0} />
      </RenameApiProvider>,
    );
    expect(screen.queryByTestId('rename-dialog')).toBeNull();
  });

  it('打开后回填当前规范名并展示稳定 ID（entityId 永不变更）', async () => {
    const { target } = await setup();
    expect(screen.getByTestId('rename-dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('新名称')).toHaveValue(target.canonicalName);
    expect(screen.getByTestId('rename-entity-id')).toHaveTextContent(target.entityId);
  });

  it('改名后自动分析影响面，展示勾选数与三级分布', async () => {
    const user = userEvent.setup();
    const { fake } = await setup();
    const input = screen.getByLabelText('新名称');
    await user.clear(input);
    await user.type(input, '登录提交');

    const panel = await screen.findByTestId('impact-panel');
    await waitFor(() => expect(panel.getAttribute('data-state')).toBe('ready'));
    expect(screen.getByTestId('rename-selection-count')).toHaveTextContent('当前勾选');

    const report = await fake.analyze({ registryId: 'reg-1', newName: '登录提交' });
    expect(screen.getByTestId('impact-execute')).toHaveTextContent(`确认执行 ${report.totals.selected} 处`);
  });

  it('非法名阻断：展示 ConflictWarning 的 3 个建议名，且不出影响面', async () => {
    const user = userEvent.setup();
    await setup();
    const input = screen.getByLabelText('新名称');
    await user.clear(input);
    await user.type(input, 'for');

    await screen.findByTestId('conflict-warning');
    expect(screen.getAllByTestId('suggestion')).toHaveLength(3);
    expect(screen.queryByTestId('impact-panel')).toBeNull();
    expect(screen.getByTestId('rename-execute')).toBeDisabled();
  });

  it('点击建议名会填入输入框并重新校验', async () => {
    const user = userEvent.setup();
    await setup();
    const input = screen.getByLabelText('新名称');
    await user.clear(input);
    await user.type(input, 'for');
    await screen.findByTestId('conflict-warning');

    const suggestion = screen.getAllByTestId('suggestion')[0]!;
    const picked = suggestion.textContent ?? '';
    await user.click(suggestion);
    await waitFor(() => expect(screen.getByLabelText('新名称')).toHaveValue(picked));
  });

  it('执行链路：二次确认 → 事务写入文件与注册表 → 记录 rename 事件', async () => {
    const user = userEvent.setup();
    const { fake, onExecuted } = await setup();
    const input = screen.getByLabelText('新名称');
    await user.clear(input);
    await user.type(input, '登录提交');
    await screen.findByTestId('impact-panel');
    await waitFor(() => expect(screen.getByTestId('impact-panel').getAttribute('data-state')).toBe('ready'));

    await user.click(screen.getByTestId('rename-execute'));
    const confirm = await screen.findByTestId('rename-confirm');
    expect(confirm).toHaveTextContent('确认执行？');
    expect(fake.state.events).toHaveLength(0); // 二次确认前不执行

    await user.click(screen.getByTestId('rename-confirm-execute'));
    await waitFor(() => expect(screen.getByTestId('rename-dialog-result')).toHaveAttribute('data-ok', 'true'));

    // 真实引擎的产物：文件、注册表、事件、提交 sha
    expect(fake.state.files.get('src/pages/Login.tsx')).toContain('<LoginSubmit');
    expect(fake.state.entries.get('reg-1')?.canonicalName).toBe('登录提交');
    expect(fake.state.entries.get('reg-1')?.projections.component).toBe('LoginSubmit');
    expect(fake.state.events).toHaveLength(1);
    expect(fake.state.events[0]?.commitSha).toBe('sha-fake-0001');
    expect(onExecuted).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('rename-dialog-result')).toHaveTextContent('已修改');
  });

  it('取消二次确认后不执行（用户可反悔）', async () => {
    const user = userEvent.setup();
    const { fake } = await setup();
    const input = screen.getByLabelText('新名称');
    await user.clear(input);
    await user.type(input, '登录提交');
    await waitFor(() => expect(screen.getByTestId('impact-panel').getAttribute('data-state')).toBe('ready'));

    await user.click(screen.getByTestId('rename-execute'));
    await screen.findByTestId('rename-confirm');
    await user.click(screen.getByText('再想想'));
    await waitFor(() => expect(screen.queryByTestId('rename-confirm')).toBeNull());
    expect(fake.state.events).toHaveLength(0);
    expect(fake.state.entries.get('reg-1')?.canonicalName).toBe('登录按钮');
  });

  it('目标为 null 时展示空状态引导', async () => {
    const fake = createFakeRenameApi();
    render(
      <RenameApiProvider api={fake}>
        <RenameDialog open target={null} onClose={() => undefined} debounceMs={0} />
      </RenameApiProvider>,
    );
    expect(screen.getByText('未选择对象')).toBeInTheDocument();
  });

  it('端口未就绪时给出引导而不是崩溃', async () => {
    const fake = createFakeRenameApi({}, { ready: false, reason: '未检测到重命名服务' });
    const targets = await createFakeRenameApi().listTargets();
    render(
      <RenameApiProvider api={fake}>
        <RenameDialog open target={targets[0] as RenameTarget} onClose={() => undefined} debounceMs={0} />
      </RenameApiProvider>,
    );
    expect(screen.getByTestId('rename-dialog')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('rename-error')).toHaveTextContent('未检测到重命名服务'));
  });
});
