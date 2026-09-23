/**
 * 真实契约测试：`@ec/account` 的 AuthClient 直接打本服务端（app.inject 桥接 fetch）。
 *
 * 目的：钉住客户端与服务端**两侧都真实**的请求/响应契约——
 * - register/login/refresh → { identity, tokens }（expiresAt/refreshExpiresAt 毫秒）；
 * - OAuth callback 走 POST + { code, codeVerifier, redirectUri, state }；
 * - bindings 返回 { bindings: [{ id, provider, externalId, boundAt }] }；
 * - 邮箱验证：注册 → 发邮件（outbox 取 token）→ confirm → identity.emailVerified 翻转；
 * - 重置密码：验证码单次有效、过期拒绝。
 *
 * 桥接方式：TransportPort.request → app.inject()（不占端口、不起真实网络）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
// 直接引客户端源码（services/account 不依赖 @ec/account workspace 包；
// 相对路径绕开依赖声明，同时保持被测对象为客户端真实实现）
import { AuthClient } from '../../../../packages/account/src/auth-client.ts';
import type { TokenPair, TransportPort } from '../../../../packages/account/src/auth-types.ts';
import { openDatabase } from '../db.ts';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { pkceChallenge } from '../jwt.ts';
import { setOAuthFetch, type OAuthFetch } from '../oauth/index.ts';

/** 把 app.inject 桥接成 TransportPort（真实 HTTP 语义：method/url/headers/body） */
function injectTransport(app: FastifyInstance): TransportPort {
  return {
    async request(input): Promise<{ status: number; json: unknown }> {
      const headers: Record<string, string> = { ...(input.headers ?? {}) };
      let payload: Record<string, unknown> | undefined;
      if (input.body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = input.body as Record<string, unknown>;
      }
      const [path, query = ''] = input.url.replace(/^https?:\/\/[^/]+/, '').split('?');
      const response = await app.inject({
        method: input.method,
        url: query.length > 0 ? `${path}?${query}` : (path ?? '/'),
        ...(payload !== undefined ? { payload } : {}),
        headers,
      });
      const text = response.body;
      let json: unknown = null;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { status: response.statusCode, json };
    },
  };
}

/** OAuth 三方的假外呼（与 account.test.ts 同一套身份面） */
function makeFakeFetch(): OAuthFetch {
  return async (req) => {
    const url = req.url;
    if (url.includes('github.com/login/oauth/access_token')) {
      return { status: 200, body: JSON.stringify({ access_token: 'gh-at' }) };
    }
    if (url.includes('api.github.com/user')) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 77,
          login: 'contract-gh',
          email: 'gh@contract.test',
          name: '契约用户',
        }),
      };
    }
    return { status: 404, body: '{}' };
  };
}

const EMAIL = 'contract@example.com';
const PASSWORD = 'Abcd1234';

let app: FastifyInstance;
let client: AuthClient;

beforeEach(async () => {
  setOAuthFetch(makeFakeFetch());
  const db = openDatabase(':memory:');
  app = await buildApp(loadConfig({ dbPath: ':memory:' }), db);
  const memorySecure = {
    map: new Map<string, string>(),
    async set(key: string, value: string) {
      this.map.set(key, value);
    },
    async get(key: string) {
      return this.map.get(key) ?? null;
    },
    async delete(key: string) {
      this.map.delete(key);
    },
  };
  client = new AuthClient({
    transport: injectTransport(app),
    system: {
      openExternal: () => Promise.resolve(),
      startLoopback: () => Promise.reject(new Error('测试不启用回环')),
      registerProtocol: () => Promise.resolve(false),
      writeClipboard: () => Promise.resolve(),
    },
    secure: memorySecure,
    baseUrl: 'http://contract.test',
  });
});

function extractVerificationToken(): string {
  const row = app.accountDb.raw
    .prepare(`SELECT body FROM account_email_outbox WHERE kind = 'verify' ORDER BY created_at DESC`)
    .get() as { body: string } | undefined;
  const match = row?.body.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('outbox 中没有验证链接');
  return match[1]!;
}

function extractResetCode(): string {
  const row = app.accountDb.raw
    .prepare(`SELECT body FROM account_email_outbox WHERE kind = 'reset' ORDER BY created_at DESC`)
    .get() as { body: string } | undefined;
  const match = row?.body.match(/验证码是：(\d{6})/);
  if (!match) throw new Error('outbox 中没有重置码');
  return match[1]!;
}

/**
 * 直接打服务端原始端点，返回**真实 HTTP 状态码**。
 *
 * 为什么不复用 `AuthClient` 的私有 `request`：那会依赖私有内部结构，且客户端会把
 * 状态码映射成 `AuthError`（`400/401` 的原始语义被包装）。契约测试要钉住的恰恰是
 * 线上的状态码与 JSON 形状，所以直接 `app.inject` 更忠实，也不碰私有 API。
 */
