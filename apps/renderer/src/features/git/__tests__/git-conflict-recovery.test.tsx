/**
 * T6-04 渲染层测试：合并 / 冲突三栏解决 / 回滚 / 暂存 / 远程与凭据。
 *
 * 重点验证硬约束：
 * - 破坏性操作（合并、回滚、stash drop、删远程、强制推送）都必须二次确认；
 * - D-04：UI 中不存在任何可直接编辑代码的控件；
 * - NFR-S-04：令牌输入框 type=password。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CONFLICT_RESOLUTION_LABELS } from '@ec/git';

import { ConflictEditor } from '../ConflictEditor';
import { GitApiProvider } from '../git-api';
import { MergePanel } from '../MergePanel';
import { RemoteManager } from '../RemoteManager';
import { RollbackDialog } from '../RollbackDialog';
import { StashPanel } from '../StashPanel';
import { createFakeGitApi } from './fake-git';

const CONFLICT_PATH = 'src/features/login/LoginPage.tsx';

function renderWith(api: ReturnType<typeof createFakeGitApi>, node: JSX.Element): void {
  render(<GitApiProvider api={api}>{node}</GitApiProvider>);
}

describe('MergePanel（T6-04 合并）', () => {
  it('预览影响展示引入提交数与文件数', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const preview = vi.spyOn(api, 'previewMerge');
    renderWith(api, <MergePanel />);

    await waitFor(() => expect(screen.getByTestId('merge-preview-action')).toBeInTheDocument());
    await user.click(screen.getByTestId('merge-preview-action'));

    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(await screen.findByTestId('merge-preview')).toHaveTextContent('将引入 2 个提交，影响 4 个文件');
  });

  it('合并前弹出确认并说明会创建备份分支；确认后才真正合并', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const merge = vi.spyOn(api, 'merge');
    renderWith(api, <MergePanel />);

    await user.click(await screen.findByTestId('merge-start'));
    expect(merge).not.toHaveBeenCalled();

    // 确认弹窗展示备份分支名（backup/<时间戳>）
    expect(await screen.findByTestId('merge-backup-name')).toHaveTextContent(/^backup\//);

    await user.click(screen.getByTestId('merge-confirm'));
    await waitFor(() => expect(merge).toHaveBeenCalledTimes(1));
    expect(merge.mock.calls[0]?.[1]).toEqual({ backup: true });
  });

  it('合并结果展示状态、冲突文件清单与备份分支', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    renderWith(api, <MergePanel />);

    await user.click(await screen.findByTestId('merge-start'));
    await user.click(screen.getByTestId('merge-confirm'));

    const outcome = await screen.findByTestId('merge-outcome');
    expect(outcome).toHaveTextContent('存在冲突，需要处理');
    expect(screen.getByTestId('merge-conflict-files')).toHaveTextContent(CONFLICT_PATH);
    expect(screen.getByTestId('merge-backup')).toHaveTextContent('backup/20260912-1');
  });

  it('取消合并确认后不调用 merge', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const merge = vi.spyOn(api, 'merge');
    renderWith(api, <MergePanel />);

    await user.click(await screen.findByTestId('merge-start'));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('ConflictEditor（T6-04 冲突三栏）', () => {
  it('每个冲突块渲染三栏（当前 / 结果 / 传入）', async () => {
    const api = createFakeGitApi();
    renderWith(api, <ConflictEditor />);

    await waitFor(() => expect(screen.getAllByTestId('col-ours').length).toBe(2));
    expect(screen.getAllByTestId('col-result')).toHaveLength(2);
    expect(screen.getAllByTestId('col-theirs')).toHaveLength(2);

    const firstOurs = screen.getAllByTestId('col-ours')[0];
    expect(firstOurs).toHaveTextContent('账号登录');
    const firstTheirs = screen.getAllByTestId('col-theirs')[0];
    expect(firstTheirs).toHaveTextContent('用户登录');
  });

  it('未解决块计数正确，未全部解决时禁止应用', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    renderWith(api, <ConflictEditor />);

    const summary = await screen.findByTestId('conflict-summary');
    expect(summary).toHaveTextContent('2 个冲突块');
    expect(summary).toHaveTextContent('未解决 2 块');
    expect(screen.getByTestId('conflict-apply')).toBeDisabled();

    await user.click(screen.getByTestId(`resolve-ours-${CONFLICT_PATH}-1`));
    await waitFor(() => expect(screen.getByTestId('conflict-summary')).toHaveTextContent('未解决 1 块'));
  });

  it('逐块选择后「结果」栏按选择展开，并显示解决标签', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    renderWith(api, <ConflictEditor />);

    await screen.findByTestId('conflict-summary');
    expect(screen.getByTestId(`resolution-${CONFLICT_PATH}-1`)).toHaveTextContent(
      CONFLICT_RESOLUTION_LABELS.unresolved,
    );

    await user.click(screen.getByTestId(`resolve-theirs-${CONFLICT_PATH}-1`));

    await waitFor(() =>
      expect(screen.getByTestId(`resolution-${CONFLICT_PATH}-1`)).toHaveTextContent(
        CONFLICT_RESOLUTION_LABELS.theirs,
      ),
    );
    expect(screen.getAllByTestId('col-result')[0]).toHaveTextContent('用户登录');
  });

  it('「两侧都要」调用 requestAiMerge 并展示指令与上下文（不让人手写代码）', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const request = vi.spyOn(api, 'requestAiMerge');
    renderWith(api, <ConflictEditor />);

    await screen.findByTestId('conflict-summary');
    await user.click(screen.getByTestId(`resolve-both-${CONFLICT_PATH}-1`));

    await waitFor(() => expect(request).toHaveBeenCalledWith({ path: CONFLICT_PATH, blockIndex: 1 }));
    const panel = await screen.findByTestId('ai-merge-request');
    expect(panel).toHaveTextContent('交给 AI 合并');
    expect(screen.getByTestId('ai-merge-instruction').textContent).toContain('请合并');
    expect(screen.getByTestId('ai-merge-context').textContent).toContain('冲突块 1');
  });

  it('全部解决后应用结果，逐文件调用 applyResolution', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const apply = vi.spyOn(api, 'applyResolution');
    renderWith(api, <ConflictEditor />);

    await screen.findByTestId('conflict-summary');
    await user.click(screen.getByTestId(`resolve-ours-${CONFLICT_PATH}-1`));
    await user.click(screen.getByTestId(`resolve-theirs-${CONFLICT_PATH}-2`));

    await waitFor(() => expect(screen.getByTestId('conflict-apply')).toBeEnabled());
    await user.click(screen.getByTestId('conflict-apply'));

    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const payload = apply.mock.calls[0]?.[0];
    expect(payload?.path).toBe(CONFLICT_PATH);
    expect(payload?.message).toBe('解决合并冲突');
    // 结果内容由领域层 resolveConflictFile 生成（两侧都无冲突标记）
    expect(payload?.content).not.toContain('<<<<<<<');
  });

  it('D-04：界面上不存在任何可直接编辑代码的控件（无 textarea / contentEditable）', async () => {
    const api = createFakeGitApi();
    const { container } = render(
      <GitApiProvider api={api}>
        <ConflictEditor />
      </GitApiProvider>,
    );

    await screen.findByTestId('conflict-summary');
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(0);
    // 三栏全部落在只读 <pre> 上
    expect(container.querySelectorAll('pre[data-testid^="col-"]').length).toBe(6);
  });

  it('没有冲突时给出空状态而不是空白页', async () => {
    const api = createFakeGitApi({ conflicts: [] });
    renderWith(api, <ConflictEditor />);
    expect(await screen.findByText('当前没有冲突')).toBeInTheDocument();
  });
});

describe('RollbackDialog（T6-04 回滚）', () => {
  function Harness(): JSX.Element {
    const [open, setOpen] = useState(true);
    return <RollbackDialog sha="sha1" open={open} onOpenChange={setOpen} />;
  }

  it('展示回滚方式、警告、受影响提交 / 文件与安全快照分支', async () => {
    const api = createFakeGitApi();
    renderWith(api, <Harness />);

    expect(await screen.findByTestId('rollback-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('rollback-sha')).toHaveTextContent('sha1');
    expect(screen.getByTestId('rollback-snapshot')).toHaveTextContent('backup/20260912-2');
    expect(screen.getByTestId('rollback-warnings')).toHaveTextContent('尚未推送');
    expect(screen.getByTestId('rollback-commits').querySelectorAll('li').length).toBeGreaterThan(0);
    expect(screen.getByTestId('rollback-files')).toHaveTextContent(CONFLICT_PATH);
  });

  it('切换到 revert 方式后重新取计划（模式进入请求参数）', async () => {
    const api = createFakeGitApi();
    const plan = vi.spyOn(api, 'rollbackPlan');
    renderWith(api, <Harness />);

    await screen.findByTestId('rollback-dialog');
    fireEvent.click(screen.getByLabelText('回滚方式'));
    const option = screen.getAllByRole('option').find((item) => item.textContent?.includes('反向提交'));
    expect(option).toBeDefined();
    fireEvent.click(option as HTMLElement);

    await waitFor(() => expect(plan).toHaveBeenCalledWith({ sha: 'sha1', mode: 'revert' }));
  });

  it('执行回滚必须二次确认：确认前不调用 rollbackExecute', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const execute = vi.spyOn(api, 'rollbackExecute');
    renderWith(api, <Harness />);

    await user.click(await screen.findByTestId('rollback-execute'));
    expect(execute).not.toHaveBeenCalled();

    await user.click(await screen.findByTestId('rollback-confirm'));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]?.[0]?.snapshotBranch).toBe('backup/20260912-2');
  });
});

describe('StashPanel（T6-04 暂存）', () => {
  it('列出暂存记录（说明 / 分支 / 文件数 / 时间）', async () => {
    const api = createFakeGitApi();
    renderWith(api, <StashPanel />);

    expect(await screen.findByTestId('stash-item-0')).toBeInTheDocument();
    expect(screen.getByText('WIP 登录页样式')).toBeInTheDocument();
    expect(screen.getByTestId('stash-time-0').textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('新建暂存传说明并刷新列表', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const push = vi.spyOn(api, 'stashPush');
    renderWith(api, <StashPanel />);

    await user.type(await screen.findByTestId('stash-message'), '临时收起');
    await user.click(screen.getByTestId('stash-push'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('临时收起'));
  });

  it('删除暂存必须二次确认', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const drop = vi.spyOn(api, 'stashDrop');
    renderWith(api, <StashPanel />);

    await user.click(await screen.findByTestId('stash-drop-0'));
    expect(drop).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('stash-drop-confirm'));
    await waitFor(() => expect(drop).toHaveBeenCalledWith(0));
  });

  it('「仅恢复」不删除记录，「恢复并删除」才带 drop', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const apply = vi.spyOn(api, 'stashApply');
    renderWith(api, <StashPanel />);

    await user.click(await screen.findByTestId('stash-apply-0'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(0, false));

    await user.click(screen.getByTestId('stash-pop-0'));
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith(0, true));
  });
});

describe('RemoteManager（T6-03 远程与凭据）', () => {
  it('列出远程仓库并可测试连通性', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    renderWith(api, <RemoteManager />);

    const list = await screen.findByTestId('remote-list');
    expect(list).toHaveTextContent('origin');
    expect(list).toHaveTextContent('https://example.com/group/repo.git');

    await user.click(screen.getByTestId('remote-test'));
    expect(await screen.findByTestId('remote-test-result')).toHaveTextContent('连通正常，远端有 3 个分支');
  });

  it('删除远程必须二次确认', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const remove = vi.spyOn(api, 'removeRemote');
    renderWith(api, <RemoteManager />);

    await user.click(await screen.findByTestId('remote-delete-origin'));
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('remote-delete-confirm'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('origin'));
  });

  it('推送默认不带 force；进度事件按 phase 回显', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const push = vi.spyOn(api, 'push');
    renderWith(api, <RemoteManager />);

    const force = await screen.findByRole('checkbox', { name: '强制推送' });
    expect(force).not.toBeChecked();

    await user.click(screen.getByTestId('remote-push'));

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    // 默认不带 force / forceWithLease
    expect(push.mock.calls[0]?.[0]).toEqual({ remote: 'origin' });
    // 进度回显
    expect(await screen.findByTestId('remote-progress')).toHaveTextContent('推送完成');
    expect(api.calls.push[0]?.progress.map((event) => event.phase)).toEqual(['connecting', 'transferring', 'done']);
  });

  it('开启强制推送后必须二次确认，确认才带 forceWithLease', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const push = vi.spyOn(api, 'push');
    renderWith(api, <RemoteManager />);

    await user.click(await screen.findByRole('checkbox', { name: '强制推送' }));
    await user.click(screen.getByTestId('remote-push'));

    // 未确认前不推送
    expect(push).not.toHaveBeenCalled();

    const dialog = await screen.findByText(/强制推送会覆盖远程分支/);
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByTestId('force-push-confirm'));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(push.mock.calls[0]?.[0]).toEqual({ remote: 'origin', forceWithLease: true });
  });

  it('令牌输入框为 password，保存后写入密钥环且不残留明文', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const save = vi.spyOn(api, 'saveHttpsCredential');
    renderWith(api, <RemoteManager />);

    const token = await screen.findByTestId('cred-token');
    expect(token).toHaveAttribute('type', 'password');

    await user.type(screen.getByTestId('cred-username'), 'dev');
    await user.type(token, 'ghp_secret_token_value');
    await user.click(screen.getByTestId('cred-save'));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ remoteName: 'origin', username: 'dev', token: 'ghp_secret_token_value' }),
    );
    // 保存后输入框清空（明文不在组件状态里久留）
    await waitFor(() => expect(token).toHaveValue(''));
    expect(await screen.findByTestId('cred-saved')).toHaveTextContent('不会明文落盘');
    // 密钥串不出现在任何界面文案里
    expect(document.body.textContent ?? '').not.toContain('ghp_secret_token_value');
  });

  it('新增远程走表单并对空值不提交', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const add = vi.spyOn(api, 'addRemote');
    renderWith(api, <RemoteManager />);

    await user.click(await screen.findByTestId('remote-add'));
    await user.click(screen.getByTestId('remote-form-submit'));
    expect(add).not.toHaveBeenCalled();

    await user.type(screen.getByTestId('remote-form-name'), 'github');
    await user.type(screen.getByTestId('remote-form-url'), 'git@github.com:group/repo.git');
    await user.click(screen.getByTestId('remote-form-submit'));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('github', 'git@github.com:group/repo.git'),
    );
  });
});
