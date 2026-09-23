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
import { ShellError } from '@ec/shell-api';

import { OfflineBanner } from './OfflineBanner';
import { ForgotPasswordForm } from './ForgotPasswordForm';
import { RegisterForm } from './RegisterForm';
import { WechatQR } from './WechatQR';
import { useAuth } from './auth-api';

/**
 * 第三方授权的等待预算与轮询窗口。
 *
 * 单次窗口刻意取短值（1.5s）：域内 `pollOAuthCallback` 会阻塞到**回调到达或窗口耗尽**，
 * 窗口太长会让"用户还在浏览器里操作"这段期间界面毫无反馈、也无法取消；
 * 由渲染层按窗口滚动重试，整体预算 5 分钟与服务端 state 有效期（10 分钟）同量级。
 */
const OAUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_POLL_INTERVAL_MS = 1500;

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
  /** 正在等待回调的第三方 provider（null = 没有进行中的授权） */
  const [oauthPending, setOauthPending] = useState<OAuthProvider | null>(null);
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

  /**
   * 发起第三方登录：打开授权页后**必须等回调**才算完成登录。
   *
   * 只 `beginOAuth` 就返回是这条链路此前的断点 —— 浏览器里授权成功了，应用侧却永远
   * 不知道自己已经登录。这里把「发起 → 等回调 → 得会话」串起来；
   * 等待期间允许取消（用户改主意时不该被一个不可关闭的等待卡住）。
   */
  const startOAuth = useCallback(
    async (provider: OAuthProvider) => {
      setError(null);
      try {
        await api.beginOAuth(provider);
        setOauthPending(provider);
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api],
  );

  useEffect(() => {
    if (oauthPending === null) return undefined;
    let cancelled = false;
    const deadline = Date.now() + OAUTH_WAIT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout>;

    const settle = (cause: unknown): void => {
      setOauthPending(null);
      if (!(cause instanceof OfflineError)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    const poll = async (): Promise<void> => {
      try {
        const result = await api.pollOAuthCallback(oauthPending, OAUTH_POLL_INTERVAL_MS);
        if (cancelled) return;
        setOauthPending(null);
        onAuthenticated(result.session);
      } catch (cause: unknown) {
        if (cancelled) return;
        // 单次窗口内没等到回调是**常态**（用户还在浏览器里操作）：继续等，
        // 只有整体预算耗尽才当失败。别把"还没点完"报成错误。
        if (cause instanceof ShellError && cause.code === 'TIMEOUT' && Date.now() < deadline) {
          timer = setTimeout(() => void poll(), OAUTH_POLL_INTERVAL_MS);
          return;
        }
        settle(cause);
      }
    };

    timer = setTimeout(() => void poll(), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, oauthPending, onAuthenticated]);

  /** 微信扫码：状态轮询已带回回调 URL，无需回环/协议通道，直接换令牌 */
  const completeWechat = useCallback(
    async (callbackUrl: string) => {
      setError(null);
      try {
        onAuthenticated(await api.completeOAuth('wechat', callbackUrl, rememberMe));
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, onAuthenticated, rememberMe],
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
                    disabled={offline || oauthPending !== null}
                    onClick={() => setQrOpen((prev) => !prev)}
                  >
                    {AUTH_PROVIDER_LABELS.wechat}扫码
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={offline || oauthPending !== null}
                    onClick={() => void startOAuth('google')}
                  >
                    {AUTH_PROVIDER_LABELS.google} 登录
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={offline || oauthPending !== null}
                    onClick={() => void startOAuth('github')}
                  >
                    {AUTH_PROVIDER_LABELS.github} 登录
                  </Button>
                </div>
                {oauthPending !== null ? (
                  <div className="ec-auth__providers">
                    <p className="ec-auth__notice" role="status">
                      {`已打开浏览器，请在浏览器中完成 ${AUTH_PROVIDER_LABELS[oauthPending]} 授权…`}
                    </p>
                    <Button variant="ghost" size="sm" onClick={() => setOauthPending(null)}>
                      取消等待
                    </Button>
                  </div>
                ) : null}
                {qrOpen ? <WechatQR onConfirmed={(url) => void completeWechat(url)} /> : null}
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
