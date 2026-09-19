/**
 * RegisterForm（T9-05 / FR-ACC-01）：邮箱注册。
 *
 * 实时提示：密码少于 8 位或少于两类字符即时提示；二次确认不一致即时提示；
 * 注册成功即进入工作台（E2E-01 全流程 ≤2 分钟，无需管理员介入）。
 */

import { useMemo, useState } from 'react';
import { Button, Checkbox, Input } from '@ec/ui';
import type { AuthSession } from '@ec/account';
import { PASSWORD_STRENGTH_LABELS, OfflineError, checkPassword } from '@ec/account';

import { useAuth } from './auth-api';

export interface RegisterFormProps {
  onRegistered: (session: AuthSession) => void;
  onSwitchToLogin: () => void;
}

export function RegisterForm({ onRegistered, onSwitchToLogin }: RegisterFormProps): JSX.Element {
  const api = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);

  const check = useMemo(() => checkPassword(password, confirm), [password, confirm]);
  const emailValid = /^\S+@\S+\.\S+$/.test(email.trim());
  const canSubmit = emailValid && check.valid;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.register({ email: email.trim(), password, confirm, rememberMe });
      // 邮箱验证：不强制验证即可使用（FR-ACC-08），此处仅尝试发送验证邮件
      try {
        await api.requestEmailVerification(email.trim());
        setVerificationSent(true);
      } catch {
        /* 验证邮件发送失败不阻塞注册（服务端也可配置关闭） */
      }
      onRegistered(session);
    } catch (cause: unknown) {
      // 离线错误由横幅统一提示
      if (!(cause instanceof OfflineError)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="ec-auth__form"
      aria-label="注册"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="ec-auth__form-title">注册账号</h2>

      <label className="ec-auth__field">
        <span>邮箱</span>
        <Input
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          aria-label="注册邮箱"
          invalid={email.length > 0 && !emailValid}
        />
      </label>

      <label className="ec-auth__field">
        <span>密码</span>
        <Input
          value={password}
          onChange={setPassword}
          type="password"
          placeholder="至少 8 位，含两类字符"
          aria-label="注册密码"
          invalid={password.length > 0 && !check.valid}
        />
        {password.length > 0 ? (
          <span className="ec-auth__strength" data-strength={check.strength} role="status">
            {`强度：${PASSWORD_STRENGTH_LABELS[check.strength]}${check.issues.length > 0 ? `（${check.issues.join('；')}）` : ''}`}
          </span>
        ) : null}
      </label>

      <label className="ec-auth__field">
        <span>确认密码</span>
        <Input
          value={confirm}
          onChange={setConfirm}
          type="password"
          placeholder="再次输入密码"
          aria-label="确认密码"
          invalid={confirm.length > 0 && confirm !== password}
        />
      </label>

      <Checkbox checked={rememberMe} onChange={setRememberMe} label="记住我（最多 30 天）" />

      {error ? <p className="ec-auth__error">{error}</p> : null}
      {verificationSent ? (
        <p className="ec-auth__hint">验证邮件已发送，未验证也可直接使用。</p>
      ) : null}

      <Button type="submit" variant="primary" fullWidth loading={busy} disabled={!canSubmit}>
        注册并进入工作台
      </Button>
      <button type="button" className="ec-auth__switch" onClick={onSwitchToLogin}>
        已有账号？直接登录
      </button>
    </form>
  );
}
