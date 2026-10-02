import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConnectionTest } from '../provider/ConnectionTest';

/** V2-T03 / V2-MDL-07：连接测试是可能计费的真实对话，必须先确认，不得一键直发 */

function renderTest(onTest: () => void, props?: { state?: 'idle' | 'running' }) {
  return render(<ConnectionTest state={props?.state ?? 'idle'} result={null} onTest={onTest} />);
}

describe('ConnectionTest 收费确认', () => {
  it('首次点击只弹确认，不直接发起测试', async () => {
    const user = userEvent.setup();
    const onTest = vi.fn();
    renderTest(onTest);

    await user.click(screen.getByRole('button', { name: '连接测试' }));

    const dialog = screen.getByRole('alertdialog', { name: '确认连接测试' });
    expect(dialog.textContent).toContain('可能消耗 Token');
    expect(onTest).not.toHaveBeenCalled();
  });

  it('确认后才发起测试，取消则不发起', async () => {
    const user = userEvent.setup();
    const onTest = vi.fn();
    renderTest(onTest);

    await user.click(screen.getByRole('button', { name: '连接测试' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onTest).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '连接测试' }));
    await user.click(screen.getByRole('button', { name: '确认测试' }));
    expect(onTest).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
