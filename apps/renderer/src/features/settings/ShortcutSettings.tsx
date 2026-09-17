/**
 * ShortcutSettings（T9-03 / FR-SET-07）：快捷键自定义。
 *
 * - 列出命令注册表（T0-09）中的全部可视化命令
 * - 支持录制/编辑快捷键，**冲突检测**并给出占用命令
 * - 键位方案可导入/导出（JSON）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Textarea } from '@ec/ui';

import { detectKeymapConflicts, useSettings, type CommandInfo } from './settings-api';

/** 由键盘事件合成快捷键串（如 Ctrl+Shift+K） */
export function keyFromEvent(event: {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) parts.push(key);
  return parts.join('+');
}

export function ShortcutSettings(): JSX.Element {
  const api = useSettings();
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [keymap, setKeymap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState('');

  useEffect(() => {
    void api
      .listCommands()
      .then((list) => {
        setCommands(list);
        const initial: Record<string, string> = {};
        for (const command of list) if (command.defaultKey) initial[command.id] = command.defaultKey;
        setKeymap(initial);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [api]);

  const conflicts = useMemo(() => detectKeymapConflicts(keymap), [keymap]);
  const conflictedKeys = useMemo(() => new Set(conflicts.map((conflict) => conflict.keys)), [conflicts]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.saveKeymap(keymap);
      if (result.ok) {
        setNotice('快捷键已保存');
        setError(null);
      } else {
        setError(`快捷键冲突：${result.conflicts.map((c) => `${c.keys} 被 ${c.commands.join('、')} 占用`).join('；')}`);
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, keymap]);

  const exportKeymap = useCallback(async () => {
    const json = await api.exportKeymap();
    setTransfer(json);
    setNotice('键位方案已导出到下方文本框，可复制保存');
  }, [api]);

  const importKeymap = useCallback(async () => {
    try {
      const parsed = await api.importKeymap(transfer);
      setKeymap(parsed);
      setNotice(`已导入 ${Object.keys(parsed).length} 条键位`);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, transfer]);

  return (
    <section className="ec-settings__panel" aria-label="快捷键">
      <h2>快捷键</h2>
      <p className="ec-settings__hint">全部可视化命令均可配置快捷键；冲突会即时提示。</p>

      <ul className="ec-settings__keymap">
        {commands.map((command) => {
          const keys = keymap[command.id] ?? '';
          const conflicted = keys.trim().length > 0 && conflictedKeys.has(keys.trim().toLowerCase());
          return (
            <li key={command.id} data-conflict={conflicted ? 'true' : 'false'}>
              <span className="ec-settings__command">{command.title}</span>
              <Input
                value={keys}
                aria-label={`${command.title} 快捷键`}
                placeholder="按下组合键"
                onKeyDown={(event) => {
                  event.preventDefault();
                  const combo = keyFromEvent(event);
                  if (combo) setKeymap((prev) => ({ ...prev, [command.id]: combo }));
                }}
                onChange={(value) => setKeymap((prev) => ({ ...prev, [command.id]: value }))}
              />
              {keys ? (
                <Button size="sm" variant="ghost" onClick={() => setKeymap((prev) => ({ ...prev, [command.id]: '' }))}>
                  清除
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {conflicts.length > 0 ? (
        <p className="ec-settings__error" role="alert">
          {`冲突：${conflicts.map((conflict) => `${conflict.keys} → ${conflict.commands.join('、')}`).join('；')}`}
        </p>
      ) : null}

      <div className="ec-settings__actions">
        <Button variant="primary" loading={busy} disabled={conflicts.length > 0} onClick={() => void save()}>
          保存快捷键
        </Button>
        <Button variant="secondary" onClick={() => void exportKeymap()}>
          导出键位方案
        </Button>
        <Button variant="secondary" disabled={!transfer.trim()} onClick={() => void importKeymap()}>
          导入键位方案
        </Button>
      </div>

      <label className="ec-settings__field">
        <span>键位方案 JSON（导入 / 导出共用）</span>
        <Textarea value={transfer} onChange={setTransfer} rows={5} aria-label="键位方案 JSON" />
      </label>

      {notice ? (
        <p className="ec-settings__notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="ec-settings__error">{error}</p> : null}
    </section>
  );
}
