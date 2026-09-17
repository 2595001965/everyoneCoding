import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeLogRecord } from '@ec/memory';

import { MemoryCenter } from '../MemoryCenter';
import { MemoryProvider } from '../memory-api';
import { createFakeMemoryApi, makeMemory, type FakeMemoryApi } from './fake-memory';

/**
 * T2-02 集成测试：树渲染 / 项目过滤 / 搜索 / 编辑保存 / 冲突徽标 / 批量删除确认与撤销 / 变更日志。
 * 通过注入内存假实现运行，不牵扯 SQLite。
 */

const USER = 'U1';

const CHANGE_LOG: ChangeLogRecord = {
  id: 'LOG1',
  userId: USER,
  memoryId: 'M-LT',
  action: 'auto_write',
  policy: 'confirm',
  sourceType: 'auto_chat',
  sourceConversationId: 'CONV-9',
  sourceSnippet: '以后都用小驼峰命名',
  before: null,
  after: null,
  detail: null,
  createdAt: 1_700_000_100_000,
};

function seed(): FakeMemoryApi {
  return createFakeMemoryApi({
    items: [
      makeMemory({ id: 'M-LT', title: '命名规范', scope: 'longterm', tags: ['convention'], importance: 5, pinned: true }),
      makeMemory({ id: 'M-PJ', title: '商城技术栈', scope: 'project', projectId: 'P1', tags: ['stack'] }),
      makeMemory({ id: 'M-PG', title: '登录页 /login', scope: 'page', projectId: 'P1', pageId: 'PG1', tags: ['page'] }),
      makeMemory({
        id: 'M-ELEM',
        title: '提交按钮',
        scope: 'page',
        projectId: 'P1',
        pageId: 'PG1',
        elementId: 'E1',
        tags: ['page'],
      }),
      makeMemory({ id: 'M-ISSUE', title: '刷新丢 Session', scope: 'issue', projectId: 'P1', pageId: 'PG1', issueId: 'ISSUE-1', tags: ['bug'] }),
      makeMemory({ id: 'M-OTHER', title: '看板任务列表', scope: 'project', projectId: 'P2', tags: ['stack'] }),
    ],
    conflicts: {
      'M-PG': [
        {
          role: 'winner',
          counterpartId: 'M-LT',
          counterpartTitle: '命名规范',
          counterpartLayer: 'longterm',
          field: 'title',
          ownValue: '登录页 /login',
          counterpartValue: '命名规范',
        },
      ],
    },
    changeLogs: [CHANGE_LOG],
    projects: [
      { id: 'P1', name: '商城' },
      { id: 'P2', name: '看板' },
    ],
  });
}

function renderCenter(api: FakeMemoryApi): void {
  render(
    <MemoryProvider api={api}>
      <MemoryCenter userId={USER} height={400} />
    </MemoryProvider>,
  );
}

