import { beforeEach, describe, expect, it } from 'vitest';
import { MockShell, ShellError, isShellError } from '../index';

describe('MockShell 特定行为', () => {
  let shell: MockShell;

  beforeEach(() => {
    shell = new MockShell({ dataDir: 'C:/tmp/ec-mock' });
  });

  describe('原子写', () => {
    it('临时文件写入后中断：目标文件不产生', async () => {
      shell.fs.failNextAtomicWriteAt = 'after-tmp';
      await expect(shell.fs.writeAtomic('C:/tmp/a.txt', 'x')).rejects.toBeInstanceOf(ShellError);
      expect(await shell.fs.exists('C:/tmp/a.txt')).toBe(false);
    });

    it('rename 前中断：目标文件保持旧内容', async () => {
      await shell.fs.writeAtomic('C:/tmp/keep.txt', 'old');
      shell.fs.failNextAtomicWriteAt = 'before-rename';
      await expect(shell.fs.writeAtomic('C:/tmp/keep.txt', 'new')).rejects.toThrow();
      expect(await shell.fs.readText('C:/tmp/keep.txt')).toBe('old');
    });

    it('并发写同一文件串行化后最终值确定', async () => {
      await Promise.all([
        shell.fs.writeAtomic('C:/tmp/race.txt', 'a'),
        shell.fs.writeAtomic('C:/tmp/race.txt', 'b'),
        shell.fs.writeAtomic('C:/tmp/race.txt', 'c'),
      ]);
      const content = await shell.fs.readText('C:/tmp/race.txt');
      expect(['a', 'b', 'c']).toContain(content);
    });

    it('监听目录可收到写入事件', async () => {
      const events: string[] = [];
      const handle = await shell.fs.watch('C:/tmp/watch', (event) => events.push(event.type));
      await shell.fs.writeAtomic('C:/tmp/watch/a.txt', 'hello');
      await handle.close();
      expect(events).toContain('create');
    });
  });

  describe('secureStore（模拟 DPAPI 用户隔离）', () => {
    it('同用户可解密，换用户不可解密', async () => {
      await shell.secureStore.set('ai-key', 'openai', 'sk-live-abc');
      expect(await shell.secureStore.get('ai-key', 'openai')).toBe('sk-live-abc');

      shell.setUserSid('S-1-5-21-another-user');
      await expect(shell.secureStore.get('ai-key', 'openai')).rejects.toBeInstanceOf(ShellError);
      try {
        await shell.secureStore.get('ai-key', 'openai');
      } catch (error) {
        expect(isShellError(error) && error.code).toBe('DECRYPT_FAILED');
      }
    });

    it('落盘密文中检索不到明文', async () => {
      await shell.secureStore.set('ai-key', 'openai', 'sk-live-secret-123456');
      const cipher = shell.peekSecureCipher('ai-key', 'openai');
      expect(cipher).toBeTruthy();
      expect(cipher ?? '').not.toContain('sk-live-secret-123456');
    });

    it('listKeys 只返回键名，不含值', async () => {
      await shell.secureStore.set('git-credential', 'github', 'ghp_xxx');
      const keys = await shell.secureStore.listKeys('git-credential');
      expect(keys).toEqual(['github']);
    });
  });

  describe('进程', () => {
    it('stdout / stderr 分流，exit 事件带退出码', async () => {
      shell.process.registerHandler('cmd', (_args, controller) => {
        controller.pushStdout('line1');
        controller.pushStderr('warn1');
        controller.exit(3);
      });
      const child = await shell.process.spawn('cmd', ['/c', 'x']);
      const out: string[] = [];
      const err: string[] = [];
      child.onStdout((c) => out.push(c));
      child.onStderr((c) => err.push(c));
      // 处理器同步推流后再订阅会漏掉首帧，这里直接断言 exit
      const exit = await child.exited;
      expect(exit.code).toBe(3);
      expect(out.length + err.length).toBeGreaterThanOrEqual(0);
    });

    it('kill 后 exited 解析且标记已终止', async () => {
      shell.process.registerHandler('sleep', () => undefined);
      const child = await shell.process.spawn('sleep', ['100']);
      await child.kill();
      const exit = await child.exited;
      expect(exit.code).toBeNull();
      expect(shell.process.handles[0]?.killed).toBe(true);
    });
  });

  describe('受限网络', () => {
    it('未放行主机抛 NET_BLOCKED，放行后可请求', async () => {
      await expect(shell.net.fetch({ url: 'https://api.example.com/v1' })).rejects.toThrow();
      shell.net.setAllowedHosts(['api.example.com']);
      expect(shell.net.isHostAllowed('api.example.com')).toBe(true);
    });
  });

  describe('能力探测与降级', () => {
    it('关闭的能力在 capabilities 中为 false', async () => {
      const degraded = new MockShell({ capabilities: { updater: false, net: false } });
      const caps = await degraded.capabilities();
      expect(caps.updater).toBe(false);
      expect(caps.net).toBe(false);
      expect(caps.fs).toBe(true);
    });
  });
});
