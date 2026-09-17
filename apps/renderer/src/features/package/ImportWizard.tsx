/**
 * 导入向导（T8-03 渲染层）。
 *
 * 步骤：选文件 → 校验 → 选模式 → 差异预览（冲突解决）→ 执行 → 报告。
 * 端口经 `usePackageApi()` 注入；未注入显示装配引导而非崩溃。
 *
 * 关键约束：冲突条目必须全部决策（默认推荐"保留本地"，绝不自动覆盖），
 * 存在未决策冲突时"执行导入"按钮禁用（E2E-14）。
 */

import { useMemo, useState } from 'react';
import { Button, Select } from '@ec/ui';

import {
  usePackageApi,
  type ConflictDecision,
  type ConflictResolution,
  type ImportMode,
  type ImportReportData,
  type PackageDiffPreview,
  type PackageObjectType,
  type VerificationReport,
} from './package-api';
import { ConflictResolver } from './ConflictResolver';
import { ImportReport } from './ImportReport';

type Step = 'select' | 'mode' | 'diff' | 'report';

/** 各模式参与的类别（与 package-kit 口径一致；渲染层不依赖 Node 包） */
const PARTICIPATING: Record<ImportMode, PackageObjectType[]> = {
  'full-restore': ['memory', 'document', 'design', 'registry', 'code', 'anchor', 'pipeline'],
  merge: ['memory', 'document', 'design', 'registry', 'code', 'anchor', 'pipeline'],
  'memory-only': ['memory'],
  'documents-only': ['document'],
  'code-only': ['code', 'design', 'registry', 'anchor', 'pipeline'],
};

const MODE_OPTIONS: Array<{ label: string; value: ImportMode }> = [
  { label: '完整恢复（覆盖同名项目）', value: 'full-restore' },
  { label: '合并（按 id + updatedAt 解决冲突）', value: 'merge' },
  { label: '仅记忆', value: 'memory-only' },
  { label: '仅文档', value: 'documents-only' },
  { label: '仅代码', value: 'code-only' },
];

