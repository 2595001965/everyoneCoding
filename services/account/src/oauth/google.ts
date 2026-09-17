/**
 * Google OAuth2（OpenID Connect）策略。
 */
import { AppError, ErrCode } from '../errors.ts';
import type { OAuthStrategy } from './index.ts';
import { assertOk, parseJson } from './index.ts';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function buildUrl(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export const googleStrategy: OAuthStrategy = {
  provider: 'google',
  buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, scope }) {
    return buildUrl(AUTHORIZE_URL, {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scope ?? 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  },
  async exchangeToken(fetchFn, { code, redirectUri, clientId, clientSecret, codeVerifier }) {
    const res = await fetchFn({
      url: TOKEN_URL,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
    const data = parseJson<{ access_token: string; id_token?: string }>(res.body);
    if (!data.access_token) {
      throw new AppError(ErrCode.OAUTH_FAILED, 'Google 未返回访问令牌', 502);
    }
    const result: { accessToken: string; idToken?: string } = { accessToken: data.access_token };
    if (data.id_token !== undefined) result.idToken = data.id_token;
    return result;
  },
  async fetchProfile(fetchFn, { accessToken }) {
    const res = await fetchFn({
      url: USERINFO_URL,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assertOk(res, '获取用户信息');
    const data = parseJson<{ sub: string; email?: string; name?: string }>(res.body);
    if (!data.sub) {
      throw new AppError(ErrCode.OAUTH_FAILED, 'Google 未返回用户标识', 502);
    }
    return { providerUserId: data.sub, email: data.email ?? null, name: data.name ?? null };
  },
};
