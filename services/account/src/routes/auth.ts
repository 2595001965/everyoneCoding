/**
 * 认证路由：注册、登录、OAuth 授权/回调、刷新、第三方绑定。
 * 严格只实现 PRD §8 规定接口；远程配置下发、云同步与分享链接等已被移除的能力一律不实现。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ErrCode } from '../errors.ts';
import { hashPassword, isStrongPassword, verifyPassword } from '../crypto.ts';
import { issueTokens, requireAuth, rotateRefreshToken } from '../auth-tokens.ts';
import { maskEmail, maskSecret, writeAudit } from '../logger.ts';
import { getStrategy, type OAuthProvider } from '../oauth/index.ts';
import { createOAuthState } from '../oauth/session.ts';
import { resolveOAuth } from '../oauth/flow.ts';
import { createMailerFromEnv, hashToken, newEmailCode, newEmailToken } from '../mailer.ts';
import type { TokenPair } from '../auth-tokens.ts';
import type { AccountDb } from '../models/account.ts';

const BINDING_LIMIT = 50;

/** 身份块：客户端 `@ec/account` 的 AccountIdentity 镜像（契约测试钉住字段名） */
function identityOf(db: AccountDb, userId: string, email: string | null) {
  const user = db.getUserById(userId);
  return {
    accountId: userId,
    login: email ?? user?.email ?? userId,
    displayName: user?.display_name ?? email ?? '用户',
    avatarUrl: null as string | null,
    emailVerified: db.isEmailVerified(userId),
    hasPassword: db.hasPassword(userId),
  };
}

