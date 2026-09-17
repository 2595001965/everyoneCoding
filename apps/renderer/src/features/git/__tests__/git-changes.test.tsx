/**
 * T6-02 渲染层测试：变更面板 / 文件差异 / hunk 选择 / 提交框。
 *
 * 全部使用内存假端口（fake-git.ts），不碰真实 git、文件系统与网络。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { GitDiff, GitDiffFile, GitDiffHunk } from '@ec/git';

import { ChangesPanel } from '../ChangesPanel';
import { CommitBox } from '../CommitBox';
import { FileDiff } from '../FileDiff';
import { GitApiProvider } from '../git-api';
import { HunkSelector } from '../HunkSelector';
import { createFakeGitApi, makeSampleDiff } from './fake-git';

function renderWith(api: ReturnType<typeof createFakeGitApi>, node: JSX.Element): void {
  render(<GitApiProvider api={api}>{node}</GitApiProvider>);
}

describe('ChangesPanel（T6-02 文件级）', () => {
  it('按目录分组展示文件，带状态标签与来源标签', async () => {
    const api = createFakeGitApi();
    renderWith(api, <ChangesPanel />);

    await waitFor(() => expect(screen.getByText('src/features/login/LoginPage.tsx')).toBeInTheDocument());

    // 目录分组：两个不同目录
    expect(screen.getByText('src/features/login')).toBeInTheDocument();
    expect(screen.getByText('server/migrations')).toBeInTheDocument();

    // 状态标签：新增（已暂存）/ 修改
    expect(screen.getByTestId('status-src/features/login/index.ts')).toHaveTextContent('新增（已暂存）');
    expect(screen.getByTestId('status-src/features/login/LoginPage.tsx')).toHaveTextContent('修改');

    // 来源标签（AI 生成 / 迁移执行）
    expect(screen.getByTestId('source-src/features/login/LoginPage.tsx')).toHaveTextContent('AI 生成');
    expect(screen.getByTestId('source-server/migrations/0007_add_user.sql')).toHaveTextContent('迁移执行');
  });

  it('全选 / 反选 / 暂存所选，暂存调用携带全部路径', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const stage = vi.spyOn(api, 'stage');
    renderWith(api, <ChangesPanel />);

    await waitFor(() => expect(screen.getByTestId('select-all')).toBeEnabled());
    await user.click(screen.getByTestId('select-all'));
    await user.click(screen.getByTestId('stage-selected'));

    await waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
    expect(stage.mock.calls[0]?.[0]).toHaveLength(4);
  });

  it('未勾选任何文件时暂存按钮禁用', async () => {
    const api = createFakeGitApi();
    renderWith(api, <ChangesPanel />);
    await waitFor(() => expect(screen.getByTestId('stage-selected')).toBeInTheDocument());
    expect(screen.getByTestId('stage-selected')).toBeDisabled();
  });

  it('点击文件名与来源标签分别触发 onOpenFile / onOpenSource', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const onOpenFile = vi.fn();
    const onOpenSource = vi.fn();
    renderWith(api, <ChangesPanel onOpenFile={onOpenFile} onOpenSource={onOpenSource} />);

    await user.click(await screen.findByTestId('open-src/features/login/LoginPage.tsx'));
    expect(onOpenFile).toHaveBeenCalledWith('src/features/login/LoginPage.tsx');

    await user.click(screen.getByTestId('source-src/features/login/LoginPage.tsx'));
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ai-task', jumpable: true }));
  });
});

describe('FileDiff（T6-02 差异视图）', () => {
  it('默认并排；切到内联后 DOM 结构不同（单列带 +- 号）', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    renderWith(api, <FileDiff diff={makeSampleDiff()} />);

    expect(screen.getByTestId('sbs')).toBeInTheDocument();
    expect(screen.getAllByTestId('sbs-row').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('inline')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('view-inline'));

    expect(screen.getByTestId('inline')).toBeInTheDocument();
    expect(screen.queryByTestId('sbs')).not.toBeInTheDocument();
    const inlineLines = screen.getAllByTestId('inline-line');
    expect(inlineLines.length).toBeGreaterThan(0);
    expect(inlineLines.some((line) => line.textContent?.startsWith('+'))).toBe(true);
    expect(inlineLines.some((line) => line.textContent?.startsWith('-'))).toBe(true);
  });

  it('并排模式下同一视觉行渲染左右两个行号', () => {
    const api = createFakeGitApi();
    renderWith(api, <FileDiff diff={makeSampleDiff()} />);
    const row = screen.getAllByTestId('sbs-row')[0];
    // 四个网格单元：左行号 / 左内容 / 右行号 / 右内容
    expect(row?.children).toHaveLength(4);
  });

  it('连续上下文超过阈值时折叠为「已折叠 N 行」', () => {
    const api = createFakeGitApi();
    renderWith(api, <FileDiff diff={contextHeavyDiff()} />);
    const folds = screen.getAllByTestId('fold-row');
    expect(folds.length).toBeGreaterThan(0);
    expect(folds[0]?.textContent).toMatch(/已折叠\s*\d+\s*行/);
  });

  it('大文件 / 二进制跳过内容对比：只显示跳过原因，不渲染行', () => {
    const api = createFakeGitApi();
    renderWith(api, <FileDiff diff={makeSampleDiff()} />);

    const skipped = screen.getByTestId('skipped-assets/logo.png');
    expect(skipped).toHaveTextContent('超过 2.0 MB 上限');
    expect(screen.getByTestId('skipped-summary')).toHaveTextContent('1 个文件');
    // 被跳过的文件不应出现在并排行里
    const fileBlock = screen.getByTestId('file-assets/logo.png');
    expect(fileBlock.querySelectorAll('[data-testid="sbs-row"]')).toHaveLength(0);
  });
});

describe('HunkSelector（T6-02 hunk 级）', () => {
  it('勾选 hunk 后「提交选中变更」传出 patch，patch 头正确', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const onCommitSelected = vi.fn();
    const file = makeSampleDiff().files[0] as GitDiffFile;

    renderWith(api, <HunkSelector file={file} onCommitSelected={onCommitSelected} />);

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(screen.getByTestId('commit-selected')).toBeDisabled();

    await user.click(screen.getByTestId('hunk-check-2'));
    await user.click(screen.getByTestId('commit-selected'));

    expect(onCommitSelected).toHaveBeenCalledTimes(1);
    const patch = onCommitSelected.mock.calls[0]?.[0] as string;
    expect(patch).toMatch(/^diff --git a\/src\/features\/login\/LoginPage\.tsx b\/src\/features\/login\/LoginPage\.tsx/);
    expect(patch).toContain('@@ -20,3 +22,4 @@');
    // 只包含选中的 hunk
    expect(patch).not.toContain('@@ -1,4 +1,6 @@');
  });

  it('被跳过的文件不渲染任何 hunk 控件', () => {
    const api = createFakeGitApi();    const skipped = makeSampleDiff().files[1] as GitDiffFile;
    const { container } = render(
      <GitApiProvider api={api}>
        <HunkSelector file={skipped} />
      </GitApiProvider>,
    );
    expect(container.querySelectorAll('[data-testid^="hunk-check-"]')).toHaveLength(0);
  });
});

describe('CommitBox（T6-02 提交）', () => {
  it('提交信息不合规时禁用提交并给出中文错误', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    renderWith(api, <CommitBox />);

    await user.type(screen.getByTestId('commit-subject'), '随便写一句');

    expect(await screen.findByTestId('commit-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('commit-submit')).toBeDisabled();
  });

  it('合规提交信息可提交，成功后清空输入', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const commit = vi.spyOn(api, 'commit');
    renderWith(api, <CommitBox />);

    const subject = screen.getByTestId('commit-subject');
    await user.type(subject, 'feat(login): 新增账号登录');
    await waitFor(() => expect(screen.getByTestId('commit-submit')).toBeEnabled());
    await user.click(screen.getByTestId('commit-submit'));

    await waitFor(() => expect(commit).toHaveBeenCalledWith({ subject: 'feat(login): 新增账号登录' }));
    await waitFor(() => expect(subject).toHaveValue(''));
  });

  it('「AI 生成提交信息」填充标题与说明，并携带当前规范', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const generate = vi.spyOn(api, 'generateCommitMessage');
    renderWith(api, <CommitBox />);

    await user.click(screen.getByTestId('ai-generate'));

    await waitFor(() => expect(generate).toHaveBeenCalledWith({ convention: 'angular' }));
    await waitFor(() => expect(screen.getByTestId('commit-subject')).toHaveValue('新增账号登录表单'));
  });

  it('自动提交策略默认「关闭」，切换为「每阶段提交」后写入策略', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const setPolicy = vi.spyOn(api, 'setAutoCommitPolicy');
    renderWith(api, <CommitBox />);

    await waitFor(() => expect(screen.getByLabelText('自动提交策略')).toHaveTextContent('关闭（默认）'));

    await user.click(screen.getByLabelText('自动提交策略'));
    const option = screen.getAllByRole('option').find((item) => item.textContent === '每阶段提交（建议）');
    expect(option).toBeDefined();
    await user.click(option as HTMLElement);

    await waitFor(() =>
      expect(setPolicy).toHaveBeenCalledWith({ trigger: 'per-stage', convention: 'angular' }),
    );
  });
});

/** 构造一个上下文行占多数、必然触发折叠的 diff */
function contextHeavyDiff(): GitDiff {
  const lines = Array.from({ length: 14 }, (_, index) => ({
    kind: 'context' as const,
    text: `line ${index + 1}`,
    oldNumber: index + 1,
    newNumber: index + 1,
  }));
  const hunk: GitDiffHunk = {
    index: 1,
    header: '@@ -1,14 +1,14 @@',
    oldStart: 1,
    oldLines: 14,
    newStart: 1,
    newLines: 14,
    section: null,
    lines,
  };
  const file: GitDiffFile = {
    path: 'src/big-context.ts',
    oldPath: null,
    status: 'modified',
    binary: false,
    skipped: false,
    skipReason: null,
    additions: 0,
    deletions: 0,
    size: 1024,
    hunks: [hunk],
  };
  return { from: 'WORKTREE', to: 'WORKTREE', staged: false, files: [file], additions: 0, deletions: 0, skippedFiles: 0 };
}
