/**
 * BackupPanel（T9-03 / FR-SET-04 + T8-02/T8-03 打通）：数据导出与本地备份。
 *
 * 完整数据备份 ZIP 与 metadata-free 源码 ZIP 分开；旧 .ecpkg 通过独立迁移入口处理。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select } from '@ec/ui';

import { useSettings, type ExportResult, type ImportResult } from './settings-api';

export interface BackupPanelProps {
  /** 当前项目 id（由外层传入；未选项目时禁用导出） */
  projectId?: string | undefined;
}

export function BackupPanel({ projectId }: BackupPanelProps): JSX.Element {
  const api = useSettings();
  const [mode, setMode] = useState<'full' | 'code-only'>('full');
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [importPath, setImportPath] = useState('');
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
        }),
      );
      setNotice('导出完成（本地文件，未上传任何服务器）');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, mode, projectId]);

  const importNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setImportResult(
        await api.importPackage({
          filePath: importPath.trim(),
        }),
      );
      setNotice('导入完成');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, importPath]);

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
        新导出为普通 ZIP。本地数据备份 ZIP 可恢复 EveryoneCoding 数据；源码 ZIP 可用打开文件夹/ZIP
        接入，不依赖产品元数据。
      </p>

      <label className="ec-settings__field">
        <span>导出范围</span>
        <Select
          aria-label="导出范围"
          value={mode}
          options={[
            { value: 'full', label: '完整数据备份（代码 + 设计 + 记忆 + 文档）' },
            { value: 'code-only', label: '源码 ZIP（无产品元数据）' },
          ]}
          onChange={(value) => setMode(value as 'full' | 'code-only')}
        />
      </label>
      <Button
        variant="primary"
        loading={busy}
        disabled={!projectId}
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
        <span>恢复完整数据备份（.zip）</span>
        <Input
          value={importPath}
          onChange={setImportPath}
          aria-label="备份 ZIP 路径"
          placeholder="D:\\backup\\ec-2026.zip"
        />
      </label>
      <Button
        variant="secondary"
        loading={busy}
        disabled={!importPath.trim()}
        onClick={() => void importNow()}
      >
        恢复备份
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
