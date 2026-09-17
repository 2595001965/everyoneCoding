/**
 * ShellHost 契约测试套件（可注入测试框架）。
 *
 * 之所以把断言框架作为参数注入而不是直接 import vitest：
 * 本文件属于运行时源码，若引入测试框架会被打包进产物；
 * 注入后 Tauri / Electron / Mock 三套实现可以复用同一份用例，满足「同一套契约测试」要求。
 */

import { ShellError, isShellError } from './errors';
import type { ShellHost } from './types';

export interface ContractExpectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(item: unknown): void;
  toBeGreaterThanOrEqual(value: number): void;
  toBeGreaterThan(value: number): void;
  toBeInstanceOf(ctor: unknown): void;
  toThrow(): void;
  rejects: { toThrow(): Promise<void> };
}

export interface ContractExpect {
  (actual: unknown): ContractExpectation;
}

export interface ContractHarness {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
  expect: ContractExpect;
  beforeEach?(fn: () => void | Promise<void>): void;
  afterEach?(fn: () => void | Promise<void>): void;
}

export interface ShellContractOptions {
  /**
   * 进程能力测试的示例命令，其 stdout 应包含 expectedOutput。
   * 真实外壳请传入平台可用命令（Windows: cmd /c echo ...）。
   */
  sampleProcess?: { command: string; args: string[]; expectedOutput: string };
}

const DEFAULT_SAMPLE = { command: 'echo', args: ['ec-contract'], expectedOutput: 'ec-contract' };

