/**
 * 渲染层测试用内存假 PackageApi（T8-02）。
 *
 * 只实现导出相关方法（exportPackage / pickExportPath / 方案存取），其余 throw。
 * exportPackage 不跑真实 Node 流水线，而是返回结构化的假 ExportJobResult（可选地回放
 * onProgress 快照），保证组件测试快且不碰 SQLite。
 */

import * as os from 'node:os';
import * as path from 'node:path';

import type {
  ExportJobRequest,
  ExportJobResult,
  ExportPlanPreset,
  ExportProgressSnapshot,
  PackageApi,
} from './package-api';

export interface FakePackageApiState {
  exportCalls: ExportJobRequest[];
  presetStore: Map<string, ExportPlanPreset>;
}

export interface FakePackageApiOptions {
  /** 自定义 exportPackage 返回结果（默认构造一份最小结构） */
  result?: ExportJobResult;
  /** 自定义进度快照回放序列（exportPackage 期间依次 onProgress 推送） */
  progress?: ExportProgressSnapshot[];
}

function defaultResult(request: ExportJobRequest): ExportJobResult {
  return {
    outputPath: request.outputPath,
    archiveSizeBytes: 2048,
    rawSizeBytes: 4096,
    durationMs: 1234,
    counts: { projects: 1, memoryItems: 2, documents: 1, pages: 1, codeFiles: 3, attachments: 0 },
    excludeStats: {
      excludedFiles: 1,
      excludedBytes: 2048,
      totalFiles: 4,
      totalBytes: 4096,
      reductionRatio: 0.5,
      hitsByPattern: [{ pattern: 'node_modules/**', files: 1, bytes: 2048 }],
    },
    redacted: request.redact ?? true,
    redactionFindings: [],
    selfCheckFindings: [],
    encrypted: request.password !== undefined,
    warnings: [],
  };
}

export function createFakePackageApi(
  options: FakePackageApiOptions = {},
): PackageApi & { readonly state: FakePackageApiState } {
  const state: FakePackageApiState = { exportCalls: [], presetStore: new Map() };

  const api: PackageApi = {
    pickExportPath: async (defaultName: string) => path.join(os.tmpdir(), defaultName),
    exportPackage: async (request: ExportJobRequest) => {
      state.exportCalls.push(request);
      const snapshots = options.progress;
      if (snapshots !== undefined && request.onProgress !== undefined) {
        for (const snapshot of snapshots) request.onProgress(snapshot);
      }
      return options.result ?? defaultResult(request);
    },
    listExportPresets: async () => [...state.presetStore.values()],
    saveExportPreset: async (preset: ExportPlanPreset) => {
      state.presetStore.set(preset.name, preset);
    },
    deleteExportPreset: async (name: string) => {
      state.presetStore.delete(name);
    },

    // 其余方法：未实现（导出测试用不到）
    pickPackagePath: async () => {
      throw new Error('假端口未实现：pickPackagePath');
    },
    verifyPackage: async () => {
      throw new Error('假端口未实现：verifyPackage');
    },
    previewImport: async () => {
      throw new Error('假端口未实现：previewImport');
    },
    previewMode: async () => {
      throw new Error('假端口未实现：previewMode');
    },
    importPackage: async () => {
      throw new Error('假端口未实现：importPackage');
    },
    runHealing: async () => {
      throw new Error('假端口未实现：runHealing');
    },
    adoptAnchorCandidate: async () => {
      throw new Error('假端口未实现：adoptAnchorCandidate');
    },
    getBackupSettings: async () => {
      throw new Error('假端口未实现：getBackupSettings');
    },
    saveBackupSettings: async () => {
      throw new Error('假端口未实现：saveBackupSettings');
    },
    createBackupNow: async () => {
      throw new Error('假端口未实现：createBackupNow');
    },
    listSnapshots: async () => {
      throw new Error('假端口未实现：listSnapshots');
    },
    restoreFromSnapshot: async () => {
      throw new Error('假端口未实现：restoreFromSnapshot');
    },
  };

  return Object.assign(api, { state });
}
