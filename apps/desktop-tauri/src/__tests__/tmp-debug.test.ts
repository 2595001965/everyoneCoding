/**
 * Tauri 桥接层路径回归测试。
 * 背景：曾出现 join('C:\\Users\\x', 'sub') 产出 'C:\\C:\\Users\\x\\sub' 的盘符重复缺陷，
 * 本用例固定该回归（文件名历史原因为 tmp-debug，待回收站恢复后可合并入 bridge.test.ts）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTauriShell } from '../bridge';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => undefined,
  Channel: class MockChannel<T = unknown> {
    id = 1;
    onmessage: ((message: T) => void) | null = null;
  },
}));

describe('Tauri 桥接层路径实现', () => {
  it('join 不重复盘符前缀', async () => {
    const shell = await createTauriShell();
    expect(shell.path.join('C:\\Users\\tester', 'sub')).toBe('C:\\Users\\tester\\sub');
    expect(shell.path.join('C:\\', 'a', 'b.txt')).toBe('C:\\a\\b.txt');
    expect(shell.path.join('C:/Users/x', 'y')).toBe('C:\\Users\\x\\y');
  });

  it('basename / extname / isWithin 语义正确', async () => {
    const shell = await createTauriShell();
    expect(shell.path.basename('C:\\a\\b.txt')).toBe('b.txt');
    expect(shell.path.extname('C:\\a\\b.txt')).toBe('.txt');
    expect(shell.path.isWithin('C:\\workspace', 'C:\\workspace\\p\\x')).toBe(true);
    expect(shell.path.isWithin('C:\\workspace', 'D:\\other')).toBe(false);
  });
});
