/**
 * ExportProgress 渲染层测试（T8-02）。
 *
 * 验证：阶段中文标签、processed/total、当前文件、对象计数、排除下降率、
 * 脱敏命中数、失败清单都从 ExportProgressSnapshot 正确渲染。
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ExportProgress } from '../ExportProgress';
import type { ExportProgressSnapshot } from '../package-api';

function snapshot(overrides: Partial<ExportProgressSnapshot> = {}): ExportProgressSnapshot {
  return {
    stage: 'writing',
    processed: 3,
    total: 10,
    currentFile: 'projects/p1/code/src/app.ts',
    counts: { projects: 1, memoryItems: 2, documents: 1, pages: 1, codeFiles: 3, attachments: 0 },
    failures: [],
    excludeStats: {
      excludedFiles: 5,
      excludedBytes: 8000,
      totalFiles: 10,
      totalBytes: 10000,
      reductionRatio: 0.8,
      hitsByPattern: [{ pattern: 'node_modules/**', files: 5, bytes: 8000 }],
    },
    redactionFindings: [{ path: 'x.ts', ruleId: 'api-key', line: 1, preview: '***' }],
    elapsedMs: 500,
    ...overrides,
  };
}

describe('ExportProgress', () => {
  it('snapshot 为 null 时渲染 idle 态', () => {
    render(<ExportProgress snapshot={null} />);
    expect(screen.getByTestId('export-progress')).toHaveAttribute('data-state', 'idle');
  });

  it('渲染阶段标签 / 进度 / 当前文件 / 计数 / 下降率 / 脱敏命中', () => {
    render(<ExportProgress snapshot={snapshot()} />);
    expect(screen.getByTestId('export-progress')).toHaveAttribute('data-state', 'writing');
    expect(screen.getByText('阶段：写入中')).toBeInTheDocument();
    expect(screen.getByText(/进度：3\/10/)).toBeInTheDocument();
    expect(screen.getByText('当前文件：projects/p1/code/src/app.ts')).toBeInTheDocument();
    expect(screen.getByText(/对象计数：项目 1/)).toBeInTheDocument();
    expect(screen.getByText('体积下降率：80%')).toBeInTheDocument();
    expect(screen.getByText('脱敏命中：1 处')).toBeInTheDocument();
  });

  it('失败清单渲染', () => {
    render(
      <ExportProgress
        snapshot={snapshot({
          failures: [{ path: 'projects/p1/code/bad.ts', reason: '读取失败' }],
        })}
      />,
    );
    expect(screen.getByTestId('export-failures')).toHaveTextContent('bad.ts');
    expect(screen.getByTestId('export-failures')).toHaveTextContent('读取失败');
  });

  it('排除统计为 null 时不渲染下降率', () => {
    const { container } = render(<ExportProgress snapshot={snapshot({ excludeStats: null })} />);
    expect(container.textContent).not.toContain('体积下降率');
  });
});
