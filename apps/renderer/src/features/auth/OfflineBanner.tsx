/**
 * OfflineBanner（T9-05）：离线本地模式横幅。
 *
 * 云端账号服务不可达时展示"当前离线，本地功能可用"，并提供重试；
 * 恢复后自动隐藏（订阅端口的离线状态变化）。
 */

import { useEffect, useState } from 'react';
import { Button } from '@ec/ui';

import { useAuthOptional } from './auth-api';

export function OfflineBanner(): JSX.Element | null {
  const api = useAuthOptional();
  const [offline, setOffline] = useState<boolean>(() => api?.isOffline() ?? false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!api) return;
    setOffline(api.isOffline());
    return api.onOfflineChange(setOffline);
  }, [api]);

  if (!api || !offline) return null;

  return (
    <div className="ec-auth__offline" role="status">
      <span>当前离线，本地功能可用；账号相关操作暂不可用。</span>
      <Button
        size="sm"
        variant="ghost"
        loading={retrying}
        onClick={() => {
          setRetrying(true);
          void api.tryRecover().finally(() => setRetrying(false));
        }}
      >
        重试连接
      </Button>
    </div>
  );
}
