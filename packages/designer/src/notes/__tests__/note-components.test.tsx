import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LayerNode } from '../../layers/LayerNode';
import { ElementNoteBadges, NoteBadge, describeNoteBadge } from '../NoteBadge';
import { NoteHistory } from '../NoteHistory';
import { NotePanel } from '../NotePanel';
import { NotePopover } from '../NotePopover';
import { NoteRepository, type NoteBadgeInfo } from '../note-repo';

function makeRepo(): NoteRepository {
  let counter = 0;
  let current = 1_000;
  return new NoteRepository({
    projectId: 'P1',
    clock: () => (current += 1),
    idFactory: (prefix) => `${prefix}-${(counter += 1)}`,
  });
}

/** Select 是自绘组合框：先点开触发器，再点选项 */
function chooseOption(label: string, optionName: string): void {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(screen.getByRole('option', { name: optionName }));
}

describe('NoteBadge（T4-01 要点 3）', () => {
  it('渲染数量与类型描述，禁止事项加硬约束标记', () => {
    render(<NoteBadge info={{ count: 3, types: ['todo', 'forbidden'], hasMustFollow: true }} />);
    const badge = screen.getByRole('img', { name: describeNoteBadge({ count: 3, types: ['todo', 'forbidden'], hasMustFollow: true }) });
    expect(badge).toHaveAttribute('data-note-badge', '3');
    expect(badge).toHaveAttribute('data-note-must-follow', 'true');
    expect(badge).toHaveTextContent('3');
  });

  it('超过 99 条显示 99+', () => {
    render(<NoteBadge info={{ count: 120, types: ['todo'], hasMustFollow: false }} />);
    expect(screen.getByRole('img')).toHaveTextContent('99+');
  });

  it('传入 onClick 后变为可点击（role=button）并可触发', () => {
    const onClick = vi.fn();
    render(<NoteBadge info={{ count: 1, types: ['validation'], hasMustFollow: false }} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('ElementNoteBadges 元素角标浮层（T4-01）', () => {
  it('按测量结果定位，缺失元素跳过', () => {
    const badges: Record<string, NoteBadgeInfo> = {
      'el-1': { count: 1, types: ['validation'], hasMustFollow: false },
      'el-2': { count: 2, types: ['forbidden'], hasMustFollow: true },
    };
    render(
      <ElementNoteBadges
        badges={badges}
        measure={(id) => (id === 'el-1' ? { top: 10, left: 20, width: 80 } : null)}
      />,
    );
    expect(screen.getByTestId('ec-note-badges').querySelectorAll('[data-note-anchor]')).toHaveLength(1);
    expect(screen.getByTestId('ec-note-badges').querySelector('[data-note-anchor="el-1"]')).not.toBeNull();
  });

  it('无角标时不渲染任何浮层', () => {
    const { container } = render(<ElementNoteBadges badges={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it('点击角标回调元素 id', () => {
    const onSelect = vi.fn();
    render(
      <ElementNoteBadges
        badges={{ 'el-1': { count: 1, types: ['todo'], hasMustFollow: false } }}
        measure={() => ({ top: 0, left: 0, width: 10 })}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith('el-1');
  });
});

describe('LayerNode 备注图标（T4-01）', () => {
  it('传入 note 时显示角标，未传时不渲染', () => {
    const { rerender } = render(
      <LayerNode
        element={{ id: 'el-1', type: 'Button', name: '登录按钮' }}
        editing={false}
        onStartRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        note={{ count: 1, types: ['validation'], hasMustFollow: false }}
      />,
    );
    expect(screen.getByRole('img', { name: /备注 1 条/ })).toBeInTheDocument();

    rerender(
      <LayerNode
        element={{ id: 'el-1', type: 'Button', name: '登录按钮' }}
        editing={false}
        onStartRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
      />,
    );
    expect(screen.queryByRole('img', { name: /备注/ })).toBeNull();
  });
});

describe('NotePopover 新增备注（T4-01 验收：给登录按钮加校验备注）', () => {
  it('选择类型、填写标题与正文、加清单与代码片段后可保存', () => {
    const repo = makeRepo();
    const onSaved = vi.fn();
    render(
      <NotePopover
        open
        target={{ targetType: 'element', targetId: 'el-btn', label: '登录按钮' }}
        repository={repo}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    chooseOption('备注类型', '校验要求');
    fireEvent.change(screen.getByLabelText('备注标题'), { target: { value: '登录按钮需校验图形验证码' } });
    fireEvent.change(screen.getByLabelText('备注正文 第 1 段'), { target: { value: '点击登录前必须校验图形验证码' } });
    fireEvent.click(screen.getByLabelText('添加清单项'));
    fireEvent.change(screen.getByLabelText('清单项文本 1'), { target: { value: '校验失败需提示' } });
    fireEvent.click(screen.getByLabelText('添加代码片段'));
    fireEvent.change(screen.getByLabelText('代码内容 1'), { target: { value: 'if (!captcha.ok) throw new Error();' } });

    fireEvent.click(screen.getByLabelText('保存备注'));

    const notes = repo.list();
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note.type).toBe('validation');
    expect(note.title).toBe('登录按钮需校验图形验证码');
    expect(note.targetType).toBe('element');
    expect(note.targetId).toBe('el-btn');
    expect(note.checklists).toHaveLength(1);
    expect(note.codeBlocks).toHaveLength(1);
    expect(note.priority).toBe(4);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('禁止事项：提示硬约束，优先级锁定 P5 且选择器禁用', () => {
    const repo = makeRepo();
    render(
      <NotePopover open target={{ targetType: 'element', targetId: 'el-1' }} repository={repo} onClose={vi.fn()} />,
    );
    chooseOption('备注类型', '禁止事项');
    expect(screen.getByRole('note')).toHaveTextContent('优先级锁定为 P5');
    expect(screen.getByLabelText('优先级')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('备注标题'), { target: { value: '不得明文存 Key' } });
    fireEvent.click(screen.getByLabelText('保存备注'));
    expect(repo.list()[0]?.priority).toBe(5);
    expect(repo.list()[0]?.manualPriority).toBeNull();
  });

  it('内容为空时拒绝保存并给出提示', () => {
    const repo = makeRepo();
    render(
      <NotePopover open target={{ targetType: 'page', targetId: 'page-1' }} repository={repo} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByLabelText('保存备注'));
    expect(screen.getByRole('alert')).toHaveTextContent('备注内容不能为空');
    expect(repo.list()).toHaveLength(0);
  });

  it('富文本：选区命中后加粗写入标记', () => {
    const repo = makeRepo();
    render(
      <NotePopover open target={{ targetType: 'page', targetId: 'page-1' }} repository={repo} onClose={vi.fn()} />,
    );
    const textarea = screen.getByLabelText('备注正文 第 1 段') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '需校验图形验证码' } });
    textarea.setSelectionRange(0, 3);
    fireEvent.click(screen.getByLabelText('加粗（第 1 段）'));
    expect(screen.getByText('预览：')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('备注标题'), { target: { value: 'A' } });
    fireEvent.click(screen.getByLabelText('保存备注'));
    const note = repo.list()[0]!;
    const block = note.content.blocks[0];
    expect(block?.type).toBe('paragraph');
    expect(block !== undefined && block.type === 'paragraph' ? block.spans[0]?.marks : []).toEqual(['bold']);
  });

  it('编辑既有备注走更新路径并递增版本', () => {
    const repo = makeRepo();
    const note = repo.create({ targetType: 'page', targetId: 'page-1', title: '初稿', text: '正文' });
    render(
      <NotePopover
        open
        target={{ targetType: 'page', targetId: 'page-1' }}
        repository={repo}
        note={note}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('备注标题')).toHaveValue('初稿');
    fireEvent.change(screen.getByLabelText('备注标题'), { target: { value: '改后' } });
    fireEvent.click(screen.getByLabelText('保存备注'));
    expect(repo.get(note.id)?.title).toBe('改后');
    expect(repo.get(note.id)?.version).toBe(2);
  });
});

describe('NotePanel 备注面板（T4-01 要点 3）', () => {
  it('展示全部备注、支持层级 / 类型 / 状态筛选与搜索', () => {
    const repo = makeRepo();
    repo.create({ targetType: 'element', targetId: 'el-btn', title: '需校验图形验证码', text: '正文' });
    repo.create({ targetType: 'page', targetId: 'page-1', title: '页面待办', type: 'todo' });
    const resolved = repo.create({ targetType: 'page', targetId: 'page-1', title: '已解决项' });
    repo.resolve(resolved.id);

    render(<NotePanel repository={repo} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    chooseOption('按层级筛选', '元素备注');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    chooseOption('按层级筛选', '全部层级');
    chooseOption('按状态筛选', '已解决');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('已解决项')).toBeInTheDocument();

    chooseOption('按状态筛选', '全部状态');
    fireEvent.change(screen.getByLabelText('搜索备注'), { target: { value: '验证码' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('点击定位回调目标；未解决计数暴露给仪表盘', () => {
    const repo = makeRepo();
    const note = repo.create({ targetType: 'element', targetId: 'el-btn', title: 'A' });
    const onJumpToTarget = vi.fn();
    const onCountChange = vi.fn();
    render(<NotePanel repository={repo} onJumpToTarget={onJumpToTarget} onCountChange={onCountChange} />);

    fireEvent.click(screen.getByLabelText('跳转到 el-btn'));
    expect(onJumpToTarget).toHaveBeenCalledWith({ targetType: 'element', targetId: 'el-btn', noteId: note.id });
    expect(onCountChange).toHaveBeenLastCalledWith(expect.objectContaining({ unresolved: 1, mustFollow: 0 }));
  });

  it('删除必须二次确认，取消不删除', () => {
    const repo = makeRepo();
    const note = repo.create({ targetType: 'element', targetId: 'el-1', title: 'A' });
    render(<NotePanel repository={repo} />);

    fireEvent.click(screen.getByLabelText(`删除 ${note.id}`));
    expect(screen.getByText(/删除后历史一并丢失/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('取消'));
    expect(repo.list()).toHaveLength(1);

    fireEvent.click(screen.getByLabelText(`删除 ${note.id}`));
    fireEvent.click(screen.getByLabelText(`确认删除 ${note.id}`));
    expect(repo.list()).toHaveLength(0);
  });

  it('解决 / 重开按钮切换状态', () => {
    const repo = makeRepo();
    const note = repo.create({ targetType: 'element', targetId: 'el-1', title: 'A' });
    render(<NotePanel repository={repo} />);
    fireEvent.click(screen.getByText('标记已解决'));
    expect(repo.get(note.id)?.status).toBe('resolved');
    fireEvent.click(screen.getByText('重新打开'));
    expect(repo.get(note.id)?.status).toBe('open');
  });
});

describe('NoteHistory 变更留痕（T4-01 要点 4）', () => {
  it('展示历史版本与字段变更摘要，可回退', () => {
    const repo = makeRepo();
    const note = repo.create({ targetType: 'element', targetId: 'el-1', title: '第一版', text: '正文' });
    repo.update(note.id, { title: '第二版' });
    const onRestored = vi.fn();

    render(<NoteHistory repository={repo} noteId={note.id} onRestored={onRestored} />);
    expect(screen.getByTestId('ec-note-history-current')).toHaveTextContent('v2');
    expect(screen.getByText('标题')).toBeInTheDocument();

    const list = screen.getByRole('list');
    fireEvent.click(within(list).getByLabelText('回退到 v1'));
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(repo.get(note.id)?.title).toBe('第一版');
    expect(repo.get(note.id)?.version).toBe(3);
  });

  it('备注不存在时展示空态而不是崩溃', () => {
    const repo = makeRepo();
    render(<NoteHistory repository={repo} noteId="missing" />);
    expect(screen.getByText('备注不存在')).toBeInTheDocument();
  });
});
