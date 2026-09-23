/**
 * 邮箱验证与找回密码服务端测试（FR-ACC-08 / T9-06）。
 *
 * 覆盖：验证邮件发送（outbox 可查）→ 链接确认 → 状态翻转；重置密码验证码
 * 单次有效、过期拒绝、重复使用拒绝、限流冷却；重置后旧 refresh 全部失效。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { openDatabase } from '../db.ts';
import { buildApp } from '../app.ts';
import { loadConfig, type AppConfig } from '../config.ts';

let app: FastifyInstance;

interface OutboxRow {
  to_addr: string;
  subject: string;
  body: string;
  kind: string;
}

/** 从 outbox 表直读（app.accountDb.raw） */
function readOutbox(): OutboxRow[] {
  return app.accountDb.raw
    .prepare(
      'SELECT to_addr, subject, body, kind FROM account_email_outbox ORDER BY created_at DESC',
    )
    .all() as OutboxRow[];
}

/** 从 outbox 正文提取验证链接 token（开发链路：链接在 body 里） */
function extractToken(body: string): string {
  const match = body.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`验证邮件正文里没有 token：${body}`);
  return match[1]!;
}

/** 从 outbox 正文提取 6 位验证码 */
function extractCode(body: string): string {
  const match = body.match(/验证码是：(\d{6})/);
  if (!match) throw new Error(`重置邮件正文里没有验证码：${body}`);
  return match[1]!;
}

async function makeApp(overrides: Partial<AppConfig> = {}): Promise<{
  app: FastifyInstance;
  config: AppConfig;
}> {
  const cfg = loadConfig({
    dbPath: ':memory:',
    emailVerifyTtlSec: 24 * 60 * 60,
    passwordResetTtlSec: 600,
    emailResendCooldownMs: 60_000,
    ...overrides,
  });
  const db = openDatabase(':memory:');
  return { app: await buildApp(cfg, db), config: cfg };
}

async function register(email: string, password = 'Abcd1234'): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(201);
}

beforeEach(async () => {
  const created = await makeApp();
  app = created.app;
});

describe('邮箱验证（FR-ACC-08）', () => {
  it('注册 → 发验证邮件（outbox 可查）→ confirm 后状态翻转为已验证', async () => {
    await register('verify@example.com');

    const sent = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      payload: { email: 'verify@example.com' },
    });
    expect(sent.statusCode).toBe(200);

    const outbox = readOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.kind).toBe('verify');
    // outbox 存原始收件人（投递需要）；dev 读取端点才做脱敏
    expect(outbox[0]!.to_addr).toBe('verify@example.com');
    // 审计日志里必须是脱敏的
    const audit = app.accountDb.raw
      .prepare(`SELECT detail FROM account_audit_log WHERE action = 'auth.email.verify.sent'`)
      .get() as { detail: string };
    expect(audit.detail).not.toContain('verify@example.com');

    const token = extractToken(outbox[0]!.body);

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify/confirm',
      payload: { token },
    });
    expect(confirm.statusCode).toBe(200);

    const status = await app.inject({
      method: 'GET',
      url: '/api/auth/email/status?email=verify@example.com',
    });
    expect(status.json().emailVerified).toBe(true);

    // 登录返回的 identity.emailVerified 一致
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'verify@example.com', password: 'Abcd1234' },
    });
    expect(login.json().identity.emailVerified).toBe(true);
  });

  it('验证链接单次有效：二次使用拒绝；冷却窗口内重复发送限流', async () => {
    await register('once@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      payload: { email: 'once@example.com' },
    });
    const token = extractToken(readOutbox()[0]!.body);

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify/confirm',
      payload: { token },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify/confirm',
      payload: { token },
    });
    expect(second.statusCode).toBe(400);

    // 冷却窗口内再发 → 429（但邮箱已验证场景先幂等成功，换未验证邮箱验证限流）
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      payload: { email: 'once@example.com' },
    });
    expect(again.json().emailVerified).toBe(true); // 已验证幂等
  });

  it('冷却窗口限流：未验证邮箱 60s 内第二次发送返回 429', async () => {
    await register('cool@example.com');
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      payload: { email: 'cool@example.com' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      payload: { email: 'cool@example.com' },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().code).toBe('RATE_LIMITED');
  });

  it('过期链接拒绝；未注册邮箱发送幂等成功（不泄露注册状态）', async () => {
    await register('exp@example.com');
    // 直接构造一个已过期的 verify 令牌：给用户发一次，再把 expires_at 改过去
    await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      payload: { email: 'exp@example.com' },
    });
    const token = extractToken(readOutbox()[0]!.body);
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    app.accountDb.raw
      .prepare('UPDATE account_email_token SET expires_at = ? WHERE token_hash = ?')
      .run(Date.now() - 1000, tokenHash);

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify/confirm',
      payload: { token },
    });
    expect(confirm.statusCode).toBe(400);

    // 未注册邮箱：幂等成功、无邮件落 outbox
    const ghost = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      payload: { email: 'ghost@example.com' },
    });
    expect(ghost.statusCode).toBe(200);
    expect(readOutbox()).toHaveLength(1); // 仍只有 exp 那封
  });
});

