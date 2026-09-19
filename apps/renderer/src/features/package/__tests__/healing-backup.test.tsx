import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HealingReportView } from '../HealingReport';
import { BackupSettings } from '../BackupSettings';
import { PackageApiProvider, type PackageApi } from '../package-api';
import type { HealingReportData, BackupSettingsData, SnapshotInfo } from '../package-api';

/** 内存假 PackageApi（只实现备份/自愈相关方法，其余 throw） */
function createFakeApi(options: { adoptOk?: boolean } = {}) {
  const settings: BackupSettingsData = {
    enabled: true,
    frequency: 'weekly',
    timeOfDay: '08:30',
    targetDir: 'D:\\EC-Backups',
    keepCount: 5,
  };
  const savedSettings: BackupSettingsData[] = [];
  const snapshots: SnapshotInfo[] = [
    {
      fileName: 'ec-backup-20260912-080000-000-scheduled.ecpkg',
      path: 'D:\\EC-Backups\\ec-backup-20260912-080000-000-scheduled.ecpkg',
      createdAt: new Date(2026, 8, 12, 8, 0).getTime(),
      sizeBytes: 1024 * 512,
      scope: 'all',
    },
  ];
  const restoreCalls: string[] = [];
  const backupNowCalls: number[] = [];
  const adoptCalls: Array<{ anchorId: string; filePath: string; symbol: string }> = [];

  const api: PackageApi = {
    pickExportPath: () => Promise.reject(new Error('not implemented')),
    exportPackage: () => Promise.reject(new Error('not implemented')),
    listExportPresets: () => Promise.reject(new Error('not implemented')),
    saveExportPreset: () => Promise.reject(new Error('not implemented')),
    deleteExportPreset: () => Promise.reject(new Error('not implemented')),
    pickPackagePath: () => Promise.reject(new Error('not implemented')),
    verifyPackage: () => Promise.reject(new Error('not implemented')),
    previewImport: () => Promise.reject(new Error('not implemented')),
    previewMode: () => Promise.reject(new Error('not implemented')),
    importPackage: () => Promise.reject(new Error('not implemented')),
    runHealing: () => Promise.reject(new Error('not implemented')),
    adoptAnchorCandidate: (anchorId, filePath, symbol) => {
      adoptCalls.push({ anchorId, filePath, symbol });
      return Promise.resolve(options.adoptOk !== false);
    },
    getBackupSettings: () => Promise.resolve(settings),
    saveBackupSettings: (next) => {
      savedSettings.push(next);
      return Promise.resolve();
    },
    createBackupNow: () => {
      backupNowCalls.push(1);
      snapshots.unshift({
        fileName: 'ec-backup-20260913-090000-000-manual.ecpkg',
        path: 'D:\\EC-Backups\\ec-backup-20260913-090000-000-manual.ecpkg',
        createdAt: new Date(2026, 8, 13, 9, 0).getTime(),
        sizeBytes: 2048,
        scope: 'all',
      });
      return Promise.resolve(snapshots[0]!);
    },
    listSnapshots: () => Promise.resolve([...snapshots]),
    restoreFromSnapshot: (path) => {
      restoreCalls.push(path);
      return Promise.resolve({
        mode: 'full-restore',
        counts: { added: 3, conflicted: 0, unchanged: 0, missing: 0 },
        applied: {
          createdProjects: 1,
          updatedProjects: 0,
          createdObjects: 3,
          updatedObjects: 0,
          keptBothObjects: 0,
          memoryCreated: 0,
          memoryUpdated: 0,
          memorySuperseded: 0,
          filesWritten: 0,
        },
        resolutions: { keepLocal: 0, takeNew: 3, keepBoth: 0 },
        failures: [],
        reportPath: null,
        durationMs: 10,
      });
    },
  };

  return { api, savedSettings, restoreCalls, backupNowCalls, adoptCalls, snapshots };
}

const sampleReport: HealingReportData = {
  anchors: {
    total: 3,
    successRate: 2 / 3,
    outcomes: [
      {
        anchorId: 'anc-1',
        symbol: 'LoginController',
        oldFilePath: 'src/auth.ts',
        newFilePath: 'src/auth.ts',
        status: 'relocated',
        reason: '依据符号名重新定位（行号已更新）',
      },
      {
        anchorId: 'anc-2',
        symbol: 'MovedService',
        oldFilePath: 'src/old/moved.ts',
        newFilePath: 'src/svc/moved.ts',
        status: 'relocated',
        reason: '原文件不存在（可能被移动或重命名）；依据代码内锚点标记重新定位',
      },
      {
        anchorId: 'anc-3',
        symbol: 'GhostRepo',
        oldFilePath: 'src/gone.ts',
        newFilePath: null,
        status: 'ambiguous',
        reason: '在 2 个文件中找到疑似位置，需人工确认',
        candidates: [{ filePath: 'src/a.ts', symbol: 'GhostRepo', startLine: 5, endLine: 5 }],
      },
    ],
  },
  links: {
    fixedCount: 1,
    unresolvableCount: 1,
    outcomes: [
      {
        linkId: 'l1',
        sourceType: 'memory',
        sourceId: 'm1',
        targetType: 'document',
        targetId: 'doc-old',
        status: 'fixed',
        newTargetId: 'doc-new',
        detail: '按名称重定向',
      },
      {
        linkId: 'l2',
        sourceType: 'memory',
        sourceId: 'm2',
        targetType: 'document',
        targetId: 'doc-gone',
        status: 'unresolvable',
        newTargetId: null,
        detail: '找不到候选',
      },
    ],
  },
  attachments: {
    checked: 4,
    issues: [{ hashName: 'ffff.png', status: 'missing', detail: '附件缺失，可从原设备补齐' }],
  },
  suggestions: ['有 1 个锚点存在多个疑似位置，请在锚点面板逐一确认候选'],
};

