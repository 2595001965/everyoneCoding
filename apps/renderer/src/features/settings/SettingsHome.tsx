/**
 * SettingsHome（T9-03）：设置一级页面（类目导航 + 内容区）。
 *
 * D-02 硬约束：本页与状态栏**不出现任何云端同步状态或入口**；
 * 导出/导入（.ecpkg）在此页一级可见。
 */

import { useState } from 'react';

import type { AiSettingsApi } from './ai-settings-context';
import { BackupPanel } from './BackupPanel';
import { DataLocation } from './DataLocation';
import { GeneralSettings } from './GeneralSettings';
import { PrivacyPanel } from './PrivacyPanel';
import {
  SettingsApiProvider,
  SettingsUnavailable,
  useSettingsOptional,
  type SettingsApi,
} from './settings-api';
import { ShortcutSettings } from './ShortcutSettings';
import { UpdatePanel } from './UpdatePanel';
import { UpdateUnavailable, type UpdateApi } from './update-api';
import { BudgetSettings } from '../usage/BudgetSettings';
import { UsageApiProvider, useUsageOptional, type UsageApi } from '../usage/usage-api';

import './settings.css';
import './settings-panels.css';

type SettingsCategory =
  'general' | 'data' | 'backup' | 'privacy' | 'shortcuts' | 'ai' | 'usage' | 'update';

const CATEGORIES: Array<{ key: SettingsCategory; label: string; hint: string }> = [
  { key: 'general', label: '通用', hint: '语言、主题、字体与编辑器偏好' },
  { key: 'data', label: '数据与位置', hint: '本地目录与手动迁移' },
  { key: 'backup', label: '导出与备份', hint: '归档导出、导入与定时本地备份' },
  { key: 'privacy', label: '隐私', hint: '匿名数据与本地清除' },
  { key: 'shortcuts', label: '快捷键', hint: '命令键位与方案导入导出' },
  { key: 'ai', label: '模型服务', hint: '中转配置、模型能力与远程配置源' },
  { key: 'usage', label: '用量与预算', hint: 'AI 用量统计与月度预算告警' },
  { key: 'update', label: '更新', hint: '检查新版本、更新通道与失败回滚' },
];

export interface SettingsHomeProps {
  api: SettingsApi | null;
  /** AI 设置端口（Wave 1 产物，由外壳注入；未注入时显示引导） */
  aiApi?: AiSettingsApi | null;
  /** 用量端口（T10-01，由外壳注入；未注入时显示引导） */
  usageApi?: UsageApi | null;
  /** 自动更新端口（T10-04，由外壳注入；未注入时显示引导） */
  updateApi?: UpdateApi | null;
  /** 当前项目（导出时使用；未选项目时导出按钮禁用） */
  projectId?: string | undefined;
  /** 项目下拉选项（保留给后续用量视图接线；当前版本未消费） */
  projectOptions?: Array<{ id: string; name: string }>;
  /**
   * 渲染"模型服务"区块（由 index.tsx 传入，避免 SettingsHome ↔ index 循环导入）。
   * 缺省时展示引导文案。
   */
  renderAiSection?: ((aiApi: AiSettingsApi | null) => JSX.Element) | undefined;
}

interface SettingsBodyProps {
  aiApi: AiSettingsApi | null;
  usageApi: UsageApi | null;
  updateApi: UpdateApi | null;
  projectId: string | undefined;
  renderAiSection: ((aiApi: AiSettingsApi | null) => JSX.Element) | undefined;
}

function SettingsBody({
  aiApi,
  usageApi,
  updateApi,
  projectId,
  renderAiSection,
}: SettingsBodyProps): JSX.Element {
  const api = useSettingsOptional();
  const usage = useUsageOptional();
  const [category, setCategory] = useState<SettingsCategory>(api ? 'general' : 'ai');

  return (
    <div className="ec-settings">
      <nav className="ec-settings__nav" aria-label="设置类目">
        {CATEGORIES.map((item) => (
          <button
            key={item.key}
            type="button"
            data-active={category === item.key ? 'true' : 'false'}
            onClick={() => setCategory(item.key)}
            title={item.hint}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="ec-settings__body">
        {!api ? <SettingsUnavailable /> : null}
        {category === 'general' && api ? <GeneralSettings /> : null}
        {category === 'data' && api ? <DataLocation /> : null}
        {category === 'backup' && api ? <BackupPanel projectId={projectId} /> : null}
        {category === 'privacy' && api ? <PrivacyPanel /> : null}
        {category === 'shortcuts' && api ? <ShortcutSettings /> : null}
        {category === 'ai' ? (
          renderAiSection ? (
            renderAiSection(aiApi)
          ) : (
            <p className="ec-settings__hint">模型服务设置需由外壳装配后可用。</p>
          )
        ) : null}
        {category === 'usage' ? (
          <UsageApiProvider api={usageApi ?? usage}>
            <div className="ec-usage-page">
              <BudgetSettings />
            </div>
          </UsageApiProvider>
        ) : null}
        {category === 'update' ? (
          updateApi === null ? (
            <UpdateUnavailable />
          ) : (
            <UpdatePanel api={updateApi} />
          )
        ) : null}
      </div>
    </div>
  );
}

export function SettingsHome({
  api,
  aiApi,
  usageApi,
  updateApi,
  projectId,
  renderAiSection,
}: SettingsHomeProps): JSX.Element {
  return (
    <SettingsApiProvider api={api}>
      <SettingsBody
        aiApi={aiApi ?? null}
        usageApi={usageApi ?? null}
        updateApi={updateApi ?? null}
        projectId={projectId}
        renderAiSection={renderAiSection}
      />
    </SettingsApiProvider>
  );
}
