import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { toDiffViewModel, type WritePlan, type WriteResult } from '@ec/ai';

import { ApplyBar } from '../ApplyBar';
import { CodeView } from '../CodeView';
import { CodeViewProvider, type CodeViewApi, type ReworkRequest } from '../code-api';
import { DiffView } from '../DiffView';

/**
 * 代码视图测试（T4-05 / E2E-18）。
 *
 * 最关键的一条断言是 **"界面上不存在任何可编辑代码的控件"**：
 * 用 RTL 查询 `textbox` / `contenteditable`，比"看代码有没有 readOnly"更接近用户可感知的事实。
 */

const FILES = [
  { path: 'src/auth/auth.controller.ts', language: 'ts' },
  { path: 'src/auth/captcha.service.ts', language: 'ts' },
];

const FILE_CONTENT = ['export class AuthController {', '  async login(dto: LoginDto) {', '    return this.service.login(dto);', '  }', '}', ''].join('\n');

function makeApi(): CodeViewApi & { reworkCalls: unknown[]; rework: ReturnType<typeof vi.fn> } {
  const rework = vi.fn<(request: ReworkRequest) => Promise<void>>(async () => undefined);
  const reworkCalls: unknown[] = [];
  const api: CodeViewApi = {
    files: {
      listFiles: async () => FILES,
      readFile: async (path) => (path === FILES[0]?.path ? FILE_CONTENT : '// captcha\n'),
    },
    write: {
      plan: async () => plan(),
      apply: async () => ({ ok: true, planId: 'plan-1', applied: ['a.ts'], skipped: [], rolledBack: [], error: null }),
      requestRework: async (request) => {
        reworkCalls.push(request);
        await rework(request);
      },
    },
  };
  return Object.assign(api, { reworkCalls, rework });
}

function plan(overrides: Partial<WritePlan> = {}): WritePlan {
  return {
    id: 'plan-1',
    mode: 'preview',
    entries: [
      {
        path: 'src/auth/auth.controller.ts',
        action: 'patch',
        language: 'ts',
        content: '@@',
        before: 'a\nb\nc\n',
        after: 'a\nB\nc\nd\n',
        blocked: false,
        blockReason: null,
        changed: true,
        selected: true,
      },
      {
        path: 'src/auth/captcha.service.ts',
        action: 'create',
        language: 'ts',
        content: 'export class CaptchaService {}\n',
        before: null,
        after: 'export class CaptchaService {}\n',
        blocked: false,
        blockReason: null,
        changed: true,
        selected: true,
      },
      {
        path: 'src/broken.ts',
        action: 'patch',
        language: 'ts',
        content: '@@',
        before: 'x\n',
        after: null,
        blocked: true,
        blockReason: '补丁片段在文件中找不到对应内容',
        changed: false,
        selected: false,
      },
    ],
    createdAt: 1,
    summary: '本次变更',
    anchors: [],
    noteIds: [],
    addedLines: 0,
    removedLines: 0,
    blockedCount: 1,
    ...overrides,
  };
}

