/**
 * 设置特性测试夹具：内存实现 + 可注入失败场景。
 */

import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings } from '@ec/core';

import type {
  CommandInfo,
  DataDirs,
  ExportResult,
  ImportResult,
  MigrationResult,
  SettingsApi,
  TelemetryInspection,
} from '../settings-api';

export interface FakeSettingsState {
  settings: GlobalSettings;
  dirs: DataDirs;
  telemetryEnabled: boolean;
  telemetryRecords: number;
  cacheBytes: number;
  keymap: Record<string, string>;
  /** 迁移前后的"条目数"（默认一致） */
  counts: { before: number; after: number };
  /** 置为 true 时迁移失败（用于验证错误提示与回滚） */
  failMigration: boolean;
  backupConfig: { intervalHours: number; dir: string; lastRunAt: number | null };
}

export interface FakeSettingsEnvironment {
  api: SettingsApi;
  state: FakeSettingsState;
  /** 记录 update 调用（断言"即时生效"链路） */
  updates: Array<Partial<GlobalSettings>>;
  exports: ExportResult[];
  imports: string[];
}

export function createFakeSettings(
  options: { failMigration?: boolean } = {},
): FakeSettingsEnvironment {
  const state: FakeSettingsState = {
    settings: { ...DEFAULT_GLOBAL_SETTINGS },
    dirs: {
      workspaceRoot: 'D:\\EC',
      projectsDir: 'D:\\EC\\projects',
      sqlitePath: 'D:\\EC\\data\\ec.db',
      cacheDir: 'D:\\EC\\cache',
    },
    telemetryEnabled: false,
    telemetryRecords: 42,
    cacheBytes: 4096,
    keymap: { 'workspace.new': 'Ctrl+N', 'workspace.settings': 'Ctrl+,' },
    counts: { before: 120, after: 120 },
    failMigration: options.failMigration ?? false,
    backupConfig: { intervalHours: 24, dir: 'D:\\EC\\backup', lastRunAt: null },
  };

  const updates: Array<Partial<GlobalSettings>> = [];
  const exports: ExportResult[] = [];
  const imports: string[] = [];

  const commands: CommandInfo[] = [
    { id: 'workspace.new', title: '新建项目', defaultKey: 'Ctrl+N' },
    { id: 'workspace.settings', title: '打开设置', defaultKey: 'Ctrl+,' },
    { id: 'designer.undo', title: '撤销', defaultKey: 'Ctrl+Z' },
    { id: 'pipeline.run', title: '运行流水线', defaultKey: null },
  ];

  const api: SettingsApi = {
    getAll: () => Promise.resolve({ ...state.settings }),
    update: (patch) => {
      updates.push(patch);
      state.settings = { ...state.settings, ...patch };
      return Promise.resolve({ ...state.settings });
    },
    getDataDirs: () => Promise.resolve({ ...state.dirs }),
    migrateDataDirs: (next): Promise<MigrationResult> => {
      state.dirs = { ...state.dirs, ...next };
      if (state.failMigration) {
        return Promise.resolve({
          ok: false,
          counts: { before: state.counts.before, after: state.counts.before - 3 },
          error: '迁移校验失败：条目数与迁移前不一致',
          rolledBack: true,
        });
      }
      return Promise.resolve({
        ok: true,
        counts: { ...state.counts },
        backupDir: 'D:\\EC\\backup\\old-20260913',
      });
    },
    rollbackMigration: (): Promise<MigrationResult> =>
      Promise.resolve({ ok: true, counts: { ...state.counts }, rolledBack: true }),
    exportProject: (input) => {
      const result: ExportResult = {
        ok: true,
        filePath: `D:\\EC\\backup\\project-${input.projectId}.ecpkg`,
        bytes: input.mode === 'full' ? 2_048_000 : 128_000,
        mode: input.mode,
      };
      exports.push(result);
      return Promise.resolve(result);
    },
    importPackage: (input): Promise<ImportResult> => {
      imports.push(input.filePath);
      return Promise.resolve({
        ok: true,
        counts: { memory: 12, docs: 3, codeFiles: 40 },
        conflicted: 2,
      });
    },
    setTelemetry: (enabled) => {
      state.telemetryEnabled = enabled;
      return Promise.resolve();
    },
    inspectLocalTelemetry: (): Promise<TelemetryInspection> =>
      Promise.resolve({ telemetryRecords: state.telemetryRecords, cacheBytes: state.cacheBytes }),
    clearLocalTelemetry: (): Promise<TelemetryInspection> => {
      state.telemetryRecords = 0;
      state.cacheBytes = 0;
      return Promise.resolve({ telemetryRecords: 0, cacheBytes: 0 });
    },
    listCommands: () => Promise.resolve(commands),
    saveKeymap: (keymap) => {
      state.keymap = { ...keymap };
      return Promise.resolve({ ok: true, conflicts: [] });
    },
    exportKeymap: () => Promise.resolve(JSON.stringify(state.keymap, null, 2)),
    importKeymap: (json) => {
      const parsed = JSON.parse(json) as Record<string, string>;
      state.keymap = parsed;
      return Promise.resolve(parsed);
    },
    getBackupConfig: () => Promise.resolve({ ...state.backupConfig }),
    saveBackupConfig: (config) => {
      state.backupConfig = { ...state.backupConfig, ...config };
      return Promise.resolve();
    },
  };

  return { api, state, updates, exports, imports };
}
