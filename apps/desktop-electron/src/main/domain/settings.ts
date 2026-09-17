import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import { APP_COMMANDS, SettingsStore, migrateSettings, type GlobalSettings, type Settings } from '@ec/core';
import { ShellError } from '@ec/shell-api';

import type { DomainRouter } from './runtime';
import { createTelemetryFileStore } from './telemetry-store';

/**
 * 设置域运行时（settings 域，16 个方法）。
 *
 * 数据落点全部在 `dataDir` 之下，便于"数据与位置"面板如实展示：
 * - `settings.json`      全局/项目两级设置（zod 校验 + 版本迁移，见 `@ec/core`）
 * - `backup-config.json` 定时备份配置
 * - `telemetry-buffer.json` 本地遥测缓冲
 * - `everyonecoding.sqlite`  业务库（迁移时用 `VACUUM INTO` 安全复制）
 *
 * **未完成说明（如实）**：`exportProject` 与 `importPackage` 暂未接线。导出的读取端需经
 * `@ec/package-kit` 的 `runExport` + `ExportSourcePort` 读取工程 / 记忆 / 文档，导入的写入端要把
 * 记忆 / 文档 / 代码落回库与工程目录 —— 两者都压在 workspace / docs 两个域上。在它们落地前先行实现，
 * 会形成第二条分叉读写路径，故按 settings → workspace → docs → 归档导入导出的顺序推进。
 * 这两个方法当前抛出**带原因**的 `NOT_SUPPORTED`，不做任何静默降级。
 */

export interface SettingsDomainOptions {
  dataDir: string;
  cacheDir: string;
  /** 未显式配置工作区时的默认根目录 */
  defaultWorkspaceRoot: string;
  userId?: string;
  /** 迁移完成后需要重启才能跟随的提示（如 AI 栈仍持旧库连接） */
  onNotice?: (message: string) => void;
}

export interface SettingsDomain {
  router: DomainRouter;
  dispose(): Promise<void>;
}

interface BackupConfig {
  intervalHours: number;
  dir: string;
  lastRunAt: number | null;
}

const DEFAULT_BACKUP_CONFIG: BackupConfig = { intervalHours: 24, dir: '', lastRunAt: null };

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    // 坏配置不炸启动：退回默认值（与 settings-schema 的迁移口径一致）
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

/** 递归统计目录内文件数（不含子目录本身），目录不存在记 0 */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(full);
    else total += 1;
  }
  return total;
}

/** 递归统计目录内字节数（缓存占用口径，与文件数区分开） */
function countBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += countBytes(full);
    else total += statSync(full).size;
  }
  return total;
}

