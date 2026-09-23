/**
 * LoginPage（T9-05 / FR-ACC-01 ~ 04）：邮箱登录 / 注册与四种登录入口。
 *
 * 离线时（云端不可达）：登录相关入口**置灰**并提示"当前离线，本地功能可用"（E2E 保障）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Input, Tabs } from '@ec/ui';
import {
  AUTH_PROVIDER_LABELS,
  OfflineError,
  type AuthSession,
  type OAuthProvider,
} from '@ec/account';

import { OfflineBanner } from './OfflineBanner';
import { ForgotPasswordForm } from './ForgotPasswordForm';
import { RegisterForm } from './RegisterForm';
import { WechatQR } from './WechatQR';
import { useAuth } from './auth-api';

export interface LoginPageProps {
  onAuthenticated: (session: AuthSession) => void;
}

export function LoginPage({ onAuthenticated }: LoginPageProps): JSX.Element {
  const api = useAuth();
  const [tab, setTab] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState<boolean>(() => api.isOffline());
  const [qrOpen, setQrOpen] = useState(false);
  /** 重置成功后的提示：必须回登录页用新密码登录（服务端已撤销旧刷新令牌） */
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  useEffect(() => {
    setOffline(api.isOffline());
    return api.onOfflineChange(setOffline);
  }, [api]);

  const login = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.login({ email: email.trim(), password, rememberMe });
      onAuthenticated(session);
    } catch (cause: unknown) {
      // 离线错误由离线横幅统一提示，避免同屏重复两遍
      if (!(cause instanceof OfflineError)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }, [api, email, onAuthenticated, password, rememberMe]);

  /** 第三方登录：发起授权 → 拿授权链接（外壳负责回调捕获与 completeOAuth） */
  const startOAuth = useCallback(
    async (provider: OAuthProvider) => {
      setError(null);
      try {
        await api.beginOAuth(provider);
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api],
  );

  return (
    <div className="ec-auth">
      <OfflineBanner />
      <div className="ec-auth__card">
        <Tabs
          items={[
            { key: 'login', label: '登录' },
            { key: 'register', label: '注册' },
            { key: 'forgot', label: '找回密码' },
          ]}
          value={tab}
          onChange={setTab}
          // eslint-disable-next-line react/no-children-prop -- Tabs 的 children 是渲染函数
          children={(active) =>
            active === 'login' ? (
              <form
                className="ec-auth__form"
                aria-label="登录"
                onSubmit={(event) => {
                  event.preventDefault();
                  void login();
                }}
              >
                <h2 className="ec-auth__form-title">登录账号</h2>
                <label className="ec-auth__field">
                  <span>邮箱</span>
                  <Input
                    value={email}
                    onChange={setEmail}
                    placeholder="you@example.com"
                    aria-label="登录邮箱"
                    disabled={offline}
                  />
                </label>
                <label className="ec-auth__field">
                  <span>密码</span>
                  <Input
                    value={password}
                    onChange={setPassword}
                    type="password"
                    placeholder="请输入密码"
                    aria-label="登录密码"
                    disabled={offline}
                  />
                </label>
                <Checkbox
                  checked={rememberMe}
                  onChange={setRememberMe}
                  label="记住我（最多 30 天）"
                  disabled={offline}
                />
                {resetNotice ? <p className="ec-auth__notice">{resetNotice}</p> : null}
                {error ? <p className="ec-auth__error">{error}</p> : null}
                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  loading={busy}
                  disabled={offline || !email || !password}
                >
                  登录
                </Button>
                <button
                  type="button"
                  className="ec-auth__switch"
                  disabled={offline}
                  onClick={() => {
                    setError(null);
                    setResetNotice(null);
                    setTab('forgot');
                  }}
                >
                  忘记密码？
                </button>

                <div className="ec-auth__divider">其它登录方式</div>
                <div className="ec-auth__providers">
                  <Button
                    variant="secondary"
                    disabled={offline}
                    onClick={() => setQrOpen((prev) => !prev)}
                  >
                    {AUTH_PROVIDER_LABELS.wechat}扫码
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={offline}
                    onClick={() => void startOAuth('google')}
                  >
                    {AUTH_PROVIDER_LABELS.google} 登录
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={offline}
                    onClick={() => void startOAuth('github')}
                  >
                    {AUTH_PROVIDER_LABELS.github} 登录
                  </Button>
                </div>
                {qrOpen ? <WechatQR onConfirmed={() => undefined} /> : null}
              </form>
            ) : active === 'register' ? (
              <RegisterForm
                onRegistered={onAuthenticated}
                onSwitchToLogin={() => setTab('login')}
              />
            ) : (
              <ForgotPasswordForm
                onReset={(resetEmail) => {
                  // 回填邮箱省一次输入；旧会话已在服务端失效，必须重新登录
                  setEmail(resetEmail);
                  setPassword('');
                  setError(null);
                  setResetNotice('密码已重置，请使用新密码登录。');
                  setTab('login');
                }}
                onSwitchToLogin={() => setTab('login')}
              />
            )
          }
        />
      </div>
    </div>
  );
}
