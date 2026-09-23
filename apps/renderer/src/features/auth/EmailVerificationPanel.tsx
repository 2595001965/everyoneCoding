/**
 * EmailVerificationPanel（T9-05 / FR-ACC-08）：登录后的邮箱验证状态与重发入口。
 *
 * ## 为什么状态必须以服务端为准
 *
 * 验证链接是发到邮箱、在**系统浏览器**里点开的（落地页见服务端 `routes/verify-page.ts`），
 * 桌面端拿不到这次点击的任何信号。因此会话里的 `identity.emailVerified` 只是登录那一刻的
 * 快照 —— 用户完全可能"先注册 → 收到邮件 → 在浏览器里验证 → 才回到应用"。
 *
 * 所以这一栏做两件事：**主动查询**服务端状态（而不是信快照），以及**重发**验证邮件
 * （带与服务端冷却窗口对齐的倒计时，避免用户只能靠 429 报错发现"还要等多久"）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Tag } from '@ec/ui';
import { OfflineError, type AccountIdentity } from '@ec/account';

import { useAuth } from './auth-api';

export interface EmailVerificationPanelProps {
  identity: AccountIdentity;
}

/** 服务端冷却窗口（`ACCOUNT_EMAIL_RESEND_COOLDOWN_MS` 默认 60s）的界面镜像 */
const RESEND_COOLDOWN_SEC = 60;

export function EmailVerificationPanel({ identity }: EmailVerificationPanelProps): JSX.Element {
  const api = useAuth();
  const [verified, setVerified] = useState(identity.emailVerified);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setInterval(() => setCooldown((prev) => (prev <= 1 ? 0 : prev - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const current = await api.emailVerified(identity.login);
      setVerified(current);
      setNotice(current ? '邮箱已验证。' : '邮箱尚未验证；请在邮件中点击验证链接后刷新状态。');
    } catch (cause: unknown) {
      if (!(cause instanceof OfflineError)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }, [api, identity.login]);

  // 挂载即查一次：会话快照可能是"验证之前"的旧值
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resend = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.requestEmailVerification(identity.login);
      setCooldown(RESEND_COOLDOWN_SEC);
      setNotice('验证邮件已重新发送，请查收（24 小时内有效）。');
    } catch (cause: unknown) {
      if (!(cause instanceof OfflineError)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }, [api, identity.login]);

  return (
    <section className="ec-auth__bindings" aria-label="邮箱验证">
      <h3>邮箱验证</h3>
      <ul className="ec-auth__binding-list">
        <li>
          <span className="ec-auth__binding-name">邮箱</span>
          <Tag color={verified ? 'success' : 'neutral'}>{verified ? '已验证' : '未验证'}</Tag>
          <span className="ec-auth__hint">{identity.login}</span>
        </li>
      </ul>

      {verified ? (
        <p className="ec-auth__hint">邮箱已验证，可用于找回密码。</p>
      ) : (
        <>
          <p className="ec-auth__hint">
            验证链接已发送到该邮箱；在浏览器中点击链接完成验证后，回到此处刷新状态即可。
          </p>
          <div className="ec-auth__providers">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || cooldown > 0}
              onClick={() => void resend()}
            >
              {cooldown > 0 ? `重新发送（${cooldown}s）` : '重新发送验证邮件'}
            </Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void refresh()}>
              刷新验证状态
            </Button>
          </div>
        </>
      )}

      {notice ? (
        <p className="ec-auth__notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="ec-auth__error">{error}</p> : null}
    </section>
  );
}
