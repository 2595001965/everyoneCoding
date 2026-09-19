import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommandPalette,
  ContextMenu,
  Drawer,
  DropdownMenu,
  Menu,
  Modal,
  Popover,
  ToastProvider,
  useMenuKeyboard,
  useToast,
} from '../components/overlay';

describe('Modal', () => {
  it('Esc 关闭、aria-modal 标记、焦点进入对话框', async () => {
    const onClose = vi.fn();
    render(
      <Modal open title="删除确认" onClose={onClose}>
        <button type="button">确认删除</button>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: '删除确认' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认删除' }));

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab 循环聚焦（焦点陷阱）', async () => {
    render(
      <Modal open title="表单" onClose={() => undefined}>
        <button type="button">第一个</button>
        <button type="button">第二个</button>
      </Modal>,
    );
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('第一个');
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('第二个');
    // 从最后一个继续 Tab 应回到第一个
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('第一个');
  });

  it('关闭按钮可触达', async () => {
    const onClose = vi.fn();
    render(
      <Modal open title="提示" onClose={onClose}>
        内容
      </Modal>,
    );
    await userEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Drawer', () => {
  it('Esc 关闭', async () => {
    const onClose = vi.fn();
    render(
      <Drawer open title="元素属性" onClose={onClose}>
        面板内容
      </Drawer>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Menu 键盘导航', () => {
  const items = [
    { key: 'rename', label: '重命名', onSelect: vi.fn() },
    { key: 'duplicate', label: '复制', disabled: true },
    { key: 'delete', label: '删除', danger: true, onSelect: vi.fn() },
  ];

  function MenuDemo({ onClose }: { onClose: () => void }) {
    const { activeIndex, setActiveIndex, onKeyDown } = useMenuKeyboard(items, onClose);
    return (
      <div onKeyDown={onKeyDown}>
        <Menu items={items} activeIndex={activeIndex} onHover={setActiveIndex} />
      </div>
    );
  }

  it('ArrowDown 跳过禁用项，Enter 执行并关闭', async () => {
    const onClose = vi.fn();
    render(<MenuDemo onClose={onClose} />);
    // 初始高亮 0（重命名），下一个可选为 2（删除）
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    expect(items[2]?.onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc 触发 onClose', async () => {
    const onClose = vi.fn();
    render(<MenuDemo onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('DropdownMenu / ContextMenu', () => {
  it('点击触发器展开并执行命令', async () => {
    const run = vi.fn();
    render(
      <DropdownMenu
        trigger={({ ref, onClick, 'aria-expanded': expanded }) => (
          <button ref={ref} onClick={onClick} aria-expanded={expanded} aria-haspopup="menu">
            更多操作
          </button>
        )}
        items={[{ key: 'export', label: '导出', onSelect: run }]}
      />,
    );
    const trigger = screen.getByRole('button', { name: '更多操作' });
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('menuitem', { name: '导出' }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ContextMenu 在指定坐标渲染并可执行', async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        at={{ x: 40, y: 60 }}
        onClose={onClose}
        items={[{ key: 'a', label: '对齐左侧', onSelect: run }]}
      />,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '对齐左侧' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Toast', () => {
  it('useToast 显示通知并带 role=status', async () => {
    function Demo() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => toast.show('已保存到本地', 'success')}>
          保存
        </button>
      );
    }
    render(
      <ToastProvider>
        <Demo />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存到本地'));
  });
});

describe('CommandPalette', () => {
  const commands = [
    { id: 'save', title: '保存项目', group: '文件', shortcut: 'Ctrl+S', run: vi.fn() },
    { id: 'new', title: '新建页面', group: '设计器', run: vi.fn() },
    { id: 'rename', title: '统一重命名', group: '设计器', run: vi.fn() },
  ];

  it('模糊检索 + ArrowDown + Enter 执行', async () => {
    render(<CommandPalette open onClose={() => undefined} commands={commands} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, '命名');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    expect(commands[2]?.run).toHaveBeenCalledTimes(1);
  });

  it('无匹配时回车不执行任何命令', async () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={commands} />);
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    await userEvent.keyboard('{Enter}');
    for (const command of commands) expect(command.run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc 关闭', async () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={commands} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Popover', () => {
  it('外点关闭', async () => {
    function Demo() {
      const anchor = useRef<HTMLButtonElement | null>(null);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button ref={anchor} onClick={() => setOpen(true)}>
            锚点
          </button>
          <div>外部区域</div>
          {open ? (
            <Popover open={open} onClose={() => setOpen(false)} anchor={anchor}>
              <div role="status">气泡内容</div>
            </Popover>
          ) : null}
        </>
      );
    }
    render(<Demo />);
    expect(screen.getByText('气泡内容')).toBeInTheDocument();
    await userEvent.click(screen.getByText('外部区域'));
    await waitFor(() => expect(screen.queryByText('气泡内容')).not.toBeInTheDocument());
  });
});
