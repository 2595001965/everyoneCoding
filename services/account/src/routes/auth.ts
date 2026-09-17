/**
 * 认证路由：注册、登录、OAuth 授权/回调、刷新、第三方绑定。
 * 严格只实现 PRD §8 规定接口；远程配置下发、云同步与分享链接等已被移除的能力一律不实现。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrCode } from '../errors.ts';
import { hashPassword, isStrongPassword, verifyPassword } from '../crypto.ts';
import { issueTokens, requireAuth, rotateRefreshToken } from '../auth-tokens.ts';
import { maskEmail, maskSecret, writeAudit } from '../logger.ts';
import { getStrategy, type OAuthProvider } from '../oauth/index.ts';
import { createOAuthState } from '../oauth/session.ts';
import { resolveOAuth } from '../oauth/flow.ts';

const BINDING_LIMIT = 50;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = app.accountDb;
  const config = app.appConfig;

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
      userId: result.userId,
      email: result.email,
      workspaceId: result.workspaceId,
      planId: result.planId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
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
      userId: user.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
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
  app.get('/api/auth/oauth/:provider/callback', async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    const query = req.query as {
      code?: string;
      state?: string;
      code_verifier?: string;
    };
    if (!query.code || !query.state || !query.code_verifier) {
      throw new AppError(ErrCode.BAD_REQUEST, '缺少 code、state 或 code_verifier', 400);
    }
    const { profile } = await resolveOAuth(
      config,
      provider,
      query.state,
      query.code,
      query.code_verifier,
    );
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
      userId: result.userId,
      workspaceId: result.workspaceId,
      planId: result.planId,
      isNew: result.isNew,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    });
  });

  // ---- 刷新令牌（旧 refresh 轮换失效）----
  app.post('/api/auth/refresh', async (req) => {
    const schema = z.object({ refreshToken: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '缺少 refreshToken', 400);
    }
    const { userId } = rotateRefreshToken(db, config, parsed.data.refreshToken);
    const tokens = issueTokens(db, config, userId);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    };
  });

  // ---- 第三方绑定：列出 ----
  app.get('/api/auth/bindings', { preHandler: requireAuth }, async (req) => {
    const userId = req.user!.userId;
    const limit = 20;
    const cursor = (req.query as { cursor?: string }).cursor ?? '';
    const all = db.getBindings(userId);
    const ordered = [...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const startIdx = cursor ? ordered.findIndex((b) => b.id === cursor) + 1 : 0;
    const slice = ordered.slice(startIdx, startIdx + limit);
    const nextCursor =
      startIdx + limit < ordered.length && slice.length > 0
        ? (slice[slice.length - 1]?.id ?? '')
        : '';
    return {
      items: slice.map((b) => ({
        id: b.id,
        provider: b.provider,
        providerUserId: maskSecret(b.provider_user_id),
        createdAt: b.created_at,
      })),
      nextCursor,
    };
  });

  // ---- 第三方绑定：新增（对已登录账号）----
  app.post('/api/auth/bindings', { preHandler: requireAuth }, async (req) => {
    const userId = req.user!.userId;
    const schema = z.object({
      provider: z.enum(['wechat', 'google', 'github']),
      code: z.string().min(1),
      state: z.string().min(1),
      code_verifier: z.string().min(1),
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
      parsed.data.code_verifier,
    );
    const existing = db.findBinding(parsed.data.provider, profile.providerUserId);
    if (existing && existing.user_id !== userId) {
      throw new AppError(ErrCode.CONFLICT, '该第三方身份已绑定到其他账号', 409);
    }
    if (existing) {
      return { id: existing.id, provider: existing.provider, createdAt: existing.created_at };
    }
    if (db.getBindings(userId).length >= BINDING_LIMIT) {
      throw new AppError(ErrCode.CONFLICT, '绑定数量已达上限', 409);
    }
    const binding = db.addBinding(userId, parsed.data.provider, profile.providerUserId);
    writeAudit(
      db.raw,
      'auth.bind.add',
      `用户=${maskSecret(userId)} provider=${parsed.data.provider}`,
    );
    return { id: binding.id, provider: binding.provider, createdAt: binding.created_at };
  });

  // ---- 第三方绑定：解绑 ----
  app.delete('/api/auth/bindings', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user!.userId;
    const bindingId =
      (req.query as { bindingId?: string }).bindingId ??
      (req.body as { bindingId?: string } | undefined)?.bindingId ??
      '';
    if (!bindingId) {
      throw new AppError(ErrCode.BAD_REQUEST, '缺少 bindingId', 400);
    }
    const methodCount = db.countLoginMethods(userId);
    if (methodCount <= 1) {
      throw new AppError(
        ErrCode.BINDING_LAST_METHOD,
        '当前为唯一登录方式，且未设置密码，无法解绑（请先设置密码）',
        409,
      );
    }
    db.removeBinding(userId, bindingId);
    writeAudit(db.raw, 'auth.bind.remove', `用户=${maskSecret(userId)} 解绑=${maskSecret(bindingId)}`);
    return reply.send({ ok: true });
  });
}
