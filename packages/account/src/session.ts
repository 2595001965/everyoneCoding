/**
 * 会话与令牌管理（T9-05 / FR-ACC-07）。
 *
 * 职责：
 * - Token 存 DPAPI 加密区（经 `SecureStorePort`），明文永不落日志
 * - Access Token 短时效 + 到期前自动刷新（Refresh Token 轮换）
 * - **并发刷新去重**：同一时刻多个请求触发刷新时只发一次网络请求
 * - 退出登录清除本地缓存；"记住我" 上限 30 天
 */

import {
  REMEMBER_ME_MAX_DAYS,
  type AuthSession,
  type SecureStorePort,
  type TokenPair,
} from './auth-types';

/** 密钥环中的会话键名 */
export const SESSION_KEY = 'account/session';

/** 提前刷新窗口：Access Token 剩余不足该时长即视为需要刷新 */
const REFRESH_SKEW_MS = 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionManagerDeps {
  secure: SecureStorePort;
  /** 刷新实现（由 AuthClient 注入，避免循环依赖） */
  refreshTokens: (refreshToken: string) => Promise<TokenPair>;
  clock?: (() => number) | undefined;
}

export class SessionManager {
  private readonly secure: SecureStorePort;
  private readonly refreshTokens: (refreshToken: string) => Promise<TokenPair>;
  private readonly clock: () => number;
  /** 进行中的刷新（并发去重） */
  private pending: Promise<AuthSession> | null = null;

  constructor(deps: SessionManagerDeps) {
    this.secure = deps.secure;
    this.refreshTokens = deps.refreshTokens;
    this.clock = deps.clock ?? Date.now;
  }

  /** 读取本地会话；已过期（记住我到期或 refresh 过期）则清除并返回 null */
  async load(): Promise<AuthSession | null> {
    const raw = await this.secure.get(SESSION_KEY);
    if (!raw) return null;
    let session: AuthSession;
    try {
      session = JSON.parse(raw) as AuthSession;
    } catch {
      await this.clear();
      return null;
    }
    const now = this.clock();
    const rememberExpired = session.rememberUntil !== null && session.rememberUntil <= now;
    const refreshExpired = session.tokens.refreshExpiresAt <= now;
    if (rememberExpired || refreshExpired) {
      await this.clear();
      return null;
    }
    return session;
  }

  async save(session: AuthSession): Promise<void> {
    await this.secure.set(SESSION_KEY, JSON.stringify(session));
  }

  /** 退出登录：清除本地缓存（含令牌） */
  async clear(): Promise<void> {
    this.pending = null;
    await this.secure.delete(SESSION_KEY);
  }

  /** Access Token 是否即将/已经过期 */
  isAccessExpired(session: AuthSession): boolean {
    return session.tokens.expiresAt - REFRESH_SKEW_MS <= this.clock();
  }

  /**
   * 保证会话可用：即将过期时刷新（并发去重）。
   * Refresh Token 也过期时抛错，由调用方引导重新登录。
   */
  async ensureFresh(session: AuthSession): Promise<AuthSession> {
    if (!this.isAccessExpired(session)) return session;
    if (this.pending) return this.pending;

    this.pending = (async () => {
      try {
        const tokens = await this.refreshTokens(session.tokens.refreshToken);
        const next: AuthSession = { ...session, tokens };
        await this.save(next);
        return next;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** 构造会话：rememberMe 决定 rememberUntil（默认 7 天，上限 30 天） */
  buildSession(input: {
    identity: AuthSession['identity'];
    tokens: TokenPair;
    rememberMe?: boolean;
    rememberDays?: number;
  }): AuthSession {
    const days = Math.min(input.rememberDays ?? REMEMBER_ME_MAX_DAYS, REMEMBER_ME_MAX_DAYS);
    return {
      identity: input.identity,
      tokens: input.tokens,
      rememberUntil: input.rememberMe ? this.clock() + days * DAY_MS : null,
    };
  }
}

/** 记住我天数换算（供 UI 展示"将记住 N 天"） */
export function rememberDaysFrom(days: number | undefined): number {
  return Math.min(days ?? 7, REMEMBER_ME_MAX_DAYS);
}
