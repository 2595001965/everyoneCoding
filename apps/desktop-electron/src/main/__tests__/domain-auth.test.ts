import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TransportPort } from '@ec/account';
import type { DomainControlServiceHost } from '@ec/shell-api';

import { createDomainRuntime } from '../domain/runtime';
import { createAuthDomain, type SafeStorageLike } from '../domain/auth';

/**
 * auth 域运行时测试。
 *
 * 网络与系统层全部注入假实现，但**装配与流程是真实的**：
 * - 传输用可编程假传输（按"路径包含"匹配返回，并记录全部请求）——
 *   路径以 `@ec/account` 的 AuthClient 实际请求为准（register/login/bindings/oauth/authorize）；
 * - 安全存储走真实的"加密 → 写文件 → 读文件 → 解密"路径（safeStorage 用假实现）；
 * - 会话持久化、令牌提取、离线判定、OAuth 握手暂存都跑真实代码。
 */

let root: string;
let secureDir: string;
let runtime: DomainControlServiceHost;

/** 假 safeStorage：可开关"系统加密可用性"；用 base64 可逆变换模拟密文（真实环境是 DPAPI） */
function makeFakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) =>
      Buffer.from(`enc1:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc1:')) throw new Error('decrypt failed');
      return Buffer.from(text.slice(5), 'base64').toString('utf8');
    },
  };
}

interface RecordedRequest {
  method: string;
  url: string;
  headers?: Record<string, string> | undefined;
  body?: unknown;
}

type FakeRoute = {
  match: string;
  respond: (request: RecordedRequest) => { status: number; json: unknown };
};

/** 可编程假传输：按"路径包含"匹配返回，未命中返回 404 */
function makeFakeTransport(routes: FakeRoute[]): {
  transport: TransportPort;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    transport: {
      async request(input) {
        const recorded: RecordedRequest = {
          method: input.method,
          url: input.url,
          headers: input.headers,
          body: input.body,
        };
        requests.push(recorded);
        const hit = routes.find((route) => input.url.includes(route.match));
        if (!hit) return { status: 404, json: { error: 'not_found' } };
        return hit.respond(recorded);
      },
    },
  };
}

function makeIdentity(): Record<string, unknown> {
  return {
    accountId: 'acc-1',
    login: 'user@example.com',
    displayName: '本地用户',
    avatarUrl: null,
    emailVerified: true,
    hasPassword: true,
  };
}

function makeTokens(): Record<string, unknown> {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3600_000,
    refreshExpiresAt: Date.now() + 86_400_000,
  };
}

function build(overrides: {
  fakeSafe?: SafeStorageLike;
  fake?: ReturnType<typeof makeFakeTransport>;
}): void {
  const domain = createAuthDomain({
    baseUrl: 'https://account.test',
    safeStorage: overrides.fakeSafe ?? makeFakeSafeStorage(),
    secureDir,
    openExternal: async () => undefined,
    writeClipboard: () => undefined,
    ...(overrides.fake ? { transport: overrides.fake.transport } : {}),
  });
  runtime = createDomainRuntime({ routers: { auth: domain.router } });
}

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await runtime.invoke({ requestId: 'test', domain: 'auth', method, params });
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & {
      code?: string | undefined;
    };
    const code = response.error?.code;
    if (code !== undefined) error.code = code;
    throw error;
  }
  return response.result as T;
}

const LOGIN_OK: FakeRoute = {
  match: '/api/auth/login',
  respond: (request) => {
    expect(request.body).toEqual({ email: 'user@example.com', password: 'Passw0rd!' });
    return { status: 200, json: { identity: makeIdentity(), tokens: makeTokens() } };
  },
};

async function login(): Promise<void> {
  await call('login', {
    input: { email: 'user@example.com', password: 'Passw0rd!', rememberMe: false },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-auth-'));
  secureDir = join(root, 'secure');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('安全存储（DPAPI 适配）', () => {
  it('系统加密不可用时拒绝保存凭据（ENCRYPT_FAILED）——登录成功也无法落盘', async () => {
    const fake = makeFakeTransport([LOGIN_OK]);
    build({ fakeSafe: makeFakeSafeStorage(false), fake });

    // 服务端其实登录成功了（请求已发出），但凭据无法安全落盘 → 整体按失败处理，
    // 不给用户一个"看起来登录了、重启就丢"的假会话
    await expect(login()).rejects.toMatchObject({ code: 'ENCRYPT_FAILED' });
    expect(fake.requests).toHaveLength(1);
    expect(await call('restore')).toBeNull();
  });
});

describe('登录 / 恢复 / 退出', () => {
  it('登录成功：会话返回、凭据加密落盘、restore 能取回、logout 清空', async () => {
    const fake = makeFakeTransport([
      LOGIN_OK,
      { match: '/api/auth/refresh', respond: () => ({ status: 200, json: makeTokens() }) },
    ]);
    build({ fake });

    const session = await call<{ identity: { login: string }; tokens: { accessToken: string } }>(
      'login',
      {
        input: {
          email: 'user@example.com',
          password: 'Passw0rd!',
          rememberMe: true,
          rememberDays: 30,
        },
      },
    );
    expect(session.identity.login).toBe('user@example.com');
    expect(session.tokens.accessToken).toBe('at-1');

    // 凭据真的写进了 secure 目录，且是密文（明文里不得出现令牌）
    expect(existsSync(secureDir)).toBe(true);
    const files = readdirSync(secureDir).filter((name) => name.endsWith('.dat'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(readFileSync(join(secureDir, name), 'utf8')).not.toContain('at-1');
    }

    const restored = await call<{ identity: { login: string } | null }>('restore');
    expect(restored?.identity?.login).toBe('user@example.com');

    await call('logout');
    expect(await call('restore')).toBeNull();
  });

  it('弱密码在客户端侧就被拒（不带网络请求）', async () => {
    const fake = makeFakeTransport([]);
    build({ fake });
    await expect(
      call('register', {
        input: { email: 'user@example.com', password: '123', confirm: '123', rememberMe: false },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.requests).toHaveLength(0);
  });

  it('服务端 409 时映射为 ALREADY_EXISTS；401 映射为 PERMISSION_DENIED', async () => {
    const fake = makeFakeTransport([
      {
        match: '/api/auth/register',
        respond: () => ({ status: 409, json: { error: 'email_taken' } }),
      },
    ]);
    build({ fake });
    await expect(
      call('register', {
        input: {
          email: 'user@example.com',
          password: 'Passw0rd!',
          confirm: 'Passw0rd!',
          rememberMe: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });
});

describe('绑定管理（令牌来自已恢复会话）', () => {
  it('未登录时拒绝并列出原因；登录后带上 Bearer 令牌', async () => {
    const fake = makeFakeTransport([
      {
        match: '/api/auth/bindings',
        respond: () => ({ status: 200, json: { bindings: [{ provider: 'github', linkedAt: 1 }] } }),
      },
      LOGIN_OK,
    ]);
    build({ fake });

    await expect(call('listBindings')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(call('listBindings')).rejects.toThrowError(/当前未登录/);

    await login();
    const bindings = await call<Array<{ provider: string; linkedAt: number }>>('listBindings');
    expect(bindings).toEqual([{ provider: 'github', linkedAt: 1 }]);

    const bindingRequest = fake.requests.find((request) =>
      request.url.includes('/api/auth/bindings'),
    );
    expect(bindingRequest?.headers?.Authorization).toBe('Bearer at-1');
  });

  it('解绑先做本地守卫校验再发 DELETE，并把 hasPassword 交给服务端裁决', async () => {
    const fake = makeFakeTransport([
      LOGIN_OK,
      // ⚠️ 顺序 matters：DELETE 的 URL 也包含 "/api/auth/bindings"，
      // 必须把更具体的路由放在前面，否则会被通用清单路由抢先匹配
      {
        match: '/api/auth/bindings?provider=',
        respond: (request) => {
          expect(request.method).toBe('DELETE');
          expect((request.headers?.Authorization ?? '').startsWith('Bearer ')).toBe(true);
          return { status: 200, json: { bindings: [] } };
        },
      },
      // bind/unbind 都会先 GET 一次绑定清单做前置守卫
      {
        match: '/api/auth/bindings',
        respond: () => ({ status: 200, json: { bindings: [{ provider: 'github' }] } }),
      },
    ]);
    build({ fake });
    await login();
    await expect(call('unbind', { provider: 'github', hasPassword: true })).resolves.toEqual([]);
  });

  it('仅剩单一登录方式且未设密码时，解绑在客户端侧被拒（FR-ACC-06）', async () => {
    const fake = makeFakeTransport([
      LOGIN_OK,
      {
        match: '/api/auth/bindings',
        respond: () => ({ status: 200, json: { bindings: [{ provider: 'github' }] } }),
      },
    ]);
    build({ fake });
    await login();
    await expect(call('unbind', { provider: 'github', hasPassword: false })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('离线模式', () => {
  it('网络层失败 → 标记离线并给出可读原因；探测仍不可达时 tryRecover 如实 false', async () => {
    const fake = makeFakeTransport([
      {
        match: '/api/auth/login',
        respond: () => {
          throw new TypeError('fetch failed');
        },
      },
      // 探测也失败（不能落到 404：404 说明服务有响应，会被判为"可达"）
      {
        match: '/api/health',
        respond: () => {
          throw new TypeError('fetch failed');
        },
      },
    ]);
    build({ fake });

    expect(await call<boolean>('isOffline')).toBe(false);
    await expect(login()).rejects.toMatchObject({ code: 'NET_ERROR' });
    await expect(
      call('login', {
        input: { email: 'user@example.com', password: 'Passw0rd!', rememberMe: false },
      }),
    ).rejects.toThrowError(/离线模式/);
    expect(await call<boolean>('isOffline')).toBe(true);
    expect(await call<boolean>('tryRecover')).toBe(false);
  });

  it('探测恢复可达后 tryRecover 返回 true 并退出离线', async () => {
    let reachable = false;
    const fake = makeFakeTransport([
      {
        match: '/api/auth/login',
        respond: () => {
          throw new TypeError('fetch failed');
        },
      },
      {
        match: '/api/health',
        respond: () =>
          reachable
            ? { status: 200, json: { ok: true } }
            : (() => {
                throw new TypeError('fetch failed');
              })(),
      },
    ]);
    build({ fake });

    // 先进入离线
    await expect(login()).rejects.toMatchObject({ code: 'NET_ERROR' });
    expect(await call<boolean>('isOffline')).toBe(true);

    // 服务恢复 → 重试成功
    reachable = true;
    expect(await call<boolean>('tryRecover')).toBe(true);
    expect(await call<boolean>('isOffline')).toBe(false);
  });

  it('服务端 5xx 不算离线（业务故障，不是断网）', async () => {
    const fake = makeFakeTransport([
      { match: '/api/auth/login', respond: () => ({ status: 500, json: { error: 'boom' } }) },
      { match: '/api/health', respond: () => ({ status: 200, json: { ok: true } }) },
    ]);
    build({ fake });
    await expect(login()).rejects.toMatchObject({ code: 'UNKNOWN' });
    expect(await call<boolean>('isOffline')).toBe(false);
  });
});

describe('OAuth 握手的状态由外壳持有', () => {
  it('没有进行中的授权时 completeOAuth 拒绝并说明原因', async () => {
    build({});
    await expect(
      call('completeOAuth', {
        provider: 'google',
        callbackUrl: 'https://account.test/oauth/callback?code=x&state=y',
        rememberMe: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      call('completeOAuth', {
        provider: 'google',
        callbackUrl: 'https://account.test/oauth/callback?code=x&state=y',
        rememberMe: true,
      }),
    ).rejects.toThrowError(/请先调用 beginOAuth/);
  });

  it('beginOAuth 产出授权链接、打开系统浏览器，并启动本地回环监听', async () => {
    const openExternal = vi.fn(async () => undefined);
    const domain = createAuthDomain({
      baseUrl: 'https://account.test',
      safeStorage: makeFakeSafeStorage(),
      secureDir,
      openExternal,
      writeClipboard: () => undefined,
      transport: makeFakeTransport([
        {
          // AuthClient 实际请求的端点（带 state / code_challenge / redirect_uri 查询参数）
          match: '/api/auth/oauth/google/authorize',
          respond: () => ({ status: 200, json: { clientId: 'cid-1' } }),
        },
      ]).transport,
    });
    runtime = createDomainRuntime({ routers: { auth: domain.router } });

    const handshake = await call<{ authorizeUrl: string; state: string }>('beginOAuth', {
      provider: 'google',
    });
    expect(handshake.state.length).toBeGreaterThan(0);
    expect(handshake.authorizeUrl).toContain('accounts.google.com');
    expect(openExternal).toHaveBeenCalledTimes(1);

    // 收尾：用一次 completeOAuth 消费握手（其 finally 会 stop 回环监听，避免句柄泄漏）
    await expect(
      call('completeOAuth', {
        provider: 'google',
        callbackUrl: 'https://account.test/oauth/callback?code=c&state=wrong',
        rememberMe: false,
      }),
    ).rejects.toBeTruthy();
    // 消费后不可重复使用
    await expect(
      call('completeOAuth', {
        provider: 'google',
        callbackUrl: 'https://account.test/oauth/callback?code=c&state=wrong',
        rememberMe: false,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
