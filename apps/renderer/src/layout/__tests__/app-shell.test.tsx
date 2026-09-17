import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppShell } from '../AppShell';
import { sanitizeUiPreferences, useUiStore } from '../../store/useUiStore';

function Location() {
  return <p data-testid="location">{useLocation().pathname}</p>;
}
beforeEach(() => {
  useUiStore.setState({
    theme: 'light',
    locale: 'zh-CN',
    leftNavWidth: 220,
    rightPanelOpen: false,
    rightPanelWidth: 320,
  });
});

describe('应用导航与布局', () => {
  it('Ctrl K 支持搜索跳转，重新打开时清除上次搜索', () => {
    render(
      <MemoryRouter>
        <AppShell>
          <Location />
        </AppShell>
      </MemoryRouter>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '设置' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/settings');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '快速跳转' }));
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('拖动分栏的键盘操作保存宽度，指南可折叠', () => {
    const { unmount } = render(
      <MemoryRouter>
        <AppShell>内容</AppShell>
      </MemoryRouter>,
    );
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(useUiStore.getState().leftNavWidth).toBe(236);
    expect(JSON.parse(localStorage.getItem('ec.ui.v1')!).leftNavWidth).toBe(236);
    fireEvent.click(screen.getByRole('button', { name: '切换工作指南' }));
    expect(screen.getByRole('complementary', { name: '工作指南' })).toBeTruthy();
    unmount();
    const { container } = render(
      <MemoryRouter>
        <AppShell>内容</AppShell>
      </MemoryRouter>,
    );
    expect((container.querySelector('.ec-split-pane__pane') as HTMLElement).style.flex).toContain(
      '236px',
    );
  });

  it('持久化数据损坏或越界时不会破坏主题、语言、尺寸及操作方法', () => {
    expect(sanitizeUiPreferences(null)).toEqual({});
    expect(
      sanitizeUiPreferences({
        theme: 'invalid',
        locale: 'xx',
        leftNavWidth: 'wide',
        rightPanelWidth: Infinity,
        setTheme: null,
      }),
    ).toEqual({});
    expect(
      sanitizeUiPreferences({
        theme: 'dark',
        locale: 'en-US',
        leftNavWidth: 9999,
        rightPanelWidth: -1,
        rightPanelOpen: true,
      }),
    ).toEqual({
      theme: 'dark',
      locale: 'en-US',
      leftNavWidth: 320,
      rightPanelWidth: 240,
      rightPanelOpen: true,
    });
  });
});
