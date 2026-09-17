import { Tabs } from '@ec/ui';

import {
  AiSettingsProvider,
  useAiSettingsOptional,
  type AiSettingsApi,
} from './ai-settings-context';
import { ProviderSettings } from './ProviderSettings';
import { RemoteConfigSettings } from './remote-config/useRemoteConfig';
import { SettingsHome as SettingsHomeImpl } from './SettingsHome';
import type { SettingsApi } from './settings-api';
import type { UpdateApi } from './update-api';
import type { UsageApi } from '../usage/usage-api';

/** 设置页的 AI 区块：模型服务 / 远程配置两个页签 */
export function AiSettingsPage({ api }: { api: AiSettingsApi | null }): JSX.Element {
  if (!api) return <AiSettingsUnavailable />;
  const items = [
    { key: 'provider', label: '模型服务' },
    { key: 'remote', label: '远程配置' },
  ];

  return (
    <AiSettingsProvider api={api}>
      <Tabs
        items={items}
        defaultValue="provider"
        // eslint-disable-next-line react/no-children-prop -- Tabs 的 children 是渲染函数（render prop），只能作为 prop 传入
        children={(active) =>
          active === 'provider' ? <ProviderSettings /> : <RemoteConfigSettings />
        }
      />
    </AiSettingsProvider>
  );
}

/** 未注入实现时的引导（等待外壳提供数据连接） */
export function AiSettingsUnavailable(): JSX.Element {
  return (
    <div className="ec-ai">
      <p className="ec-ai__hint">
        AI 接入层尚未连接本地数据库。完成初始化后，这里可以配置模型服务与远程配置源。
      </p>
    </div>
  );
}

export { useAiSettingsOptional };
export type { AiSettingsApi };
export { ProviderSettings } from './ProviderSettings';
export { RemoteConfigSettings } from './remote-config/useRemoteConfig';
export { ProviderList } from './provider/ProviderList';
export { ProviderEditor } from './provider/ProviderEditor';
export { ConnectionTest } from './provider/ConnectionTest';
export { ModelCapabilityTable } from './provider/ModelCapabilityTable';
export { PurposeBindingPanel } from './provider/PurposeBinding';
export { RemoteConfigList } from './remote-config/RemoteConfigList';
export { RemoteConfigEditor } from './remote-config/RemoteConfigEditor';
export { DiffPreview } from './remote-config/DiffPreview';

/* ------------------------------- Wave 9（T9-03） ------------------------------- */

/** 设置页容器：把 Wave 1 的 AI 区块注入"模型服务"类目（避免 SettingsHome ↔ index 循环导入） */
export function SettingsPageContainer({
  settingsApi,
  aiApi,
  usageApi,
  updateApi,
  projectId,
}: {
  settingsApi: SettingsApi | null;
  aiApi: AiSettingsApi | null;
  usageApi?: UsageApi | null;
  /** 自动更新端口（T10-04）；未注入时"更新"类目显示引导 */
  updateApi?: UpdateApi | null;
  projectId?: string | undefined;
}): JSX.Element {
  return (
    <SettingsHomeImpl
      api={settingsApi}
      aiApi={aiApi}
      usageApi={usageApi ?? null}
      updateApi={updateApi ?? null}
      projectId={projectId}
      renderAiSection={(resolvedAi) => <AiSettingsPage api={resolvedAi} />}
    />
  );
}

export { SettingsHomeImpl as SettingsHome };
export { UpdatePanel } from './UpdatePanel';
export {
  UpdateApiProvider,
  UpdateUnavailable,
  readInjectedUpdateApi,
  useUpdate,
  useUpdateOptional,
  type UpdateApi,
  type UpdateSettingsPatch,
  type UpdateViewState,
} from './update-api';
export { createUpdateApi } from './update-service-host';
export { GeneralSettings } from './GeneralSettings';
export { DataLocation } from './DataLocation';
export { BackupPanel } from './BackupPanel';
export { PrivacyPanel } from './PrivacyPanel';
export { ShortcutSettings, keyFromEvent } from './ShortcutSettings';
export {
  SettingsApiProvider,
  SettingsUnavailable,
  detectKeymapConflicts,
  readInjectedSettingsApi,
  useSettings,
  useSettingsOptional,
  type CommandInfo,
  type DataDirs,
  type ExportResult,
  type ImportResult,
  type KeymapConflict,
  type MigrationResult,
  type SettingsApi,
  type TelemetryInspection,
} from './settings-api';
