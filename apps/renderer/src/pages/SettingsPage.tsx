import { useMemo } from 'react';

import { SettingsPageContainer, readInjectedSettingsApi } from '../features/settings';
import type { AiSettingsApi } from '../features/settings/ai-settings-context';
import { readInjectedUsageApi } from '../features/usage/usage-api';
import { useAppStore } from '../store/useAppStore';

/**
 * 设置页（Wave 9 / T9-03 + T10-01 用量类目）。
 *
 * 三类端口由外壳注入：
 * - `globalThis.__EC_SETTINGS__`：通用设置 / 数据目录 / 导出备份 / 隐私 / 快捷键
 * - `globalThis.__EC_AI_SETTINGS__`：模型服务与远程配置（Wave 1 产物）
 * - `globalThis.__EC_USAGE__`：用量与预算（T10-01）
 *
 * 未注入时对应区块展示引导；**状态栏与设置页不提供任何云端同步入口**（D-02）。
 */

function readInjectedAiApi(): AiSettingsApi | null {
  const injected = (globalThis as unknown as { __EC_AI_SETTINGS__?: AiSettingsApi }).__EC_AI_SETTINGS__;
  return typeof injected === 'object' && injected !== null ? injected : null;
}

export function SettingsPage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const ports = useMemo(
    () =>
      (void shellReady, {
        settingsApi: readInjectedSettingsApi(),
        aiApi: readInjectedAiApi(),
        usageApi: readInjectedUsageApi(),
      }),
    [shellReady],
  );

  return (
    <SettingsPageContainer
      settingsApi={ports.settingsApi}
      aiApi={ports.aiApi}
      usageApi={ports.usageApi}
    />
  );
}
