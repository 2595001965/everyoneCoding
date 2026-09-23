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

  /** 发起第三方授权（PKCE，返回授权链接与 state；state 由服务端签发） */
  beginOAuth(provider: OAuthProvider): Promise<{ authorizeUrl: string; state: string }>;
  /**
   * 等待授权回调并完成登录（回环命中 / `everyonecoding://oauth` 被拉起都会推到这里）。
   *
   * 这是**浏览器授权类登录的收口方法**：渲染层拿不到回调 URL（那是外壳的事），
   * 只能等域把回调消费掉之后把会话交回来。单次调用只等 `timeoutMs`，
   * 超时抛 `ShellError`(`TIMEOUT`)——调用方据此继续等或提示重试。
   */
  pollOAuthCallback(
    provider: OAuthProvider,
    timeoutMs?: number,
  ): Promise<{ status: 'completed'; session: AuthSession }>;
  /**
   * 完成第三方授权（回调 URL 已知时使用）。
   * 微信扫码是这条路径的唯一用户：状态轮询顺带把回调 URL 带回来，无需回环或协议通道。
   */
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
  /**
   * 绑定第三方身份（走完整 OAuth 流程）。
   *
   * 入参刻意收窄为 `OAuthProvider`：`email` 不在此列——邮箱方式是**注册时**建立的，
   * 不存在"给已有账号绑一个邮箱登录"的路径。收窄前端口写的是 `AuthProvider`，
   * 于是实现侧只能靠断言绕过，类型系统反而拦不住真正的错用。
   */
  bind(provider: OAuthProvider): Promise<Binding[]>;
  /** 解绑（仅剩单一方式且无密码时由实现拒绝） */
  unbind(provider: AuthProvider, hasPassword: boolean): Promise<Binding[]>;

  requestEmailVerification(email: string): Promise<void>;
  /** 邮件链接里的 token 确认（本机之外点开链接时由壳外触发，供深链复用） */
  confirmEmailVerification(token: string): Promise<void>;
  /** 查询邮箱验证状态（验证链接在系统浏览器点开，应用侧只能轮询） */
  emailVerified(email: string): Promise<boolean>;
  /** 请求找回密码验证码（6 位邮件码，冷却窗口限流） */
  requestPasswordReset(email: string): Promise<void>;
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
