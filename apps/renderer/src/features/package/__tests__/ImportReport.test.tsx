/**
 * ImportReport 渲染层测试（T8-03 / FR-PKG-12）。
 *
 * 覆盖：四类统计卡片、落库统计、冲突决策摘要、失败清单与"重试失败项"、
 * "导出报告"两个动作回调。纯展示 + 回调断言。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ImportReportData } from '../package-api';
import { ImportReport } from '../ImportReport';

function okReport(): ImportReportData {
  return {
    mode: 'full-restore',
    counts: { added: 3, conflicted: 2, unchanged: 1, missing: 0 },
    applied: {
      createdProjects: 1,
      updatedProjects: 1,
      createdObjects: 3,
      updatedObjects: 1,
      keptBothObjects: 1,
      memoryCreated: 2,
      memoryUpdated: 1,
      memorySuperseded: 0,
      filesWritten: 4,
    },
    resolutions: { keepLocal: 1, takeNew: 0, keepBoth: 1 },
    failures: [],
    reportPath: null,
    durationMs: 123,
  };
}

describe('ImportReport', () => {
  it('展示四类统计卡片', () => {
    render(<ImportReport report={okReport()} onRetry={vi.fn()} onExportReport={vi.fn()} />);
    expect(screen.getByTestId('count-added')).toHaveTextContent('新增 3');
    expect(screen.getByTestId('count-conflicted')).toHaveTextContent('冲突 2');
    expect(screen.getByTestId('count-unchanged')).toHaveTextContent('不变 1');
    expect(screen.getByTestId('count-missing')).toHaveTextContent('缺失 0');
  });

  it('展示落库统计（项目/对象/记忆/文件）', () => {
    render(<ImportReport report={okReport()} onRetry={vi.fn()} onExportReport={vi.fn()} />);
    expect(screen.getByTestId('applied-projects')).toHaveTextContent('项目 2');
    expect(screen.getByTestId('applied-objects')).toHaveTextContent('对象 5');
    expect(screen.getByTestId('applied-memory')).toHaveTextContent('记忆 3');
    expect(screen.getByTestId('applied-files')).toHaveTextContent('文件 4');
  });

  it('展示冲突决策摘要（默认不覆盖：keepLocal 占多数）', () => {
    render(<ImportReport report={okReport()} onRetry={vi.fn()} onExportReport={vi.fn()} />);
    expect(screen.getByTestId('report-resolutions')).toHaveTextContent('保留本地 1 / 采用包内 0 / 两者都保留 1');
  });

  it('失败清单 + 重试按钮回调 onRetry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const report: ImportReportData = {
      ...okReport(),
      failures: [
        { path: 'memory/longterm.jsonl', reason: '写入失败' },
        { path: 'documents/a.md', reason: '校验未通过' },
      ],
    };
    render(<ImportReport report={report} onRetry={onRetry} onExportReport={vi.fn()} />);
    expect(screen.getByTestId('failure-count')).toHaveTextContent('失败 2 项：');
    expect(screen.getAllByTestId('failure')).toHaveLength(2);
    expect(screen.getByText('memory/longterm.jsonl：写入失败')).toBeInTheDocument();

    await user.click(screen.getByTestId('retry-button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('"导出报告"按钮回调 onExportReport', async () => {
    const user = userEvent.setup();
    const onExportReport = vi.fn();
    render(<ImportReport report={okReport()} onRetry={vi.fn()} onExportReport={onExportReport} />);
    await user.click(screen.getByTestId('export-button'));
    expect(onExportReport).toHaveBeenCalledTimes(1);
  });
});
