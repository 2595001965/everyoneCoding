/**
 * GeneralSettings（T9-03 / FR-SET-01）：通用设置。
 *
 * 语言（简体中文 / English）、主题（浅色 / 深色 / 跟随系统）、字体与字号、编辑器偏好。
 * **全部即时生效**：保存后立即应用（主题直接改 DOM `data-theme`），不要求重启。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Select, Switch, applyTheme, type ThemeMode } from '@ec/ui';
import type { GlobalSettings } from '@ec/core';

import { useSettings } from './settings-api';
import { useUiStore } from '../../store/useUiStore';

export interface GeneralSettingsProps {
  /** 设置变更后通知外层（如顶栏主题切换按钮同步） */
  onChanged?: ((settings: GlobalSettings) => void) | undefined;
}

type Language = GlobalSettings['language'];

export function GeneralSettings({ onChanged }: GeneralSettingsProps): JSX.Element {
  const api = useSettings();
  const theme = useUiStore((state) => state.theme);
  const locale = useUiStore((state) => state.locale);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getAll()
      .then(setSettings)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [api]);

  const apply = useCallback(
    async (patch: Partial<GlobalSettings>) => {
      setBusy(true);
      setError(null);
      try {
        const next = await api.update(patch);
        setSettings(next);
        // 即时生效：主题立刻作用到 DOM（无需重启）
        if (patch.theme !== undefined) {
          applyTheme(next.theme);
          useUiStore.getState().setTheme(next.theme);
        }
        if (patch.language !== undefined) useUiStore.getState().setLocale(next.language);
        setNotice('已保存并即时生效');
        onChanged?.(next);
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [api, onChanged],
  );

  if (!settings)
    return (
      <p
        className={error ? 'ec-settings__error' : 'ec-settings__hint'}
        role={error ? 'alert' : 'status'}
      >
        {error ?? '正在加载设置…'}
      </p>
    );

  return (
    <section className="ec-settings__panel" aria-label="通用设置">
      <h2>通用</h2>

      <label className="ec-settings__field">
        <span>界面语言</span>
        <Select
          aria-label="界面语言"
          value={locale}
          options={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en-US', label: 'English' },
          ]}
          onChange={(value) => void apply({ language: value as Language })}
        />
      </label>

      <label className="ec-settings__field">
        <span>主题</span>
        <Select
          aria-label="主题"
          value={theme}
          options={[
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
            { value: 'system', label: '跟随系统' },
          ]}
          onChange={(value) => void apply({ theme: value as ThemeMode })}
        />
      </label>

      <label className="ec-settings__field">
        <span>编辑器字号</span>
        <Select
          aria-label="编辑器字号"
          value={String(settings.editor?.fontSize ?? 14)}
          options={[
            { value: '12', label: '12 px' },
            { value: '14', label: '14 px' },
            { value: '16', label: '16 px' },
          ]}
          onChange={(value) =>
            void apply({ editor: { ...settings.editor, fontSize: Number(value) } })
          }
        />
      </label>

      <label className="ec-settings__field">
        <span>自动换行</span>
        <Switch
          checked={settings.editor?.wordWrap ?? true}
          onChange={(checked) => void apply({ editor: { ...settings.editor, wordWrap: checked } })}
          aria-label="自动换行"
        />
      </label>

      {notice ? (
        <p className="ec-settings__notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="ec-settings__error">{error}</p> : null}
      <Button size="sm" variant="ghost" loading={busy} onClick={() => void apply({})}>
        重新校验配置
      </Button>
    </section>
  );
}
