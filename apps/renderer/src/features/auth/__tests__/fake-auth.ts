/**
 * 账号特性测试夹具：**真实 AuthClient + 内存端口**。
 *
 * 网络经内存 transport（返回可控响应），令牌经内存 secure store，
 * 系统能力经内存 system（记录打开的外部链接）；因此组件测试能断言
 * "真的走了注册端点 / 真的把授权链接交给了系统浏览器 / 真的没发解绑请求"。
 */

import {
  AuthClient,
  OfflineController,
  type AccountIdentity,
  type Binding,
  type SecureStorePort,
  type SystemPort,
  type TokenPair,
  type TransportPort,
} from '@ec/account';

import type { AuthApi } from '../auth-api';

const NOW = 1_700_000_000_000;

/**
 * 复刻服务端 `services/account/src/oauth/*` 的授权 URL 形状。
 *
 * 之所以要"复刻"而不是返回一个占位 URL：桌面侧的职责正是**把服务端给的地址原样交给
 * 系统浏览器**，返一个 `accounts.example.com` 之类的假域名会让这条断言彻底失去意义。
 */
function authorizeUrlOf(
  provider: string,
  state: string,
  codeChallenge: string,
  redirectUri: string,
): string {
  if (provider === 'github') {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', 'client-id-1');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }
  if (provider === 'wechat') {
    const url = new URL('https://open.weixin.qq.com/connect/oauth2/authorize');
    url.searchParams.set('appid', 'client-id-1');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'snsapi_userinfo');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.hash = 'wechat_redirect';
    return url.toString();
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', 'client-id-1');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** 内存安全存储（DPAPI 替身） */
export class MemorySecureStore implements SecureStorePort {
  readonly map = new Map<string, string>();
  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
  dump(): string {
    return [...this.map.values()].join('\n');
  }
}

/** 内存传输：默认返回"注册/登录成功"载荷 */
export class MemoryTransport implements TransportPort {
  readonly calls: Array<{ method: string; url: string; body?: unknown }> = [];
  bindings: Binding[] = [];
  identity: AccountIdentity = {
    accountId: 'acc-1',
    login: 'dev@example.com',
    displayName: '小吴',
    avatarUrl: null,
    emailVerified: false,
    hasPassword: true,
  };
  /** 设为 true 后所有请求抛网络错误（模拟云端不可达） */
  failNetwork = false;
  /** 微信扫码轮询计数（前 N 次 pending） */
  wechatPendingTimes = 1;
  /**
   * 服务端侧的邮箱验证状态。
   *
   * **与会话里的 `identity.emailVerified` 分开**：验证链接在外部浏览器里点开，
   * 会话快照可能仍是旧值 —— 这正是 `EmailVerificationPanel` 必须主动查询的原因，
   * 夹具不共用同一个字段才能测出这个区别。
   */
  serverEmailVerified = false;
  /** 记录已发出的重置码请求（断言"真的请求了服务端"而不是只改本地状态） */
  readonly resetRequests: string[] = [];

  private tokens(): TokenPair {
    return {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 900_000,
      refreshExpiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
    };
  }

  async request(input: {
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; json: unknown }> {
    this.calls.push({
      method: input.method,
      url: input.url,
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    if (this.failNetwork) throw new TypeError('Failed to fetch');

    if (input.url.includes('/authorize')) {
      /**
       * state 由服务端签发（客户端不自造 state），授权 URL 也由服务端拼好返回。
       * 这里按 provider 复刻服务端 `services/account/src/oauth/*` 的 URL 形状
       * （端点域名、scope、`code_challenge_method=S256`、微信的 `#wechat_redirect`），
       * 好让"真的把正确的第三方地址交给了系统浏览器"可被断言。
       */
      const provider = /\/oauth\/([^/]+)\/authorize/.exec(input.url)?.[1] ?? 'google';
      const state = 'srv-state-test';
      const challenge = new URL(input.url).searchParams.get('code_challenge') ?? '';
      const redirectUri = new URL(input.url).searchParams.get('redirect_uri') ?? '';
      return {
        status: 200,
        json: { authorizeUrl: authorizeUrlOf(provider, state, challenge, redirectUri), state },
      };
    }
    if (input.url.includes('/wechat/state')) {
      if (this.wechatPendingTimes > 0) {
        this.wechatPendingTimes -= 1;
        return { status: 200, json: { state: 'pending' } };
      }
      return { status: 200, json: { state: 'confirmed' } };
    }
    if (input.url.includes('/bindings')) {
      // 绑定走真实 OAuth 换身份，此处只需把"服务端侧绑定清单"更新成含新绑定
      if (input.method === 'POST') {
        const provider = (input.body as { provider?: Binding['provider'] } | undefined)?.provider;
        if (provider !== undefined && !this.bindings.some((item) => item.provider === provider)) {
          this.bindings = [
            ...this.bindings,
            { id: `b-${provider}`, provider, externalId: `${provider}-user`, boundAt: 2 },
          ];
        }
      }
      return { status: 200, json: { bindings: this.bindings } };
    }
    // ⚠️ 顺序 matters：`/email/status` 不含 `/email/verify`，但 `/email/verify/confirm` 含之，
    // 故具体路由必须排在通用前缀路由之前
    if (input.url.includes('/email/status')) {
      return { status: 200, json: { emailVerified: this.serverEmailVerified } };
    }
    if (input.url.includes('/password/reset/request')) {
      const body = input.body as { email?: string } | undefined;
      if (typeof body?.email === 'string') this.resetRequests.push(body.email);
      return { status: 200, json: { ok: true } };
    }
    if (input.url.includes('/email/verify') || input.url.includes('/password/reset')) {
      return { status: 200, json: { ok: true } };
    }
    return { status: 200, json: { identity: this.identity, tokens: this.tokens() } };
  }
}

/** 内存系统能力 */
export class MemorySystem implements SystemPort {
  readonly opened: string[] = [];
  readonly clipboard: string[] = [];
  stopped = 0;
  loopbackAvailable = true;
  protocolAvailable = true;
  /**
   * 最近一次回环监听注册的处理器。
   *
   * 测试用它**模拟浏览器命中回环**：`AuthClient` 的 `bind` / `oauthSignIn` 会阻塞等待回调，
   * 没有这条通道就只能干等 5 分钟超时 —— 而"授权完成后真的能接上"恰恰是必须覆盖的路径。
   */
  handler: ((callbackUrl: string) => void) | null = null;

  openExternal(url: string): Promise<void> {
    this.opened.push(url);
    return Promise.resolve();
  }
  startLoopback(
    handler: (callbackUrl: string) => void,
  ): Promise<{ redirectUri: string; stop: () => void }> {
    if (!this.loopbackAvailable) return Promise.reject(new Error('回环不可用'));
    this.handler = handler;
    return Promise.resolve({
      redirectUri: 'http://127.0.0.1:49152/oauth/callback',
      stop: () => {
        this.stopped += 1;
      },
    });
  }
  registerProtocol(handler: (callbackUrl: string) => void): Promise<boolean> {
    if (!this.protocolAvailable) return Promise.resolve(false);
    this.handler = handler;
    return Promise.resolve(true);
  }
  writeClipboard(text: string): Promise<void> {
    this.clipboard.push(text);
    return Promise.resolve();
  }
}

export interface FakeAuthEnvironment {
  api: AuthApi;
  client: AuthClient;
  transport: MemoryTransport;
  system: MemorySystem;
  secure: MemorySecureStore;
  offline: OfflineController;
  /** 记录扫码确认回调 */
  confirmedStates: string[];
}

export function createFakeAuthApi(): FakeAuthEnvironment {
  const transport = new MemoryTransport();
  const system = new MemorySystem();
  const secure = new MemorySecureStore();
  const offline = new OfflineController(() => Promise.resolve(!transport.failNetwork));
  const client = new AuthClient({
    transport,
    system,
    secure,
    baseUrl: 'https://account.example.com',
    offline,
    clock: () => NOW,
  });
  const confirmedStates: string[] = [];
  void confirmedStates;

  /**
   * 进行中的 OAuth 握手（按 state 暂存）。
   *
   * 忠实模拟外壳行为：`beginOAuth` 起回环监听 → 回调到达后由 `pollOAuthCallback`
   * 一次性消费 state 并换令牌。测试通过 `env.system.handler(...)` 模拟"浏览器命中回环"。
   */
  const handshakes = new Map<string, Awaited<ReturnType<AuthClient['beginOAuth']>>>();

  const api: AuthApi = {
    register: (input) => client.register(input),
    login: (input) => client.login(input),
    logout: () => client.logout(),
    restore: () => client.restore(),
    beginOAuth: async (provider) => {
      const handshake = await client.beginOAuth(provider);
      handshakes.set(handshake.state, handshake);
      return { authorizeUrl: handshake.authorizeUrl, state: handshake.state };
    },
    pollOAuthCallback: async (provider, timeoutMs = 2000) => {
      const handshake = [...handshakes.values()].find((item) => item.provider === provider);
      if (!handshake) throw new Error(`没有待完成的 ${provider} 授权：请先调用 beginOAuth`);
      // 与真实域一致：窗口内没等到回调就抛 TIMEOUT（渲染层据此继续等而不是报错）
      const callbackUrl = await client.waitForCallback(handshake.state, timeoutMs);
      handshakes.delete(handshake.state);
      const session = await client.completeOAuth(handshake, callbackUrl, { rememberMe: false });
      return { status: 'completed' as const, session };
    },
    completeOAuth: async (provider, callbackUrl, rememberMe) => {
      const existing = [...handshakes.values()].find((item) => item.provider === provider);
      if (existing) handshakes.delete(existing.state);
      // 微信路径没有经过 beginOAuth 暂存，握手由回调 URL 里的 state 复原
      const handshake = existing ?? {
        provider,
        state: new URL(callbackUrl).searchParams.get('state') ?? 'srv-state-test',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:49152/oauth/callback',
        authorizeUrl: system.opened[system.opened.length - 1] ?? '',
        channel: 'loopback' as const,
        stop: () => undefined,
      };
      return client.completeOAuth(handshake, callbackUrl, { rememberMe });
    },
    pollWechatScan: async (state) => {
      const result = await client.waitWechatScan(state, {
        intervalMs: 0,
        timeoutMs: 10_000,
        clock: () => NOW,
        sleep: () => Promise.resolve(),
      });
      return result.state === 'confirmed'
        ? { state: 'confirmed', callbackUrl: `everyonecoding://oauth?state=${state}&code=wx-code` }
        : { state: result.state };
    },
    listBindings: () => client.withToken((token) => client.listBindings(token)),
    bind: (provider) => client.withToken((token) => client.bind(provider, token)),
    unbind: (provider, hasPassword) =>
      client.withToken((token) => client.unbind(provider, token, hasPassword)),
    requestEmailVerification: (email) => client.requestEmailVerification(email),
    confirmEmailVerification: (token) => client.confirmEmailVerification(token),
    emailVerified: (email) => client.emailVerified(email),
    requestPasswordReset: (email) => client.requestPasswordReset(email),
    resetPassword: (input) => client.resetPassword(input),
    isOffline: () => offline.isOffline(),
    onOfflineChange: (listener) => offline.onChange(listener),
    tryRecover: () => offline.tryRecover(),
  };

  return { api, client, transport, system, secure, offline, confirmedStates };
}
