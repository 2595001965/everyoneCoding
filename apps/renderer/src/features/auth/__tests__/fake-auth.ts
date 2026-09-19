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

    if (input.url.includes('/authorize')) return { status: 200, json: { clientId: 'client-id-1' } };
    if (input.url.includes('/wechat/state')) {
      if (this.wechatPendingTimes > 0) {
        this.wechatPendingTimes -= 1;
        return { status: 200, json: { state: 'pending' } };
      }
      return { status: 200, json: { state: 'confirmed' } };
    }
    if (input.url.includes('/bindings')) return { status: 200, json: { bindings: this.bindings } };
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

  openExternal(url: string): Promise<void> {
    this.opened.push(url);
    return Promise.resolve();
  }
  startLoopback(): Promise<{ redirectUri: string; stop: () => void }> {
    if (!this.loopbackAvailable) return Promise.reject(new Error('回环不可用'));
    return Promise.resolve({
      redirectUri: 'http://127.0.0.1:49152/oauth/callback',
      stop: () => {
        this.stopped += 1;
      },
    });
  }
  registerProtocol(): Promise<boolean> {
    return Promise.resolve(this.protocolAvailable);
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

  const api: AuthApi = {
    register: (input) => client.register(input),
    login: (input) => client.login(input),
    logout: () => client.logout(),
    restore: () => client.restore(),
    beginOAuth: async (provider) => {
      const handshake = await client.beginOAuth(provider);
      return { authorizeUrl: handshake.authorizeUrl, state: handshake.state };
    },
    completeOAuth: async (provider, callbackUrl, rememberMe) => {
      // 组件测试不重放完整回调；此处用 state 从授权链接回推（真实装配由外壳捕获回调）
      const authorizeUrl = system.opened[system.opened.length - 1] ?? '';
      const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
      const handshake = {
        provider,
        state,
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:49152/oauth/callback',
        authorizeUrl,
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
    resetPassword: (input) => client.resetPassword(input),
    isOffline: () => offline.isOffline(),
    onOfflineChange: (listener) => offline.onChange(listener),
    tryRecover: () => offline.tryRecover(),
  };

  return { api, client, transport, system, secure, offline, confirmedStates };
}
