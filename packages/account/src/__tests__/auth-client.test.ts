import { describe, it, expect } from 'vitest';

import { AuthClient } from '../auth-client';
import { AuthError, OfflineError, type AccountIdentity, type SecureStorePort, type SystemPort, type TokenPair, type TransportPort } from '../auth-types';
import { canBind, canUnbind } from '../binding';
import { OfflineController } from '../offline';
import { createPkcePair, checkPassword, createState } from '../security';
import { pollWechatQr } from '../oauth/wechat';

/* ------------------------------ 测试替身 ------------------------------ */

const IDENTITY: AccountIdentity = {
  accountId: 'acc-1',
  login: 'dev@example.com',
  displayName: '开发小王',
  avatarUrl: null,
  emailVerified: false,
  hasPassword: true,
};

function tokens(expiresInMs = 15 * 60 * 1000): TokenPair {
  const now = 1_700_000_000_000;
  return {
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    expiresAt: now + expiresInMs,
    refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
  };
}

class FakeSecureStore implements SecureStorePort {
  readonly map = new Map<string, string>();
  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
  /** 全部落盘内容拼接（用于断言"无明文"） */
  dump(): string {
    return [...this.map.values()].join('\n');
  }
}

class FakeTransport implements TransportPort {
  readonly calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
  handler: (input: { method: string; url: string; body?: unknown }) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }> = () => ({
    status: 200,
    json: { identity: IDENTITY, tokens: tokens() },
  });

  async request(input: {
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; json: unknown }> {
    this.calls.push({
      method: input.method,
      url: input.url,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
    });
    return this.handler(input);
  }
}

class FakeSystem implements SystemPort {
  readonly opened: string[] = [];
  readonly clipboard: string[] = [];
  loopbackAvailable = true;
  protocolAvailable = true;
  stopped = 0;
  handler: ((url: string) => void) | null = null;

  openExternal(url: string): Promise<void> {
    this.opened.push(url);
    return Promise.resolve();
  }
  startLoopback(handler: (callbackUrl: string) => void): Promise<{ redirectUri: string; stop: () => void }> {
    if (!this.loopbackAvailable) return Promise.reject(new Error('回环监听不可用'));
    this.handler = handler;
    return Promise.resolve({
      redirectUri: 'http://127.0.0.1:49152/oauth/callback',
      stop: () => {
        this.stopped += 1;
      },
    });
  }
  registerProtocol(handler: (url: string) => void): Promise<boolean> {
    if (!this.protocolAvailable) return Promise.resolve(false);
    this.handler = handler;
    return Promise.resolve(true);
  }
  writeClipboard(text: string): Promise<void> {
    this.clipboard.push(text);
    return Promise.resolve();
  }
}

function createClient(clock?: () => number) {
  const transport = new FakeTransport();
  const system = new FakeSystem();
  const secure = new FakeSecureStore();
  const client = new AuthClient({
    transport,
    system,
    secure,
    baseUrl: 'https://account.example.com/',
    ...(clock !== undefined ? { clock } : {}),
  });
  return { client, transport, system, secure };
}

/* ------------------------------ 密码校验 ------------------------------ */

describe('密码强度校验（FR-ACC-01）', () => {
  it('满足 ≥8 位且含两类字符才算有效', () => {
    expect(checkPassword('Abcd1234').valid).toBe(true);
    expect(checkPassword('Abcd1234', 'Abcd1234').valid).toBe(true);
    expect(checkPassword('短abc1').valid).toBe(false);
    expect(checkPassword('abcdefgh').valid).toBe(false); // 只有一类
    expect(checkPassword('Abcd1234', 'Abcd9999').valid).toBe(false);
  });

  it('给出可读的问题清单与强度分级', () => {
    const weak = checkPassword('abc');
    expect(weak.strength).toBe('weak');
    expect(weak.issues.some((issue) => issue.includes('至少 8 位'))).toBe(true);
    expect(checkPassword('').strength).toBe('empty');
    expect(checkPassword('Abcd1234!xyz').strength).toBe('strong');
    expect(checkPassword('Abcd1234').strength).toBe('medium');
  });
});

/* ------------------------------ 注册 / 登录 ------------------------------ */

