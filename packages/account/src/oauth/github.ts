/**
 * GitHub OAuth（T9-05 / FR-ACC-04）。
 *
 * scope 固定为 `read:user user:email`：读取公开资料与**主邮箱**（GitHub 邮箱默认私有，
 * 不带 user:email 拿不到用于建号的邮箱）。
 */

import type { OAuthProvider } from '../auth-types';

export const GITHUB_PROVIDER: OAuthProvider = 'github';

export const GITHUB_AUTHORIZE_ENDPOINT = 'https://github.com/login/oauth/authorize';

/** GitHub 授权 scope（E2E-02 要求：授权后展示已绑定信息） */
export const GITHUB_SCOPE = 'read:user user:email';

export interface GitHubAuthorizeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

/** 构造 GitHub 授权 URL（GitHub 支持 PKCE S256，但**要求**带 code_challenge_method） */
export function buildGithubAuthorizeUrl(input: GitHubAuthorizeInput): string {
  const url = new URL(GITHUB_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPE);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

export function parseGithubCallback(callbackUrl: string, expectedState: string): { code: string } {
  const url = new URL(callbackUrl);
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description') ?? '';
    throw new Error(`GitHub 授权被拒绝：${error}${description ? `（${description}）` : ''}`);
  }
  const state = url.searchParams.get('state');
  if (!state || state !== expectedState) throw new Error('GitHub 回调 state 校验失败（可能是 CSRF）');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('GitHub 回调缺少授权码');
  return { code };
}