describe('重置密码（FR-ACC-08）', () => {
  it('请求重置码 → 验证码重置成功 → 新密码可登录、旧 refresh 失效', async () => {
    await register('reset@example.com');
    const loginOld = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'reset@example.com', password: 'Abcd1234' },
    });
    const oldRefresh = loginOld.json().tokens.refreshToken as string;

    const req = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset/request',
      payload: { email: 'reset@example.com' },
    });
    expect(req.statusCode).toBe(200);
    const code = extractCode(readOutbox().find((row) => row.kind === 'reset')!.body);

    const reset = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { email: 'reset@example.com', code, newPassword: 'NewPass99' },
    });
    expect(reset.statusCode).toBe(200);

    // 新密码可登录
    const loginNew = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'reset@example.com', password: 'NewPass99' },
    });
    expect(loginNew.statusCode).toBe(200);
    expect(loginNew.json().identity.hasPassword).toBe(true);

    // 旧密码失效
    const loginStale = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'reset@example.com', password: 'Abcd1234' },
    });
    expect(loginStale.statusCode).toBe(401);

    // 重置前签发的 refresh 全部失效（安全：强制重新登录）
    const reuseRefresh = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: oldRefresh },
    });
    expect(reuseRefresh.statusCode).toBe(401);
  });

  it('验证码单次有效：重复使用拒绝；错误验证码拒绝', async () => {
    await register('twice@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset/request',
      payload: { email: 'twice@example.com' },
    });
    const code = extractCode(readOutbox().find((row) => row.kind === 'reset')!.body);

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { email: 'twice@example.com', code, newPassword: 'NewPass99' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { email: 'twice@example.com', code, newPassword: 'Other88x' },
    });
    expect(second.statusCode).toBe(400);

    // 错误码（新请求的新码已被消费过一轮，直接给错码）
    await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset/request',
      payload: { email: 'twice@example.com' },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { email: 'twice@example.com', code: '000000', newPassword: 'Other88x' },
    });
    expect(wrong.statusCode).toBe(400);
  });

  it('过期验证码拒绝；新密码强度不足拒绝（WEAK_PASSWORD）', async () => {
    await register('expire@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset/request',
      payload: { email: 'expire@example.com' },
    });
    const code = extractCode(readOutbox().find((row) => row.kind === 'reset')!.body);
    // 手动把该 reset 令牌置为过期
    app.accountDb.raw
      .prepare(`UPDATE account_email_token SET expires_at = ? WHERE kind = 'reset'`)
      .run(Date.now() - 1000);

    const expired = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { email: 'expire@example.com', code, newPassword: 'NewPass99' },
    });
    expect(expired.statusCode).toBe(400);

    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { email: 'expire@example.com', code: '123456', newPassword: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('WEAK_PASSWORD');
  });

  it('重置码请求限流：冷却窗口内第二次 429', async () => {
    await register('rl@example.com');
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset/request',
      payload: { email: 'rl@example.com' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset/request',
      payload: { email: 'rl@example.com' },
    });
    expect(second.statusCode).toBe(429);
  });
});
