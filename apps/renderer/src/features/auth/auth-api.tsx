/**
 * 账号特性端口（T9-05）。
 *
 * 冻结契约：外壳把 `@ec/account` 的 `AuthClient`（含 DPAPI 会话、回环监听、系统浏览器）
 * 注入到 `globalThis.__EC_AUTH__`；渲染层不直接持有 token，也不 import shell-api 实现。
 */

import { createContext, useContext, type ReactNode } from 'react';

import type { AuthProvider, AuthSession, Binding, OAuthProvider } from '@ec/account';

export interface AuthApi {
  /** 邮箱注册（成功后即登录，E2E-01 无管理员介入） */
  register(input: {
    email: string;
    password: string;
    confirm: string;
    rememberMe: boolean;
    rememberDays?: number;
  }): Promise<AuthSession>;
  /** 邮箱登录 */
  login(input: {
    email: string;
    password: string;
    rememberMe: boolean;
    rememberDays?: number;
  }): Promise<AuthSession>;
  logout(): Promise<void>;
  /** 启动恢复本地会话（离线时保留本地身份） */
  restore(): Promise<AuthSession | null>;

  /** 发起第三方授权（PKCE，返回授权链接与 state） */
  beginOAuth(provider: OAuthProvider): Promise<{ authorizeUrl: string; state: string }>;
  /** 完成第三方授权（回调 URL 由外壳捕获） */
  completeOAuth(
    provider: OAuthProvider,
    callbackUrl: string,
    rememberMe: boolean,
  ): Promise<AuthSession>;
  /** 微信扫码轮询状态（5 分钟超时过期） */
  pollWechatScan(state: string): Promise<{
    state: 'pending' | 'scanned' | 'confirmed' | 'expired' | 'cancelled';
    callbackUrl?: string;
  }>;

  listBindings(): Promise<Binding[]>;
  bind(provider: AuthProvider): Promise<Binding[]>;
  /** 解绑（仅剩单一方式且无密码时由实现拒绝） */
  unbind(provider: AuthProvider, hasPassword: boolean): Promise<Binding[]>;

  requestEmailVerification(email: string): Promise<void>;
  resetPassword(input: { email: string; code: string; newPassword: string }): Promise<void>;

  /** 离线状态（云端不可达：本地功能可用，登录入口置灰） */
  isOffline(): boolean;
  onOfflineChange(listener: (offline: boolean) => void): () => void;
  tryRecover(): Promise<boolean>;
}

const AuthContext = createContext<AuthApi | null>(null);

/** 端口 Provider（命名带 Api 前缀，避免与 @ec/account 的 AuthProvider 概念混淆） */
export function AuthApiProvider({
  api,
  children,
}: {
  api: AuthApi | null;
  children: ReactNode;
}): JSX.Element {
  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuthOptional(): AuthApi | null {
  return useContext(AuthContext);
}

export function useAuth(): AuthApi {
  const api = useContext(AuthContext);
  if (!api) throw new Error('账号端口未注入：请先在外壳中装配 globalThis.__EC_AUTH__');
  return api;
}

/** 装配引导 */
export function AuthUnavailable(): JSX.Element {
  return (
    <div className="ec-auth">
      <p className="ec-auth__hint">
        账号服务尚未连接。可先离线使用本地项目与记忆；接入账号服务后此处可注册、登录与绑定第三方身份。
      </p>
    </div>
  );
}

export function readInjectedAuthApi(): AuthApi | null {
  const injected = (globalThis as { __EC_AUTH__?: AuthApi }).__EC_AUTH__;
  return injected ?? null;
}