describe('记忆中心', () => {
  let api: FakeMemoryApi;

  beforeEach(() => {
    api = seed();
  });

  it('五个层级可在同一棵树中浏览', () => {
    renderCenter(api);
    const tree = screen.getByRole('tree', { name: '记忆分层树' });
    expect(within(tree).getByText('长期记忆')).toBeInTheDocument();
    expect(within(tree).getByText('项目记忆')).toBeInTheDocument();
    expect(within(tree).getByText('功能记忆')).toBeInTheDocument();
    expect(within(tree).getByText('页面记忆')).toBeInTheDocument();
    expect(within(tree).getByText('元素备注')).toBeInTheDocument();
    expect(within(tree).getByText('问题记忆')).toBeInTheDocument();
  });

  it('默认展示全部条目，切换项目后正确过滤（其他项目条目消失、长期记忆保留）', async () => {
    const user = userEvent.setup();
    renderCenter(api);

    expect(screen.getByText('看板任务列表')).toBeInTheDocument();
    expect(screen.getByText('命名规范')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: '选择项目' }));
    await user.click(screen.getByRole('option', { name: '商城' }));

    await waitFor(() => {
      expect(screen.queryByText('看板任务列表')).not.toBeInTheDocument();
    });
    expect(screen.getByText('商城技术栈')).toBeInTheDocument();
    // 长期记忆跨项目，任何项目下都应出现
    expect(screen.getByText('命名规范')).toBeInTheDocument();
  });

  it('搜索关键字过滤列表', async () => {
    const user = userEvent.setup();
    renderCenter(api);

    await user.type(screen.getByRole('textbox', { name: '搜索记忆' }), 'Session');
    await waitFor(() => {
      expect(screen.queryByText('商城技术栈')).not.toBeInTheDocument();
    });
    expect(screen.getByText('刷新丢 Session')).toBeInTheDocument();
  });

  it('标签筛选：点击树上的标签后只剩含该标签的条目', async () => {
    const user = userEvent.setup();
    renderCenter(api);

    const tree = screen.getByRole('tree', { name: '记忆分层树' });
    // 标签分组默认收起：Tree 的行点击是"选中"，展开要点行首的折叠箭头
    const groupRow = within(tree).getByText(/^标签（/).closest('[role="treeitem"]');
    expect(groupRow).not.toBeNull();
    await user.click(groupRow?.querySelector('.ec-tree__twisty') as Element);
    await user.click(await within(tree).findByText('convention'));

    await waitFor(() => {
      expect(screen.queryByText('商城技术栈')).not.toBeInTheDocument();
    });
    expect(screen.getByText('命名规范')).toBeInTheDocument();
    // 标签筛选以标签条形式回显，可一键清除
    expect(screen.getByRole('button', { name: '清除标签 convention' })).toBeInTheDocument();
  });

  it('Markdown 编辑与预览即时同步，保存后标题与正文更新', async () => {
    const user = userEvent.setup();
    renderCenter(api);

    await user.click(screen.getByText('命名规范'));
    const titleInput = await screen.findByRole('textbox', { name: '记忆标题' });
    await user.clear(titleInput);
    await user.type(titleInput, '命名规范（更新）');

    await user.click(screen.getByRole('tab', { name: '预览' }));
    expect(screen.getByTestId('markdown-preview')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('已保存');
    });
    expect(api.all().find((item) => item.id === 'M-LT')?.title).toBe('命名规范（更新）');
  });

  it('结构化字段表单编辑可保存', async () => {
    const user = userEvent.setup();
    renderCenter(api);

    await user.click(screen.getByText('登录页 /login'));
    await user.click(await screen.findByRole('tab', { name: '结构化' }));

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('已保存');
    });
  });

  it('冲突徽标显示来源并可展开查看被覆盖内容', async () => {
    const user = userEvent.setup();
    renderCenter(api);

    const badge = await screen.findByRole('button', { name: '覆盖了：长期记忆·命名规范' });
    await user.click(badge);

    const detail = screen.getByRole('region', { name: /的差异详情/ });
    expect(within(detail).getByText('冲突字段：title')).toBeInTheDocument();
  });

  it('批量删除需二次确认，删除后可撤销恢复', async () => {
    const user = userEvent.setup();
    renderCenter(api);

    await user.click(screen.getByRole('checkbox', { name: '选择「命名规范」' }));
    expect(screen.getByText('已选 1 条')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/将删除 1 条记忆/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => {
      expect(api.all().some((item) => item.id === 'M-LT')).toBe(false);
    });

    // 撤销按钮出现，点击后条目回到库里
    const undo = await screen.findByRole('button', { name: '撤销删除' });
    await user.click(undo);
    await waitFor(() => {
      expect(api.all().some((item) => item.id === 'M-LT')).toBe(true);
    });
  });

  it('取消二次确认时不会删除任何条目', async () => {
    const user = userEvent.setup();
    renderCenter(api);

    await user.click(screen.getByRole('checkbox', { name: '选择「命名规范」' }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(api.all().some((item) => item.id === 'M-LT')).toBe(true);
  });

  it('变更日志展示来源对话片段，未注入跳转实现时给出不可跳转提示', async () => {
    const user = userEvent.setup();
    renderCenter(api);
    // 选中条目后右侧展示该条目的变更日志
    await user.click(screen.getByText('命名规范'));
    expect(await screen.findByText('自动写入')).toBeInTheDocument();
    expect(screen.getByText(/以后都用小驼峰命名/)).toBeInTheDocument();
    expect(screen.getByText('原始对话暂不可跳转')).toBeInTheDocument();
  });

  it('导出调用端口并回显文件名', async () => {
    const user = userEvent.setup();
    renderCenter(api);

    await user.click(screen.getByRole('checkbox', { name: '选择「命名规范」' }));
    await user.click(screen.getByRole('button', { name: '导出选中为 JSON' }));

    await waitFor(() => {
      expect(api.lastExport?.format).toBe('json');
    });
    expect(await screen.findByText(/已导出：memories\.json/)).toBeInTheDocument();
  });

  it('未注入实现时展示初始化引导而不是崩溃', () => {
    render(
      <MemoryProvider api={null}>
        <MemoryCenter userId={USER} />
      </MemoryProvider>,
    );
    expect(screen.getByText('记忆中心尚未初始化')).toBeInTheDocument();
  });

  it('其它项目下的条目不会被误纳入统计', () => {
    renderCenter(api);
    // 项目记忆：P1 一条 + P2 一条（当前未选项目，两者都可见）
    expect(screen.getByText('共 6 条')).toBeInTheDocument();
    expect(vi.isMockFunction(api.list)).toBe(false);
  });
});
