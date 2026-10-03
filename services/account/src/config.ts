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
  /** 计费 attempt 执行租约；租约到期且未续期时转待对账，默认 30s */
  billingAttemptLeaseMs: number;
  /** 待人工对账 SLA；超期只提示管理员，不自动释放冻结或归零，默认 24h */
  billingReconciliationSlaMs: number;
  /** Root directory for secret:// Provider credentials; keep this directory access-restricted. */
  platformSecretDir: string;
  /** Test-only loopback upstream allowance. Public/private non-loopback addresses stay blocked. */
  gatewayAllowLoopbackUpstreams: boolean;
  /** 邮箱验证链接有效期（秒），默认 24h */
  emailVerifyTtlSec: number;
  /** 重置密码验证码有效期（秒），默认 10 分钟 */
  passwordResetTtlSec: number;
  /** 同一用户同类邮件最小发送间隔（毫秒），默认 60s */
  emailResendCooldownMs: number;
  /** 平台目录管理员账号 ID 的服务端 allowlist；不得由公开注册接口设置 */
  platformAdminAccountIds: string[];
  /** 邮件投递 webhook（可选；空则落 outbox 表） */
  mailWebhookUrl: string | undefined;
  /**
   * 服务对外基础地址（邮件里的链接指向本服务时使用）。
   * 反代/公网部署必须显式设置，否则邮件里会出现 `localhost`。
   */
  publicBaseUrl: string;
  /** 邮箱验证链接基础地址（邮件正文拼接用；默认指向本服务的 `/verify-email` 落地页） */
  emailVerifyBaseUrl: string;
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
  const port = num(process.env.ACCOUNT_PORT, 3000);
  /**
   * 验证链接的默认落地页是**本服务自己的** `/verify-email`（见 `routes/auth.ts`），
   * 不再指向渲染层 dev server：
   * - 用户是在**邮件客户端/浏览器**里点链接的，此时桌面应用很可能根本没开；
   * - 渲染层用 HashRouter，`http://host/verify-email` 这种裸路径根本路由不到。
   */
  const publicBaseUrl = str(process.env.ACCOUNT_PUBLIC_BASE_URL, `http://localhost:${port}`);
  const base: AppConfig = {
    host: str(process.env.ACCOUNT_HOST, '0.0.0.0'),
    port,
    dbPath: str(process.env.ACCOUNT_DB_PATH, 'data/account.db'),
    jwtSecret: str(process.env.ACCOUNT_JWT_SECRET, 'dev-only-insecure-secret-change-me'),
    accessTokenTtlSec: num(process.env.ACCOUNT_ACCESS_TTL, 15 * 60),
    refreshTokenTtlSec: num(process.env.ACCOUNT_REFRESH_TTL, 30 * 24 * 60 * 60),
    loginRateLimitPerMin: num(process.env.ACCOUNT_LOGIN_LIMIT, 20),
    registerRateLimitPerMin: num(process.env.ACCOUNT_REGISTER_LIMIT, 20),
    oauthStateTtlSec: num(process.env.ACCOUNT_OAUTH_STATE_TTL, 10 * 60),
    idempotencyTtlSec: num(process.env.ACCOUNT_IDEMPOTENCY_TTL, 24 * 60 * 60),
    billingAttemptLeaseMs: num(process.env.ACCOUNT_BILLING_ATTEMPT_LEASE_MS, 30 * 1000),
    billingReconciliationSlaMs: num(
      process.env.ACCOUNT_BILLING_RECONCILIATION_SLA_MS,
      24 * 60 * 60 * 1000,
    ),
    platformSecretDir: str(process.env.ACCOUNT_PLATFORM_SECRET_DIR, 'data/platform-secrets'),
    gatewayAllowLoopbackUpstreams: process.env.ACCOUNT_GATEWAY_ALLOW_LOOPBACK === 'true',
    emailVerifyTtlSec: num(process.env.ACCOUNT_EMAIL_VERIFY_TTL, 24 * 60 * 60),
    passwordResetTtlSec: num(process.env.ACCOUNT_PASSWORD_RESET_TTL, 10 * 60),
    emailResendCooldownMs: num(process.env.ACCOUNT_EMAIL_RESEND_COOLDOWN_MS, 60 * 1000),
    platformAdminAccountIds: str(process.env.ACCOUNT_PLATFORM_ADMIN_IDS, '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    mailWebhookUrl: str(process.env.ACCOUNT_MAIL_WEBHOOK_URL, '') || undefined,
    publicBaseUrl,
    emailVerifyBaseUrl: str(process.env.ACCOUNT_EMAIL_VERIFY_BASE_URL, publicBaseUrl),
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