describe('CodeView 只读（T4-05 要点 2 / E2E-18）', () => {
  it('渲染文件列表与只读代码面，界面里不存在任何可编辑控件', async () => {
    const api = makeApi();
    render(
      <CodeViewProvider api={api}>
        <CodeView path="src/auth/auth.controller.ts" />
      </CodeViewProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('ec-code-surface')).toHaveTextContent('AuthController'));
    expect(screen.getByTestId('ec-code-surface')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByTestId('ec-code-surface')).toHaveAttribute('aria-readonly', 'true');
    // 用户可感知的事实：没有可输入的地方
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it('尝试键入被拦截，并弹出「交给 AI 修改」入口', async () => {
    const api = makeApi();
    const onRequestAiFix = vi.fn();
    render(
      <CodeViewProvider api={api}>
        <CodeView path="src/auth/auth.controller.ts" onRequestAiFix={onRequestAiFix} />
      </CodeViewProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ec-code-surface')).toBeInTheDocument());

    const surface = screen.getByTestId('ec-code-surface');
    surface.focus();
    fireEvent.keyDown(surface, { key: 'x' });

    expect(await screen.findByRole('note')).toHaveTextContent('键盘输入已被拦截（代码视图只读）');
    expect(screen.getByText('交给 AI 修改', { selector: '[id^="ec-modal-title"]' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '交给 AI 修改' }));
    expect(onRequestAiFix).toHaveBeenCalledWith({
      path: 'src/auth/auth.controller.ts',
      reason: '键盘输入已被拦截（代码视图只读）',
      fileName: 'auth.controller.ts',
    });
  });

  it('粘贴同样被拦截（复制放行）', async () => {
    const api = makeApi();
    render(
      <CodeViewProvider api={api}>
        <CodeView path="src/auth/auth.controller.ts" />
      </CodeViewProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ec-code-surface')).toBeInTheDocument());
    const surface = screen.getByTestId('ec-code-surface');

    fireEvent.paste(surface, { clipboardData: { getData: () => '恶意粘贴的代码' } });
    expect(await screen.findByRole('note')).toHaveTextContent('粘贴已被拦截');
  });

  it('可切换查看其它文件（仍是只读）', async () => {
    const api = makeApi();
    render(
      <CodeViewProvider api={api}>
        <CodeView />
      </CodeViewProvider>,
    );

    await waitFor(() => expect(screen.getByText('src/auth/captcha.service.ts')).toBeInTheDocument());
    fireEvent.click(screen.getByText('src/auth/captcha.service.ts'));
    await waitFor(() => expect(screen.getByTestId('ec-code-surface')).toHaveTextContent('captcha'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('未注入端口时抛错由边界捕获（组件要求外层提供 Provider）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<CodeView path="a.ts" />)).toThrow(/代码视图未初始化/);
    spy.mockRestore();
  });
});

describe('DiffView（T4-05 要点 4）', () => {
  it('逐文件展示增删统计，按文件勾选后回调', () => {
    const model = toDiffViewModel(plan());
    const onToggleFile = vi.fn();
    render(<DiffView model={model} onToggleFile={onToggleFile} />);

    expect(screen.getByText('src/auth/auth.controller.ts')).toBeInTheDocument();
    expect(screen.getByTestId('ec-diff-view')).toHaveTextContent('2/3 个文件将应用');
    expect(document.querySelector('[data-diff-blocked="true"]')).not.toBeNull();
    expect(screen.getByText(/补丁片段在文件中找不到对应内容/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('应用 src/auth/auth.controller.ts'));
    expect(onToggleFile).toHaveBeenCalledWith('src/auth/auth.controller.ts');
  });

  it('内联 / 并排视图切换', () => {
    const model = toDiffViewModel(plan());
    render(<DiffView model={model} />);
    expect(screen.getAllByTestId('ec-diff-inline').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText('切换到并排视图'));
    expect(screen.getAllByTestId('ec-diff-side-by-side').length).toBeGreaterThan(0);
  });

  it('可按块勾选，并把选择范围交给「要求 AI 重改」', () => {
    const longBefore = Array.from({ length: 30 }, (_, index) => `l${index + 1}`).join('\n');
    const longAfter = longBefore.replace('l3', 'l3x').replace('l25', 'l25x');
    const model = toDiffViewModel(
      plan({
        entries: [
          {
            path: 'a.ts',
            action: 'patch',
            language: 'ts',
            content: '',
            before: longBefore,
            after: longAfter,
            blocked: false,
            blockReason: null,
            changed: true,
            selected: true,
          },
        ],
      }),
    );
    const onToggleHunk = vi.fn();
    const onRequestRework = vi.fn();
    render(<DiffView model={model} onToggleHunk={onToggleHunk} onRequestRework={onRequestRework} />);

    expect(document.querySelector('[data-hunk-key="a.ts#0"]')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('应用 a.ts 第 2 块'));
    expect(onToggleHunk).toHaveBeenCalledWith('a.ts', 1);

    fireEvent.click(screen.getByLabelText('要求 AI 重改'));
    expect(onRequestRework).toHaveBeenCalledWith(['a.ts']);
  });

  it('大文件跳过内容 diff 并提示', () => {
    const model = toDiffViewModel(
      plan({
        entries: [
          {
            path: 'big.ts',
            action: 'patch',
            language: 'ts',
            content: '',
            before: 'x'.repeat(1024 * 1024 + 1),
            after: 'y',
            blocked: false,
            blockReason: null,
            changed: true,
            selected: true,
          },
        ],
      }),
    );
    render(<DiffView model={model} />);
    expect(screen.getByText(/已跳过逐行 diff/)).toBeInTheDocument();
  });
});

describe('ApplyBar（T4-05 要点 1 / 5）', () => {
  it('展示将应用的文件，应用成功后回显结果', async () => {
    const model = toDiffViewModel(plan());
    const onApply = vi.fn(
      async (): Promise<WriteResult> => ({
        ok: true,
        planId: 'plan-1',
        applied: ['src/auth/auth.controller.ts', 'src/auth/captcha.service.ts'],
        skipped: [],
        rolledBack: [],
        error: null,
      }),
    );
    render(<ApplyBar plan={plan()} model={model} onApply={onApply} />);

    expect(screen.getByText(/将应用：修改 src\/auth\/auth.controller.ts/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('应用变更'));

    await waitFor(() => expect(screen.getByTestId('ec-apply-result')).toHaveAttribute('data-apply-ok', 'true'));
    expect(screen.getByTestId('ec-apply-result')).toHaveTextContent('已应用 2 个文件');
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-1' }), 'preview');
  });

  it('应用失败时展示错误与回滚情况', async () => {
    const model = toDiffViewModel(plan());
    const onApply = vi.fn(
      async (): Promise<WriteResult> => ({
        ok: false,
        planId: 'plan-1',
        applied: [],
        skipped: [],
        rolledBack: ['src/auth/auth.controller.ts'],
        error: '磁盘写入失败',
      }),
    );
    render(<ApplyBar plan={plan()} model={model} onApply={onApply} />);
    fireEvent.click(screen.getByLabelText('应用变更'));

    await waitFor(() => expect(screen.getByTestId('ec-apply-result')).toHaveAttribute('data-apply-ok', 'false'));
    expect(screen.getByTestId('ec-apply-result')).toHaveTextContent('已回滚 1 个文件');
  });

  it('列出被拒绝的文件并给出原因', () => {
    const model = toDiffViewModel(plan());
    render(<ApplyBar plan={plan()} model={model} onApply={vi.fn(async () => ({ ok: true, planId: 'p', applied: [], skipped: [], rolledBack: [], error: null }))} />);
    const blocked = screen.getByRole('list', { name: '被拒绝的文件' });
    expect(within(blocked).getByText(/src\/broken.ts/)).toBeInTheDocument();
  });

  it('不存在"手动编辑"模式：模式选项只有新建 / 增量补丁 / 预览后应用', () => {
    const model = toDiffViewModel(plan());
    render(<ApplyBar plan={plan()} model={model} onApply={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('写入模式'));
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['新建文件', '增量补丁', '预览后应用']);
    expect(options.join()).not.toContain('编辑');
  });

  it('「要求 AI 重改」把选择范围交回 AI', () => {
    const model = toDiffViewModel(plan());
    const onRequestRework = vi.fn();
    render(<ApplyBar plan={plan()} model={model} onApply={vi.fn()} onRequestRework={onRequestRework} />);
    fireEvent.click(screen.getByLabelText('要求 AI 重改'));
    expect(onRequestRework).toHaveBeenCalledWith(['src/auth/auth.controller.ts', 'src/auth/captcha.service.ts']);
  });

  it('未选中任何文件时禁止应用', () => {
    const model = toDiffViewModel(plan(), { unselectedPaths: ['src/auth/auth.controller.ts', 'src/auth/captcha.service.ts'] });
    render(<ApplyBar plan={plan()} model={model} onApply={vi.fn()} />);
    expect(screen.getByLabelText('应用变更')).toBeDisabled();
    expect(screen.getByText(/未选择任何文件/)).toBeInTheDocument();
  });
});
