/**
 * 设置特性端口（T9-03 / FR-SET-01 ~ 08）。
 *
 * 边界（D-02 硬约束）：**状态栏与设置页不出现任何云端同步入口**；
 * 数据导出/导入走 `.ecpkg`（T8-02/T8-03），不走云。
 *
 * 冻结契约：外壳注入 `globalThis.__EC_SETTINGS__`。
 */

import { createContext, useContext, type ReactNode } from 'react';

import type { GlobalSettings } from '@ec/core';

/** 数据目录配置（FR-SET-02/03） */
export interface DataDirs {
  workspaceRoot: string;
  projectsDir: string;
  sqlitePath: string;
  cacheDir: string;
}

/** 迁移结果：迁移前后条数必须一致（迁移完整性判据） */
export interface MigrationResult {
  ok: boolean;
  counts: { before: number; after: number };
  /** 旧目录备份位置（迁移成功时保留备份） */
  backupDir?: string | undefined;
  /** 迁移失败/校验失败时的可读原因 */
  error?: string | undefined;
  /** 是否已回滚 */
  rolledBack?: boolean | undefined;
}

/** 导出结果 */
export interface ExportResult {
  ok: boolean;
  filePath: string;
  bytes: number;
  /** 只导出代码时为轻量包 */
  mode: 'full' | 'code-only';
}

/** 导入结果 */
export interface ImportResult {
  ok: boolean;
  counts: { memory: number; docs: number; codeFiles: number };
  conflicted: number;
}

/** 本地遥测自检结果（清除后应全为 0） */
export interface TelemetryInspection {
  telemetryRecords: number;
  cacheBytes: number;
}

/** 命令（快捷键绑定对象，来自 T0-09 的命令注册表） */
export interface CommandInfo {
  id: string;
  title: string;
  defaultKey: string | null;
}

/** 快捷键冲突 */
export interface KeymapConflict {
  keys: string;
  commands: string[];
}

export interface SettingsApi {
  getAll(): Promise<GlobalSettings>;
  /** 更新全局设置（**即时生效，无需重启**） */
  update(patch: Partial<GlobalSettings>): Promise<GlobalSettings>;

  getDataDirs(): Promise<DataDirs>;
  /** 修改数据目录并自动迁移（复制 + 校验 + 切换 + 旧目录保留备份） */
  migrateDataDirs(next: Partial<DataDirs>): Promise<MigrationResult>;
  /** 迁移失败后回滚到迁移前目录 */
  rollbackMigration(): Promise<MigrationResult>;

  exportProject(input: { projectId: string; mode: 'full' | 'code-only'; encrypted: boolean }): Promise<ExportResult>;
  importPackage(input: { filePath: string }): Promise<ImportResult>;

  setTelemetry(enabled: boolean): Promise<void>;
  inspectLocalTelemetry(): Promise<TelemetryInspection>;
  /** 一键清除本地遥测与缓存数据 */
  clearLocalTelemetry(): Promise<TelemetryInspection>;

  listCommands(): Promise<CommandInfo[]>;
  saveKeymap(keymap: Record<string, string>): Promise<{ ok: boolean; conflicts: KeymapConflict[] }>;
  exportKeymap(): Promise<string>;
  importKeymap(json: string): Promise<Record<string, string>>;

  /** 定时本地备份配置（T8-04 调度器） */
  getBackupConfig(): Promise<{ intervalHours: number; dir: string; lastRunAt: number | null }>;
  saveBackupConfig(config: { intervalHours: number; dir: string }): Promise<void>;
}

const SettingsContext = createContext<SettingsApi | null>(null);

export function SettingsApiProvider({ api, children }: { api: SettingsApi | null; children: ReactNode }): JSX.Element {
  return <SettingsContext.Provider value={api}>{children}</SettingsContext.Provider>;
}

export function useSettingsOptional(): SettingsApi | null {
  return useContext(SettingsContext);
}

export function useSettings(): SettingsApi {
  const api = useContext(SettingsContext);
  if (!api) throw new Error('设置端口未注入：请先在外壳中装配 globalThis.__EC_SETTINGS__');
  return api;
}

export function SettingsUnavailable(): JSX.Element {
  return (
    <div className="ec-settings">
      <p className="ec-settings__hint">设置尚未连接本地配置。完成初始化后，这里可以调整界面、数据目录、隐私与快捷键。</p>
    </div>
  );
}

export function readInjectedSettingsApi(): SettingsApi | null {
  const injected = (globalThis as { __EC_SETTINGS__?: SettingsApi }).__EC_SETTINGS__;
  return injected ?? null;
}

/** 检测冲突：同一快捷键绑定到多个命令 */
export function detectKeymapConflicts(keymap: Record<string, string>): KeymapConflict[] {
  const byKeys = new Map<string, string[]>();
  for (const [commandId, keys] of Object.entries(keymap)) {
    if (!keys.trim()) continue;
    const normalized = keys.trim().toLowerCase();
    const list = byKeys.get(normalized) ?? [];
    list.push(commandId);
    byKeys.set(normalized, list);
  }
  return [...byKeys.entries()]
    .filter(([, commands]) => commands.length > 1)
    .map(([keys, commands]) => ({ keys, commands }));
}