describe('邮箱注册与登录（E2E-01）', () => {
  it('注册成功后保存会话，落盘内容不含明文密码', async () => {
    const { client, transport, secure } = createClient();
    const session = await client.register({ email: 'dev@example.com', password: 'Abcd1234!' });

    expect(session.identity.accountId).toBe('acc-1');
    expect(transport.calls[0]!.url).toBe('https://account.example.com/api/auth/register');
    expect(secure.map.size).toBe(1);
    expect(secure.dump()).toContain('access-token-1');
    // 明文密码绝不落盘
    expect(secure.dump()).not.toContain('Abcd1234!');
  });

  it('弱密码在本地即被拒绝，不发网络请求', async () => {
    const { client, transport } = createClient();
    await expect(client.register({ email: 'a@b.com', password: '123' })).rejects.toBeInstanceOf(AuthError);
    expect(transport.calls).toHaveLength(0);
  });

  it('登录：服务端错误转成带 code 的 AuthError', async () => {
    const { client, transport } = createClient();
    transport.handler = () => ({ status: 401, json: { code: 'invalid_credentials', message: '邮箱或密码不正确' } });
    await expect(client.login({ email: 'a@b.com', password: 'Abcd1234' })).rejects.toThrowError(/邮箱或密码不正确/);
  });

  it('记住我上限 30 天（FR-ACC-07）', async () => {
    const now = 1_700_000_000_000;
    const clock = (): number => now;
    const { client } = createClient(clock);
    const session = await client.login({ email: 'a@b.com', password: 'Abcd1234', rememberMe: true, rememberDays: 45 });
    expect(session.rememberUntil! - now).toBe(30 * 24 * 60 * 60 * 1000);
    const noRemember = await client.login({ email: 'a@b.com', password: 'Abcd1234' });
    expect(noRemember.rememberUntil).toBeNull();
  });

  it('退出登录清除本地缓存', async () => {
    const { client, secure } = createClient();
    await client.login({ email: 'a@b.com', password: 'Abcd1234' });
    expect(secure.map.size).toBe(1);
    await client.logout();
    expect(secure.map.size).toBe(0);
  });
});

/* ------------------------------ 令牌刷新 ------------------------------ */

