/**
 * 定时备份设置（T8-04 / FR-PKG-13）。
 *
 * 全部 UI 操作（硬约束 5）：开关 / 频率 / 时间 / 目录 / 保留份数 → 保存；
 * 立即备份；快照列表与一键回滚（回滚前由端口自动做安全快照，UI 二次确认）。
 * 调度本身在客户端内实现（BackupScheduler，不依赖系统任务计划程序）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Modal, Select, Switch, Tag } from '@ec/ui';

import type { BackupFrequency, BackupSettingsData, SnapshotInfo } from './package-api';
import { usePackageApi } from './package-api';

const FREQUENCY_OPTIONS: Array<{ value: BackupFrequency; label: string }> = [
  { value: 'daily', label: '每日' },
  { value: 'weekly', label: '每周' },
];

const DEFAULT_SETTINGS: BackupSettingsData = {
  enabled: false,
  frequency: 'daily',
  timeOfDay: '09:00',
  targetDir: '',
  keepCount: 7,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function BackupSettings(): JSX.Element {
  const api = usePackageApi();
  const [settings, setSettings] = useState<BackupSettingsData>(DEFAULT_SETTINGS);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 待回滚的快照（Modal 二次确认用） */
  const [pendingRestore, setPendingRestore] = useState<SnapshotInfo | null>(null);

  const refreshSnapshots = useCallback(async (): Promise<void> => {
    if (api === null) return;
    setSnapshots(await api.listSnapshots());
  }, [api]);

  useEffect(() => {
    if (api === null) return;
    void (async () => {
      const [loadedSettings, snapshotList] = await Promise.all([
        api.getBackupSettings(),
        api.listSnapshots(),
      ]);
      setSettings(loadedSettings);
      setSnapshots(snapshotList);
      setLoaded(true);
    })();
  }, [api]);

  if (api === null) {
    return (
      <section aria-label="定时备份">
        <h3>定时备份</h3>
        <p>外壳尚未注入 PackageApi（__EC_PACKAGE__），备份设置不可用。</p>
      </section>
    );
  }

  const save = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      if (!/^\d{4}-\d{2}-\d{2}/.test('') && settings.keepCount < 1) {
        setMessage('保留份数至少为 1');
        return;
      }
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(settings.timeOfDay)) {
        setMessage('触发时间格式应为 HH:mm（如 09:00）');
        return;
      }
      await api.saveBackupSettings(settings);
      setMessage('备份设置已保存');
    } finally {
      setBusy(false);
    }
  };

  const backupNow = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const snapshot = await api.createBackupNow();
      setMessage(`已创建快照：${snapshot.fileName}（${formatBytes(snapshot.sizeBytes)}）`);
      await refreshSnapshots();
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = async (): Promise<void> => {
    if (pendingRestore === null) return;
    setBusy(true);
    try {
      const report = await api.restoreFromSnapshot(pendingRestore.path);
      setMessage(
        `已回滚到 ${pendingRestore.fileName}；回滚前已自动备份当前状态（新增 ${report.counts.added}，冲突 ${report.counts.conflicted}）`,
      );
      setPendingRestore(null);
      await refreshSnapshots();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ec-backup-settings" aria-label="定时备份">
      <h3>定时本地备份</h3>
      {loaded ? null : <p>加载中…</p>}

      <div className="ec-backup-settings__form">
        <label>
          <Switch
            checked={settings.enabled}
            aria-label="启用定时备份"
            onChange={(checked) => setSettings((prev) => ({ ...prev, enabled: checked }))}
          />{' '}
          启用定时备份
        </label>

        <label>
          频率
          <Select
            options={FREQUENCY_OPTIONS}
            value={settings.frequency}
            aria-label="备份频率"
            onChange={(value) =>
              setSettings((prev) => ({ ...prev, frequency: value as BackupFrequency }))
            }
          />
        </label>

        <label>
          触发时间（HH:mm）
          <Input
            value={settings.timeOfDay}
            aria-label="触发时间"
            onChange={(value) => setSettings((prev) => ({ ...prev, timeOfDay: value }))}
          />
        </label>

        <label>
          快照目录
          <Input
            value={settings.targetDir}
            aria-label="快照目录"
            placeholder="如 D:\EveryoneCoding-Backups"
            onChange={(value) => setSettings((prev) => ({ ...prev, targetDir: value }))}
          />
        </label>

        <label>
          保留份数
          <Input
            value={String(settings.keepCount)}
            aria-label="保留份数"
            onChange={(value) => {
              const parsed = Number(value);
              setSettings((prev) => ({
                ...prev,
                keepCount: Number.isFinite(parsed) ? Math.floor(parsed) : 0,
              }));
            }}
          />
        </label>

        <div className="ec-backup-settings__actions">
          <Button onClick={() => void save()} disabled={busy}>
            保存设置
          </Button>
          <Button variant="primary" onClick={() => void backupNow()} disabled={busy}>
            立即备份
          </Button>
        </div>
        {message !== null && (
          <p role="status" aria-live="polite">
            {message}
          </p>
        )}
      </div>

      <h4>
        快照列表（{snapshots.length}）<Tag>保留最近 {settings.keepCount} 份</Tag>
      </h4>
      {snapshots.length === 0 ? (
        <p>暂无快照。启用定时备份或点击「立即备份」生成第一份。</p>
      ) : (
        <ul aria-label="备份快照">
          {snapshots.map((snapshot) => (
            <li key={snapshot.path}>
              <code>{snapshot.fileName}</code> · {formatTime(snapshot.createdAt)} ·{' '}
              {formatBytes(snapshot.sizeBytes)}
              <Button size="sm" disabled={busy} onClick={() => setPendingRestore(snapshot)}>
                回滚到此快照
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={pendingRestore !== null}
        title="确认回滚工作区"
        onOpenChange={(open) => {
          if (!open) setPendingRestore(null);
        }}
        footer={
          <>
            <Button onClick={() => setPendingRestore(null)}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={() => void confirmRestore()}>
              确认回滚
            </Button>
          </>
        }
      >
        <p>
          将把工作区恢复到快照 <code>{pendingRestore?.fileName ?? ''}</code> 的状态。
          <strong>回滚前会自动备份当前状态</strong>（回滚错了还可以再滚回来）。
        </p>
      </Modal>
    </section>
  );
}