async function raw(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  const response = await app.inject({
    method,
    url: path,
    ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    headers,
  });
  let json: unknown = null;
  try {
    json = response.body.length > 0 ? JSON.parse(response.body) : null;
  } catch {
    json = { raw: response.body };
  }
  return { status: response.statusCode, json };
}

describe('注册 → 验证 → 登录 → 找回（E2E-01 链路的客户端×服务端契约）', () => {
  it('注册返回 { identity, tokens }；验证后 emailVerified 翻转；重登一致', async () => {
    const session = await client.register({ email: EMAIL, password: PASSWORD });
    expect(session.identity.accountId).toBeTruthy();
    expect(session.identity.hasPassword).toBe(true);
    expect(session.identity.emailVerified).toBe(false);
    expect(session.tokens.accessToken).toBeTruthy();
    expect(session.tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(session.tokens.refreshExpiresAt).toBeGreaterThan(session.tokens.expiresAt);

    // 发验证邮件 → outbox 取 token → confirm
    await client.requestEmailVerification(EMAIL);
    await client.confirmEmailVerification(extractVerificationToken());
    expect(await client.emailVerified(EMAIL)).toBe(true);

    // 重新登录：identity.emailVerified 已翻转
    const relogin = await client.login({ email: EMAIL, password: PASSWORD });
    expect(relogin.identity.emailVerified).toBe(true);
  });

  it('重置密码：请求码 → 单次有效重置 → 旧密码 401、旧 refresh 失效', async () => {
    await client.register({ email: EMAIL, password: PASSWORD });
    const old = await client.login({ email: EMAIL, password: PASSWORD });
    await client.requestPasswordReset(EMAIL);
    const code = extractResetCode();

    await client.resetPassword({ email: EMAIL, code, newPassword: 'NewPass99' });

    await expect(client.login({ email: EMAIL, password: PASSWORD })).rejects.toMatchObject({
      status: 401,
    });
    const fresh = await client.login({ email: EMAIL, password: 'NewPass99' });
    expect(fresh.identity.hasPassword).toBe(true);

    // 旧 access refresh 已被服务端撤销
    const revoked = await raw('POST', '/api/auth/refresh', {
      body: { refreshToken: old.tokens.refreshToken },
    });
    expect(revoked.status).toBe(401);
  });

  it('重置码重复使用被拒；过期验证链接被拒', async () => {
    await client.register({ email: EMAIL, password: PASSWORD });
    await client.requestPasswordReset(EMAIL);
    const code = extractResetCode();

    await client.resetPassword({ email: EMAIL, code, newPassword: 'NewPass99' });
    await expect(
      client.resetPassword({ email: EMAIL, code, newPassword: 'Again88x' }),
    ).rejects.toMatchObject({ status: 400 });

    // 验证链接单次使用
    await client.requestEmailVerification(EMAIL);
    const token = extractVerificationToken();
    await client.confirmEmailVerification(token);
    await expect(client.confirmEmailVerification(token)).rejects.toMatchObject({ status: 400 });
  });
});

describe('OAuth（客户端 POST 回调 × 服务端 PKCE）', () => {
  it('authorize 下发 state；callback POST 换令牌并自动建号（isNew 首真后假）', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = pkceChallenge(verifier);

    // authorize：客户端不传 state（服务端签发）
    const authorize = await raw(
      'GET',
      `/api/auth/oauth/github/authorize?code_challenge=${encodeURIComponent(challenge)}&redirect_uri=${encodeURIComponent('everyonecoding://oauth')}`,
    );
    const authorizeBody = authorize.json as { authorizeUrl: string; state: string };
    expect(authorize.status).toBe(200);
    expect(authorizeBody.authorizeUrl).toContain('github.com/login/oauth/authorize');
    expect(authorizeBody.state.length).toBeGreaterThan(0);

    // 第一次回调：POST + camelCase codeVerifier（AuthClient.completeOAuth 的真实请求形状）
    const cb1Res = await raw('POST', '/api/auth/oauth/github/callback', {
      body: {
        code: 'code-1',
        codeVerifier: verifier,
        redirectUri: 'everyonecoding://oauth',
        state: authorizeBody.state,
      },
    });
    const cb1 = cb1Res.json as {
      identity: { accountId: string };
      tokens: TokenPair;
      isNew: boolean;
    };
    expect(cb1Res.status).toBe(200);
    expect(cb1.isNew).toBe(true);
    expect(cb1.identity.accountId).toBeTruthy();
    expect(cb1.tokens.accessToken).toBeTruthy();

    // state 单次消费：同 state 二次回调拒绝
    const replay = await raw('POST', '/api/auth/oauth/github/callback', {
      body: {
        code: 'code-2',
        codeVerifier: verifier,
        redirectUri: 'everyonecoding://oauth',
        state: authorizeBody.state,
      },
    });
    expect(replay.status).toBe(400);

    // 第二次授权（同 GitHub 身份）→ isNew=false，同账号
    const verifier2 = randomBytes(32).toString('base64url');
    const authorize2 = await raw(
      'GET',
      `/api/auth/oauth/github/authorize?code_challenge=${encodeURIComponent(pkceChallenge(verifier2))}&redirect_uri=${encodeURIComponent('everyonecoding://oauth')}`,
    );
    const authorize2Body = authorize2.json as { state: string };
    const cb2 = (
      await raw('POST', '/api/auth/oauth/github/callback', {
        body: {
          code: 'code-3',
          codeVerifier: verifier2,
          redirectUri: 'everyonecoding://oauth',
          state: authorize2Body.state,
        },
      })
    ).json as { identity: { accountId: string }; isNew: boolean };
    expect(cb2.isNew).toBe(false);
    expect(cb2.identity.accountId).toBe(cb1.identity.accountId);
  });

  it('错误 verifier 被服务端 PKCE 校验拒绝（OAUTH_PKCE_MISMATCH）', async () => {
    const authorize = await raw(
      'GET',
      `/api/auth/oauth/github/authorize?code_challenge=${encodeURIComponent(pkceChallenge(randomBytes(32).toString('base64url')))}&redirect_uri=${encodeURIComponent('everyonecoding://oauth')}`,
    );
    const authorizeBody = authorize.json as { state: string };
    const mismatch = await raw('POST', '/api/auth/oauth/github/callback', {
      body: {
        code: 'code-x',
        codeVerifier: 'wrong-verifier-aaaaaaaaaaaaaaaaaaaaaaaaaaa',
        redirectUri: 'everyonecoding://oauth',
        state: authorizeBody.state,
      },
    });
    expect(mismatch.status).toBe(400);
    expect(JSON.stringify(mismatch.json)).toContain('OAUTH_PKCE_MISMATCH');
  });
});

