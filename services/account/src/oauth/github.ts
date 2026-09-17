/**
 * GitHub OAuth2 策略。
 */
import { AppError, ErrCode } from '../errors.ts';
import type { OAuthStrategy } from './index.ts';
import { assertOk, parseJson } from './index.ts';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

function buildUrl(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export const githubStrategy: OAuthStrategy = {
  provider: 'github',
  buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, scope }) {
    return buildUrl(AUTHORIZE_URL, {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scope ?? 'read:user user:email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  },
  async exchangeToken(fetchFn, { code, redirectUri, clientId, clientSecret, codeVerifier }) {
    const res = await fetchFn({
      url: TOKEN_URL,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      }).toString(),
    });
    assertOk(res, '换取令牌');
    const data = parseJson<{ access_token: string }>(res.body);
    if (!data.access_token) {
      throw new AppError(ErrCode.OAUTH_FAILED, 'GitHub 未返回访问令牌', 502);
    }
    return { accessToken: data.access_token };
  },
  async fetchProfile(fetchFn, { accessToken }) {
    const res = await fetchFn({
      url: USER_URL,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'everyonecoding-account' },
    });
    assertOk(res, '获取用户信息');
    const data = parseJson<{ id: number; login: string; email?: string; name?: string }>(res.body);
    if (!data.id) {
      throw new AppError(ErrCode.OAUTH_FAILED, 'GitHub 未返回用户标识', 502);
    }
    const name = data.name ?? data.login;
    return { providerUserId: String(data.id), email: data.email ?? null, name };
  },
};
