/**
 * BackupPanel（T9-03 / FR-SET-04 + T8-02/T8-03 打通）：数据导出与本地备份。
 *
 * 两种导出共用同一套排除与脱敏策略（FR-SET-04）：
 * - 「完整归档」（.ecpkg：代码 + 设计 DSL + 记忆 + 文档）
 * - 「仅代码」（轻量包）
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select, Switch } from '@ec/ui';

import { useSettings, type ExportResult, type ImportResult } from './settings-api';

export interface BackupPanelProps {
  /** 当前项目 id（由外层传入；未选项目时禁用导出） */
  projectId?: string | undefined;
}

export function BackupPanel({ projectId }: BackupPanelProps): JSX.Element {
  const api = useSettings();
  const [mode, setMode] = useState<'full' | 'code-only'>('full');
  const [encrypted, setEncrypted] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [importPath, setImportPath] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [intervalHours, setIntervalHours] = useState('24');
  const [backupDir, setBackupDir] = useState('');
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getBackupConfig()
      .then((config) => {
        setIntervalHours(String(config.intervalHours));
        setBackupDir(config.dir);
        setLastRunAt(config.lastRunAt);
      })
      .catch(() => {
        /* 未配置时保持默认值 */
      });
  }, [api]);

  const exportNow = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      setExportResult(
        await api.exportProject({
          projectId,
          mode,
          encrypted,
          // 只有勾选加密时才带口令；空串按"未提供"处理，由实现给出明确报错
          ...(encrypted && exportPassword ? { password: exportPassword } : {}),
        }),
      );
      setNotice('导出完成（本地文件，未上传任何服务器）');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, encrypted, exportPassword, mode, projectId]);

  const importNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setImportResult(
        await api.importPackage({
          filePath: importPath.trim(),
          ...(importPassword ? { password: importPassword } : {}),
        }),
      );
      setNotice('导入完成');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, importPassword, importPath]);

  const saveSchedule = useCallback(async () => {
    setBusy(true);
    try {
      await api.saveBackupConfig({ intervalHours: Number(intervalHours) || 24, dir: backupDir });
      setNotice('备份计划已保存（由客户端内调度器执行，不依赖系统任务计划）');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, backupDir, intervalHours]);

  return (
    <section className="ec-settings__panel" aria-label="导出与备份">
      <h2>导出与备份</h2>
      <p className="ec-settings__hint">
        归档包为本地文件（`.ecpkg`）；本产品不提供云端同步与分享链接。
      </p>

      <label className="ec-settings__field">
        <span>导出范围</span>
        <Select
          aria-label="导出范围"
          value={mode}
          options={[
            { value: 'full', label: '完整归档（代码 + 设计 + 记忆 + 文档）' },
            { value: 'code-only', label: '仅代码（轻量包）' },
          ]}
          onChange={(value) => setMode(value as 'full' | 'code-only')}
        />
      </label>
      <label className="ec-settings__field">
        <span>加密归档（口令保护）</span>
        <Switch checked={encrypted} onChange={setEncrypted} aria-label="加密归档" />
      </label>
      {encrypted ? (
        <label className="ec-settings__field">
          <span>口令</span>
          <Input
            type="password"
            value={exportPassword}
            onChange={setExportPassword}
            aria-label="归档口令"
            placeholder="设置用于加密归档的口令"
          />
        </label>
      ) : null}
      <Button
        variant="primary"
        loading={busy}
        disabled={!projectId || (encrypted && exportPassword.length === 0)}
        onClick={() => void exportNow()}
      >
        一键导出
      </Button>
      {exportResult ? (
        <p className="ec-settings__notice" role="status">
          {`已导出 ${exportResult.mode === 'full' ? '完整归档' : '仅代码包'}：${exportResult.filePath}（${(
            exportResult.bytes / 1024
          ).toFixed(1)} KB）`}
        </p>
      ) : null}

      <label className="ec-settings__field">
        <span>导入归档包（.ecpkg）</span>
        <Input
          value={importPath}
          onChange={setImportPath}
          aria-label="归档包路径"
          placeholder="D:\\backup\\ec-2026.ecpkg"
        />
      </label>
      <label className="ec-settings__field">
        <span>归档口令（加密包才需要）</span>
        <Input
          type="password"
          value={importPassword}
          onChange={setImportPassword}
          aria-label="导入口令"
          placeholder="未加密的归档可留空"
        />
      </label>
      <Button
        variant="secondary"
        loading={busy}
        disabled={!importPath.trim()}
        onClick={() => void importNow()}
      >
        导入归档
      </Button>
      {importResult ? (
        <p className="ec-settings__notice" role="status">
          {`导入完成：记忆 ${importResult.counts.memory} 条、文档 ${importResult.counts.docs} 篇、代码 ${importResult.counts.codeFiles} 个文件；冲突 ${importResult.conflicted} 项已按"不覆盖"处理`}
        </p>
      ) : null}

      <h3>定时本地备份</h3>
      <label className="ec-settings__field">
        <span>备份间隔（小时）</span>
        <Input value={intervalHours} onChange={setIntervalHours} aria-label="备份间隔" />
      </label>
      <label className="ec-settings__field">
        <span>备份目录</span>
        <Input
          value={backupDir}
          onChange={setBackupDir}
          aria-label="备份目录"
          placeholder="D:\\EveryOneCoding\\backup"
        />
      </label>
      <div className="ec-settings__actions">
        <Button variant="secondary" loading={busy} onClick={() => void saveSchedule()}>
          保存备份计划
        </Button>
        <span className="ec-settings__hint">
          {lastRunAt
            ? `上次备份：${new Date(lastRunAt).toLocaleString('zh-CN')}`
            : '尚未执行过备份'}
        </span>
      </div>

      {notice ? (
        <p className="ec-settings__notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="ec-settings__error">{error}</p> : null}
    </section>
  );
}
