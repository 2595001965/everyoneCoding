/**
 * E2E-02：第三方登录 —— GitHub 授权登录 → 回调成功后自动建号并进入工作台。
 *
 * 装配：真实 `services/account` + 真实 PKCE/state 校验，仅把**对外 HTTP 出网**换成假 fetch
 * （GitHub 的 token/user 端点）——这是唯一不可自动化的一环（需要真实 GitHub 应用凭据与人工授权），
 * 其余链路（state 校验、PKCE 换令牌、自动建号、发令牌）全部走真实实现。
 *
 * 与 E2E-01 的差别：本用例专门验证 **OAuth 身份合并**（同一 GitHub 用户第二次登录命中已有账号）
 * 与 **state 防伪**（伪造 state 被拒）。
 */

import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../services/account/src/app.ts';
import { loadConfig } from '../../services/account/src/config.ts';
import { openDatabase } from '../../services/account/src/db.ts';
import { pkceChallenge } from '../../services/account/src/jwt.ts';
import { setOAuthFetch, type OAuthFetch } from '../../services/account/src/oauth/index.ts';

/** 服务端实例类型（避免从 e2e 直接依赖 fastify 的类型解析） */
type App = Awaited<ReturnType<typeof buildApp>>;

const cb = (params: Record<string, string>): string => new URLSearchParams(params).toString();

/** 假 GitHub 出网：token 端点 + user 端点（真实报文结构） */
function fakeGithubFetch(): OAuthFetch {
  return async (req) => {
    if (req.url.includes('github.com/login/oauth/access_token')) {
      return { status: 200, body: JSON.stringify({ access_token: 'gh-at-e2e' }) };
    }
    if (req.url.includes('api.github.com/user')) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 424242,
          login: 'octocat-e2e',
          email: 'octocat@example.com',
          name: 'Octo E2E',
        }),
      };
    }
    return { status: 404, body: '{}' };
  };
}

let app: App;

beforeAll(async () => {
  setOAuthFetch(fakeGithubFetch());
  const cfg = loadConfig({
    dbPath: ':memory:',
    loginRateLimitPerMin: 50,
    registerRateLimitPerMin: 50,
  });
  app = await buildApp(cfg, openDatabase(':memory:'));
});

describe('E2E-02 第三方登录：GitHub 授权 → 回调自动建号', () => {
  it('首次授权自动建号并直接拿到工作区与会话令牌（无二次注册步骤）', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const authorize = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/github/authorize?${cb({
        redirect_uri: 'https://app.example.com/cb',
        code_challenge: pkceChallenge(verifier),
      })}`,
    });
    expect(authorize.statusCode).toBe(200);
    const issued = authorize.json() as { authorizeUrl: string; state: string };
    expect(issued.authorizeUrl).toContain('github.com');
    expect(issued.authorizeUrl).toContain('code_challenge');

    const callback = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/github/callback?${cb({
        code: 'gh-code-1',
        state: issued.state,
        code_verifier: verifier,
      })}`,
    });
    expect(callback.statusCode).toBe(200);
    const body = callback.json() as {
      userId: string;
      workspaceId: string;
      planId: string;
      isNew: boolean;
      accessToken: string;
      refreshToken: string;
    };
    expect(body.isNew).toBe(true);
    expect(body.userId).toBeTruthy();
    // 回调成功即自动建号并开通工作区 → 直接进入工作台
    expect(body.workspaceId).toBeTruthy();
    expect(body.planId).toBe('free');
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it('同一 GitHub 身份再次登录命中已有账号（不重复建号）', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const authorize = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/github/authorize?${cb({
        redirect_uri: 'https://app.example.com/cb',
        code_challenge: pkceChallenge(verifier),
      })}`,
    });
    const { state } = authorize.json() as { state: string };

    const callback = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/github/callback?${cb({ code: 'gh-code-2', state, code_verifier: verifier })}`,
    });
    expect(callback.statusCode).toBe(200);
    expect((callback.json() as { isNew: boolean }).isNew).toBe(false);
  });

  it('伪造 / 篡改 state 被拒绝（PKCE + state 防伪，回调不可被冒用）', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const forged = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/github/callback?${cb({
        code: 'gh-code-3',
        state: 'forged-state-value',
        code_verifier: verifier,
      })}`,
    });
    expect(forged.statusCode).toBeGreaterThanOrEqual(400);
    expect(forged.statusCode).toBeLessThan(500);
  });

  it('缺失 code_verifier 的回调被拒（PKCE 强制）', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/github/callback?${cb({ code: 'gh-code-4', state: 'x' })}`,
    });
    expect(missing.statusCode).toBe(400);
  });
});
