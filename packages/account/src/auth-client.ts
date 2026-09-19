/**
 * 账号客户端（T9-05 / FR-ACC-01 ~ 08）。
 *
 * 服务端边界（D-02 / D-06 / D-09）：**只**调用 PRD §8 的八个接口，不做云同步、
 * 不拉远程配置、不生成分享链接。
 *
 * OAuth 回调双通道：优先本地回环监听（`127.0.0.1:<随机端口>`），
 * 回环不可用时回退自定义协议 `everyonecoding://oauth`；均使用 PKCE（S256）。
 */

import {
  AuthError,
  OfflineError,
  type AccountIdentity,
  type AuthProvider,
  type AuthSession,
  type Binding,
  type OAuthProvider,
  type SecureStorePort,
  type SystemPort,
  type TokenPair,
  type TransportPort,
} from './auth-types';
import { canBind, canUnbind } from './binding';
import { OfflineController, isNetworkError } from './offline';
import { buildGoogleAuthorizeUrl, GOOGLE_PROVIDER, parseGoogleCallback } from './oauth/google';
import { buildGithubAuthorizeUrl, GITHUB_PROVIDER, parseGithubCallback } from './oauth/github';
import {
  buildWechatQrUrl,
  parseWechatCallback,
  pollWechatQr,
  WECHAT_PROVIDER,
  type WechatPollResult,
} from './oauth/wechat';
import { checkPassword, createPkcePair, createState } from './security';
import { SessionManager } from './session';

export interface AuthClientDeps {
  transport: TransportPort;
  system: SystemPort;
  secure: SecureStorePort;
  /** 服务端基址，如 https://account.everyonecooding.example */
  baseUrl: string;
  offline?: OfflineController | undefined;
  clock?: (() => number) | undefined;
}

/** OAuth 握手上下文（完成后需连同回调 URL 一起交给 completeOAuth） */
export interface OAuthHandshake {
  provider: OAuthProvider;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authorizeUrl: string;
  /** 主通道（回环）或辅通道（自定义协议） */
  channel: 'loopback' | 'protocol';
  /** 关闭回环监听（协议通道为空操作） */
  stop(): void;
}

interface RegisterInput {
  email: string;
  password: string;
  confirm?: string | undefined;
  rememberMe?: boolean | undefined;
  rememberDays?: number | undefined;
}

interface LoginInput {
  email: string;
  password: string;
  rememberMe?: boolean | undefined;
  rememberDays?: number | undefined;
}

export class AuthClient {
  readonly session: SessionManager;
  private readonly transport: TransportPort;
  private readonly system: SystemPort;
  private readonly baseUrl: string;
  private readonly offline: OfflineController;

  constructor(deps: AuthClientDeps) {
    this.transport = deps.transport;
    this.system = deps.system;
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.offline = deps.offline ?? new OfflineController();
    this.session = new SessionManager({
      secure: deps.secure,
      refreshTokens: (refreshToken) => this.refreshTokens(refreshToken),
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    });
  }

  get offlineController(): OfflineController {
    return this.offline;
  }

  /* ----------------------------- 传输层 ----------------------------- */

