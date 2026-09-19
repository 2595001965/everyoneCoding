import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  createContextEngine,
  type AssembledContext,
  type ContextAssemblyRequest,
  type ContextMemoryHit,
  type ContextSources,
} from '@ec/ai';

import { BlockCard } from '../BlockCard';
import { ContextPanel } from '../ContextPanel';
import { ContextPanelProvider, type ContextPanelApi } from '../context-api';

/**
 * 上下文面板集成测试（T4-02 要点 3）。
 *
 * 关键决策：**用真实引擎 + 假端口**，而不是手搓一个 AssembledContext 常量。
 * 只有这样，面板上显示的 token 分布 / 省略清单才与引擎真实行为一致，
 * 「勾选变化实时反映到提交内容」这类验收项才有意义。
 */

const REQUEST: ContextAssemblyRequest = {
  userId: 'USER0000000000000000000000',
  projectId: 'P0000000000000000000000001',
  purpose: 'code',
  target: 'backend-code',
  elementId: 'el-btn',
  pageId: 'page-login',
};

function hit(id: string, title: string, importance = 4): ContextMemoryHit {
  return {
    id,
    scope: 'project',
    title,
    content: `${title} 的正文说明。`,
    importance,
    confidence: 1,
    updatedAt: 1_760_000_000_000,
  };
}

function makeApi(): ContextPanelApi & { calls: ContextAssemblyRequest[] } {
  const sources: ContextSources = {
    memory: {
      search: ({ limit }) =>
        [hit('m1', '技术栈：Tauri 2 + React 18'), hit('m2', '目录约定：packages/*')].slice(
          0,
          limit,
        ),
    },
    notes: {
      getNotesForContext: () => [
        {
          id: 'note-1',
          targetType: 'element',
          targetId: 'el-btn',
          type: 'forbidden',
          typeLabel: '禁止事项',
          mustFollow: true,
          priority: 5,
          text: '【禁止】不得把验证码明文写入日志',
          version: 1,
          updatedAt: 1_760_000_000_000,
        },
        {
          id: 'note-2',
          targetType: 'element',
          targetId: 'el-btn',
          type: 'validation',
          typeLabel: '校验要求',
          mustFollow: false,
          priority: 4,
          text: '点击登录前必须校验图形验证码',
          version: 1,
          updatedAt: 1_760_000_000_000,
        },
      ],
    },
    elements: {
      getElementChain: () => [
        { id: 'el-form', type: 'Form', name: '登录表单' },
        { id: 'el-btn', type: 'Button', name: '登录按钮', props: { text: '登录' } },
      ],
    },
    clock: () => 1_760_000_000_000,
  };

  const engine = createContextEngine({ sources });
  const calls: ContextAssemblyRequest[] = [];

  return {
    ready: true,
    availableSources: ['memory', 'notes', 'elements'],
    calls,
    assemble: async (request) => {
      calls.push(request);
      return engine.assemble(request);
    },
  };
}

