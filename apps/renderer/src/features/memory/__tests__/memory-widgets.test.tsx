import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AutoWriteToast } from '../AutoWriteToast';
import { ConflictCard } from '../ConflictCard';
import { IssueMemoryDraft, type IssueMemoryDraftValue } from '../IssueMemoryDraft';
import { IssuePromptCard } from '../IssuePromptCard';
import { MarkdownPreview } from '../MarkdownPreview';
import { StructurePreview } from '../../designer/StructurePreview';

/** T2-04 / T2-05 / T2-06 的渲染层交互测试 */

describe('AutoWriteToast（T2-04 策略②：自动写入 + 可撤销）', () => {
  it('显示写入条目与来源片段，点击撤销触发回调', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    render(
      <AutoWriteToast
        record={{ memoryId: 'M1', title: '命名规范', policy: 'confirm', category: '命名规范', snippet: '以后都用小驼峰' }}
        onUndo={onUndo}
      />,
    );

    expect(screen.getByTestId('auto-write-toast')).toBeInTheDocument();
    expect(screen.getByText(/已记入长期记忆：命名规范/)).toBeInTheDocument();
    expect(screen.getByText(/以后都用小驼峰/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(onUndo).toHaveBeenCalledWith('M1');
    expect(screen.getByRole('button', { name: '已撤销' })).toBeDisabled();
  });

  it('到期自动消失（默认 5 秒；这里用 300ms 缩短验证）', async () => {
    const onDismiss = vi.fn();
    render(
      <AutoWriteToast
        record={{ memoryId: 'M1', title: '目录结构', policy: 'confirm' }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
        durationMs={300}
      />,
    );
    await waitFor(() => expect(onDismiss).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('点击「查看」回调条目 id', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <AutoWriteToast
        record={{ memoryId: 'M9', title: 'UI 风格', policy: 'confirm' }}
        onUndo={vi.fn()}
        onOpen={onOpen}
      />,
    );
    await user.click(screen.getByRole('button', { name: '查看' }));
    expect(onOpen).toHaveBeenCalledWith('M9');
  });
});

describe('ConflictCard（T2-04 冲突三选项）', () => {
  const model = {
    memoryId: 'M1',
    title: '命名规范',
    category: '命名规范',
    existing: { title: '命名规范', content: '小驼峰' },
    incoming: { title: '命名规范', content: 'snake_case' },
    fields: ['content'],
  };

  it('三个选项各自触发对应策略', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(<ConflictCard model={model} onResolve={onResolve} />);

    expect(screen.getByTestId('conflict-card')).toBeInTheDocument();
    expect(screen.getByText('小驼峰')).toBeInTheDocument();
    expect(screen.getByText('snake_case')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '采用新' }));
    expect(onResolve).toHaveBeenLastCalledWith('takeNew');
    await user.click(screen.getByRole('button', { name: '保留旧' }));
    expect(onResolve).toHaveBeenLastCalledWith('keepLocal');
    await user.click(screen.getByRole('button', { name: '合并' }));
    expect(onResolve).toHaveBeenLastCalledWith('merge');
    expect(onResolve).toHaveBeenCalledTimes(3);
  });
});

describe('IssuePromptCard（T2-05 非模态提示卡）', () => {
  it('非模态：不是 dialog、不夺取输入焦点', async () => {
    render(
      <IssuePromptCard
        suggestion={{ targetKey: 'page:PG1|element:E1', title: '登录页 / 提交按钮', detail: '窗口内已命中 3 次循环' }}
        onBuild={vi.fn()}
        onLater={vi.fn()}
        onNeverShow={vi.fn()}
      />,
    );

    // 非模态：不应存在 dialog 角色，也不应成为焦点
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const card = screen.getByTestId('issue-prompt-card');
    expect(card).toHaveAttribute('role', 'status');
    expect(document.activeElement).not.toBe(card);
  });

  it('三个动作各自回调', async () => {
    const user = userEvent.setup();
    const onBuild = vi.fn();
    const onLater = vi.fn();
    const onNeverShow = vi.fn();
    render(
      <IssuePromptCard
        suggestion={{ targetKey: 'k', title: '登录页' }}
        onBuild={onBuild}
        onLater={onLater}
        onNeverShow={onNeverShow}
      />,
    );

    await user.click(screen.getByRole('button', { name: '立即建立' }));
    await user.click(screen.getByRole('button', { name: '稍后' }));
    await user.click(screen.getByRole('button', { name: '不再提示此项' }));
    expect(onBuild).toHaveBeenCalledTimes(1);
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(onNeverShow).toHaveBeenCalledTimes(1);
  });
});

