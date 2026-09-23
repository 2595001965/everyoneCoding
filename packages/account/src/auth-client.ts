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
import { GOOGLE_PROVIDER, parseGoogleCallback } from './oauth/google';
import { GITHUB_PROVIDER, parseGithubCallback } from './oauth/github';
import {
  parseWechatCallback,
  pollWechatQr,
  WECHAT_PROVIDER,
  type WechatPollResult,
} from './oauth/wechat';
import { checkPassword, createPkcePair } from './security';
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
  /** 摄入的回调 URL（按 state 索引；oauthSignIn / 外壳轮询消费） */
  private readonly pendingCallbacks = new Map<string, string>();

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

  /**
   * 发起 OAuth：回环监听为主、自定义协议为辅。
   *
   * 契约：authorize 端点返回 { authorizeUrl, state } —— **state 由服务端签发**
   * （服务端在 authorize 时暂存 PKCE challenge，回调时校验），客户端不再自造 state，
   * 只生成 code_verifier 并把 challenge 递给服务端。
   */
  async beginOAuth(provider: OAuthProvider): Promise<OAuthHandshake> {
    const pkce = await createPkcePair();

    let redirectUri = '';
    let channel: OAuthHandshake['channel'] = 'loopback';
    let stop = (): void => undefined;
    let loopbackHandler: ((callbackUrl: string) => void) | null = null;

    try {
      const loopback = await this.system.startLoopback((callbackUrl) => {
        loopbackHandler?.(callbackUrl);
      });
      redirectUri = loopback.redirectUri;
      stop = loopback.stop;
    } catch {
      const protocolOk = await this.system.registerProtocol((callbackUrl) => {
        loopbackHandler?.(callbackUrl);
      });
      if (!protocolOk) {
        throw new AuthError(
          'oauth_channel_unavailable',
          '本地回环监听与自定义协议均不可用，无法完成第三方登录。',
        );
      }
      redirectUri = 'everyonecoding://oauth';
      channel = 'protocol';
    }

    // 服务端签发 state 并暂存 challenge；返回真正的第三方授权 URL
    const meta = await this.request<{ authorizeUrl: string; state: string }>({
      method: 'GET',
      path: `/api/auth/oauth/${provider}/authorize?code_challenge=${encodeURIComponent(pkce.challenge)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });

    const handshake: OAuthHandshake = {
      provider,
      state: meta.state,
      codeVerifier: pkce.verifier,
      redirectUri,
      authorizeUrl: meta.authorizeUrl,
      channel,
      stop,
    };
    // 回环/协议回调统一进入 ingestCallback：外壳无需区分通道
    loopbackHandler = (callbackUrl) => this.ingestCallback(callbackUrl);
    await this.system.openExternal(meta.authorizeUrl);
    return handshake;
  }

  /**
   * 摄入一条 OAuth 回调 URL（回环命中 / 自定义协议拉起都会到这里）。
   * 只保留**与进行中 state 匹配**的回调；多余或过期回调被静默丢弃。
   */
  ingestCallback(callbackUrl: string): void {
    let state = '';
    try {
      state = new URL(callbackUrl).searchParams.get('state') ?? '';
    } catch {
      return;
    }
    if (state.length > 0) this.pendingCallbacks.set(state, callbackUrl);
  }

  /**
   * 等待回调到达（回环 handler / 协议 handler 已由 beginOAuth 接到 ingestCallback）。
   * 公开口：外壳/域层可代为等待并消费回调（一次性：取走即删除）。
   */
  async waitForCallback(state: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.pendingCallbacks.get(state);
      if (hit !== undefined) {
        this.pendingCallbacks.delete(state);
        return hit;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new AuthError(
      'oauth_callback_timeout',
      '等待授权回调超时：请重试并在浏览器中完成授权。',
      408,
    );
  }

  /** 完成 OAuth：解析回调 → 校验 state → 服务端换令牌 → 保存会话（首次授权自动建号） */
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

  /**
   * 便捷口：发起授权后阻塞等待回调并完成登录。
   * 回环与协议回调都已接入 ingestCallback，这里只是串起"等待 → complete"。
   */
  async oauthSignIn(
    provider: OAuthProvider,
    options: {
      timeoutMs?: number;
      clock?: () => number;
      sleep?: (ms: number) => Promise<void>;
      rememberMe?: boolean;
      rememberDays?: number;
    } = {},
  ): Promise<AuthSession> {
    const handshake = await this.beginOAuth(provider);
    const callbackUrl = await this.waitForCallback(
      handshake.state,
      options.timeoutMs ?? 5 * 60 * 1000,
    );
    return this.completeOAuth(handshake, callbackUrl, {
      rememberMe: options.rememberMe ?? false,
      ...(options.rememberDays !== undefined ? { rememberDays: options.rememberDays } : {}),
    });
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

  /**
   * 绑定第三方身份：走完整 OAuth 流程（服务端需要真实换身份）。
   * 返回绑定后的完整清单。
   */
  async bind(provider: OAuthProvider, token: string): Promise<Binding[]> {
    const current = await this.listBindings(token);
    const guard = canBind(current, provider);
    if (!guard.allowed) throw new AuthError('already_bound', guard.reason ?? '已绑定', 409);

    // 复用登录侧的 PKCE + 双通道握手，但不自动打开浏览器会话存令牌：
    // 拿到回调后转发到 bindings 端点。
    const pkce = await createPkcePair();
    let redirectUri = '';
    let stop = (): void => undefined;
    let loopbackHandler: ((callbackUrl: string) => void) | null = null;
    try {
      const loopback = await this.system.startLoopback((callbackUrl) => {
        loopbackHandler?.(callbackUrl);
      });
      redirectUri = loopback.redirectUri;
      stop = loopback.stop;
    } catch {
      const protocolOk = await this.system.registerProtocol((callbackUrl) => {
        loopbackHandler?.(callbackUrl);
      });
      if (!protocolOk) {
        throw new AuthError(
          'oauth_channel_unavailable',
          '本地回环监听与自定义协议均不可用，无法完成第三方绑定。',
        );
      }
      redirectUri = 'everyonecoding://oauth';
    }

    const meta = await this.request<{ authorizeUrl: string; state: string }>({
      method: 'GET',
      path: `/api/auth/oauth/${provider}/authorize?code_challenge=${encodeURIComponent(pkce.challenge)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    loopbackHandler = (callbackUrl) => this.ingestCallback(callbackUrl);
    await this.system.openExternal(meta.authorizeUrl);

    try {
      const callbackUrl = await this.waitForCallback(meta.state, 5 * 60 * 1000);
      const { code } =
        provider === GOOGLE_PROVIDER
          ? parseGoogleCallback(callbackUrl, meta.state)
          : provider === GITHUB_PROVIDER
            ? parseGithubCallback(callbackUrl, meta.state)
            : parseWechatCallback(callbackUrl, meta.state);
      const payload = await this.request<{ bindings: Binding[] }>({
        method: 'POST',
        path: '/api/auth/bindings',
        headers: { Authorization: `Bearer ${token}` },
        body: { provider, code, state: meta.state, codeVerifier: pkce.verifier },
      });
      return payload.bindings;
    } finally {
      stop();
    }
  }

  /** 解绑：仅剩单一登录方式且未设密码时拒绝（FR-ACC-06）；按 bindingId 删除 */
  async unbind(provider: AuthProvider, token: string, hasPassword: boolean): Promise<Binding[]> {
    const current = await this.listBindings(token);
    const guard = canUnbind({ bindings: current, target: provider, hasPassword });
    if (!guard.allowed) {
      throw new AuthError('must_set_password', guard.reason ?? '无法解绑', 400);
    }
    const target = current.find((binding) => binding.provider === provider);
    if (!target) throw new AuthError('binding_missing', '该登录方式尚未绑定', 404);
    const payload = await this.request<{ bindings: Binding[] }>({
      method: 'DELETE',
      path: `/api/auth/bindings?bindingId=${encodeURIComponent(target.id)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    return payload.bindings;
  }

  /* ----------------------------- 邮箱验证与找回密码 ----------------------------- */

  /** 发送验证邮件（服务端可配置为不强制验证即可使用；冷却窗口限流） */
  async requestEmailVerification(email: string): Promise<void> {
    await this.request<{ ok: boolean }>({
      method: 'POST',
      path: '/api/auth/email/verify',
      body: { email },
    });
  }

  /** 确认邮箱验证（邮件链接里的 token） */
  async confirmEmailVerification(token: string): Promise<void> {
    await this.request<{ ok: boolean }>({
      method: 'POST',
      path: '/api/auth/email/verify/confirm',
      body: { token },
    });
  }

  /** 查询邮箱验证状态（注册后轮询） */
  async emailVerified(email: string): Promise<boolean> {
    const payload = await this.request<{ emailVerified: boolean }>({
      method: 'GET',
      path: `/api/auth/email/status?email=${encodeURIComponent(email)}`,
    });
    return payload.emailVerified;
  }

  /** 请求重置密码验证码（6 位邮件码，冷却窗口限流） */
  async requestPasswordReset(email: string): Promise<void> {
    await this.request<{ ok: boolean }>({
      method: 'POST',
      path: '/api/auth/password/reset/request',
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