/** tokens → 客户端 TokenPair 镜像（expiresAt/refreshExpiresAt 毫秒时间戳） */
function toClientTokens(tokens: TokenPair) {
  const now = Date.now();
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + tokens.expiresIn * 1000,
    refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = app.accountDb;
  const config = app.appConfig;
  const mailer = createMailerFromEnv(db.raw, config.mailWebhookUrl);

  // ---- 注册 ----
  app.post('/api/auth/register', async (req, reply) => {
    const schema = z.object({
      email: z.string().email('邮箱格式不正确'),
      password: z.string().min(1, '密码不能为空'),
      displayName: z.string().min(1).max(64).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求参数校验失败', 400);
    }
    const email = parsed.data.email.toLowerCase();
    const password = parsed.data.password;
    if (!isStrongPassword(password)) {
      throw new AppError(
        ErrCode.WEAK_PASSWORD,
        '密码至少 8 位且包含两类字符（大写、小写、数字、特殊字符）',
        400,
      );
    }
    if (db.getUserByEmail(email)) {
      throw new AppError(ErrCode.EMAIL_TAKEN, '该邮箱已被注册', 409);
    }
    const displayName = parsed.data.displayName ?? email.split('@')[0] ?? '新用户';
    const result = db.registerEmailUser(email, hashPassword(password), displayName);
    const tokens = issueTokens(db, config, result.userId);
    writeAudit(db.raw, 'auth.register', `邮箱=${maskEmail(email)} 自注册开通`);
    return reply.code(201).send({
      identity: identityOf(db, result.userId, result.email),
      tokens: toClientTokens(tokens),
      workspaceId: result.workspaceId,
      planId: result.planId,
    });
  });

  // ---- 登录 ----
  app.post('/api/auth/login', async (req) => {
    const schema = z.object({
      email: z.string().email('邮箱格式不正确'),
      password: z.string().min(1, '密码不能为空'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求参数校验失败', 400);
    }
    const email = parsed.data.email.toLowerCase();
    const user = db.getUserByEmail(email);
    if (!user || !user.password_hash || !verifyPassword(parsed.data.password, user.password_hash)) {
      writeAudit(db.raw, 'auth.login.fail', `邮箱=${maskEmail(email)} 密码错误`);
      throw new AppError(ErrCode.INVALID_CREDENTIALS, '邮箱或密码错误', 401);
    }
    const tokens = issueTokens(db, config, user.id);
    writeAudit(db.raw, 'auth.login.ok', `邮箱=${maskEmail(email)} 登录成功`);
    return {
      identity: identityOf(db, user.id, user.email),
      tokens: toClientTokens(tokens),
    };
  });

  // ---- OAuth 发起授权 ----
  app.get('/api/auth/oauth/:provider/authorize', async (req) => {
    const provider = (req.params as { provider: string }).provider;
    const strategy = getStrategy(provider);
    if (!strategy) {
      throw new AppError(ErrCode.BAD_REQUEST, `不支持的 OAuth 提供方：${provider}`, 400);
    }
    const query = req.query as {
      redirect_uri?: string;
      code_challenge?: string;
      scope?: string;
    };
    if (!query.redirect_uri || !query.code_challenge) {
      throw new AppError(ErrCode.BAD_REQUEST, '缺少 redirect_uri 或 code_challenge', 400);
    }
    const cfg = config.oauth[provider as OAuthProvider];
    const state = createOAuthState(
      provider as OAuthProvider,
      query.code_challenge,
      query.redirect_uri,
      config.oauthStateTtlSec,
    );
    const authorizeUrl = strategy.buildAuthorizeUrl({
      clientId: cfg.clientId,
      redirectUri: query.redirect_uri,
      state,
      codeChallenge: query.code_challenge,
      ...(query.scope !== undefined ? { scope: query.scope } : {}),
    });
    return { authorizeUrl, state };
  });

  // ---- OAuth 回调换取令牌（首次授权自动建号）----
  // 双协议：GET（浏览器重定向直连服务端）与 POST（客户端经服务端转发回调参数）都接受。
  // POST 是 `@ec/account` completeOAuth 的主路径：回环/协议回调由客户端捕获后转发到这里。
  const handleOAuthCallback = async (req: FastifyRequest, reply: FastifyReply) => {
    const provider = (req.params as { provider: string }).provider;
    const query = (req.query ?? {}) as { code?: string; state?: string; code_verifier?: string };
    const body = (req.body ?? {}) as {
      code?: string;
      state?: string;
      codeVerifier?: string;
      code_verifier?: string;
    };
    const code = body.code ?? query.code;
    const state = body.state ?? query.state;
    const codeVerifier = body.codeVerifier ?? body.code_verifier ?? query.code_verifier;
    if (!code || !state || !codeVerifier) {
      throw new AppError(ErrCode.BAD_REQUEST, '缺少 code、state 或 code_verifier', 400);
    }
    const { profile } = await resolveOAuth(config, provider, state, code, codeVerifier);
    const result = db.upsertOAuthUser({
      provider,
      providerUserId: profile.providerUserId,
      email: profile.email,
      name: profile.name,
    });
    const tokens = issueTokens(db, config, result.userId);
    writeAudit(
      db.raw,
      'auth.oauth.callback',
      `provider=${provider} 用户=${maskSecret(profile.providerUserId)} isNew=${result.isNew}`,
    );
    return reply.send({
      identity: identityOf(db, result.userId, profile.email),
      tokens: toClientTokens(tokens),
      workspaceId: result.workspaceId,
      planId: result.planId,
      isNew: result.isNew,
    });
  };

  app.get('/api/auth/oauth/:provider/callback', handleOAuthCallback);
  app.post('/api/auth/oauth/:provider/callback', handleOAuthCallback);

  // ---- 刷新令牌（旧 refresh 轮换失效）----
  app.post('/api/auth/refresh', async (req) => {
    const schema = z.object({ refreshToken: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '缺少 refreshToken', 400);
    }
    const { userId } = rotateRefreshToken(db, config, parsed.data.refreshToken);
    const tokens = issueTokens(db, config, userId);
    return toClientTokens(tokens);
  });

  // ---- 第三方绑定：列出 ----
  // 返回 { bindings }（客户端 @ec/account 直接消费该键）；兼容旧 cursor 分页语义。
  app.get('/api/auth/bindings', { preHandler: requireAuth }, async (req) => {
    const userId = req.user!.userId;
    const all = db.getBindings(userId);
    return {
      bindings: all.map((b) => ({
        id: b.id,
        provider: b.provider,
        externalId: maskSecret(b.provider_user_id),
        boundAt: b.created_at,
      })),
      nextCursor: '',
    };
  });

  // ---- 第三方绑定：新增（对已登录账号，走完整 OAuth 换身份）----
  app.post('/api/auth/bindings', { preHandler: requireAuth }, async (req) => {
    const userId = req.user!.userId;
    const schema = z.object({
      provider: z.enum(['wechat', 'google', 'github']),
      code: z.string().min(1),
      state: z.string().min(1),
      codeVerifier: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求参数校验失败', 400);
    }
    const { profile } = await resolveOAuth(
      config,
      parsed.data.provider,
      parsed.data.state,
      parsed.data.code,
      parsed.data.codeVerifier,
    );
    const existing = db.findBinding(parsed.data.provider, profile.providerUserId);
    if (existing && existing.user_id !== userId) {
      throw new AppError(ErrCode.CONFLICT, '该第三方身份已绑定到其他账号', 409);
    }
    if (existing) {
      throw new AppError(ErrCode.CONFLICT, '该第三方身份已绑定到当前账号', 409);
    }
    if (db.getBindings(userId).length >= BINDING_LIMIT) {
      throw new AppError(ErrCode.CONFLICT, '绑定数量已达上限', 409);
    }
    db.addBinding(userId, parsed.data.provider, profile.providerUserId);
    writeAudit(
      db.raw,
      'auth.bind.add',
      `用户=${maskSecret(userId)} provider=${parsed.data.provider}`,
    );
    return {
      bindings: db.getBindings(userId).map((b) => ({
        id: b.id,
        provider: b.provider,
        externalId: maskSecret(b.provider_user_id),
        boundAt: b.created_at,
      })),
    };
  });

  // ---- 第三方绑定：解绑（按 bindingId；provider 可选附带用于审计与客户端日志）----
  app.delete('/api/auth/bindings', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user!.userId;
    const query = req.query as { bindingId?: string; provider?: string };
    const body = (req.body ?? {}) as { bindingId?: string; provider?: string } | undefined;
    const bindingId = query.bindingId ?? body?.bindingId ?? '';
    if (!bindingId) {
      throw new AppError(ErrCode.BAD_REQUEST, '缺少 bindingId', 400);
    }
    const target = db.getBindings(userId).find((b) => b.id === bindingId);
    if (!target) {
      throw new AppError(ErrCode.NOT_FOUND, '绑定不存在或不属于当前账号', 404);
    }
    if (db.countLoginMethods(userId) <= 1) {
      throw new AppError(
        ErrCode.BINDING_LAST_METHOD,
        '当前为唯一登录方式，且未设置密码，无法解绑（请先设置密码）',
        409,
      );
    }
    db.removeBinding(userId, bindingId);
    writeAudit(
      db.raw,
      'auth.bind.remove',
      `用户=${maskSecret(userId)} 解绑=${maskSecret(bindingId)} provider=${target.provider}`,
    );
    return reply.send({
      bindings: db.getBindings(userId).map((b) => ({
        id: b.id,
        provider: b.provider,
        externalId: maskSecret(b.provider_user_id),
        boundAt: b.created_at,
      })),
    });
  });

  /* --------------------- 邮箱验证与找回密码（FR-ACC-08） --------------------- */

  // 发送验证邮件：已验证直接幂等成功；冷却窗口内拒绝（限流）；邮件落 outbox/webhook
  app.post('/api/auth/email/verify', async (req) => {
    const schema = z.object({ email: z.string().email('邮箱格式不正确') });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求参数校验失败', 400);
    }
    const email = parsed.data.email.toLowerCase();
    const user = db.getUserByEmail(email);
    // 不存在邮箱也返回成功（不泄露注册状态）；存在且已验证同样幂等成功
    if (!user) return { ok: true };
    if (db.isEmailVerified(user.id)) return { ok: true, emailVerified: true };
    if (db.hasRecentEmailToken(user.id, 'verify', config.emailResendCooldownMs)) {
      throw new AppError(ErrCode.RATE_LIMITED, '验证邮件发送过于频繁，请稍后再试', 429);
    }
    const token = newEmailToken();
    db.createEmailToken({
      userId: user.id,
      kind: 'verify',
      tokenHash: hashToken(token),
      code: '',
      expiresAt: Date.now() + config.emailVerifyTtlSec * 1000,
    });
    const link = `${config.emailVerifyBaseUrl}/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    await mailer.send({
      to: email,
      kind: 'verify',
      subject: 'EveryoneCoding 邮箱验证',
      text: `请点击以下链接完成邮箱验证（24 小时内有效）：\n${link}\n\n如果这不是您的操作，请忽略本邮件。`,
    });
    writeAudit(db.raw, 'auth.email.verify.sent', `邮箱=${maskEmail(email)}`);
    return { ok: true };
  });

  // 验证邮箱确认：token 单次有效、过期拒绝
  app.post('/api/auth/email/verify/confirm', async (req) => {
    const schema = z.object({ token: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '缺少验证令牌', 400);
    }
    const row = db.consumeEmailToken('verify', hashToken(parsed.data.token));
    if (!row) {
      throw new AppError(
        ErrCode.BAD_REQUEST,
        '验证链接无效、已过期或已被使用，请重新获取验证邮件',
        400,
      );
    }
    db.setEmailVerified(row.user_id, true);
    writeAudit(db.raw, 'auth.email.verify.ok', `用户=${maskSecret(row.user_id)} 邮箱验证完成`);
    return { ok: true };
  });

  // 查询验证状态（注册后轮询用）
  app.get('/api/auth/email/status', async (req) => {
    const email = String((req.query as { email?: string }).email ?? '').toLowerCase();
    if (!email) throw new AppError(ErrCode.BAD_REQUEST, '缺少 email', 400);
    const user = db.getUserByEmail(email);
    return { emailVerified: user !== null && db.isEmailVerified(user.id) };
  });

  // 请求重置密码：发 6 位验证码（不泄露注册状态）；冷却窗口限流
  app.post('/api/auth/password/reset/request', async (req) => {
    const schema = z.object({ email: z.string().email('邮箱格式不正确') });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求参数校验失败', 400);
    }
    const email = parsed.data.email.toLowerCase();
    const user = db.getUserByEmail(email);
    if (!user) return { ok: true }; // 不泄露注册状态
    if (db.hasRecentEmailToken(user.id, 'reset', config.emailResendCooldownMs)) {
      throw new AppError(ErrCode.RATE_LIMITED, '重置码发送过于频繁，请稍后再试', 429);
    }
    const code = newEmailCode();
    db.createEmailToken({
      userId: user.id,
      kind: 'reset',
      tokenHash: hashToken(`${user.id}:${code}`),
      code,
      expiresAt: Date.now() + config.passwordResetTtlSec * 1000,
    });
    await mailer.send({
      to: email,
      kind: 'reset',
      subject: 'EveryoneCoding 重置密码验证码',
      text: `您的重置密码验证码是：${code}（${Math.round(config.passwordResetTtlSec / 60)} 分钟内有效）\n\n如果这不是您的操作，请忽略本邮件。`,
    });
    writeAudit(db.raw, 'auth.password.reset.sent', `邮箱=${maskEmail(email)}`);
    return { ok: true };
  });

  // 重置密码：验证码单次有效、过期拒绝；成功后撤销该用户全部刷新令牌
  app.post('/api/auth/password/reset', async (req) => {
    const schema = z.object({
      email: z.string().email('邮箱格式不正确'),
      code: z.string().min(4).max(12),
      newPassword: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求参数校验失败', 400);
    }
    if (!isStrongPassword(parsed.data.newPassword)) {
      throw new AppError(
        ErrCode.WEAK_PASSWORD,
        '密码至少 8 位且包含两类字符（大写、小写、数字、特殊字符）',
        400,
      );
    }
    const email = parsed.data.email.toLowerCase();
    const user = db.getUserByEmail(email);
    if (!user) {
      throw new AppError(ErrCode.BAD_REQUEST, '验证码无效或已过期', 400);
    }
    const row = db.consumeEmailTokenByCode(user.id, 'reset', parsed.data.code);
    if (!row) {
      throw new AppError(
        ErrCode.BAD_REQUEST,
        '验证码无效、已过期或已被使用，请重新获取重置码',
        400,
      );
    }
    db.setPassword(user.id, hashPassword(parsed.data.newPassword));
    db.revokeAllRefreshTokens(user.id);
    writeAudit(db.raw, 'auth.password.reset.ok', `邮箱=${maskEmail(email)} 密码已重置`);
    return { ok: true };
  });

  // 开发/运维：读取 outbox（仅本机调试用；生产建议 webhook 投递）
  app.get('/api/dev/email-outbox', async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? '20') || 20, 100);
    const rows = db.raw
      .prepare('SELECT * FROM account_email_outbox ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{
      id: string;
      to_addr: string;
      subject: string;
      body: string;
      kind: string;
      created_at: number;
    }>;
    return {
      items: rows.map((row) => ({ ...row, to_addr: maskEmail(row.to_addr) })),
    };
  });
}
