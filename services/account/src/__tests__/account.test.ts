/**
 * 账号服务端集成测试：通过 app.inject() 运行（不占用端口）。
 * 覆盖 T9-06 验收的 8 类场景，并含「已移除接口不存在」的 grep 断言。
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../db.ts';
import { buildApp } from '../app.ts';
import { loadConfig, type AppConfig } from '../config.ts';
import { pkceChallenge } from '../jwt.ts';
import { setOAuthFetch, type OAuthFetch } from '../oauth/index.ts';

let app: FastifyInstance;

function makeFakeFetch(): OAuthFetch {
  return async (req) => {
    const url = req.url;
    if (url.includes('oauth2.googleapis.com/token')) {
      return { status: 200, body: JSON.stringify({ access_token: 'g-at', id_token: 'g-id' }) };
    }
    if (url.includes('openidconnect.googleapis.com')) {
      return {
        status: 200,
        body: JSON.stringify({ sub: 'g-sub-1', email: 'g@example.com', name: 'Google 用户' }),
      };
    }
    if (url.includes('github.com/login/oauth/access_token')) {
      return { status: 200, body: JSON.stringify({ access_token: 'gh-at' }) };
    }
    if (url.includes('api.github.com/user')) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 99,
          login: 'ghuser',
          email: 'gh@example.com',
          name: 'Github 用户',
        }),
      };
    }
    if (url.includes('sns/oauth2/access_token')) {
      return {
        status: 200,
        body: JSON.stringify({ access_token: 'wx-at', openid: 'wx-openid-1' }),
      };
    }
    if (url.includes('sns/userinfo')) {
      return { status: 200, body: JSON.stringify({ openid: 'wx-openid-1', nickname: '微信用户' }) };
    }
    return { status: 404, body: '{}' };
  };
}

function newVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function q(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function makeApp(overrides: Partial<AppConfig> = {}): Promise<{
  app: FastifyInstance;
  config: AppConfig;
}> {
  const cfg = loadConfig({
    dbPath: ':memory:',
    loginRateLimitPerMin: 20,
    registerRateLimitPerMin: 20,
    ...overrides,
  });
  const db = openDatabase(':memory:');
  const built = await buildApp(cfg, db);
  return { app: built, config: cfg };
}

beforeEach(async () => {
  setOAuthFetch(makeFakeFetch());
  const created = await makeApp();
  app = created.app;
});

describe('注册 / 登录 / 刷新', () => {
  it('注册成功并自开通工作区与免费权益包；登录成功；刷新后旧 refresh 失效', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'alice@example.com', password: 'Abcd1234', displayName: 'Alice' },
    });
    expect(reg.statusCode).toBe(201);
    const regBody = reg.json();
    expect(regBody.workspaceId).toBeTruthy();
    expect(regBody.planId).toBe('free');
    // 新契约：{ identity, tokens }（契约测试在 contract.test.ts 钉住完整形状）
    expect(regBody.identity.accountId).toBeTruthy();
    expect(regBody.identity.hasPassword).toBe(true);
    expect(regBody.identity.emailVerified).toBe(false);
    expect(regBody.tokens.accessToken).toBeTruthy();
    expect(regBody.tokens.refreshToken).toBeTruthy();
    expect(typeof regBody.tokens.expiresAt).toBe('number');

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: 'Abcd1234' },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json();
    expect(loginBody.tokens.accessToken).toBeTruthy();
    const oldRefresh = loginBody.tokens.refreshToken as string;

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: oldRefresh },
    });
    expect(refresh.statusCode).toBe(200);

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: oldRefresh },
    });
    expect(reuse.statusCode).toBe(401);
  });
});

describe('注册校验', () => {
  it('重复邮箱被拒；弱密码被拒；错误密码登录被拒', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'bob@example.com', password: 'Abcd1234' },
    });
    expect(ok.statusCode).toBe(201);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'bob@example.com', password: 'Xy12!@#$' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('EMAIL_TAKEN');

    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'weak@example.com', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('WEAK_PASSWORD');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'bob@example.com', password: 'WrongPass1' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('INVALID_CREDENTIALS');
  });
});

describe('OAuth（三 provider + 自动建号）', () => {
  it('mock 三个 provider：首次授权自动建号，再次授权命中已有账号', async () => {
    const providers = ['google', 'github', 'wechat'] as const;
    for (const provider of providers) {
      const verifier = newVerifier();
      const challenge = pkceChallenge(verifier);
      const auth = await app.inject({
        method: 'GET',
        url: `/api/auth/oauth/${provider}/authorize?${q({
          redirect_uri: 'https://app.example.com/cb',
          code_challenge: challenge,
        })}`,
      });
      expect(auth.statusCode).toBe(200);
      const authBody = auth.json();
      expect(authBody.authorizeUrl).toContain('state=');
      const state = authBody.state as string;

      const cb1 = await app.inject({
        method: 'GET',
        url: `/api/auth/oauth/${provider}/callback?${q({
          code: 'code-1',
          state,
          code_verifier: verifier,
        })}`,
      });
      expect(cb1.statusCode).toBe(200);
      const cb1Body = cb1.json();
      expect(cb1Body.isNew).toBe(true);
      expect(cb1Body.identity.accountId).toBeTruthy();
      expect(cb1Body.tokens.accessToken).toBeTruthy();
      const userId = cb1Body.identity.accountId as string;

      // 再次授权（同 provider 同身份）
      const verifier2 = newVerifier();
      const challenge2 = pkceChallenge(verifier2);
      const auth2 = await app.inject({
        method: 'GET',
        url: `/api/auth/oauth/${provider}/authorize?${q({
          redirect_uri: 'https://app.example.com/cb',
          code_challenge: challenge2,
        })}`,
      });
      const state2 = auth2.json().state as string;
      const cb2 = await app.inject({
        method: 'GET',
        url: `/api/auth/oauth/${provider}/callback?${q({
          code: 'code-2',
          state: state2,
          code_verifier: verifier2,
        })}`,
      });
      expect(cb2.statusCode).toBe(200);
      const cb2Body = cb2.json();
      expect(cb2Body.isNew).toBe(false);
      expect(cb2Body.identity.accountId).toBe(userId);
    }
  });

  it('PKCE 校验失败应被拒', async () => {
    const verifier = newVerifier();
    const auth = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/google/authorize?${q({
        redirect_uri: 'https://app.example.com/cb',
        code_challenge: pkceChallenge(verifier),
      })}`,
    });
    const state = auth.json().state as string;
    const bad = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/google/callback?${q({
        code: 'code-x',
        state,
        code_verifier: 'wrong-verifier',
      })}`,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('OAUTH_PKCE_MISMATCH');
  });
});

describe('绑定管理', () => {
  async function registerAndLogin(email: string, password: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    return login.json().tokens.accessToken as string;
  }

  it('列出 / 新增 / 解绑；解绑最后一个登录方式（无密码）应被拒绝', async () => {
    // 1) 邮箱账号（有密码）可解绑唯一绑定
    const token = await registerAndLogin('bind@example.com', 'Abcd1234');
    const verifier = newVerifier();
    const auth = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/github/authorize?${q({
        redirect_uri: 'https://app.example.com/cb',
        code_challenge: pkceChallenge(verifier),
      })}`,
    });
    const state = auth.json().state as string;
    // 新契约：POST bindings 用 codeVerifier（camelCase），返回 { bindings }
    const add = await app.inject({
      method: 'POST',
      url: '/api/auth/bindings',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'github', code: 'c', state, codeVerifier: verifier },
    });
    expect(add.statusCode).toBe(200);
    const addBody = add.json();
    const bindingId = addBody.bindings[0]?.id as string;

    const list = await app.inject({
      method: 'GET',
      url: '/api/auth/bindings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().bindings as unknown[]).length).toBe(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/auth/bindings?bindingId=${bindingId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
    expect((del.json().bindings as unknown[]).length).toBe(0);

    // 2) OAuth 建号（无密码、单一绑定）解绑应被拒
    const verifier2 = newVerifier();
    const auth2 = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/google/authorize?${q({
        redirect_uri: 'https://app.example.com/cb',
        code_challenge: pkceChallenge(verifier2),
      })}`,
    });
    const state2 = auth2.json().state as string;
    const cb = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/google/callback?${q({
        code: 'c',
        state: state2,
        code_verifier: verifier2,
      })}`,
    });
    const oauthToken = cb.json().tokens.accessToken as string;
    const oauthList = await app.inject({
      method: 'GET',
      url: '/api/auth/bindings',
      headers: { authorization: `Bearer ${oauthToken}` },
    });
    const oauthBindingId = (oauthList.json().bindings as { id: string }[])[0]?.id as string;
    const delLast = await app.inject({
      method: 'DELETE',
      url: `/api/auth/bindings?bindingId=${oauthBindingId}`,
      headers: { authorization: `Bearer ${oauthToken}` },
    });
    expect(delLast.statusCode).toBe(409);
    expect(delLast.json().code).toBe('BINDING_LAST_METHOD');
  });
});

describe('幂等键', () => {
  it('同一 Idempotency-Key 重复注册只创建一个账号且响应一致', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'idempotency-key': 'same-key-1' },
      payload: { email: 'idem@example.com', password: 'Abcd1234' },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'idempotency-key': 'same-key-1' },
      payload: { email: 'idem@example.com', password: 'Abcd1234' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().identity.accountId).toBe(firstBody.identity.accountId);
    expect(second.headers['idempotency-key-replay']).toBe('true');

    // 不同 key 重复邮箱 -> 仅一个账号，第二次被拒
    const third = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'idempotency-key': 'other-key-2' },
      payload: { email: 'idem@example.com', password: 'Abcd1234' },
    });
    expect(third.statusCode).toBe(409);
  });
});

describe('认证与限流', () => {
  it('未授权访问 /api/usage/report 返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/usage/report',
      payload: { client: 'test', version: '1.0.0', events: [] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('限流触发返回 429', async () => {
    const limited = await makeApp({ loginRateLimitPerMin: 2 });
    for (let i = 0; i < 2; i++) {
      const r = await limited.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `x${i}@example.com`, password: 'Whatever1' },
      });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await limited.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'x9@example.com', password: 'Whatever1' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('RATE_LIMITED');
  });
});

describe('版本检查（双形态）', () => {
  it('tauri 与 electron 返回不同形态的清单', async () => {
    const tauri = await app.inject({
      method: 'GET',
      url: '/api/release/check?form=tauri',
    });
    expect(tauri.statusCode).toBe(200);
    const t = tauri.json();
    expect(t.form).toBe('tauri');
    expect(typeof t.installer.signature).toBe('string');

    const electron = await app.inject({
      method: 'GET',
      url: '/api/release/check?form=electron',
    });
    expect(electron.statusCode).toBe(200);
    const e = electron.json();
    expect(e.form).toBe('electron');
    expect(t.installer.url).not.toBe(e.installer.url);
  });
});

describe('已移除接口不存在（grep 断言）', () => {
  it('源码与路由中不存在被移除的接口', () => {
    const forbidden = [
      'config/remote',
      'sync/memory',
      'sync/project-meta',
      '/api/share',
      'api/share',
    ];
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    const files = readdirSync(srcDir, { recursive: true } as { recursive: boolean })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'))
      .filter((f) => !f.includes('__tests__'));
    const contents = files.map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n');
    for (const token of forbidden) {
      expect(contents.includes(token), `不应包含被移除接口片段：${token}`).toBe(false);
    }
  });
});