describe('ContextPanel（T4-02 要点 3）', () => {
  it('端口未注入时展示引导而不是崩溃', () => {
    render(<ContextPanel request={REQUEST} />);
    expect(screen.getByText('上下文面板未初始化')).toBeInTheDocument();
  });

  it('端口未就绪时展示原因', () => {
    render(
      <ContextPanelProvider
        api={{ ready: false, reason: '本地数据层正在初始化', assemble: vi.fn() }}
      >
        <ContextPanel request={REQUEST} />
      </ContextPanelProvider>,
    );
    expect(screen.getByText('上下文服务未就绪')).toBeInTheDocument();
    expect(screen.getByText('本地数据层正在初始化')).toBeInTheDocument();
  });

  it('自动组装并展示每块 token、来源与总量', async () => {
    const api = makeApi();
    render(
      <ContextPanelProvider api={api}>
        <ContextPanel request={REQUEST} />
      </ContextPanelProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('项目记忆（技术选型与工程约定）')).toBeInTheDocument(),
    );
    expect(api.calls).toHaveLength(1);
    expect(
      screen.getByLabelText('包含 元素备注（业务规则 / 校验 / 禁止事项）'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('ec-context-refs')).toHaveTextContent('#note-1');
    expect(screen.getByTestId('ec-context-distribution')).toHaveTextContent('token');
  });

  it('块缺失时显示「未参与本次提交」的原因', async () => {
    const api = makeApi();
    render(
      <ContextPanelProvider api={api}>
        <ContextPanel request={REQUEST} />
      </ContextPanelProvider>,
    );
    await waitFor(() => expect(screen.getAllByText(/未参与本次提交：/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/未接入/).length).toBeGreaterThan(0);
  });

  it('取消勾选后该块标记为未提交，且提交内容随之变化', async () => {
    const api = makeApi();
    render(
      <ContextPanelProvider api={api}>
        <ContextPanel request={REQUEST} />
      </ContextPanelProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('项目记忆（技术选型与工程约定）')).toBeInTheDocument(),
    );
    const toggle = screen.getByLabelText('包含 项目记忆（技术选型与工程约定）');
    fireEvent.click(toggle);

    const card = document.querySelector('[data-block-id="project"]');
    expect(card?.getAttribute('data-block-enabled')).toBe('false');
    expect(
      within(card as HTMLElement).getByText(/已被手动取消勾选，本次不会提交/),
    ).toBeInTheDocument();
  });

  it('就地编辑后块内容采用编辑文本（所见即所提交）', async () => {
    const api = makeApi();
    render(
      <ContextPanelProvider api={api}>
        <ContextPanel request={REQUEST} />
      </ContextPanelProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('项目记忆（技术选型与工程约定）')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText('编辑 项目记忆（技术选型与工程约定）'));
    fireEvent.change(screen.getByLabelText('项目记忆（技术选型与工程约定） 内容'), {
      target: { value: '仅保留：技术栈 Tauri 2 + React 18' },
    });
    fireEvent.click(screen.getByLabelText('保存 项目记忆（技术选型与工程约定） 编辑'));

    expect(screen.getByTestId('ec-context-content-project')).toHaveTextContent(
      '仅保留：技术栈 Tauri 2 + React 18',
    );
    expect(screen.getByText(/已手动编辑/)).toBeInTheDocument();
  });

  it('超预算时提示「已省略 X 项」并可展开查看原因', async () => {
    const api = makeApi();
    // 故意给一个极小预算以稳定触发裁剪（真实场景由用户勾选过多内容导致）
    render(
      <ContextPanelProvider api={api}>
        <ContextPanel request={{ ...REQUEST, budget: 100 }} />
      </ContextPanelProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('ec-context-omitted')).toBeInTheDocument());
    expect(screen.getByTestId('ec-context-omitted')).toHaveTextContent(/已省略 \d+ 项/);
    expect(document.querySelectorAll('[data-omitted-reason]').length).toBeGreaterThan(0);
    expect(screen.getByTestId('ec-context-warnings')).toHaveTextContent('已省略');
  });

  it('受控模式下由外部提供组装结果与选择状态', () => {
    const context = {
      blocks: [
        {
          id: 'note' as const,
          label: '元素备注',
          priority: 880,
          quota: 5_000,
          tokens: 30,
          content: '[备注 #note-9] 校验要求\n需校验图形验证码',
          source: '备注 1 条',
          editable: true,
          items: [
            {
              key: 'note-9',
              label: '校验要求',
              tokens: 30,
              weight: 4,
              text: '[备注 #note-9] 校验要求\n需校验图形验证码',
            },
          ],
        },
      ],
      system: 's',
      user: 'u',
      messages: [],
      totalTokens: 30,
      budget: 128_000,
      tookMs: 1,
      truncation: null,
      noteIds: ['note-9'],
      memoryIds: [],
      skipped: [],
      aggressive: false,
    } satisfies AssembledContext;

    const onOpenNote = vi.fn();
    render(
      <ContextPanelProvider api={makeApi()}>
        <ContextPanel request={REQUEST} context={context} onOpenNote={onOpenNote} />
      </ContextPanelProvider>,
    );

    // 受控时不应自行组装（不会出现项目记忆块）
    expect(screen.queryByText('项目记忆（技术选型与工程约定）')).toBeNull();
    expect(screen.getByLabelText('包含 元素备注')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('查看 元素备注 条目'));
    fireEvent.click(screen.getByRole('button', { name: '校验要求' }));
    expect(onOpenNote).toHaveBeenCalledWith('note-9');
  });
});

describe('BlockCard（T4-02 要点 3）', () => {
  it('显示配额、占比与展开内容', () => {
    render(
      <BlockCard
        block={{
          id: 'code',
          label: '已有代码与锚点',
          tokens: 500,
          quota: 40_000,
          priority: 860,
          source: '代码片段 2 段',
          editable: false,
          enabled: true,
          content: 'export class AuthController {}',
          omittedCount: 3,
          percent: 12.5,
          items: [
            { key: 'a1', label: 'AuthController.login', tokens: 500, weight: 1, preview: 'x' },
          ],
        }}
      />,
    );

    expect(screen.getByText('500 token')).toBeInTheDocument();
    expect(screen.getByText('配额 40000')).toBeInTheDocument();
    expect(screen.getByText('本块已省略 3 项')).toBeInTheDocument();
    expect(screen.getByTestId('ec-context-bar-code')).toHaveAttribute('data-percent', '12.5');
    expect(screen.queryByLabelText('编辑 已有代码与锚点')).toBeNull();

    fireEvent.click(screen.getByLabelText('查看 已有代码与锚点 条目'));
    expect(screen.getByText('AuthController.login')).toBeInTheDocument();
  });
});
