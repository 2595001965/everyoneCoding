/**
 * 导入报告（T8-03 渲染层）。
 *
 * 展示四类统计（新增/冲突/不变/缺失）、冲突决策摘要、失败清单，
 * 并提供"重试失败项"与"导出报告"两个动作（由向导注入回调）。
 */

import { Button } from '@ec/ui';

import type { ImportReportData } from './package-api';

export interface ImportReportProps {
  report: ImportReportData;
  onRetry: () => void;
  onExportReport: () => void;
}

export function ImportReport({ report, onRetry, onExportReport }: ImportReportProps): JSX.Element {
  const { counts, resolutions, failures, applied } = report;

  return (
    <div className="import-report">
      <h2 data-testid="report-title">导入完成</h2>

      <div className="import-report__counts">
        <div data-testid="count-added">新增 {counts.added}</div>
        <div data-testid="count-conflicted">冲突 {counts.conflicted}</div>
        <div data-testid="count-unchanged">不变 {counts.unchanged}</div>
        <div data-testid="count-missing">缺失 {counts.missing}</div>
      </div>

      <div className="import-report__applied">
        <span data-testid="applied-projects">项目 {applied.createdProjects + applied.updatedProjects}</span>
        <span data-testid="applied-objects">对象 {applied.createdObjects + applied.updatedObjects + applied.keptBothObjects}</span>
        <span data-testid="applied-memory">记忆 {applied.memoryCreated + applied.memoryUpdated}</span>
        <span data-testid="applied-files">文件 {applied.filesWritten}</span>
      </div>

      <div className="import-report__resolutions" data-testid="report-resolutions">
        保留本地 {resolutions.keepLocal} / 采用包内 {resolutions.takeNew} / 两者都保留 {resolutions.keepBoth}
      </div>

      {failures.length > 0 && (
        <div className="import-report__failures">
          <p data-testid="failure-count">失败 {failures.length} 项：</p>
          <ul>
            {failures.map((f, i) => (
              <li key={i} data-testid="failure">
                {f.path}：{f.reason}
              </li>
            ))}
          </ul>
          <Button onClick={onRetry} data-testid="retry-button">
            重试失败项
          </Button>
        </div>
      )}

      <Button onClick={onExportReport} data-testid="export-button">
        导出报告
      </Button>
    </div>
  );
}
