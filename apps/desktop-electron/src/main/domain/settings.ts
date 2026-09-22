import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import {
  APP_COMMANDS,
  SettingsStore,
  migrateSettings,
  type GlobalSettings,
  type Settings,
} from '@ec/core';
import { ShellError } from '@ec/shell-api';
import {
  EcpkgReader,
  buildDiffPreview,
  collectPackageObjects,
  runExport,
  runImport,
  type ConflictResolution,
  type ContentSelection,
  type ExportSelection,
  type ImportMode,
  type PackageObject,
} from '@ec/package-kit';

import type { DomainRouter } from './runtime';
import {
  createExportSourcePort,
  createImportLocalStatePort,
  createImportTargetPort,
} from './package-ports';
import { createTelemetryFileStore } from './telemetry-store';
import { createTelemetryRuntime, type TelemetryRuntime } from './telemetry-runtime';

/**
 * 设置域运行时（settings 域，16 个方法全部可用）。
 *
 * 数据落点全部在 `dataDir` 之下，便于"数据与位置"面板如实展示：
 * - `settings.json`      全局/项目两级设置（zod 校验 + 版本迁移，见 `@ec/core`）
 * - `backup-config.json` 定时备份配置
 * - `telemetry-buffer.json` 本地遥测缓冲
 * - `everyonecoding.sqlite`  业务库（迁移时用 `VACUUM INTO` 安全复制）
 * - `exports/`（或备份配置里的目录）归档 `.ecpkg` 的默认输出位置
 *
 * 归档导出/导入接 `@ec/package-kit` 的真实作业：
 * - 导出：`runExport` + 本目录 `package-ports.ts` 的 `ExportSourcePort`；
 * - 导入：`runImport` + `ImportLocalStatePort` / `ImportTargetPort`；
 *   `mode: 'merge'` 且按类型批量决策为 `keepLocal`（与界面"冲突按不覆盖处理"的文案一致）；
 * - `ImportReportData` 只有四分类计数，故 memory/docs/codeFiles 三个数在导入前
 *   另开一次 `EcpkgReader` 按对象类型统计。
 *
 * 加密归档的**合同细节**：加密用口令派生密钥（PBKDF2-SHA256），
 * `encrypted: true` 却没给口令时**拒绝导出**，绝不静默产出未加密文件。
 */

export interface SettingsDomainOptions {
  dataDir: string;
  cacheDir: string;
  /** 未显式配置工作区时的默认根目录 */
  defaultWorkspaceRoot: string;
  /** 工程目录根（`<workspaceRoot>/projects`），归档导出/导入需要 */
  projectsDir: string;
  /** 业务库连接（归档导出/导入读写项目与文档元数据） */
  db: Database.Database;
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

/**
 * 归档内容选择。
 *
 * `attachments` 为 true：附件已按内容寻址装配（`<projectDir>/attachments/<sha256>.<ext>`），
 * `listAttachments()` 会真实枚举磁盘文件，因此 manifest 与包内容一致。
 * 若某项目确实没有附件，导出自然为空，不会虚报。
 */
function buildExportSelection(mode: 'full' | 'code-only', projectId: string): ExportSelection {
  const full: ContentSelection = {
    memory: { longterm: true, project: true, feature: true, page: true, issue: true },
    documents: true,
    code: true,
    pipeline: true,
    anchors: true,
    registry: true,
    attachments: true,
  };
  // 「仅代码（轻量包）」与导入侧 MODE_PARTICIPATING_TYPES['code-only'] 的参与类型对齐
  const codeOnly: ContentSelection = {
    memory: { longterm: false, project: false, feature: false, page: false, issue: false },
    documents: false,
    code: true,
    pipeline: true,
    anchors: true,
    registry: true,
    attachments: false,
  };
  return { scope: 'project', projectIds: [projectId], content: mode === 'full' ? full : codeOnly };
}

/** 归档文件名里剔除路径非法字符（项目名可能含 `\ / : * ? " < > |`） */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'project';
}