export function ImportWizard(): JSX.Element {
  const api = usePackageApi();
  const [step, setStep] = useState<Step>('select');
  const [packagePath, setPackagePath] = useState<string | null>(null);
  const [verifyReport, setVerifyReport] = useState<VerificationReport | null>(null);
  const [mode, setMode] = useState<ImportMode>('full-restore');
  const [modePreview, setModePreview] = useState<{ toApply: number; toOverwrite: number; toSkip: number; summary: string } | null>(null);
  const [diff, setDiff] = useState<PackageDiffPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ConflictResolution>>({});
  const [report, setReport] = useState<ImportReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const participating = useMemo(() => new Set(PARTICIPATING[mode]), [mode]);

  const conflictedItems = useMemo(
    () => (diff?.items ?? []).filter((i) => i.classification === 'conflicted' && participating.has(i.incoming.type)),
    [diff, participating],
  );
  const undecidedCount = conflictedItems.filter((i) => decisions[i.incoming.id] === undefined).length;
  const canImport = verifyReport?.ok === true && undecidedCount === 0;

  if (api === null) {
    return (
      <div className="import-wizard import-wizard--unwired">
        <p>未装配 PackageApi：请由外壳经 globalThis.__EC_PACKAGE__ 注入归档与迁移端口后再使用导入功能。</p>
      </div>
    );
  }

  const reset = (): void => {
    setStep('select');
    setPackagePath(null);
    setVerifyReport(null);
    setModePreview(null);
    setDiff(null);
    setDecisions({});
    setReport(null);
    setError(null);
  };

  const handlePick = async (): Promise<void> => {
    setError(null);
    const path = await api.pickPackagePath();
    if (path === null) return;
    setPackagePath(path);
    const v = await api.verifyPackage(path);
    setVerifyReport(v);
    if (!v.ok) {
      setError(v.failureMessage ?? '包校验未通过');
      return;
    }
    setStep('mode');
  };

  const handleModeChange = async (next: ImportMode): Promise<void> => {
    if (packagePath === null) return;
    setMode(next);
    const [mp, dp] = await Promise.all([api.previewMode(packagePath, next), api.previewImport(packagePath)]);
    setModePreview({ toApply: mp.toApply, toOverwrite: mp.toOverwrite, toSkip: mp.toSkip, summary: mp.summary });
    setDiff(dp);
    setStep('diff');
  };

  const handleDecisionChange = (id: string, resolution: ConflictResolution): void => {
    setDecisions((prev) => ({ ...prev, [id]: resolution }));
  };

  const handleBatchChange = (type: PackageObjectType, resolution: ConflictResolution): void => {
    setDecisions((prev) => {
      const next = { ...prev };
      for (const item of conflictedItems) {
        if (item.incoming.type === type) next[item.incoming.id] = resolution;
      }
      return next;
    });
  };

  const decisionList = (): ConflictDecision[] =>
    Object.entries(decisions).map(([id, resolution]) => ({ id, resolution }));

  const handleImport = async (): Promise<void> => {
    if (packagePath === null || !canImport) return;
    setError(null);
    try {
      const r = await api.importPackage({ packagePath, mode, decisions: decisionList() });
      setReport(r);
      setStep('report');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="import-wizard">
      {step === 'select' && (
        <section className="import-wizard__select">
          <h2>导入 .ecpkg 包</h2>
          <p>选择要导入的归档包，将先进行格式/完整性/签名校验。</p>
          <Button onClick={() => void handlePick()}>选择包文件</Button>
          {packagePath && <p className="import-wizard__path">已选择：{packagePath}</p>}
          {verifyReport && !verifyReport.ok && (
            <div className="import-wizard__verify-fail" role="alert">
              <p><strong>校验未通过：</strong>{verifyReport.failureMessage}</p>
              <ul>
                {verifyReport.steps.map((s) => (
                  <li key={s.step} className={s.ok ? 'ok' : 'fail'}>
                    {s.step}：{s.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && verifyReport?.ok && <p className="import-wizard__error" role="alert">{error}</p>}
        </section>
      )}

      {step === 'mode' && (
        <section className="import-wizard__mode">
          <h2>选择导入模式</h2>
          <Select
            aria-label="导入模式"
            options={MODE_OPTIONS}
            value={mode}
            onChange={(v) => void handleModeChange(v as ImportMode)}
          />
          {modePreview && (
            <div className="import-wizard__mode-preview" data-testid="mode-preview">
              <p>将新增 {modePreview.toApply} 个、覆盖 {modePreview.toOverwrite} 个、跳过 {modePreview.toSkip} 个。</p>
              <p>{modePreview.summary}</p>
            </div>
          )}
          <Button onClick={() => void handleModeChange(mode)}>下一步：差异预览</Button>
        </section>
      )}

      {step === 'diff' && (
        <section className="import-wizard__diff">
          <h2>差异预览与冲突解决</h2>
          <div className="import-wizard__counts">
            <span data-testid="count-added">新增 {diff?.counts.added ?? 0}</span>
            <span data-testid="count-conflicted">冲突 {diff?.counts.conflicted ?? 0}</span>
            <span data-testid="count-unchanged">不变 {diff?.counts.unchanged ?? 0}</span>
            <span data-testid="count-missing">缺失 {diff?.counts.missing ?? 0}</span>
          </div>
          {conflictedItems.length > 0 && (
            <ConflictResolver
              items={conflictedItems}
              decisions={decisions}
              onChange={handleDecisionChange}
              onBatchChange={handleBatchChange}
            />
          )}
          {undecidedCount > 0 && (
            <p className="import-wizard__undecided" role="alert">还有 {undecidedCount} 个冲突条目未决策，请先解决。</p>
          )}
          <Button onClick={() => void handleImport()} disabled={!canImport} data-testid="import-button">
            执行导入
          </Button>
          {error && <p className="import-wizard__error" role="alert">{error}</p>}
        </section>
      )}

      {step === 'report' && report && (
        <ImportReport
          report={report}
          onRetry={() => void handleImport()}
          onExportReport={() => {
            /* 导出报告由外壳写盘；测试用 spy 断言调用 */
          }}
        />
      )}

      {step !== 'select' && step !== 'report' && (
        <Button onClick={reset}>重新选择</Button>
      )}
    </div>
  );
}
