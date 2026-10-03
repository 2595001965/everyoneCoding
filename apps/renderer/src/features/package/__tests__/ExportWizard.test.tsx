/**
 * ExportWizard 渲染层测试（T8-02 / FR-PKG-12）。
 *
 * 覆盖：未注入端口的装配引导、脱敏关闭的二次确认 Modal、普通源码 ZIP 契约、
 * 导出完成结果展示、进度回放。只走内存假端口，不跑 Node 流水线。
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { PackageApiProvider } from '../package-api';
import { ExportWizard } from '../ExportWizard';
import { createFakePackageApi } from '../fake-package-api';
import type { ExportProgressSnapshot } from '../package-api';

describe('ExportWizard', () => {
  it('未注入端口：渲染装配引导而不崩溃', () => {
    render(<ExportWizard />);
    expect(screen.getByTestId('export-guidance')).toBeInTheDocument();
  });

  it('脱敏开关关闭：弹出二次确认 Modal，确认后关闭脱敏', async () => {
    const user = userEvent.setup();
    render(
      <PackageApiProvider api={createFakePackageApi()}>
        <ExportWizard />
      </PackageApiProvider>,
    );
    // 默认脱敏开启；点击取消 → 弹确认 Modal
    await user.click(screen.getByLabelText('导出时脱敏（默认开启，关闭需二次确认）'));
    expect(screen.getByTestId('redact-confirm')).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-disable-redact'));
    // Modal 关闭，不再出现
    await waitFor(() => expect(screen.queryByTestId('redact-confirm')).not.toBeInTheDocument());
  });

  it('默认源码 ZIP 使用标准 ZIP 且不带产品数据选择', async () => {
    const user = userEvent.setup();
    const api = createFakePackageApi();
    render(
      <PackageApiProvider api={api}>
        <ExportWizard projects={[{ id: 'p-1', name: '演示项目' }]} />
      </PackageApiProvider>,
    );
    await user.click(screen.getByTestId('export-start'));
    await waitFor(() => expect(screen.getByTestId('export-result')).toBeInTheDocument());
    expect(api.state.exportCalls[0]?.archiveFormat).toBe('standard-zip');
    expect(api.state.exportCalls[0]?.archiveKind).toBe('source');
    expect(api.state.exportCalls[0]?.selection.content.memory.longterm).toBe(false);
    expect(screen.getByText(/普通 ZIP（无产品元数据）/)).toBeInTheDocument();
  });

  it('导出完成：展示结果（路径/大小/耗时）', async () => {
    const user = userEvent.setup();
    const api = createFakePackageApi({
      result: {
        outputPath: '/tmp/out.zip',
        archiveSizeBytes: 1024,
        rawSizeBytes: 2048,
        durationMs: 555,
        counts: {
          projects: 1,
          memoryItems: 2,
          documents: 1,
          pages: 1,
          codeFiles: 3,
          attachments: 0,
        },
        excludeStats: {
          excludedFiles: 1,
          excludedBytes: 1024,
          totalFiles: 4,
          totalBytes: 2048,
          reductionRatio: 0.5,
          hitsByPattern: [{ pattern: 'node_modules/**', files: 1, bytes: 1024 }],
        },
        redacted: true,
        redactionFindings: [],
        selfCheckFindings: [],
        encrypted: false,
        warnings: [],
      },
    });
    render(
      <PackageApiProvider api={api}>
        <ExportWizard projects={[{ id: 'p-1', name: '演示项目' }]} />
      </PackageApiProvider>,
    );
    await user.click(screen.getByTestId('export-start'));
    await waitFor(() => expect(screen.getByTestId('export-result')).toBeInTheDocument());
    expect(api.state.exportCalls).toHaveLength(1);
    expect(screen.getByText('包大小：1024 字节')).toBeInTheDocument();
    expect(screen.getByText('耗时：555 ms')).toBeInTheDocument();
  });

  it('进度回放：回传快照驱动进度面板渲染', async () => {
    const user = userEvent.setup();
    const snapshots: ExportProgressSnapshot[] = [
      {
        stage: 'enumerating',
        processed: 0,
        total: 10,
        currentFile: null,
        counts: {
          projects: 0,
          memoryItems: 0,
          documents: 0,
          pages: 0,
          codeFiles: 0,
          attachments: 0,
        },
        failures: [],
        excludeStats: null,
        redactionFindings: [],
        elapsedMs: 1,
      },
      {
        stage: 'writing',
        processed: 5,
        total: 10,
        currentFile: 'code/a.ts',
        counts: {
          projects: 1,
          memoryItems: 0,
          documents: 0,
          pages: 0,
          codeFiles: 5,
          attachments: 0,
        },
        failures: [],
        excludeStats: null,
        redactionFindings: [],
        elapsedMs: 50,
      },
    ];
    render(
      <PackageApiProvider api={createFakePackageApi({ progress: snapshots })}>
        <ExportWizard projects={[{ id: 'p-1', name: '演示项目' }]} />
      </PackageApiProvider>,
    );
    await user.click(screen.getByTestId('export-start'));
    await waitFor(() => expect(screen.getByTestId('export-result')).toBeInTheDocument());
    // 进度面板曾渲染 writing 阶段（含当前文件名）
    expect(screen.getByText((content) => content.includes('code/a.ts'))).toBeInTheDocument();
  });
});