describe('HealingReportView（T8-04）', () => {
  it('渲染三段报告与成功率', () => {
    render(<HealingReportView report={sampleReport} />);
    expect(screen.getByText(/成功率 66\.7%/)).toBeTruthy();
    expect(screen.getByText(/自动修复 1，未修复 1/)).toBeTruthy();
    // detail 与 hashName 分属不同元素，用子串匹配
    expect(screen.getByText(/可从原设备补齐/)).toBeTruthy();
    expect(screen.getByText(/逐一确认候选/)).toBeTruthy();
  });

  it('report 为 null 显示空态', () => {
    render(<HealingReportView report={null} />);
    expect(screen.getByText('尚无自愈报告')).toBeTruthy();
  });

  it('ambiguous 锚点可采纳候选（调用端口并标记已采纳）', async () => {
    const fake = createFakeApi();
    render(
      <PackageApiProvider api={fake.api}>
        <HealingReportView report={sampleReport} />
      </PackageApiProvider>,
    );
    const adoptButtons = screen.getAllByRole('button', { name: /采纳/ });
    expect(adoptButtons.length).toBe(1);
    fireEvent.click(adoptButtons[0]!);
    await waitFor(() => expect(fake.adoptCalls.length).toBe(1));
    expect(fake.adoptCalls[0]).toEqual({
      anchorId: 'anc-3',
      filePath: 'src/a.ts',
      symbol: 'GhostRepo',
    });
    await waitFor(() => expect(screen.getAllByText('已采纳').length).toBe(1));
  });
});

describe('BackupSettings（T8-04 / FR-PKG-13）', () => {
  it('加载设置与快照列表', async () => {
    const fake = createFakeApi();
    render(
      <PackageApiProvider api={fake.api}>
        <BackupSettings />
      </PackageApiProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText('保留份数')).toHaveValue('5'));
    expect((screen.getByLabelText('保留份数') as HTMLInputElement).value).toBe('5');
    expect(await screen.findByText(/ec-backup-20260912-080000/)).toBeTruthy();
    expect(screen.getByText(/保留最近 5 份/)).toBeTruthy();
  });

  it('修改保留份数后保存（走端口）', async () => {
    const fake = createFakeApi();
    render(
      <PackageApiProvider api={fake.api}>
        <BackupSettings />
      </PackageApiProvider>,
    );
    const keepInput = await screen.findByLabelText('保留份数');
    fireEvent.change(keepInput, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(fake.savedSettings.length).toBe(1));
    expect(fake.savedSettings[0]?.keepCount).toBe(3);
    expect(screen.getByText('备份设置已保存')).toBeTruthy();
  });

  it('立即备份生成快照并刷新列表', async () => {
    const fake = createFakeApi();
    render(
      <PackageApiProvider api={fake.api}>
        <BackupSettings />
      </PackageApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '立即备份' }));
    await waitFor(() => expect(fake.backupNowCalls.length).toBe(1));
    await waitFor(() =>
      expect(screen.getAllByText(/ec-backup-20260913-090000/).length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.getByText(/已创建快照/)).toBeTruthy();
  });

  it('回滚需二次确认，确认后调用端口', async () => {
    const fake = createFakeApi();
    render(
      <PackageApiProvider api={fake.api}>
        <BackupSettings />
      </PackageApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '回滚到此快照' }));
    // Modal 出现，取消按钮可关
    expect(screen.getByText('确认回滚工作区')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByText('确认回滚工作区')).toBeNull());
    expect(fake.restoreCalls.length).toBe(0);

    // 再次打开并确认
    fireEvent.click(screen.getByRole('button', { name: '回滚到此快照' }));
    fireEvent.click(screen.getByRole('button', { name: '确认回滚' }));
    await waitFor(() => expect(fake.restoreCalls.length).toBe(1));
    expect(fake.restoreCalls[0]).toContain('ec-backup-20260912-080000');
    expect(screen.getByText(/已回滚到/)).toBeTruthy();
  });
});