  private async request<T>(input: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<T> {
    return this.offline.run(async () => {
      let response: { status: number; json: unknown };
      try {
        response = await this.transport.request({
          method: input.method,
          url: `${this.baseUrl}${input.path}`,
          ...(input.headers !== undefined ? { headers: input.headers } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        });
      } catch (error: unknown) {
        if (isNetworkError(error)) throw new OfflineError();
        throw error;
      }
      if (response.status >= 400) {
        const payload = (response.json ?? {}) as { code?: string; message?: string };
        throw new AuthError(
          payload.code ?? 'http_error',
          payload.message ?? `请求失败（${response.status}）`,
          response.status,
        );
      }
      return response.json as T;
    });
  }

  /* ----------------------------- 邮箱注册登录 ----------------------------- */

  /** 邮箱注册：密码校验 → 注册 → 自动登录并保存会话（E2E-01：无管理员介入） */
  async register(input: RegisterInput): Promise<AuthSession> {
    const check = checkPassword(input.password, input.confirm);
    if (!check.valid) {
      throw new AuthError('weak_password', check.issues.join('；'), 400);
    }
    const payload = await this.request<{ identity: AccountIdentity; tokens: TokenPair }>({
      method: 'POST',
      path: '/api/auth/register',
      body: { email: input.email, password: input.password },
    });
    return this.persistSession(payload, input.rememberMe ?? false, input.rememberDays);
  }

  /** 邮箱登录 */
  async login(input: LoginInput): Promise<AuthSession> {
    const payload = await this.request<{ identity: AccountIdentity; tokens: TokenPair }>({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: input.email, password: input.password },
    });
    return this.persistSession(payload, input.rememberMe ?? false, input.rememberDays);
  }

  private async persistSession(
    payload: { identity: AccountIdentity; tokens: TokenPair },
    rememberMe: boolean,
    rememberDays: number | undefined,
  ): Promise<AuthSession> {
    const session = this.session.buildSession({
      identity: payload.identity,
      tokens: payload.tokens,
      rememberMe,
      ...(rememberDays !== undefined ? { rememberDays } : {}),
    });
    await this.session.save(session);
    return session;
  }

  /** 启动时恢复会话（含自动刷新）；本地缓存失效返回 null */
  async restore(): Promise<Awaited<ReturnType<SessionManager['load']>>> {
    const session = await this.session.load();
    if (!session) return null;
    try {
      return await this.session.ensureFresh(session);
    } catch (error: unknown) {
      if (isNetworkError(error)) {
        this.offline.setOffline(true);
        return session; // 离线时仍可用本地身份，登录入口置灰
      }
      throw error;
    }
  }

  /** 退出登录：清除本地缓存（令牌一并清除） */
  async logout(): Promise<void> {
    await this.session.clear();
  }

  private async refreshTokens(refreshToken: string): Promise<TokenPair> {
    return this.request<TokenPair>({
      method: 'POST',
      path: '/api/auth/refresh',
      body: { refreshToken },
    });
  }

  /* ----------------------------- OAuth（PKCE + 双通道） ----------------------------- */

  /** 发起 OAuth：回环监听为主、自定义协议为辅 */
  async beginOAuth(provider: OAuthProvider): Promise<OAuthHandshake> {
    const state = createState();
    const pkce = await createPkcePair();

    let redirectUri = '';
    let channel: OAuthHandshake['channel'] = 'loopback';
    let stop = (): void => undefined;

    try {
      const loopback = await this.system.startLoopback(() => undefined);
      redirectUri = loopback.redirectUri;
      stop = loopback.stop;
    } catch {
      const protocolOk = await this.system.registerProtocol(() => undefined);
      if (!protocolOk) {
        throw new AuthError(
          'oauth_channel_unavailable',
          '本地回环监听与自定义协议均不可用，无法完成第三方登录。',
        );
      }
      redirectUri = 'everyonecoding://oauth';
      channel = 'protocol';
    }

    const meta = await this.request<{ clientId: string }>({
      method: 'GET',
      path: `/api/auth/oauth/${provider}/authorize?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(pkce.challenge)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });

    const authorizeUrl = this.buildAuthorizeUrl(provider, {
      clientId: meta.clientId,
      redirectUri,
      codeChallenge: pkce.challenge,
      state,
    });
    await this.system.openExternal(authorizeUrl);
    return {
      provider,
      state,
      codeVerifier: pkce.verifier,
      redirectUri,
      authorizeUrl,
      channel,
      stop,
    };
  }

  private buildAuthorizeUrl(
    provider: OAuthProvider,
    input: { clientId: string; redirectUri: string; codeChallenge: string; state: string },
  ): string {
    if (provider === GOOGLE_PROVIDER) return buildGoogleAuthorizeUrl(input);
    if (provider === GITHUB_PROVIDER) return buildGithubAuthorizeUrl(input);
    return buildWechatQrUrl({
      appId: input.clientId,
      redirectUri: input.redirectUri,
      state: input.state,
    });
  }

  /** 完成 OAuth：解析回调 → 服务端换令牌 → 保存会话（首次授权自动建号） */
  async completeOAuth(
    handshake: OAuthHandshake,
    callbackUrl: string,
    options: { rememberMe?: boolean | undefined; rememberDays?: number | undefined } = {},
  ): Promise<AuthSession> {
    try {
      const { code } =
        handshake.provider === GOOGLE_PROVIDER
          ? parseGoogleCallback(callbackUrl, handshake.state)
          : handshake.provider === GITHUB_PROVIDER
            ? parseGithubCallback(callbackUrl, handshake.state)
            : parseWechatCallback(callbackUrl, handshake.state);

      const payload = await this.request<{ identity: AccountIdentity; tokens: TokenPair }>({
        method: 'POST',
        path: `/api/auth/oauth/${handshake.provider}/callback`,
        body: {
          code,
          codeVerifier: handshake.codeVerifier,
          redirectUri: handshake.redirectUri,
          state: handshake.state,
        },
      });
      return this.persistSession(payload, options.rememberMe ?? false, options.rememberDays);
    } finally {
      handshake.stop();
    }
  }

  /** 微信扫码轮询（5 分钟超时自动过期，由 UI 重新取码） */
  async waitWechatScan(
    state: string,
    options: {
      intervalMs?: number;
      timeoutMs?: number;
      clock?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ): Promise<WechatPollResult> {
    return pollWechatQr(
      () =>
        this.request<WechatPollResult>({
          method: 'GET',
          path: `/api/auth/oauth/wechat/state?state=${encodeURIComponent(state)}`,
        }),
      options,
    );
  }

  /* ----------------------------- 绑定与解绑 ----------------------------- */

  async listBindings(token: string): Promise<Binding[]> {
    const payload = await this.request<{ bindings: Binding[] }>({
      method: 'GET',
      path: '/api/auth/bindings',
      headers: { Authorization: `Bearer ${token}` },
    });
    return payload.bindings;
  }

  async bind(provider: AuthProvider, token: string): Promise<Binding[]> {
    const current = await this.listBindings(token);
    const guard = canBind(current, provider);
    if (!guard.allowed) throw new AuthError('already_bound', guard.reason ?? '已绑定', 409);
    const payload = await this.request<{ bindings: Binding[] }>({
      method: 'POST',
      path: '/api/auth/bindings',
      headers: { Authorization: `Bearer ${token}` },
      body: { provider },
    });
    return payload.bindings;
  }

  /** 解绑：仅剩单一登录方式且未设密码时拒绝（FR-ACC-06） */
  async unbind(provider: AuthProvider, token: string, hasPassword: boolean): Promise<Binding[]> {
    const current = await this.listBindings(token);
    const guard = canUnbind({ bindings: current, target: provider, hasPassword });
    if (!guard.allowed) {
      throw new AuthError('must_set_password', guard.reason ?? '无法解绑', 400);
    }
    const payload = await this.request<{ bindings: Binding[] }>({
      method: 'DELETE',
      path: `/api/auth/bindings?provider=${encodeURIComponent(provider)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    return payload.bindings;
  }

  /* ----------------------------- 邮箱验证与找回密码 ----------------------------- */

  /** 发送验证邮件（服务端可配置为不强制验证即可使用） */
  async requestEmailVerification(email: string): Promise<void> {
    await this.request<{ ok: boolean }>({
      method: 'POST',
      path: '/api/auth/email/verify',
      body: { email },
    });
  }

  /** 验证码重置密码 */
  async resetPassword(input: { email: string; code: string; newPassword: string }): Promise<void> {
    const check = checkPassword(input.newPassword);
    if (!check.valid) throw new AuthError('weak_password', check.issues.join('；'), 400);
    await this.request<{ ok: boolean }>({
      method: 'POST',
      path: '/api/auth/password/reset',
      body: { email: input.email, code: input.code, newPassword: input.newPassword },
    });
  }

  /** 使用 Access Token 调用需要授权的接口（自动续期） */
  async withToken<T>(operation: (token: string) => Promise<T>): Promise<T> {
    const session = await this.session.load();
    if (!session) throw new AuthError('unauthenticated', '尚未登录', 401);
    const fresh = await this.session.ensureFresh(session);
    return operation(fresh.tokens.accessToken);
  }
}

export { WECHAT_PROVIDER, GOOGLE_PROVIDER, GITHUB_PROVIDER };
