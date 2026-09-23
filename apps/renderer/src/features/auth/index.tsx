/**
 * 账号中心页面（T9-05）：未登录 → 登录/注册；已登录 → 身份与绑定管理。
 */

import { useEffect, useState } from 'react';
import { Button } from '@ec/ui';
import type { AuthSession } from '@ec/account';

import { AuthApiProvider, AuthUnavailable, useAuthOptional, type AuthApi } from './auth-api';
import { BindingPanel } from './BindingPanel';
import { EmailVerificationPanel } from './EmailVerificationPanel';
import { LoginPage } from './LoginPage';
import { OfflineBanner } from './OfflineBanner';

import './auth.css';

export interface AuthPageProps {
  api: AuthApi | null;
}

function AuthWorkspace(): JSX.Element {
  const api = useAuthOptional();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api
      .restore()
      .then((restored) => {
        if (!cancelled) setSession(restored);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (restoring) return <p className="ec-auth__hint">正在恢复登录状态…</p>;

  if (!session) return <LoginPage onAuthenticated={setSession} />;

  return (
    <div className="ec-auth">
      <OfflineBanner />
      <header className="ec-auth__head">
        <h1>账号中心</h1>
        <Button
          variant="ghost"
          onClick={() => {
            void api?.logout().then(() => setSession(null));
          }}
        >
          退出登录
        </Button>
      </header>
      <EmailVerificationPanel identity={session.identity} />
      <BindingPanel identity={session.identity} />
    </div>
  );
}

export function AuthPage({ api }: AuthPageProps): JSX.Element {
  if (!api) return <AuthUnavailable />;
  return (
    <AuthApiProvider api={api}>
      <AuthWorkspace />
    </AuthApiProvider>
  );
}

export { LoginPage } from './LoginPage';
export { RegisterForm } from './RegisterForm';
export { ForgotPasswordForm } from './ForgotPasswordForm';
export { EmailVerificationPanel } from './EmailVerificationPanel';
export { WechatQR } from './WechatQR';
export { BindingPanel } from './BindingPanel';
export { OfflineBanner } from './OfflineBanner';
export {
  AuthApiProvider,
  AuthUnavailable,
  useAuth,
  useAuthOptional,
  readInjectedAuthApi,
} from './auth-api';
export type { AuthApi } from './auth-api';
