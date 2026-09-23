/**
 * ForgotPasswordForm（T9-05 / FR-ACC-08）：邮箱验证码找回密码。
 *
 * 两步式（对齐服务端的两段接口，也避免"验证码"与"邮箱"混在一个表单里让人误填）：
 *
 * 1. **请求验证码** —— `POST /api/auth/password/reset/request`。服务端对同一邮箱有
 *    冷却窗口（默认 60s）与每 IP 限流，超限返回 429。界面据此做本地倒计时，
 *    目的不是取代服务端限流（那是安全边界），而是让用户不必靠报错才能发现"还要等多久"。
 * 2. **验证码 + 新密码** —— `POST /api/auth/password/reset`。验证码单次有效、限时过期；
 *    重置成功后服务端会撤销该用户全部刷新令牌，故必须回登录页重新登录。
 *
 * 复制「验证码为空/过期/已使用」这类失败原因**原样透传服务端文案**：猜测性改写会掩盖
 * "链接是不是发到另一个邮箱了"这种真实问题。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '@ec/ui';
import { OfflineError, PASSWORD_STRENGTH_LABELS, checkPassword } from '@ec/account';

import { useAuth } from './auth-api';

export interface ForgotPasswordFormProps {
  /** 重置成功：回到登录页（服务端已撤销旧刷新令牌，必须重新登录） */
  onReset: (email: string) => void;
  onSwitchToLogin: () => void;
}

/** 服务端冷却窗口（`ACCOUNT_EMAIL_RESEND_COOLDOWN_MS` 默认 60s）的界面镜像 */
const RESEND_COOLDOWN_SEC = 60;

type Step = 'request' | 'confirm';

export function ForgotPasswordForm({
  onReset,
  onSwitchToLogin,
}: ForgotPasswordFormProps): JSX.Element {
  const api = useAuth();
  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // 倒计时：到点自动解锁"重新发送"，避免用户点击后只得到一个 429
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setInterval(() => setCooldown((prev) => (prev <= 1 ? 0 : prev - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const emailValid = /^\S+@\S+\.\S+$/.test(email.trim());
  const check = checkPassword(password, confirm);

  const sendCode = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.requestPasswordReset(email.trim());
      setStep('confirm');
      setCooldown(RESEND_COOLDOWN_SEC);
      // 不透露邮箱是否已注册：服务端对未注册邮箱同样返回成功
      setNotice('若该邮箱已注册，验证码已发送，请查收（10 分钟内有效）。');
    } catch (cause: unknown) {
      // 离线错误由离线横幅统一提示，避免同屏重复两遍
      if (!(cause instanceof OfflineError)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }, [api, email]);

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword({ email: email.trim(), code: code.trim(), newPassword: password });
      onReset(email.trim());
    } catch (cause: unknown) {
      if (!(cause instanceof OfflineError)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }, [api, code, email, onReset, password]);

  if (step === 'request') {
    return (
      <form
        className="ec-auth__form"
        aria-label="找回密码"
        onSubmit={(event) => {
          event.preventDefault();
          void sendCode();
        }}
      >
        <h2 className="ec-auth__form-title">找回密码</h2>
        <p className="ec-auth__hint">输入注册邮箱，我们会发送 6 位验证码用于重置密码。</p>

        <label className="ec-auth__field">
          <span>邮箱</span>
          <Input
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            aria-label="找回密码邮箱"
            invalid={email.length > 0 && !emailValid}
          />
        </label>

        {error ? <p className="ec-auth__error">{error}</p> : null}

        <Button type="submit" variant="primary" fullWidth loading={busy} disabled={!emailValid}>
          发送验证码
        </Button>
        <button type="button" className="ec-auth__switch" onClick={onSwitchToLogin}>
          想起密码了？返回登录
        </button>
      </form>
    );
  }

  return (
    <form
      className="ec-auth__form"
      aria-label="重置密码"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="ec-auth__form-title">重置密码</h2>
      <p className="ec-auth__hint">{`验证码已发送至 ${email.trim()}，10 分钟内有效。`}</p>
      {notice ? <p className="ec-auth__notice">{notice}</p> : null}

      <label className="ec-auth__field">
        <span>验证码</span>
        <Input
          value={code}
          onChange={setCode}
          placeholder="6 位数字"
          aria-label="重置验证码"
          inputMode="numeric"
        />
      </label>

      <label className="ec-auth__field">
        <span>新密码</span>
        <Input
          value={password}
          onChange={setPassword}
          type="password"
          placeholder="至少 8 位，含两类字符"
          aria-label="新密码"
          invalid={password.length > 0 && !check.valid}
        />
        {password.length > 0 ? (
          <span className="ec-auth__strength" data-strength={check.strength} role="status">
            {`强度：${PASSWORD_STRENGTH_LABELS[check.strength]}${check.issues.length > 0 ? `（${check.issues.join('；')}）` : ''}`}
          </span>
        ) : null}
      </label>

      <label className="ec-auth__field">
        <span>确认新密码</span>
        <Input
          value={confirm}
          onChange={setConfirm}
          type="password"
          placeholder="再次输入新密码"
          aria-label="确认新密码"
          invalid={confirm.length > 0 && confirm !== password}
        />
      </label>

      {error ? <p className="ec-auth__error">{error}</p> : null}

      <Button
        type="submit"
        variant="primary"
        fullWidth
        loading={busy}
        disabled={code.trim().length === 0 || !check.valid}
      >
        重置密码
      </Button>

      <div className="ec-auth__providers">
        <Button
          type="button"
          variant="secondary"
          disabled={busy || cooldown > 0}
          onClick={() => void sendCode()}
        >
          {cooldown > 0 ? `重新发送（${cooldown}s）` : '重新发送验证码'}
        </Button>
        <Button type="button" variant="secondary" onClick={onSwitchToLogin}>
          返回登录
        </Button>
      </div>
    </form>
  );
}