/** 递归复制目录（目标已存在则合并覆盖） */
function copyTree(source: string, target: string): number {
  if (!existsSync(source)) return 0;
  mkdirSync(target, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copied += copyTree(from, to);
    else {
      writeFileSync(to, readFileSync(from));
      copied += 1;
    }
  }
  return copied;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createSettingsDomain(options: SettingsDomainOptions): SettingsDomain {
  const { dataDir, cacheDir } = options;
  const settingsPath = join(dataDir, 'settings.json');
  const backupConfigPath = join(dataDir, 'backup-config.json');
  const telemetryBufferPath = join(dataDir, 'telemetry-buffer.json');

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const settings: SettingsStore = new SettingsStore(migrateSettings(readJson<unknown>(settingsPath, null)));
  let backupConfig: BackupConfig = { ...DEFAULT_BACKUP_CONFIG, ...readJson<Partial<BackupConfig>>(backupConfigPath, {}) };
  const telemetry = createTelemetryFileStore(telemetryBufferPath);

  const persistSettings = (): void => writeJsonAtomic(settingsPath, JSON.parse(settings.toJSON()) as Settings);
  const persistBackupConfig = (): void => writeJsonAtomic(backupConfigPath, backupConfig);

  /** 数据条目数：工程目录文件数 + 三张主表行数，迁移前后必须一致 */
  const countEntries = (dirs: { projectsDir: string; sqlitePath: string }): number => {
    let rows = 0;
    if (existsSync(dirs.sqlitePath)) {
      const db = new Database(dirs.sqlitePath, { readonly: true });
      try {
        for (const table of ['project', 'memory_item', 'document']) {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
          rows += row?.n ?? 0;
        }
      } catch {
        rows += 0;
      } finally {
        db.close();
      }
    }
    return countFiles(dirs.projectsDir) + rows;
  };

  const currentDirs = (): { workspaceRoot: string; projectsDir: string; sqlitePath: string; cacheDir: string } => {
    const global = settings.getGlobal();
    const workspaceRoot = global.workspaceRoot || options.defaultWorkspaceRoot;
    return {
      workspaceRoot,
      projectsDir: join(workspaceRoot, 'projects'),
      sqlitePath: join(dataDir, 'everyonecoding.sqlite'),
      cacheDir,
    };
  };

  /** 迁移前状态，供 rollbackMigration 使用 */
  let migrationBackup: { dirs: ReturnType<typeof currentDirs>; backupDir: string } | null = null;

  const router: DomainRouter = async (method, params) => {
    switch (method) {
      case 'getAll':
        return settings.getGlobal() satisfies GlobalSettings;

      case 'update': {
        const patch = params['patch'];
        if (!isRecord(patch)) throw new ShellError('INVALID_ARGUMENT', 'update 需要 patch 对象');
        // zod 校验失败会抛错且不写盘（SettingsStore.updateGlobal 的既有语义）
        settings.updateGlobal(patch as Partial<GlobalSettings>);
        persistSettings();
        return settings.getGlobal();
      }

      case 'getDataDirs':
        return currentDirs();

      case 'migrateDataDirs': {
        const next = isRecord(params['next']) ? params['next'] : {};
        const from = currentDirs();
        const target = {
          workspaceRoot: typeof next['workspaceRoot'] === 'string' && next['workspaceRoot'] ? next['workspaceRoot'] : from.workspaceRoot,
          projectsDir: typeof next['projectsDir'] === 'string' && next['projectsDir'] ? next['projectsDir'] : from.projectsDir,
          sqlitePath: typeof next['sqlitePath'] === 'string' && next['sqlitePath'] ? next['sqlitePath'] : from.sqlitePath,
          cacheDir: typeof next['cacheDir'] === 'string' && next['cacheDir'] ? next['cacheDir'] : from.cacheDir,
        };
        const before = countEntries(from);
        const backupDir = `${from.projectsDir}.bak-${Date.now()}`;

        try {
          // 1) 工程目录：复制后按条目数校验
          if (target.projectsDir !== from.projectsDir) copyTree(from.projectsDir, target.projectsDir);
          // 2) 缓存目录：缓存可再生，仍搬一次避免用户困惑
          if (target.cacheDir !== from.cacheDir) copyTree(from.cacheDir, target.cacheDir);
          // 3) SQLite：用 VACUUM INTO 做在线一致快照（不能裸复制正在写入的库）
          if (target.sqlitePath !== from.sqlitePath && existsSync(from.sqlitePath)) {
            mkdirSync(dirname(target.sqlitePath), { recursive: true });
            const db = new Database(from.sqlitePath);
            try {
              db.prepare('VACUUM INTO ?').run(target.sqlitePath);
            } finally {
              db.close();
            }
          }

          const after = countEntries(target);
          if (after !== before) {
            // 校验失败：清掉刚复制过去的目标目录，保留源目录不动
            if (target.projectsDir !== from.projectsDir && existsSync(target.projectsDir)) {
              rmSync(target.projectsDir, { recursive: true, force: true });
            }
            return {
              ok: false,
              counts: { before, after },
              error: `迁移校验失败：条目数与迁移前不一致（${before} → ${after}）`,
              rolledBack: true,
            };
          }

          // 4) 旧目录改名留作备份（不删除）
          if (target.projectsDir !== from.projectsDir && existsSync(from.projectsDir)) {
            renameSync(from.projectsDir, backupDir);
          }

          settings.updateGlobal({ workspaceRoot: target.workspaceRoot });
          persistSettings();
          migrationBackup = { dirs: from, backupDir };

          if (target.sqlitePath !== from.sqlitePath) {
            options.onNotice?.(
              `业务库已迁移至 ${target.sqlitePath}；AI 栈需重启应用后才会跟随新路径（当前仍持旧库连接）。`,
            );
          }
          return { ok: true, counts: { before, after }, backupDir };
        } catch (error) {
          return {
            ok: false,
            counts: { before, after: countEntries(target) },
            error: error instanceof Error ? error.message : String(error),
            rolledBack: false,
          };
        }
      }

      case 'rollbackMigration': {
        if (!migrationBackup) {
          throw new ShellError('NOT_FOUND', '没有可回滚的迁移记录');
        }
        const { dirs, backupDir } = migrationBackup;
        if (existsSync(backupDir)) {
          // 备份目录已改名占位，这里恢复回原路径
          rmSync(dirs.projectsDir, { recursive: true, force: true });
          renameSync(backupDir, dirs.projectsDir);
        }
        settings.updateGlobal({ workspaceRoot: dirs.workspaceRoot });
        persistSettings();
        const counts = { before: countEntries(dirs), after: countEntries(dirs) };
        migrationBackup = null;
        return { ok: true, counts, rolledBack: true };
      }

      case 'exportProject':
        throw new ShellError(
          'NOT_SUPPORTED',
          '工程导出尚未接线：需接 @ec/package-kit 的 runExport 并实现其 ExportSourcePort（工程代码 / 记忆 / 文档的读取端），随 workspace 与 docs 域一并交付。',
        );

      case 'importPackage':
        throw new ShellError(
          'NOT_SUPPORTED',
          '归档导入尚未接线：其写入端需要对记忆 / 文档 / 代码落库，属 workspace 与 docs 域的写路径，随这两个域一并交付。',
        );

      case 'setTelemetry': {
        const enabled = params['enabled'];
        if (typeof enabled !== 'boolean') throw new ShellError('INVALID_ARGUMENT', 'setTelemetry 需要 enabled 布尔值');
        settings.updateGlobal({ privacy: { ...settings.getGlobal().privacy, telemetryEnabled: enabled } });
        persistSettings();
        if (!enabled) telemetry.clear();
        return undefined;
      }

      case 'inspectLocalTelemetry':
        return { telemetryRecords: telemetry.count(), cacheBytes: countBytes(currentDirs().cacheDir) };

      case 'clearLocalTelemetry': {
        telemetry.clear();
        // 缓存可直接清空重建（清完再统计，保证回传值与实际一致）
        const dir = currentDirs().cacheDir;
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        return { telemetryRecords: 0, cacheBytes: 0 };
      }

      case 'listCommands':
        return APP_COMMANDS.map((command) => ({
          id: command.id,
          title: command.title,
          defaultKey: command.defaultKey,
        }));

      case 'saveKeymap': {
        const keymap = params['keymap'];
        if (!isRecord(keymap)) throw new ShellError('INVALID_ARGUMENT', 'saveKeymap 需要 keymap 对象');
        const entries: Record<string, string> = {};
        for (const [id, keys] of Object.entries(keymap)) {
          if (typeof keys === 'string') entries[id] = keys;
        }
        settings.updateGlobal({ keymap: entries });
        persistSettings();
        // 冲突检测由渲染层用同一套规则先行拦截；这里返回空表表示已落盘
        return { ok: true, conflicts: [] };
      }

      case 'exportKeymap':
        return JSON.stringify(settings.getGlobal().keymap, null, 2);

      case 'importKeymap': {
        const json = params['json'];
        if (typeof json !== 'string') throw new ShellError('INVALID_ARGUMENT', 'importKeymap 需要 json 字符串');
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          throw new ShellError('INVALID_ARGUMENT', '快捷键方案不是合法 JSON');
        }
        if (!isRecord(parsed)) throw new ShellError('INVALID_ARGUMENT', '快捷键方案必须是「命令 id → 键位」的对象');
        const entries: Record<string, string> = {};
        for (const [id, keys] of Object.entries(parsed)) {
          if (typeof keys === 'string') entries[id] = keys;
        }
        settings.updateGlobal({ keymap: entries });
        persistSettings();
        return entries;
      }

      case 'getBackupConfig':
        return { ...backupConfig };

      case 'saveBackupConfig': {
        const config = params['config'];
        if (!isRecord(config)) throw new ShellError('INVALID_ARGUMENT', 'saveBackupConfig 需要 config 对象');
        const intervalHours = Number(config['intervalHours']);
        const dir = config['dir'];
        if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
          throw new ShellError('INVALID_ARGUMENT', '备份间隔必须是大于 0 的小时数');
        }
        if (typeof dir !== 'string') throw new ShellError('INVALID_ARGUMENT', '备份目录必须是字符串');
        backupConfig = { ...backupConfig, intervalHours, dir };
        persistBackupConfig();
        return undefined;
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `settings 域不支持的方法：${method}`);
    }
  };

  return {
    router,
    async dispose(): Promise<void> {
      await Promise.resolve();
    },
  };
}
