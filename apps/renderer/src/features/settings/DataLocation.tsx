/**
 * DataLocation（T9-03 / FR-SET-02/03）：本地数据目录与手动迁移。
 *
 * D-02：**本地优先**——页面不出现任何云端入口；迁移 = 复制 + 校验 + 切换 + 旧目录保留备份，
 * 校验判据是**迁移前后条数一致**；失败展示可读原因并允许一键回滚。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '@ec/ui';

import { useSettings, type DataDirs, type MigrationResult } from './settings-api';

const FIELD_LABELS: Array<{ key: keyof DataDirs; label: string; placeholder: string }> = [
  { key: 'workspaceRoot', label: '工作区根目录', placeholder: 'D:\\EveryOneCoding' },
  { key: 'projectsDir', label: '工程目录', placeholder: 'D:\\EveryOneCoding\\projects' },
  { key: 'sqlitePath', label: 'SQLite 数据库位置', placeholder: 'D:\\EveryOneCoding\\data\\ec.db' },
  { key: 'cacheDir', label: '缓存目录', placeholder: 'D:\\EveryOneCoding\\cache' },
];

export function DataLocation(): JSX.Element {
  const api = useSettings();
  const [dirs, setDirs] = useState<DataDirs | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getDataDirs()
      .then(setDirs)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [api]);

  const migrate = useCallback(async () => {
    if (!dirs) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.migrateDataDirs(dirs);
      setResult(outcome);
      if (!outcome.ok) setError(outcome.error ?? '迁移失败');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, dirs]);

  const rollback = useCallback(async () => {
    setBusy(true);
    try {
      setResult(await api.rollbackMigration());
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api]);

  if (!dirs) return <p className="ec-settings__hint">正在加载数据目录…</p>;

  return (
    <section className="ec-settings__panel" aria-label="数据位置">
      <h2>数据与位置</h2>
      <p className="ec-settings__hint">
        项目、记忆、文档与代码全部保存在本地；导出/导入使用 `.ecpkg` 归档包，不上传任何服务器。
      </p>

      {FIELD_LABELS.map((field) => (
        <label key={field.key} className="ec-settings__field">
          <span>{field.label}</span>
          <Input
            value={dirs[field.key]}
            onChange={(value) => setDirs({ ...dirs, [field.key]: value })}
            aria-label={field.label}
            placeholder={field.placeholder}
          />
        </label>
      ))}

      <div className="ec-settings__actions">
        <Button variant="primary" loading={busy} onClick={() => void migrate()}>
          迁移数据目录
        </Button>
        {result && !result.ok ? (
          <Button variant="secondary" onClick={() => void rollback()}>
            回滚迁移
          </Button>
        ) : null}
      </div>

      {result ? (
        <p className={result.ok ? 'ec-settings__notice' : 'ec-settings__error'} role="status">
          {result.ok
            ? `迁移完成：条目 ${result.counts.before} → ${result.counts.after}（一致）；旧目录已备份${
                result.backupDir ? `至 ${result.backupDir}` : ''
              }`
            : `迁移失败：${result.error ?? '未知原因'}${result.rolledBack ? '（已回滚）' : ''}`}
        </p>
      ) : null}
      {error ? <p className="ec-settings__error">{error}</p> : null}
    </section>
  );
}
