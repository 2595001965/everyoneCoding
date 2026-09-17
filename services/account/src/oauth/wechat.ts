/**
 * 微信 OAuth2 策略（公众号/开放平台网页授权）。
 * 注意：授权 URL 末尾需带 #wechat_redirect 片段。
 */
import { AppError, ErrCode } from '../errors.ts';
import type { OAuthStrategy } from './index.ts';
import { assertOk, parseJson } from './index.ts';

const AUTHORIZE_URL = 'https://open.weixin.qq.com/connect/oauth2/authorize';
const TOKEN_URL = 'https://api.weixin.qq.com/sns/oauth2/access_token';
const USERINFO_URL = 'https://api.weixin.qq.com/sns/userinfo';

function buildAuthorizeUrl(params: Record<string, string>): string {
  const u = new URL(AUTHORIZE_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.hash = 'wechat_redirect';
  return u.toString();
}

export const wechatStrategy: OAuthStrategy = {
  provider: 'wechat',
  buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, scope }) {
    return buildAuthorizeUrl({
      appid: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scope ?? 'snsapi_userinfo',
      state,
      // 微信不直接支持 PKCE，但仍透传 code_challenge 以便客户端保持流程一致
      code_challenge: codeChallenge,
    });
  },
  async exchangeToken(fetchFn, { code, clientId, clientSecret }) {
    const url = new URL(TOKEN_URL);
    url.searchParams.set('appid', clientId);
    url.searchParams.set('secret', clientSecret);
    url.searchParams.set('code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    const res = await fetchFn({ url: url.toString(), method: 'GET' });
    assertOk(res, '换取令牌');
    const data = parseJson<{ access_token: string; openid: string; unionid?: string }>(res.body);
    if (!data.access_token || !data.openid) {
      throw new AppError(ErrCode.OAUTH_FAILED, '微信未返回访问令牌或 openid', 502);
    }
    return { accessToken: data.access_token, openid: data.openid };
  },
  async fetchProfile(fetchFn, { accessToken, openid }) {
    if (openid === undefined) {
      throw new AppError(ErrCode.OAUTH_FAILED, '微信缺少 openid', 502);
    }
    const url = new URL(USERINFO_URL);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('openid', openid);
    const res = await fetchFn({ url: url.toString(), method: 'GET' });
    assertOk(res, '获取用户信息');
    const data = parseJson<{ openid: string; unionid?: string; nickname?: string }>(res.body);
    const providerUserId = data.unionid ?? data.openid;
    return { providerUserId, email: null, name: data.nickname ?? null };
  },
};
