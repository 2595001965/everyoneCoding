/**
 * E2E-01：新用户注册 —— 邮箱注册 → 校验 → 自开通工作区 → 登录 → 刷新（服务端整链路）。
 *
 * 装配：真实 `services/account`（Fastify + better-sqlite3），经 `app.inject()` 跑真实路由，
 * 不起常驻进程、不占端口（与 Wave 9 的 account 服务测试同源口径）。
 *
 * 判定：全流程无管理员介入（自动开通 workspace + free 权益包）；
 * 邮箱「链接验证」不在 PRD §8 的八个服务端接口内，作为手工项记录在 docs/E2E-CHECKLIST.md。
 */

import { describe, expect, it } from 'vitest';

import { buildApp } from '../../services/account/src/app.ts';
import { loadConfig } from '../../services/account/src/config.ts';
import { openDatabase } from '../../services/account/src/db.ts';

/** 服务端实例类型（避免从 e2e 直接依赖 fastify 的类型解析） */
type App = Awaited<ReturnType<typeof buildApp>>;

async function makeApp(): Promise<App> {
  const cfg = loadConfig({ dbPath: ':memory:', loginRateLimitPerMin: 50, registerRateLimitPerMin: 50 });
  const db = openDatabase(':memory:');
  return buildApp(cfg, db);
}

describe('E2E-01 新用户注册：注册 → 自开通 → 登录 → 刷新', () => {
  it('邮箱注册成功并自动开通工作区与免费权益包（无管理员介入）', async () => {
    const app = await makeApp();
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'newbie@example.com', password: 'Abcd1234', displayName: '新用户' },
    });

    expect(reg.statusCode).toBe(201);
    const body = reg.json() as {
      userId: string;
      workspaceId: string;
      planId: string;
      accessToken: string;
      refreshToken: string;
    };
    // 自注册即开通（FR-ACC-05）：工作区与权益包在注册响应里就绪
    expect(body.userId).toBeTruthy();
    expect(body.workspaceId).toBeTruthy();
    expect(body.planId).toBe('free');
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    await app.close();
  });

  it('注册校验：邮箱格式与密码强度不合格被拒（未通过验证不得建号）', async () => {
    const app = await makeApp();

    const badEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', password: 'Abcd1234' },
    });
    expect(badEmail.statusCode).toBeGreaterThanOrEqual(400);
    expect(badEmail.statusCode).toBeLessThan(500);
    expect(badEmail.json()).toMatchObject({ code: expect.any(String), message: expect.any(String) });

    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'weak@example.com', password: '123' },
    });
    expect(weak.statusCode).toBeGreaterThanOrEqual(400);

    // 重复邮箱被拒
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'dup@example.com', password: 'Abcd1234' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'dup@example.com', password: 'Abcd1234' },
    });
    expect(dup.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it('登录成功 → 刷新成功 → 旧 refresh 令牌失效（令牌轮换，会话安全）', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'flow@example.com', password: 'Abcd1234' },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'flow@example.com', password: 'Abcd1234' },
    });
    expect(login.statusCode).toBe(200);
    const oldRefresh = (login.json() as { refreshToken: string }).refreshToken;

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: oldRefresh },
    });
    expect(refreshed.statusCode).toBe(200);
    expect((refreshed.json() as { accessToken: string }).accessToken).toBeTruthy();

    // 旧 refresh 复用被拒（轮换后失效）
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: oldRefresh },
    });
    expect(reuse.statusCode).toBe(401);

    // 错误密码被拒
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'flow@example.com', password: 'Wrong1234' },
    });
    expect(wrong.statusCode).toBe(401);
    await app.close();
  });
});