export function createSettingsDomain(options: SettingsDomainOptions): SettingsDomain {
  const { dataDir, cacheDir, db, projectsDir } = options;
  const userId = options.userId ?? 'local-user';
  const settingsPath = join(dataDir, 'settings.json');
  const backupConfigPath = join(dataDir, 'backup-config.json');
  const telemetryBufferPath = join(dataDir, 'telemetry-buffer.json');

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const settings: SettingsStore = new SettingsStore(
    migrateSettings(readJson<unknown>(settingsPath, null)),
  );
  let backupConfig: BackupConfig = {
    ...DEFAULT_BACKUP_CONFIG,
    ...readJson<Partial<BackupConfig>>(backupConfigPath, {}),
  };
  const telemetry = createTelemetryFileStore(telemetryBufferPath);
  /**
   * 遥测运行时：授权位取自持久化设置（默认 false）。
   *
   * 与文件缓冲的关系：`telemetry` 负责"存"，本运行时负责"记"与"清"。
   * 关键路径埋点统一走 `telemetryRuntime.record()`——它经 `buildEvent` 构造，
   * 字段白名单断言在构造期就拦截内容字段（提示词 / 代码 / 文档正文 / Key）。
   */
  const telemetryRuntime: TelemetryRuntime = createTelemetryRuntime({
    db,
    bufferPath: telemetryBufferPath,
    enabled: settings.getGlobal().privacy.telemetryEnabled === true,
  });

  const persistSettings = (): void =>
    writeJsonAtomic(settingsPath, JSON.parse(settings.toJSON()) as Settings);
  const persistBackupConfig = (): void => writeJsonAtomic(backupConfigPath, backupConfig);

  /** 数据条目数：工程目录文件数 + 三张主表行数，迁移前后必须一致 */
  const countEntries = (dirs: { projectsDir: string; sqlitePath: string }): number => {
    let rows = 0;
    if (existsSync(dirs.sqlitePath)) {
      const db = new Database(dirs.sqlitePath, { readonly: true });
      try {
        for (const table of ['project', 'memory_item', 'document']) {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
            { n: number } | undefined;
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

  const currentDirs = (): {
    workspaceRoot: string;
    projectsDir: string;
    sqlitePath: string;
    cacheDir: string;
  } => {
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
          workspaceRoot:
            typeof next['workspaceRoot'] === 'string' && next['workspaceRoot']
              ? next['workspaceRoot']
              : from.workspaceRoot,
          projectsDir:
            typeof next['projectsDir'] === 'string' && next['projectsDir']
              ? next['projectsDir']
              : from.projectsDir,
          sqlitePath:
            typeof next['sqlitePath'] === 'string' && next['sqlitePath']
              ? next['sqlitePath']
              : from.sqlitePath,
          cacheDir:
            typeof next['cacheDir'] === 'string' && next['cacheDir']
              ? next['cacheDir']
              : from.cacheDir,
        };
        const before = countEntries(from);
        const backupDir = `${from.projectsDir}.bak-${Date.now()}`;

        try {
          // 1) 工程目录：复制后按条目数校验
          if (target.projectsDir !== from.projectsDir)
            copyTree(from.projectsDir, target.projectsDir);
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

      case 'exportProject': {
        const input = params['input'] as {
          projectId: string;
          mode: 'full' | 'code-only';
          encrypted: boolean;
          password?: string | undefined;
        };
        const password =
          typeof input.password === 'string' && input.password.length > 0
            ? input.password
            : undefined;
        if (input.encrypted && password === undefined) {
          throw new ShellError(
            'INVALID_ARGUMENT',
            '加密导出需要口令：请先在「加密归档」下方填写口令再重试（不会退化成未加密导出）。',
          );
        }
        const project = db
          .prepare(`SELECT id, name FROM project WHERE id = ?`)
          .get(input.projectId) as { id: string; name: string } | undefined;
        if (!project) throw new ShellError('NOT_FOUND', `项目不存在：${input.projectId}`);

        const outputDir = backupConfig.dir.trim() ? backupConfig.dir : join(dataDir, 'exports');
        mkdirSync(outputDir, { recursive: true });
        const outputPath = join(outputDir, `${sanitizeFileName(project.name)}-${Date.now()}.ecpkg`);

        const source = createExportSourcePort({ db, projectsDir, userId });
        const startedAt = Date.now();
        const result = await runExport(
          {
            outputPath,
            selection: buildExportSelection(input.mode, input.projectId),
            redact: true,
            ...(password !== undefined ? { password } : {}),
          },
          source,
        );
        // 关键路径埋点（T10-01）：只上报事件名 + 体积 + 耗时，不含任何内容
        telemetryRuntime.record('package.export', 'success', {
          durationMs: Date.now() - startedAt,
          dims: {
            projectId: input.projectId,
            bytes: result.archiveSizeBytes,
            count: result.counts.codeFiles,
            version: '1',
          },
        });
        return {
          ok: true,
          filePath: result.outputPath,
          bytes: result.archiveSizeBytes,
          mode: input.mode,
        };
      }

      case 'importPackage': {
        const input = params['input'] as { filePath: string; password?: string | undefined };
        const password =
          typeof input.password === 'string' && input.password.length > 0
            ? input.password
            : undefined;
        if (!existsSync(input.filePath)) {
          throw new ShellError('NOT_FOUND', `归档文件不存在：${input.filePath}`);
        }

        // 先按对象类型统计（ImportReportData 只有 added/conflicted/unchanged/missing 四分类）
        const counts = { memory: 0, docs: 0, codeFiles: 0 };
        let objects: PackageObject[] = [];
        try {
          const reader = EcpkgReader.open(
            input.filePath,
            password !== undefined ? { password } : {},
          );
          try {
            objects = collectPackageObjects(reader);
            counts.memory = objects.filter((object) => object.type === 'memory').length;
            counts.docs = objects.filter((object) => object.type === 'document').length;
            counts.codeFiles = objects.filter((object) => object.type === 'code').length;
          } finally {
            reader.close();
          }
        } catch (error) {
          throw new ShellError(
            'INVALID_ARGUMENT',
            `无法读取归档包：${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // 逐条给"冲突"项决策为 keepLocal，**不**用类型级批量决策：
        // `resolveStrategy` 里用户决策优先于分类，类型级 keepLocal 会把「包内新增」也一并丢弃。
        const localPort = createImportLocalStatePort({ db, projectsDir, userId });
        const preview = buildDiffPreview(objects, localPort);
        const decisions = preview.items
          .filter((item) => item.classification === 'conflicted')
          .map((item) => ({ id: item.incoming.id, resolution: 'keepLocal' as ConflictResolution }));

        const report = await runImport(
          {
            packagePath: input.filePath,
            mode: 'merge' satisfies ImportMode,
            decisions,
            ...(password !== undefined ? { password } : {}),
          },
          {
            local: localPort,
            target: createImportTargetPort({ db, projectsDir, userId }),
          },
        );

        // 关键路径埋点（T10-01）：只上报计数与耗时，不含包内容
        telemetryRuntime.record(
          'package.import',
          report.failures.length === 0 ? 'success' : 'failure',
          {
            dims: {
              count: report.counts.added + report.counts.conflicted,
              bytes: 0,
            },
          },
        );
        return {
          ok: report.failures.length === 0,
          counts,
          conflicted: report.counts.conflicted,
        };
      }

      case 'setTelemetry': {
        const enabled = params['enabled'];
        if (typeof enabled !== 'boolean')
          throw new ShellError('INVALID_ARGUMENT', 'setTelemetry 需要 enabled 布尔值');
        settings.updateGlobal({
          privacy: { ...settings.getGlobal().privacy, telemetryEnabled: enabled },
        });
        persistSettings();
        // 运行时同步授权位：撤销时清空本地缓冲（"关闭"就该不留数据）
        telemetryRuntime.setEnabled(enabled);
        if (!enabled) telemetry.clear();
        return undefined;
      }

      case 'inspectLocalTelemetry': {
        const inspection = telemetryRuntime.inspect();
        return {
          telemetryRecords: inspection.telemetryRecords,
          cacheBytes: countBytes(currentDirs().cacheDir),
        };
      }

      case 'clearLocalTelemetry': {
        // 一键清除必须覆盖三层：内存队列 + 文件缓冲 + 数据库记录（FR-SET-06 验收）
        telemetryRuntime.clearAll();
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
        if (!isRecord(keymap))
          throw new ShellError('INVALID_ARGUMENT', 'saveKeymap 需要 keymap 对象');
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
        if (typeof json !== 'string')
          throw new ShellError('INVALID_ARGUMENT', 'importKeymap 需要 json 字符串');
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          throw new ShellError('INVALID_ARGUMENT', '快捷键方案不是合法 JSON');
        }
        if (!isRecord(parsed))
          throw new ShellError('INVALID_ARGUMENT', '快捷键方案必须是「命令 id → 键位」的对象');
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
        if (!isRecord(config))
          throw new ShellError('INVALID_ARGUMENT', 'saveBackupConfig 需要 config 对象');
        const intervalHours = Number(config['intervalHours']);
        const dir = config['dir'];
        if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
          throw new ShellError('INVALID_ARGUMENT', '备份间隔必须是大于 0 的小时数');
        }
        if (typeof dir !== 'string')
          throw new ShellError('INVALID_ARGUMENT', '备份目录必须是字符串');
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
