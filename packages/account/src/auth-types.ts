/**
 * 账号域类型与端口（T9-05 / FR-ACC-01 ~ 08）。
 *
 * 约束：
 * - 服务端**仅**负责账号注册/登录与版本更新（D-02 无云同步 / D-06 无远程配置 / D-09 无分享）。
 * - Token 一律经 `SecureStorePort`（外壳适配 DPAPI）落盘，明文永不进日志。
 * - 网络与系统能力（打开浏览器、注册自定义协议、回环监听）一律经端口注入，
 *   本包不直接依赖 shell-api 的运行时实现，便于单测与渲染层复用。
 */

/** 登录方式 */
export const AUTH_PROVIDERS = ['email', 'wechat', 'google', 'github'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const AUTH_PROVIDER_LABELS: Record<AuthProvider, string> = {
  email: '邮箱',
  wechat: '微信',
  google: 'Google',
  github: 'GitHub',
};

/** 第三方 OAuth 提供方（不含邮箱） */
export type OAuthProvider = Exclude<AuthProvider, 'email'>;

/** 账号身份（服务端返回） */
export interface AccountIdentity {
  accountId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  /** 是否已完成邮箱验证（FR-ACC-08；服务端可配置为不强制） */
  emailVerified: boolean;
  /** 是否已设置密码（解绑前置校验依赖它） */
  hasPassword: boolean;
}

/** 绑定项（FR-ACC-06；与服务端 Binding schema 对齐） */
export interface Binding {
  /** 绑定行 id（解绑参数 bindingId） */
  id: string;
  provider: AuthProvider;
  /** 第三方侧标识（如 GitHub login、微信 openid 脱敏串） */
  externalId: string;
  boundAt: number;
}

/** 令牌对 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access Token 过期时间（毫秒时间戳） */
  expiresAt: number;
  /** Refresh Token 过期时间（毫秒时间戳） */
  refreshExpiresAt: number;
}

/** 记住我：默认 7 天，上限 30 天（FR-ACC-07） */
export const REMEMBER_ME_MAX_DAYS = 30;
export const REMEMBER_ME_DEFAULT_DAYS = 7;

/** 会话（含身份 + 令牌 + 记住我标记） */
export interface AuthSession {
  identity: AccountIdentity;
  tokens: TokenPair;
  /** 记住我到何时（未勾选为 null → 关闭应用即失效） */
  rememberUntil: number | null;
}

/** 网络传输端口（外壳/测试注入；浏览器用 fetch） */
export interface TransportPort {
  request(input: {
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; json: unknown }>;
}

/** 安全存储端口（外壳适配 DPAPI；测试用内存实现） */
export interface SecureStorePort {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/** 系统集成端口：打开浏览器 / 注册自定义协议 / 回环监听 / 剪贴板 */
export interface SystemPort {
  /** 用系统默认浏览器打开 URL */
  openExternal(url: string): Promise<void>;
  /**
   * 启动本地回环监听，返回回调 URL 与停止函数（主通道）。
   * `handler` 收到**真实回调 URL**（浏览器命中监听端口时由外壳转发）。
   * 失败时抛错，调用方回退到自定义协议（辅通道）。
   */
  startLoopback(
    handler: (callbackUrl: string) => void,
  ): Promise<{ redirectUri: string; stop: () => void }>;
  /** 注册自定义协议 everyonecoding://oauth（辅通道）；不支持时返回 false */
  registerProtocol(handler: (url: string) => void): Promise<boolean>;
  /** 系统剪贴板（复制授权链接） */
  writeClipboard(text: string): Promise<void>;
}

/** 账号服务端基址与端点配置 */
export interface AuthEndpoints {
  baseUrl: string;
}

/** 服务端错误（带 code，供 UI 提示） */
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/** 离线（云端不可达）：本地功能可用，登录相关入口置灰（FR-ACC-05 保障） */
export class OfflineError extends AuthError {
  constructor(message = '当前离线，本地功能可用；账号相关操作暂不可用。') {
    super('offline', message, 0);
    this.name = 'OfflineError';
  }
}