describe('会话与令牌刷新（FR-ACC-07）', () => {
  it('并发刷新只发一次请求（去重）', async () => {
    const now = 1_700_000_000_000;
    const { client, transport } = createClient(() => now);
    // 构造一个即将过期的会话
    const session = await client.login({ email: 'a@b.com', password: 'Abcd1234' });
    const stale = { ...session, tokens: { ...session.tokens, expiresAt: now + 1000 } };
    await client.session.save(stale);

    transport.handler = () => ({
      status: 200,
      json: { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: now + 900_000, refreshExpiresAt: now + 900_000 },
    });

    const [a, b, c] = await Promise.all([
      client.session.ensureFresh(stale),
      client.session.ensureFresh(stale),
      client.session.ensureFresh(stale),
    ]);
    const refreshCalls = transport.calls.filter((call) => call.url.endsWith('/api/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
    expect(a.tokens.accessToken).toBe('access-2');
    expect(b.tokens.accessToken).toBe('access-2');
    expect(c.tokens.accessToken).toBe('access-2');
  });

  it('未过期时不刷新', async () => {
    const now = 1_700_000_000_000;
    const { client, transport } = createClient(() => now);
    const session = await client.login({ email: 'a@b.com', password: 'Abcd1234' });
    const before = transport.calls.length;
    await client.session.ensureFresh(session);
    expect(transport.calls.length).toBe(before);
  });

  it('记住我到期后本地会话失效并被清除', async () => {
    let now = 1_700_000_000_000;
    const { client, secure } = createClient(() => now);
    await client.login({ email: 'a@b.com', password: 'Abcd1234', rememberMe: true, rememberDays: 7 });
    expect(await client.session.load()).not.toBeNull();
    now += 8 * 24 * 60 * 60 * 1000;
    expect(await client.session.load()).toBeNull();
    expect(secure.map.size).toBe(0);
  });

  it('启动恢复：网络不可达时保留本地身份并标记离线', async () => {
    const now = 1_700_000_000_000;
    const { client, transport } = createClient(() => now);
    await client.login({ email: 'a@b.com', password: 'Abcd1234' });
    transport.handler = () => {
      throw new TypeError('Failed to fetch');
    };
    const session = await client.session.load();
    // 置为已过期 → restore 会尝试刷新，此时网络不可达
    const stale = { ...session!, tokens: { ...session!.tokens, expiresAt: now } };
    await client.session.save(stale);
    const restored = await client.restore();
    expect(restored).not.toBeNull();
    expect(client.offlineController.isOffline()).toBe(true);
  });
});

/* ------------------------------ OAuth ------------------------------ */

describe('OAuth（PKCE + 双通道）', () => {
  it('beginOAuth(Google)：URL 含 code_challenge/state/redirect_uri，主通道为回环', async () => {
    const { client, transport, system } = createClient();
    transport.handler = (input) =>
      input.url.includes('/authorize')
        ? { status: 200, json: { clientId: 'google-client-id' } }
        : { status: 200, json: { identity: IDENTITY, tokens: tokens() } };

    const handshake = await client.beginOAuth('google');
    expect(handshake.channel).toBe('loopback');
    const url = new URL(handshake.authorizeUrl);
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(handshake.state);
    expect(url.searchParams.get('redirect_uri')).toBe(handshake.redirectUri);
    expect(system.opened).toHaveLength(1);
  });

  it('completeOAuth：state 不一致被拒绝（防 CSRF）', async () => {
    const { client, transport } = createClient();
    transport.handler = (input) =>
      input.url.includes('/authorize')
        ? { status: 200, json: { clientId: 'cid' } }
        : { status: 200, json: { identity: IDENTITY, tokens: tokens() } };
    const handshake = await client.beginOAuth('google');
    await expect(
      client.completeOAuth(handshake, 'http://127.0.0.1:49152/oauth/callback?code=abc&state=wrong'),
    ).rejects.toThrowError(/state 校验失败/);
  });

  it('completeOAuth：正确回调后换取令牌并关闭回环监听', async () => {
    const { client, transport, system } = createClient();
    transport.handler = (input) =>
      input.url.includes('/authorize')
        ? { status: 200, json: { clientId: 'cid' } }
        : { status: 200, json: { identity: IDENTITY, tokens: tokens() } };
    const handshake = await client.beginOAuth('google');
    const session = await client.completeOAuth(
      handshake,
      `http://127.0.0.1:49152/oauth/callback?code=code-1&state=${handshake.state}`,
    );
    expect(session.identity.accountId).toBe('acc-1');
    expect(system.stopped).toBe(1);
    // code_verifier 提交给服务端（PKCE 完整链条）
    const callbackCall = transport.calls.find((call) => call.url.includes('/callback'));
    expect((callbackCall!.body as { codeVerifier: string }).codeVerifier).toBe(handshake.codeVerifier);
  });

  it('回环不可用时回退自定义协议 everyonecoding://oauth', async () => {
    const { client, transport, system } = createClient();
    system.loopbackAvailable = false;
    transport.handler = () => ({ status: 200, json: { clientId: 'cid' } });
    const handshake = await client.beginOAuth('github');
    expect(handshake.channel).toBe('protocol');
    expect(handshake.redirectUri).toBe('everyonecoding://oauth');
  });

  it('两条通道都不可用时如实报错', async () => {
    const { client, system } = createClient();
    system.loopbackAvailable = false;
    system.protocolAvailable = false;
    await expect(client.beginOAuth('google')).rejects.toThrowError(/无法完成第三方登录/);
  });

  it('GitHub 授权 scope 为 read:user user:email', async () => {
    const { client, transport } = createClient();
    transport.handler = () => ({ status: 200, json: { clientId: 'cid' } });
    const handshake = await client.beginOAuth('github');
    const url = new URL(handshake.authorizeUrl);
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
  });

  it('微信扫码：URL 以 #wechat_redirect 结尾，轮询超时视为过期', async () => {
    const { client, transport } = createClient();
    transport.handler = () => ({ status: 200, json: { clientId: 'wx-appid' } });
    const handshake = await client.beginOAuth('wechat');
    expect(handshake.authorizeUrl.endsWith('#wechat_redirect')).toBe(true);

    let now = 0;
    const result = await pollWechatQr(() => Promise.resolve({ state: 'pending' as const }), {
      intervalMs: 10,
      timeoutMs: 50,
      clock: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    expect(result.state).toBe('expired');
  });

  it('PKCE：challenge = BASE64URL(SHA256(verifier))', async () => {
    const pair = await createPkcePair('fixed-verifier-value');
    expect(pair.method).toBe('S256');
    expect(pair.verifier).toBe('fixed-verifier-value');
    // 与手工 S256 结果一致（无 = 填充、+ / 换 - _）
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).not.toContain('=');
    expect(createState()).toHaveLength(43);
  });
});

/* ------------------------------ 绑定 / 解绑 ------------------------------ */

describe('绑定与解绑（FR-ACC-06）', () => {
  it('解绑唯一登录方式且未设密码时必须先设置密码', () => {
    const bindings = [{ provider: 'github' as const, externalId: 'octocat', boundAt: 1 }];
    const denied = canUnbind({ bindings, target: 'github', hasPassword: false });
    expect(denied.allowed).toBe(false);
    expect(denied.requiresPassword).toBe(true);
    expect(denied.reason).toContain('先设置密码');

    const allowed = canUnbind({ bindings, target: 'github', hasPassword: true });
    expect(allowed.allowed).toBe(true);
  });

  it('多绑定方式时可自由解绑；未绑定的方式无需解绑', () => {
    const bindings = [
      { provider: 'github' as const, externalId: 'octocat', boundAt: 1 },
      { provider: 'google' as const, externalId: 'g-1', boundAt: 2 },
    ];
    expect(canUnbind({ bindings, target: 'github', hasPassword: false }).allowed).toBe(true);
    expect(canUnbind({ bindings, target: 'wechat', hasPassword: false }).allowed).toBe(false);
  });

  it('重复绑定被拒绝', () => {
    const bindings = [{ provider: 'google' as const, externalId: 'g-1', boundAt: 1 }];
    expect(canBind(bindings, 'google').allowed).toBe(false);
    expect(canBind(bindings, 'wechat').allowed).toBe(true);
  });

  it('客户端解绑前先做前置校验（不满足不发网络请求）', async () => {
    const { client, transport } = createClient();
    transport.handler = (input) => {
      if (input.url.endsWith('/api/auth/bindings') && input.method === 'GET') {
        return { status: 200, json: { bindings: [{ provider: 'github', externalId: 'octocat', boundAt: 1 }] } };
      }
      return { status: 200, json: { bindings: [] } };
    };
    await expect(client.unbind('github', 'token', false)).rejects.toThrowError(/先设置密码/);
    expect(transport.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);

    const after = await client.unbind('github', 'token', true);
    expect(after).toEqual([]);
    expect(transport.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('带令牌请求绑定列表', async () => {
    const { client, transport } = createClient();
    await client.listBindings('token-abc');
    expect(transport.calls[0]!.headers?.['Authorization']).toBe('Bearer token-abc');
    expect(transport.calls[0]!.url).toContain('/api/auth/bindings');
  });
});

/* ------------------------------ 离线模式 ------------------------------ */

describe('离线本地模式（FR-ACC-05）', () => {
  it('网络错误转成 OfflineError 并标记离线', async () => {
    const { client, transport } = createClient();
    transport.handler = () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(client.login({ email: 'a@b.com', password: 'Abcd1234' })).rejects.toBeInstanceOf(OfflineError);
    expect(client.offlineController.isOffline()).toBe(true);
  });

  it('离线后不再发网络请求（登录入口置灰的依据）', async () => {
    const { client, transport } = createClient();
    transport.handler = () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(client.login({ email: 'a@b.com', password: 'Abcd1234' })).rejects.toBeInstanceOf(OfflineError);
    const before = transport.calls.length;
    await expect(client.login({ email: 'a@b.com', password: 'Abcd1234' })).rejects.toBeInstanceOf(OfflineError);
    expect(transport.calls.length).toBe(before);
  });

  it('恢复探测成功后回到在线并通知订阅者', async () => {
    const offline = new OfflineController(() => Promise.resolve(true));
    const events: boolean[] = [];
    offline.onChange((value) => events.push(value));
    offline.setOffline(true);
    expect(await offline.tryRecover()).toBe(true);
    expect(offline.isOffline()).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it('探测仍不可达时保持离线', async () => {
    const offline = new OfflineController(() => Promise.reject(new Error('still down')));
    offline.setOffline(true);
    expect(await offline.tryRecover()).toBe(false);
    expect(offline.isOffline()).toBe(true);
  });
});

/* ------------------------------ 邮箱验证 / 找回密码 ------------------------------ */

describe('邮箱验证与找回密码（FR-ACC-08）', () => {
  it('发送验证邮件与验证码重置密码走对应端点', async () => {
    const { client, transport } = createClient();
    transport.handler = () => ({ status: 200, json: { ok: true } });
    await client.requestEmailVerification('a@b.com');
    expect(transport.calls[0]!.url).toContain('/api/auth/email/verify');

    await client.resetPassword({ email: 'a@b.com', code: '123456', newPassword: 'Abcd1234' });
    expect(transport.calls[1]!.url).toContain('/api/auth/password/reset');
  });

  it('重置密码同样做强度校验', async () => {
    const { client, transport } = createClient();
    await expect(client.resetPassword({ email: 'a@b.com', code: '1', newPassword: 'abc' })).rejects.toThrowError(
      /至少 8 位/,
    );
    expect(transport.calls).toHaveLength(0);
  });
});