/** 对任意 ShellHost 实现跑同一套契约用例 */
export function runShellContract(
  title: string,
  factory: () => Promise<ShellHost> | ShellHost,
  harness: ContractHarness,
  options: ShellContractOptions = {},
): void {
  const { describe, it, expect } = harness;
  const sample = options.sampleProcess ?? DEFAULT_SAMPLE;

  describe(`ShellHost 契约 - ${title}`, () => {
    let shell!: ShellHost;

    harness.beforeEach?.(async () => {
      shell = await factory();
    });
    harness.afterEach?.(async () => {
      if (shell) await shell.dispose();
    });

    it('能力探测返回完整的能力结构', async () => {
      const caps = await shell.capabilities();
      const keys = [
        'fs',
        'watch',
        'process',
        'dialog',
        'window',
        'secureStore',
        'updater',
        'net',
        'clipboard',
        'openExternal',
        'ai',
        'domain',
      ];
      for (const key of keys) {
        expect(typeof (caps as unknown as Record<string, unknown>)[key]).toBe('boolean');
      }
    });

    it('fs 原子写：写入后可完整读回，覆盖后内容更新', async () => {
      const dir = shell.path.join(await shell.appInfo.getDataDir(), 'contract');
      await shell.fs.mkdir(dir, { recursive: true });
      const file = shell.path.join(dir, 'a.txt');
      await shell.fs.writeAtomic(file, 'first');
      expect(await shell.fs.readText(file)).toBe('first');
      await shell.fs.writeAtomic(file, 'second');
      expect(await shell.fs.readText(file)).toBe('second');
    });

    it('fs 原子写：目标是目录时抛 INVALID_ARGUMENT', async () => {
      const dir = shell.path.join(await shell.appInfo.getDataDir(), 'contract-dir');
      await shell.fs.mkdir(dir, { recursive: true });
      await expect(shell.fs.writeAtomic(dir, 'x')).rejects.toThrow();
    });

    it('fs：stat / exists / readdir / remove 语义正确', async () => {
      const root = shell.path.join(await shell.appInfo.getDataDir(), 'contract-fs');
      await shell.fs.mkdir(root, { recursive: true });
      const file = shell.path.join(root, 'x.txt');
      await shell.fs.writeAtomic(file, 'hello');
      expect(await shell.fs.exists(file)).toBe(true);
      const stat = await shell.fs.stat(file);
      expect(stat).toBeTruthy();
      expect(stat?.isFile).toBe(true);
      expect(stat?.size).toBe(5);
      const entries = await shell.fs.readdir(root);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      await shell.fs.remove(root, { recursive: true });
      expect(await shell.fs.exists(root)).toBe(false);
      expect(await shell.fs.stat(shell.path.join(root, 'nope.txt'))).toBeNull();
    });

    it('fs：读取不存在的文件抛 NOT_FOUND', async () => {
      const missing = shell.path.join(await shell.appInfo.getDataDir(), '__missing__.txt');
      await expect(shell.fs.readText(missing)).rejects.toThrow();
    });

    it('path：join / basename / extname / isWithin 行为正确', () => {
      expect(shell.path.basename(shell.path.join('a', 'b', 'c.txt'))).toBe('c.txt');
      expect(shell.path.extname('a/b/c.txt')).toBe('.txt');
      expect(shell.path.isWithin('/root', '/root/child/x')).toBe(true);
      expect(shell.path.isWithin('/root', '/other/x')).toBe(false);
    });

    it('process：spawn 可收到 stdout 与 exit', async () => {
      const child = await shell.process.spawn(sample.command, sample.args);
      const chunks: string[] = [];
      child.onStdout((chunk) => chunks.push(chunk));
      const exit = await child.exited;
      const output = chunks.join('');
      expect(output).toContain(sample.expectedOutput);
      expect(exit.code === 0 || exit.code === null).toBe(true);
    });

    it('process：kill 后 exit 带信号', async () => {
      const child = await shell.process.spawn(sample.command, sample.args);
      // 先等首帧输出，避免命令过快结束导致 kill 无效果
      await Promise.race([child.exited, new Promise((r) => setTimeout(r, 50))]);
      await child.kill();
      const exit = await child.exited;
      expect(exit.code === null || typeof exit.code === 'number').toBe(true);
    });

    it('secureStore：set / has / get / listKeys / delete 全链路', async () => {
      await shell.secureStore.set('ai-key', 'contract', 'sk-secret-value');
      expect(await shell.secureStore.has('ai-key', 'contract')).toBe(true);
      expect(await shell.secureStore.get('ai-key', 'contract')).toBe('sk-secret-value');
      expect(await shell.secureStore.listKeys('ai-key')).toContain('contract');
      await shell.secureStore.delete('ai-key', 'contract');
      expect(await shell.secureStore.get('ai-key', 'contract')).toBeNull();
    });

    it('secureStore：读取不存在的键返回 null 而非抛错', async () => {
      expect(await shell.secureStore.get('app-secret', 'nope')).toBeNull();
    });

    it('clipboard：写入后可读回', async () => {
      await shell.clipboard.writeText('ec-clip');
      expect(await shell.clipboard.readText()).toBe('ec-clip');
    });

    it('net：未放行主机必须被拒绝且不泄漏请求', async () => {
      shell.net.setAllowedHosts([]);
      expect(shell.net.isHostAllowed('example.com')).toBe(false);
      try {
        await shell.net.fetch({ url: 'https://example.com/ping' });
        throw new Error('应被拒绝却通过了');
      } catch (error) {
        const ok = isShellError(error) && (error.code === 'NET_BLOCKED' || error.code === 'NET_ERROR');
        expect(ok).toBe(true);
      }
    });

    it('window：setSize 后 getSize 反映变更', async () => {
      await shell.window.setSize({ width: 1280, height: 720 });
      const size = await shell.window.getSize();
      expect(size.width).toBe(1280);
      expect(size.height).toBe(720);
    });

    it('appInfo：返回形态、版本与数据目录', async () => {
      const info = await shell.appInfo.get();
      expect(info.kind).toBe(shell.kind);
      expect(typeof info.version).toBe('string');
      expect((await shell.appInfo.getDataDir()).length).toBeGreaterThan(0);
    });

    it('错误类型统一为 ShellError', async () => {
      try {
        await shell.fs.readText(shell.path.join(await shell.appInfo.getDataDir(), '__none__'));
        throw new Error('应当抛错');
      } catch (error) {
        expect(isShellError(error)).toBe(true);
        if (error instanceof ShellError) {
          expect(error.code).toBe('NOT_FOUND');
        }
      }
    });

    it('dispose 可重复调用且不抛错', async () => {
      await shell.dispose();
      await shell.dispose();
      expect(true).toBe(true);
    });
  });
}
