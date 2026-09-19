/**
 * BindingPanel（T9-05 / FR-ACC-06）：第三方身份绑定与解绑。
 *
 * 解绑规则：仅剩单一登录方式且未设置密码时必须先设置密码——
 * 本地用 `canUnbind` 预检并给出可读原因，避免用户在服务端被拒后才明白后果。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Tag } from '@ec/ui';
import {
  AUTH_PROVIDER_LABELS,
  canBind,
  canUnbind,
  type AccountIdentity,
  type AuthProvider,
  type Binding,
} from '@ec/account';

import { useAuth } from './auth-api';

const PROVIDERS: AuthProvider[] = ['email', 'wechat', 'google', 'github'];

export interface BindingPanelProps {
  identity: AccountIdentity;
}

export function BindingPanel({ identity }: BindingPanelProps): JSX.Element {
  const api = useAuth();
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBindings(await api.listBindings());
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const isBound = (provider: AuthProvider): boolean =>
    provider === 'email'
      ? identity.hasPassword
      : bindings.some((binding) => binding.provider === provider);

  const handleBind = async (provider: AuthProvider): Promise<void> => {
    const guard = canBind(bindings, provider);
    if (!guard.allowed) {
      setNotice(guard.reason);
      return;
    }
    try {
      setBindings(await api.bind(provider));
      setNotice(`${AUTH_PROVIDER_LABELS[provider]} 绑定成功。`);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleUnbind = async (provider: AuthProvider): Promise<void> => {
    const guard = canUnbind({ bindings, target: provider, hasPassword: identity.hasPassword });
    if (!guard.allowed) {
      setNotice(guard.reason);
      return;
    }
    try {
      setBindings(await api.unbind(provider, identity.hasPassword));
      setNotice(`${AUTH_PROVIDER_LABELS[provider]} 已解绑。`);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="ec-auth__bindings" aria-label="登录方式绑定">
      <h3>登录方式绑定</h3>
      <p className="ec-auth__hint">
        {`当前账号：${identity.displayName}（${identity.login}）${identity.emailVerified ? '' : ' · 邮箱未验证'}`}
      </p>

      <ul className="ec-auth__binding-list">
        {PROVIDERS.map((provider) => {
          const bound = isBound(provider);
          return (
            <li key={provider}>
              <span className="ec-auth__binding-name">{AUTH_PROVIDER_LABELS[provider]}</span>
              <Tag color={bound ? 'success' : 'neutral'}>{bound ? '已绑定' : '未绑定'}</Tag>
              {provider === 'email' ? (
                <span className="ec-auth__hint">
                  {identity.hasPassword ? '已设置密码' : '未设置密码'}
                </span>
              ) : bound ? (
                <Button size="sm" variant="ghost" onClick={() => void handleUnbind(provider)}>
                  解绑
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => void handleBind(provider)}>
                  绑定
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {notice ? (
        <p className="ec-auth__notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="ec-auth__error">{error}</p> : null}
    </section>
  );
}
