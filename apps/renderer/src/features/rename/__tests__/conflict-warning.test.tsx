/**
 * T7-03 渲染层测试：冲突与非法检测提示（FR-UNI-11）。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkName, resolveNamingRule } from '@ec/registry';

import { ConflictWarning } from '../ConflictWarning';

const RULE = resolveNamingRule({ platform: 'web' });

describe('ConflictWarning', () => {
  it('校验通过（ok）时不渲染任何内容', () => {
    const ok = checkName({ canonicalName: '用户登录按钮', entityType: 'element', rule: RULE });
    const { container } = render(<ConflictWarning result={ok} />);
    expect(container.querySelector('[data-testid="conflict-warning"]')).toBeNull();
    expect(screen.queryByText('无法使用该名称')).toBeNull();
  });

  it('result 为 null 时不渲染', () => {
    const { container } = render(<ConflictWarning result={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('阻断时列出全部违规项与说明', () => {
    const result = checkName({
      canonicalName: '用户登录按钮',
      entityType: 'element',
      rule: RULE,
      symbols: { frontend: ['UserLoginButton'], backend: ['handleUserLoginButton'] },
    });
    render(<ConflictWarning result={result} />);

    const warning = screen.getByTestId('conflict-warning');
    expect(warning.getAttribute('data-violations')).toBe('2');
    expect(screen.getAllByTestId('violation')).toHaveLength(2);
    expect(warning).toHaveTextContent('标识符冲突');
    expect(warning).toHaveTextContent('组件名');
    expect(warning).toHaveTextContent('后端方法名');
    expect(warning).toHaveTextContent('已阻断影响面分析');
  });

  it('始终给出 3 个建议名，点击后回传（不自动执行）', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const result = checkName({ canonicalName: 'for', entityType: 'element', rule: RULE });
    render(<ConflictWarning result={result} onPick={onPick} />);

    const suggestions = screen.getAllByTestId('suggestion');
    expect(suggestions).toHaveLength(3);
    await user.click(suggestions[1]!);
    expect(onPick).toHaveBeenCalledWith(suggestions[1]?.textContent);
  });

  it('未提供 onPick 时点击不报错（纯展示可用）', async () => {
    const user = userEvent.setup();
    const result = checkName({ canonicalName: 'for', entityType: 'element', rule: RULE });
    render(<ConflictWarning result={result} />);
    await user.click(screen.getAllByTestId('suggestion')[0]!);
    expect(screen.getByTestId('conflict-warning')).toBeInTheDocument();
  });
});
