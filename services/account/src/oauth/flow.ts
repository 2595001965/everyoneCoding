/**
 * OAuth 统一流程：消费 state、校验 PKCE、换取令牌、拉取用户档案。
 * authorize 与 callback、bindings 复用同一流程。
 */
import { AppError, ErrCode } from '../errors.ts';
import { pkceChallenge } from '../jwt.ts';
import type { AppConfig } from '../config.ts';
import {
  getOAuthFetch,
  getStrategy,
  providerConfig,
  type OAuthProfile,
  type OAuthProvider,
} from './index.ts';
import { consumeOAuthState } from './session.ts';

export interface OAuthResolved {
  profile: OAuthProfile;
  redirectUri: string;
}

export async function resolveOAuth(
  config: AppConfig,
  provider: string,
  state: string,
  code: string,
  codeVerifier: string,
): Promise<OAuthResolved> {
  const strategy = getStrategy(provider);
  if (!strategy) {
    throw new AppError(ErrCode.BAD_REQUEST, `不支持的 OAuth 提供方：${provider}`, 400);
  }
  const saved = consumeOAuthState(state);
  if (!saved) {
    throw new AppError(ErrCode.OAUTH_STATE_EXPIRED, 'OAuth state 无效或已过期', 400);
  }
  if (saved.provider !== provider) {
    throw new AppError(ErrCode.OAUTH_FAILED, 'OAuth state 与提供方不匹配', 400);
  }
  if (pkceChallenge(codeVerifier) !== saved.codeChallenge) {
    throw new AppError(ErrCode.OAUTH_PKCE_MISMATCH, 'PKCE 校验失败', 400);
  }
  const cfg = providerConfig(provider as OAuthProvider, config);
  const fetchFn = getOAuthFetch();
  const token = await strategy.exchangeToken(fetchFn, {
    code,
    redirectUri: saved.redirectUri,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    codeVerifier,
  });
  const profile = await strategy.fetchProfile(fetchFn, {
    accessToken: token.accessToken,
    ...(token.openid !== undefined ? { openid: token.openid } : {}),
  });
  return { profile, redirectUri: saved.redirectUri };
}
