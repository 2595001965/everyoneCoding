/**
 * 服务端运行配置。
 * 所有项均可通过环境变量覆盖；测试时可传入覆盖对象构造。
 */

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  jwtSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  /** 登录接口每 IP 每分钟允许次数 */
  loginRateLimitPerMin: number;
  /** 注册接口每 IP 每分钟允许次数 */
  registerRateLimitPerMin: number;
  /** OAuth state 有效期（秒） */
  oauthStateTtlSec: number;
  /** 幂等键记录保留时长（秒） */
  idempotencyTtlSec: number;
  oauth: {
    google: OAuthProviderConfig;
    github: OAuthProviderConfig;
    wechat: OAuthProviderConfig;
  };
}

function str(env: string | undefined, fallback: string): string {
  return env === undefined || env === '' ? fallback : env;
}

function num(env: string | undefined, fallback: number): number {
  if (env === undefined || env === '') return fallback;
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    host: str(process.env.ACCOUNT_HOST, '0.0.0.0'),
    port: num(process.env.ACCOUNT_PORT, 3000),
    dbPath: str(process.env.ACCOUNT_DB_PATH, 'data/account.db'),
    jwtSecret: str(process.env.ACCOUNT_JWT_SECRET, 'dev-only-insecure-secret-change-me'),
    accessTokenTtlSec: num(process.env.ACCOUNT_ACCESS_TTL, 15 * 60),
    refreshTokenTtlSec: num(process.env.ACCOUNT_REFRESH_TTL, 30 * 24 * 60 * 60),
    loginRateLimitPerMin: num(process.env.ACCOUNT_LOGIN_LIMIT, 20),
    registerRateLimitPerMin: num(process.env.ACCOUNT_REGISTER_LIMIT, 20),
    oauthStateTtlSec: num(process.env.ACCOUNT_OAUTH_STATE_TTL, 10 * 60),
    idempotencyTtlSec: num(process.env.ACCOUNT_IDEMPOTENCY_TTL, 24 * 60 * 60),
    oauth: {
      google: {
        clientId: str(process.env.ACCOUNT_OAUTH_GOOGLE_ID, ''),
        clientSecret: str(process.env.ACCOUNT_OAUTH_GOOGLE_SECRET, ''),
        redirectUri: str(process.env.ACCOUNT_OAUTH_GOOGLE_REDIRECT, ''),
      },
      github: {
        clientId: str(process.env.ACCOUNT_OAUTH_GITHUB_ID, ''),
        clientSecret: str(process.env.ACCOUNT_OAUTH_GITHUB_SECRET, ''),
        redirectUri: str(process.env.ACCOUNT_OAUTH_GITHUB_REDIRECT, ''),
      },
      wechat: {
        clientId: str(process.env.ACCOUNT_OAUTH_WECHAT_ID, ''),
        clientSecret: str(process.env.ACCOUNT_OAUTH_WECHAT_SECRET, ''),
        redirectUri: str(process.env.ACCOUNT_OAUTH_WECHAT_REDIRECT, ''),
      },
    },
  };
  return { ...base, ...overrides, oauth: { ...base.oauth, ...(overrides.oauth ?? {}) } };
}
