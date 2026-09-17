/**
 * T6-03 渲染层测试：分支树（含二次确认）/ 提交图 SVG / 历史筛选与虚拟滚动时间线。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { BranchGraph as BranchGraphModel } from '@ec/git';

import { BranchGraph } from '../BranchGraph';
import { BranchTree } from '../BranchTree';
import { GitApiProvider } from '../git-api';
import { EMPTY_HISTORY_FILTER, HistoryFilter, type HistoryFilterValue } from '../HistoryFilter';
import { HistoryTimeline, formatTime } from '../HistoryTimeline';
import { createFakeGitApi } from './fake-git';

function renderWith(api: ReturnType<typeof createFakeGitApi>, node: JSX.Element): void {
  render(<GitApiProvider api={api}>{node}</GitApiProvider>);
}

function sampleGraph(): BranchGraphModel {
  return {
    lanes: 2,
    head: 'a',
    forks: ['c'],
    merges: ['c'],
    nodes: [
      { sha: 'a', subject: 'head commit', authorName: '小吴', authoredAt: 3, lane: 0, parents: [{ sha: 'c', lane: 0 }], branches: ['main'], tags: [], isHead: true, isMerge: false },
      { sha: 'b', subject: 'side commit', authorName: '小吴', authoredAt: 2, lane: 1, parents: [{ sha: 'c', lane: 0 }], branches: ['feat/login'], tags: ['v0.1.0'], isHead: false, isMerge: false },
      { sha: 'c', subject: 'merge commit', authorName: '主人', authoredAt: 1, lane: 0, parents: [{ sha: 'd', lane: 0 }, { sha: 'e', lane: 1 }], branches: [], tags: [], isHead: false, isMerge: true },
      { sha: 'd', subject: 'base one', authorName: '主人', authoredAt: 0, lane: 0, parents: [], branches: [], tags: [], isHead: false, isMerge: false },
      { sha: 'e', subject: 'base two', authorName: '主人', authoredAt: 0, lane: 1, parents: [], branches: [], tags: [], isHead: false, isMerge: false },
    ],
  };
}

describe('BranchTree（T6-03 分支树）', () => {
  it('渲染分支层级，展示当前标记、ahead/behind 与上游', async () => {
    const api = createFakeGitApi();
    renderWith(api, <BranchTree />);

    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument());
    expect(screen.getByText('当前')).toBeInTheDocument();
    expect(screen.getByTestId('ahead-main')).toHaveTextContent('↑2');
    expect(screen.getByTestId('behind-main')).toHaveTextContent('↓1');
    expect(screen.getByTestId('upstream-main')).toHaveTextContent('origin/main');
    // gone 的上游标注
    expect(screen.getByTestId('upstream-fix/bug/utf8')).toHaveTextContent('（已删除）');
  });

  it('删除分支必须二次确认：确认前不调用 deleteBranch', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const remove = vi.spyOn(api, 'deleteBranch');
    renderWith(api, <BranchTree />);

    await user.click(await screen.findByTestId('branch-delete-feat/login'));
    expect(remove).not.toHaveBeenCalled();

    // 确认弹窗里出现待删除分支名
    const dialogText = await screen.findByText(/即将删除分支/);
    expect(dialogText).toBeInTheDocument();

    await user.click(screen.getByTestId('branch-delete-confirm'));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove.mock.calls[0]?.[0]).toBe('feat/login');
  });

  it('取消删除后仍不调用 deleteBranch', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const remove = vi.spyOn(api, 'deleteBranch');
    renderWith(api, <BranchTree />);

    await user.click(await screen.findByTestId('branch-delete-fix/bug/utf8'));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(remove).not.toHaveBeenCalled();
  });

  it('新建分支名校验不通过时给出错误且不调用 createBranch', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const create = vi.spyOn(api, 'createBranch');
    renderWith(api, <BranchTree />);

    await user.click(await screen.findByTestId('branch-create'));
    await user.type(screen.getByTestId('branch-create-input'), 'bad..name');
    await user.click(screen.getByTestId('branch-create-confirm'));

    expect(await screen.findByTestId('branch-create-error')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('BranchGraph（T6-03 提交图）', () => {
  it('内联 SVG 画泳道；≥2 泳道时出现 ≥2 个不同 x 坐标', () => {
    const api = createFakeGitApi();
    const { container } = render(
      <GitApiProvider api={api}>
        <BranchGraph graph={sampleGraph()} />
      </GitApiProvider>,
    );

    const svg = screen.getByTestId('branch-graph');
    expect(svg.tagName.toLowerCase()).toBe('svg');

    const nodeXs = [...container.querySelectorAll('[data-testid="graph-node"] circle[r="5"]')].map((circle) =>
      circle.getAttribute('cx'),
    );
    expect(nodeXs.length).toBe(5);
    expect(new Set(nodeXs).size).toBeGreaterThanOrEqual(2);
  });

  it('合并节点渲染 2 条父边，父子关系写进 data-from / data-to', () => {
    const api = createFakeGitApi();
    const { container } = render(
      <GitApiProvider api={api}>
        <BranchGraph graph={sampleGraph()} />
      </GitApiProvider>,
    );

    const mergeEdges = container.querySelectorAll('[data-testid="graph-edge"][data-from="c"]');
    expect(mergeEdges).toHaveLength(2);
    const targets = [...mergeEdges].map((edge) => edge.getAttribute('data-to')).sort();
    expect(targets).toEqual(['d', 'e']);
  });

  it('渲染 HEAD 标记、分支标签与 tag', () => {
    const api = createFakeGitApi();
    renderWith(api, <BranchGraph graph={sampleGraph()} />);

    expect(screen.getByTestId('graph-head')).toHaveTextContent('HEAD');
    expect(screen.getAllByTestId('graph-branch-label').map((node) => node.textContent)).toEqual(
      expect.arrayContaining(['main', 'feat/login']),
    );
    expect(screen.getByTestId('graph-tag')).toHaveTextContent('#v0.1.0');
  });

  it('点击提交点回调 sha', () => {
    const api = createFakeGitApi();
    const onSelect = vi.fn();
    const { container } = render(
      <GitApiProvider api={api}>
        <BranchGraph graph={sampleGraph()} onSelect={onSelect} />
      </GitApiProvider>,
    );

    const node = container.querySelector('[data-testid="graph-node"][data-sha="b"]');
    expect(node).not.toBeNull();
    fireEvent.click(node as Element);
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('空仓库时给出提示而不画图', () => {
    const api = createFakeGitApi();
    const empty: BranchGraphModel = { nodes: [], lanes: 0, head: null, forks: [], merges: [] };
    renderWith(api, <BranchGraph graph={empty} />);
    expect(screen.queryByTestId('branch-graph')).not.toBeInTheDocument();
    expect(screen.getByText('暂无提交。')).toBeInTheDocument();
  });
});

/** 把筛选与时间线组装成与工作区一致的受控结构 */
function HistoryHarness(): JSX.Element {
  const [filter, setFilter] = useState<HistoryFilterValue>({ ...EMPTY_HISTORY_FILTER });
  return (
    <>
      <HistoryFilter value={filter} onChange={setFilter} />
      <HistoryTimeline filter={filter} />
    </>
  );
}

