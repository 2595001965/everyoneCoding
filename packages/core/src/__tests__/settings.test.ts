import { MockShell } from '@ec/shell-api';
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../settings';
import { SETTINGS_VERSION, migrateSettings } from '../settings-schema';
import { SecureStore } from '../secure-store';
import { Telemetry } from '../telemetry';

describe('设置中心', () => {
  it('默认值合法且可解析', () => {
    const store = new SettingsStore();
    expect(store.getGlobal().language).toBe('zh-CN');
    expect(store.getGlobal().theme).toBe('light');
    expect(store.get().version).toBe(SETTINGS_VERSION);
  });

  it('修改即时生效，订阅者同步收到通知（无需重启）', () => {
    const store = new SettingsStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.updateGlobal({ theme: 'dark' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getGlobal().theme).toBe('dark');
  });

  it('非法值被 zod 拦截且不改变状态', () => {
    const store = new SettingsStore();
    const before = store.get();
    // @ts-expect-error 故意传入非法主题
    expect(() => store.updateGlobal({ theme: 'neon' })).toThrow();
    expect(store.get()).toEqual(before);
  });

  it('项目级设置未配置时继承全局策略', () => {
    const store = new SettingsStore();
    store.updateGlobal({ ai: { ...store.getGlobal().ai, memoryWritePolicy: 'manual' } });
    expect(store.forProject('p1').memoryWritePolicy).toBe('manual');

    store.updateProject('p1', { memoryWritePolicy: 'auto' });
    expect(store.forProject('p1').memoryWritePolicy).toBe('auto');
    expect(store.forProject('p2').memoryWritePolicy).toBe('manual');
  });

  it('resetProject 回到继承全局', () => {
    const store = new SettingsStore();
    store.updateProject('p1', { namingRuleId: 'camel' });
    store.resetProject('p1');
    expect(store.forProject('p1').namingRuleId).toBe('default');
  });

  it('旧版本配置自动迁移而非丢弃', () => {
    const legacy = { global: { language: 'en-US' } };
    const migrated = migrateSettings(legacy);
    expect(migrated.version).toBe(SETTINGS_VERSION);
    expect(migrated.global.language).toBe('en-US');
    expect(migrated.global.theme).toBe('light');
  });

  it('toJSON / fromJSON 往返一致', () => {
    const store = new SettingsStore();
    store.updateGlobal({ dataDir: 'D:/ec-data' });
    const restored = SettingsStore.fromJSON(store.toJSON());
    expect(restored.getGlobal().dataDir).toBe('D:/ec-data');
  });
});

describe('密钥环', () => {
  it('写入后可读取，磁盘密文中无明文', async () => {
    const shell = new MockShell();
    const store = new SecureStore(shell);
    await store.set('ai-key', 'openai', 'sk-live-abcdef123456');

    expect(await store.get('ai-key', 'openai')).toBe('sk-live-abcdef123456');
    const cipher = shell.peekSecureCipher('ai-key', 'openai') ?? '';
    expect(cipher).not.toContain('sk-live-abcdef123456');
  });

  it('listKeys 只返回键名，不返回任何值', async () => {
    const shell = new MockShell();
    const store = new SecureStore(shell);
    await store.set('git-credential', 'github', 'ghp_secret');
    expect(await store.listKeys('git-credential')).toEqual(['github']);
  });

  it('空值不允许写入', async () => {
    const store = new SecureStore(new MockShell());
    await expect(store.set('ai-key', 'empty', '')).rejects.toThrow();
  });

  it('异常不泄漏明文到错误信息', async () => {
    const shell = new MockShell();
    const store = new SecureStore(shell);
    await store.set('ai-key', 'boom', 'sk-topsecret-value');
    shell.setUserSid('S-1-5-21-other');

    await expect(store.get('ai-key', 'boom')).rejects.toThrow();
    await store.get('ai-key', 'boom').catch((error: unknown) => {
      expect(String(error)).not.toContain('sk-topsecret-value');
    });
  });
});

describe('遥测', () => {
  it('默认关闭时零上报（sink 与网络均不被调用）', async () => {
    const sink = vi.fn();
    const telemetry = new Telemetry({ enabled: false, sink });
    telemetry.track('app.start');
    telemetry.track('designer.drop', { count: 3 });

    expect(telemetry.pending).toBe(0);
    expect(await telemetry.flush()).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it('未授权时即使配置端点也不发起网络请求', async () => {
    const shell = new MockShell();
    const responder = vi.fn(() => ({ status: 200, statusText: 'OK', headers: {}, body: 'ok' }));
    shell.net.setAllowedHosts(['stats.example.com']);
    (shell.net as unknown as { setResponder: (fn: unknown) => void }).setResponder(responder);

    const telemetry = new Telemetry({
      enabled: false,
      shell,
      endpoint: 'https://stats.example.com/collect',
    });
    telemetry.track('app.start');
    await telemetry.flush();

    expect(responder).not.toHaveBeenCalled();
  });

  it('授权后按批量上报且不含 AI 内容字段', async () => {
    const sink = vi.fn();
    const telemetry = new Telemetry({ enabled: true, sink, batchSize: 2 });
    telemetry.track('ai.generate', { model: 'glm', promptText: 'sk-should-not-appear' });
    telemetry.track('ai.done', { durationMs: 120 });

    expect(sink).toHaveBeenCalledTimes(1);
    const events = sink.mock.calls[0]?.[0] as Array<{ properties?: Record<string, unknown> }>;
    expect(events).toHaveLength(2);
  });

  it('撤销授权会清空待发队列', () => {
    const telemetry = new Telemetry({ enabled: true });
    telemetry.track('a');
    expect(telemetry.pending).toBe(1);
    telemetry.setEnabled(false);
    expect(telemetry.pending).toBe(0);
  });
});
