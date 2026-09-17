import { useMemo } from 'react';

import { AuthPage, readInjectedAuthApi } from '../features/auth';
import { useAppStore } from '../store/useAppStore';

/**
 * 账号页（Wave 9 / T9-05）。
 *
 * 端口由外壳注入（`globalThis.__EC_AUTH__`）：会话令牌存 DPAPI 加密区、
 * OAuth 回环监听与打开系统浏览器都在外壳侧完成（服务端仅负责注册/登录与版本更新）。
 * 未注入时展示装配引导；云端不可达时由端口上报离线，登录入口置灰但本地功能可用。
 */
export function AccountPage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const api = useMemo(() => (void shellReady, readInjectedAuthApi()), [shellReady]);

  return <AuthPage api={api} />;
}