describe('HistoryFilter + HistoryTimeline（T6-03 历史）', () => {
  it('筛选条件变化后按参数调用 log（空条件不传空串）', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const log = vi.spyOn(api, 'log');
    renderWith(api, <HistoryHarness />);

    await waitFor(() => expect(log).toHaveBeenCalled());
    expect(log.mock.calls[0]?.[0]).toEqual({});

    await user.type(screen.getByRole('textbox', { name: '按关键词筛选' }), 'login');
    await waitFor(() => expect(log).toHaveBeenCalledWith({ keyword: 'login' }));

    await user.type(screen.getByRole('textbox', { name: '按作者筛选' }), '小吴');
    await waitFor(() => expect(log).toHaveBeenCalledWith({ keyword: 'login', author: '小吴' }));
  });

  it('重置按钮回到不限制状态', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const log = vi.spyOn(api, 'log');
    renderWith(api, <HistoryHarness />);

    await user.type(await screen.findByRole('textbox', { name: '按文件筛选' }), 'src/app.ts');
    await waitFor(() => expect(log).toHaveBeenCalledWith({ path: 'src/app.ts' }));

    await user.click(screen.getByTestId('filter-reset'));
    await waitFor(() => expect(log).toHaveBeenLastCalledWith({}));
  });

  it('点击提交展示详情（文件清单与增删行数）', async () => {
    const user = userEvent.setup();
    const api = createFakeGitApi();
    const detail = vi.spyOn(api, 'commitDetail');
    renderWith(api, <HistoryTimeline />);

    const firstRow = (await screen.findAllByTestId('history-row'))[0];
    expect(firstRow).toBeDefined();
    await user.click(firstRow as HTMLElement);

    await waitFor(() => expect(detail).toHaveBeenCalledTimes(1));
    const detailPanel = await screen.findByTestId('commit-detail');
    expect(within(detailPanel).getAllByTestId('detail-file').length).toBeGreaterThan(0);
    expect(detailPanel).toHaveTextContent(/个文件，\+\d+ \/ -\d+/);
  });

  it('1000 条提交：虚拟滚动下 DOM 行数远小于总数，并打印实测耗时', async () => {
    const api = createFakeGitApi({ commitCount: 1000 });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { container } = render(
      <GitApiProvider api={api}>
        <HistoryTimeline />
      </GitApiProvider>,
    );

    await waitFor(() => expect(container.querySelectorAll('[data-testid="history-row"]').length).toBeGreaterThan(0));

    const rows = container.querySelectorAll('[data-testid="history-row"]').length;
    expect(rows).toBeLessThan(100);
    expect(rows).toBeGreaterThan(0);

    await waitFor(() => {
      const measured = info.mock.calls.map((call) => String(call[0])).find((line) => line.includes('[T6-03]'));
      expect(measured).toBeDefined();
      expect(measured).toMatch(/\d+\.\d ms|\d ms|\d+\.\dms/);
      // 把实测口径写进测试输出，便于验收时直接取证
      process.stdout.write(`[实测] ${measured ?? ''}\n`);
    });
    info.mockRestore();
  });

  it('时间格式固定为 YYYY-MM-DD HH:mm（不依赖运行环境 locale）', () => {
    expect(formatTime(0)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