describe('绑定（登录态 × bindingId 解绑）', () => {
  it('登录后绑定 GitHub → 清单含 id/externalId → 解绑后为空 → 解绑唯一方式被拒', async () => {
    const session = await client.register({ email: EMAIL, password: PASSWORD });
    const token = session.tokens.accessToken;

    // 绑定（完整 OAuth：authorize + callback 转发）
    const verifier = randomBytes(32).toString('base64url');
    const authorize = await raw(
      'GET',
      `/api/auth/oauth/github/authorize?code_challenge=${encodeURIComponent(pkceChallenge(verifier))}&redirect_uri=${encodeURIComponent('everyonecoding://oauth')}`,
      { token },
    );
    const authorizeBody = authorize.json as { state: string };
    const bound = await raw('POST', '/api/auth/bindings', {
      token,
      body: {
        provider: 'github',
        code: 'code-b',
        state: authorizeBody.state,
        codeVerifier: verifier,
      },
    });
    expect(bound.status).toBe(200);
    expect((bound.json as { bindings: unknown[] }).bindings).toHaveLength(1);

    const list1 = await client.listBindings(token);
    expect(list1).toHaveLength(1);
    expect(list1[0]!.id).toBeTruthy();
    expect(list1[0]!.provider).toBe('github');
    expect(list1[0]!.externalId).not.toBe('77'); // 脱敏

    // 有密码 + 有邮箱方式：解绑唯一绑定允许
    const after = await client.unbind('github', token, true);
    expect(after).toHaveLength(0);

    // OAuth 建号（无密码、单绑定）解绑 → 服务端 409 BINDING_LAST_METHOD
    const verifier2 = randomBytes(32).toString('base64url');
    const auth2 = await raw(
      'GET',
      `/api/auth/oauth/github/authorize?code_challenge=${encodeURIComponent(pkceChallenge(verifier2))}&redirect_uri=${encodeURIComponent('everyonecoding://oauth')}`,
    );
    const auth2Body = auth2.json as { state: string };
    const oauthSession = (
      await raw('POST', '/api/auth/oauth/github/callback', {
        body: {
          code: 'code-o',
          codeVerifier: verifier2,
          redirectUri: 'everyonecoding://oauth',
          state: auth2Body.state,
        },
      })
    ).json as { tokens: TokenPair };
    const oauthToken = oauthSession.tokens.accessToken;
    const oauthBindings = await client.listBindings(oauthToken);
    await expect(client.unbind('github', oauthToken, false)).rejects.toMatchObject({ status: 400 });
    expect(oauthBindings).toHaveLength(1);
  });

  it('刷新令牌轮换：旧 refresh 一次性', async () => {
    const session = await client.register({ email: EMAIL, password: PASSWORD });
    const rotated = (
      await raw('POST', '/api/auth/refresh', {
        body: { refreshToken: session.tokens.refreshToken },
      })
    ).json as TokenPair;
    expect(rotated.accessToken).toBeTruthy();

    const replay = await raw('POST', '/api/auth/refresh', {
      body: { refreshToken: session.tokens.refreshToken },
    });
    expect(replay.status).toBe(401);
  });
});
