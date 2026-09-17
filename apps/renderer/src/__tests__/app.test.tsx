import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { useUiStore } from '../store/useUiStore';

beforeEach(() => {
  window.location.hash = '#/';
  useUiStore.setState({ theme: 'light', locale: 'zh-CN', rightPanelOpen: false });
});

describe('应用入口', () => {
  it('未连接数据库也能启动欢迎页，顶栏主题变化应用到整个文档', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: '工作台', level: 1 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '切换主题' }));
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('dark'));
    expect(screen.getByRole('link', { name: '探索设计器' })).toHaveAttribute('href', '#/designer');
  });

  it('可以按需加载设置页，通用设置未连接时仍展示模型类目', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('link', { name: '设置' }));
    expect(await screen.findByLabelText('设置类目', {}, { timeout: 10000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: '模型服务' })).toBeTruthy();
  });
});
