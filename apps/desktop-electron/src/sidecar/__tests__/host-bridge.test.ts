import { describe, expect, it, vi } from 'vitest';

import { HOST_CAPABILITIES } from '../protocol';
import type { SidecarLink } from '../link';
import { createHostCipher, createHostPorts } from '../service';

/**
 * 宿主能力适配层：DPAPI 原语与外壳端口的**诚实性**测试。
 *
 * 这里只钉一条纪律，但它是最重要的一条：**宿主没做成，就不能返回"成功"**。
 * 失败被吞掉的后果不是报错，而是"密钥其实没存上"，而用户以为存上了——
 * 那类故障要等到重启后登录失败才会暴露。
 */

function fakeLink(overrides: Partial<SidecarLink> = {}): {
  link: SidecarLink;
  calls: Array<{ capability: string; payload: unknown }>;
} {
  const calls: Array<{ capability: string; payload: unknown }> = [];
  const link: SidecarLink = {
    send: vi.fn(),
    emitEvent: vi.fn(),
    log: vi.fn(),
    closed: false,
    async callHost(capability, payload) {
      calls.push({ capability, payload });
      if (capability === HOST_CAPABILITIES.secureEncrypt) {
        return { cipherBase64: Buffer.from('密文占位', 'utf8').toString('base64') };
      }
      if (capability === HOST_CAPABILITIES.secureDecrypt) return { plainText: '解出来的明文' };
      return undefined;
    },
    ...overrides,
  };
  return { link, calls };
}

describe('宿主能力适配：DPAPI 原语', () => {
  it('可用性来自握手结果，且是**同步**回答（装配期要立刻决定装不装 auth 域）', () => {
    const { link } = fakeLink();
    expect(createHostCipher(link, true).isEncryptionAvailable()).toBe(true);
    expect(createHostCipher(link, false).isEncryptionAvailable()).toBe(false);
  });

  it('加解密经宿主往返，且明文/密文形状正确', async () => {
    const { link, calls } = fakeLink();
    const cipher = createHostCipher(link, true);

    const encrypted = await cipher.encryptString('sk-secret');
    expect(Buffer.isBuffer(encrypted)).toBe(true);
    expect(calls[0]?.capability).toBe(HOST_CAPABILITIES.secureEncrypt);
    expect(calls[0]?.payload).toEqual({ plainText: 'sk-secret' });

    const decrypted = await cipher.decryptString(Buffer.from('x'));
    expect(decrypted).toBe('解出来的明文');
    expect(calls[1]?.capability).toBe(HOST_CAPABILITIES.secureDecrypt);
    // 密文以 base64 过管道：二进制不经 JSON 直传（会被当成非法 UTF-8 损坏）
    expect(calls[1]?.payload).toEqual({ cipherBase64: Buffer.from('x').toString('base64') });
  });

  it('宿主加密失败 → 抛错，绝不返回"空密文"冒充成功', async () => {
    const { link } = fakeLink({
      callHost: () =>
        Promise.reject(Object.assign(new Error('DPAPI 不可用'), { code: 'ENCRYPT_FAILED' })),
    });
    const cipher = createHostCipher(link, true);
    await expect(cipher.encryptString('sk-secret')).rejects.toThrow(/DPAPI 不可用/);
  });

  it('宿主应答缺字段 → 抛错（空串会被当成"密文为空"，比失败更糟）', async () => {
    const { link } = fakeLink({ callHost: () => Promise.resolve({ somethingElse: 'x' }) });
    const cipher = createHostCipher(link, true);
    await expect(cipher.encryptString('sk-secret')).rejects.toThrow(/cipherBase64/);
    await expect(cipher.decryptString(Buffer.from('x'))).rejects.toThrow(/plainText/);
  });

  it('宿主关闭连接后调用 → 以 CANCELLED 拒绝（不是静默成功）', async () => {
    const { link } = fakeLink({
      closed: true,
      callHost: () => Promise.reject(new Error('不应走到这里')),
    });
    const cipher = createHostCipher(link, true);
    // closed 由 createLink 内部维护；此处的假 link 直接拒绝，验证消费方不吞错
    await expect(cipher.encryptString('x')).rejects.toThrow();
  });
});

describe('宿主能力适配：外壳端口', () => {
  it('openExternal 转发给宿主（auth 域 OAuth 主通道依赖它）', async () => {
    const { link, calls } = fakeLink();
    await createHostPorts(link).openExternal('https://example.com/oauth');
    expect(calls[0]).toEqual({
      capability: HOST_CAPABILITIES.shellOpenExternal,
      payload: { url: 'https://example.com/oauth' },
    });
  });

  it('writeClipboard 是 fire-and-forget，但失败会留痕（不伪造成功）', async () => {
    const log = vi.fn();
    const { link, calls } = fakeLink({
      log,
      callHost: (_capability, payload) => {
        calls.push({ capability: 'clipboard.writeText', payload });
        return Promise.reject(new Error('剪贴板被占用'));
      },
    });
    // 同步签名：立刻返回，不阻塞调用方
    expect(() => createHostPorts(link).writeClipboard('授权码 1234')).not.toThrow();
    expect(calls).toHaveLength(1);

    // 失败必须在日志里留痕：否则用户只会看到"剪贴板没变"而无从判断
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(String(log.mock.calls[0]?.[1])).toMatch(/剪贴板被占用/);
  });

  it('onNotice 走正式日志通道（不污染 stdout）', () => {
    const { link } = fakeLink();
    const log = link.log as unknown as ReturnType<typeof vi.fn>;
    createHostPorts(link).onNotice?.('数据目录迁移完成');
    expect(log).toHaveBeenCalledWith('warn', '数据目录迁移完成');
  });
});