describe('IssueMemoryDraft（T2-05 草稿可编辑）', () => {
  const draft: IssueMemoryDraftValue = {
    title: '登录后刷新页面 Session 丢失',
    phenomenon: '刷新后跳转登录页',
    reproduce: ['登录成功', '刷新页面'],
    attempts: [{ action: '调整 token 过期时间', result: '无效' }],
    conclusion: '',
    commitSha: 'abc1234',
    relatedPageId: 'PG1',
    relatedElementId: 'E1',
    relatedFeatureId: 'F1',
    codeLocations: [{ filePath: 'src/auth/session.ts', symbol: 'writeSession' }],
  };

  it('自动汇总关联信息，编辑后保存携带改动', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<IssueMemoryDraft draft={draft} onSave={onSave} onCancel={vi.fn()} />);

    expect(screen.getByText(/调整 token 过期时间（无效）/)).toBeInTheDocument();
    expect(screen.getByText(/页面 PG1/)).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();

    const title = screen.getByRole('textbox', { name: '问题标题' });
    await user.clear(title);
    await user.type(title, 'Session 丢失（已复现）');
    const reproduce = screen.getByRole('textbox', { name: '复现步骤' });
    await user.clear(reproduce);
    await user.type(reproduce, '登录成功{enter}刷新页面{enter}第三次刷新');
    await user.click(screen.getByRole('button', { name: '保存为问题记忆' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]?.[0] as IssueMemoryDraftValue;
    expect(saved.title).toBe('Session 丢失（已复现）');
    expect(saved.reproduce).toEqual(['登录成功', '刷新页面', '第三次刷新']);
  });
});

describe('StructurePreview（T2-06 摘要预览与 token 估算）', () => {
  const summary = {
    skeleton: 'Container[Card[Form[Input(phone), Button(submit)]]]',
    state: ['phone', 'password'],
    events: [{ trigger: 'submit.click', actions: ['POST /api/auth/login'] }],
    apiDeps: ['/api/auth/login'],
  };

  it('展示 token 估算与摘要内容，超预算时标记已裁剪', () => {
    render(
      <StructurePreview
        summary={summary}
        tokenEstimate={1840}
        tokenBudget={2000}
        truncated
        revisions={[{ revision: 3, tokenEstimate: 1800, createdAt: 1_700_000_000_000, changed: ['btn-submit'] }]}
      />,
    );

    expect(screen.getByTestId('structure-tokens')).toHaveTextContent('1840 / 2000 tokens');
    expect(screen.getByText('已裁剪')).toBeInTheDocument();
    expect(screen.getByText(/Container\[Card/)).toBeInTheDocument();
    expect(screen.getByTestId('structure-revision-3')).toBeInTheDocument();
    expect(screen.getByText(/变更：btn-submit/)).toBeInTheDocument();
  });

  it('手动编辑并保存摘要', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StructurePreview summary={summary} tokenEstimate={100} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: '手动编辑' }));
    const editor = screen.getByRole('textbox', { name: '结构摘要 JSON' });
    await user.clear(editor);
    // 用 paste 而不是 type：userEvent 会把 `{` `}` `[` `]` 当特殊键描述符
    await user.click(editor);
    await user.paste('{"skeleton":"Container[]"}');
    await user.click(screen.getByRole('button', { name: '保存摘要' }));

    expect(onChange).toHaveBeenCalledWith({ skeleton: 'Container[]' });
  });
});

describe('MarkdownPreview', () => {
  it('渲染标题、列表、代码块与行内强调', () => {
    render(
      <MarkdownPreview
        text={'## 规范\n- **小驼峰**\n- 统一用 `npm`\n\n```ts\nconst a = 1;\n```\n> 备注'}
      />,
    );
    expect(screen.getByText('规范')).toBeInTheDocument();
    expect(screen.getByText('小驼峰')).toBeInTheDocument();
    expect(screen.getByText('npm')).toBeInTheDocument();
    expect(screen.getByText(/const a = 1;/)).toBeInTheDocument();
    expect(screen.getByText('备注')).toBeInTheDocument();
  });

  it('不注入原始 HTML（防 XSS）', () => {
    render(<MarkdownPreview text={'<img src=x onerror=alert(1)>'} />);
    expect(screen.getByTestId('markdown-preview').querySelector('img')).toBeNull();
  });
});
