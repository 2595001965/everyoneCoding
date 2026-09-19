/**
 * Google OAuth 2.0（T9-05 / FR-ACC-03）。
 *
 * 客户端只负责构造授权 URL 与解析回调；**换取令牌由服务端完成**
 * （客户端 secret 不下发，符合桌面端安全实践）。
 */

import type { OAuthProvider } from '../auth-types';

export const GOOGLE_PROVIDER: OAuthProvider = 'google';

/** Google 授权端点 */
export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Google 要求的 scope：openid + email + profile 即可拿到邮箱与昵称 */
export const GOOGLE_SCOPE = 'openid email profile';

export interface AuthorizeUrlInput {
  /** 由服务端下发的 client_id（Google 侧） */
  clientId: string;
  /** 本地回环或自定义协议回调地址 */
  redirectUri: string;
  /** PKCE code_challenge（S256） */
  codeChallenge: string;
  /** 防 CSRF state */
  state: string;
}

/** 构造 Google 授权 URL（access_type=offline 以拿到 refresh_token） */
export function buildGoogleAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPE);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/** 解析 Google 回调（成功返回 code，失败抛出可读原因） */
export function parseGoogleCallback(callbackUrl: string, expectedState: string): { code: string } {
  const url = new URL(callbackUrl);
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Google 授权被拒绝：${error}`);
  const state = url.searchParams.get('state');
  if (!state || state !== expectedState)
    throw new Error('Google 回调 state 校验失败（可能是 CSRF）');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Google 回调缺少授权码');
  return { code };
}
