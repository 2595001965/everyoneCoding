import { useState } from 'react';
import { Button } from '@ec/ui';
import { BackupSettings } from './BackupSettings';
import { LegacyPackageMigration } from './LegacyPackageMigration';
import { ExportWizard } from './ExportWizard';
import { ImportWizard } from './ImportWizard';
import { HealingReportView } from './HealingReport';
import { PackageApiProvider, readInjectedPackageApi, type HealingReportData } from './package-api';

export function downloadReport(value: unknown, name: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function ArchiveSettings({
  projects,
}: {
  projects: Array<{ id: string; name: string }>;
}): JSX.Element {
  const api = readInjectedPackageApi();
  const [tab, setTab] = useState('export');
  const [report, setReport] = useState<HealingReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heal = async (): Promise<void> => {
    try {
      if (api) setReport(await api.runHealing(null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <PackageApiProvider api={api}>
      <nav aria-label="归档操作">
        {Object.entries({
          export: '导出归档',
          import: '恢复数据备份',
          legacy: '旧包迁移',
          backup: '定时备份与恢复',
          healing: '自愈检查',
        }).map(([id, label]) => (
          <Button key={id} onClick={() => setTab(id)}>
            {label}
          </Button>
        ))}
      </nav>
      {tab === 'export' && <ExportWizard projects={projects} />}
      {tab === 'import' && <ImportWizard />}
      {tab === 'legacy' && <LegacyPackageMigration />}
      {tab === 'backup' && <BackupSettings />}
      {tab === 'healing' && (
        <>
          <Button onClick={() => void heal()}>检查并自愈</Button>
          <HealingReportView
            report={report}
            onRerun={() => void heal()}
            onExport={() => downloadReport(report, 'healing-report.json')}
          />
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </PackageApiProvider>
  );
}
