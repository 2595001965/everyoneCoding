import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Button, CommandPalette, Input, Modal, Select, SplitPane, Table } from '../index';

let stylesheet: HTMLStyleElement;
beforeEach(() => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../styles.css'),
    'utf8',
  );
  document.head.appendChild(stylesheet);
});
afterEach(() => stylesheet.remove());

describe('组件与真实样式表的连接', () => {
  it('按钮与复合输入框使用组件样式，输入框内部不出现第二层原生边框', () => {
    render(
      <>
        <Button>保存</Button>
        <Input aria-label="名称" />
        <Select aria-label="类型" options={[{ value: 'web', label: 'Web' }]} />
      </>,
    );
    expect(getComputedStyle(screen.getByRole('button', { name: '保存' })).display).toBe(
      'inline-flex',
    );
    expect(getComputedStyle(screen.getByLabelText('名称')).borderTopWidth).toBe('0px');
    fireEvent.click(screen.getByRole('combobox'));
    expect(getComputedStyle(screen.getByRole('listbox')).position).toBe('absolute');
  });

  it('删除确认类弹窗使用覆盖整个窗口的遮罩，而不是插入页面尾部', () => {
    render(
      <Modal open title="确认操作">
        内容
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(getComputedStyle(dialog.parentElement!).position).toBe('fixed');
    expect(getComputedStyle(dialog.parentElement!).display).toBe('flex');
  });

  it('命令面板位于遮罩中，结果列表限制高度并可滚动', () => {
    render(
      <CommandPalette
        open
        commands={[{ id: 'settings', title: '设置' }]}
        onSelect={() => undefined}
      />,
    );
    expect(getComputedStyle(screen.getByRole('dialog').parentElement!).position).toBe('fixed');
    expect(getComputedStyle(screen.getByRole('listbox')).overflow).toBe('auto');
  });

  it('虚拟表格的表头和数据按列横向排布', () => {
    render(
      <Table
        columns={[{ key: 'name', title: '项目' }]}
        rows={[{ id: '1', name: '作品' }]}
        rowKey={(row) => row.id}
        height={200}
      />,
    );
    for (const row of screen.getAllByRole('row'))
      expect(getComputedStyle(row).display).toBe('flex');
  });

  it('分栏拖动柄具有可点击宽度和水平调整光标', () => {
    render(<SplitPane first="导航" second="内容" />);
    const divider = getComputedStyle(screen.getByRole('separator'));
    expect(divider.flexBasis).toBe('4px');
    expect(divider.cursor).toBe('col-resize');
  });
});
