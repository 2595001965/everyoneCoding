/**
 * OAuth 抽象层：provider 策略 + 可注入的 fetch（便于测试 mock 三个 provider 的令牌交换）。
 * 真实环境使用 Node 内置 fetch；测试通过 setOAuthFetch 注入假实现。
 */
import type { AppConfig } from '../config.ts';
import { AppError, ErrCode } from '../errors.ts';
import { googleStrategy } from './google.ts';
import { githubStrategy } from './github.ts';
import { wechatStrategy } from './wechat.ts';

export type OAuthProvider = 'wechat' | 'google' | 'github';

export interface OAuthProfile {
  providerUserId: string;
  email: string | null;
  name: string | null;
}

export interface OAuthFetchRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export interface OAuthFetchResponse {
  status: number;
  body: string;
}

export type OAuthFetch = (req: OAuthFetchRequest) => Promise<OAuthFetchResponse>;

export interface OAuthStrategy {
  provider: OAuthProvider;
  buildAuthorizeUrl(opts: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scope?: string;
  }): string;
  exchangeToken(
    fetchFn: OAuthFetch,
    opts: {
      code: string;
      redirectUri: string;
      clientId: string;
      clientSecret: string;
      codeVerifier: string;
    },
  ): Promise<{ accessToken: string; idToken?: string; openid?: string }>;
  fetchProfile(
    fetchFn: OAuthFetch,
    opts: { accessToken: string; openid?: string },
  ): Promise<OAuthProfile>;
}

/** 默认实现：基于 Node 内置 fetch。 */
async function nodeFetch(req: OAuthFetchRequest): Promise<OAuthFetchResponse> {
  const init: RequestInit = { method: req.method };
  if (req.headers !== undefined) init.headers = req.headers;
  if (req.body !== undefined) init.body = req.body;
  const res = await fetch(req.url, init);
  const text = await res.text();
  return { status: res.status, body: text };
}

let currentFetch: OAuthFetch = nodeFetch;

/** 注入自定义 fetch（测试用）。 */
export function setOAuthFetch(fn: OAuthFetch): void {
  currentFetch = fn;
}

export function getOAuthFetch(): OAuthFetch {
  return currentFetch;
}

export const oauthStrategies: Record<OAuthProvider, OAuthStrategy> = {
  google: googleStrategy,
  github: githubStrategy,
  wechat: wechatStrategy,
};

export function getStrategy(provider: string): OAuthStrategy | null {
  return oauthStrategies[provider as OAuthProvider] ?? null;
}

/** 将 provider 配置从总配置中取出。 */
export function providerConfig(
  provider: OAuthProvider,
  config: AppConfig,
): { clientId: string; clientSecret: string; redirectUri: string } {
  const c = config.oauth[provider];
  return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri };
}

export function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new AppError(ErrCode.OAUTH_FAILED, 'OAuth 响应解析失败', 502);
  }
}

export function assertOk(res: OAuthFetchResponse, ctx: string): void {
  if (res.status < 200 || res.status >= 300) {
    throw new AppError(ErrCode.OAUTH_FAILED, `OAuth ${ctx} 失败（HTTP ${res.status}）`, 502);
  }
}
