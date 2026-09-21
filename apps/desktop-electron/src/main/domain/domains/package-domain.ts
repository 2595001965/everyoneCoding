import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

import {
  EcpkgReader,
  buildDiffPreview,
  collectPackageObjects,
  runExport,
  runImport,
  verifyPackage,
  type ConflictResolution,
  type ContentSelection,
  type PackageObject,
} from '@ec/package-kit';
import { ShellError } from '@ec/shell-api';

import type { DomainRouter } from '../runtime';
import {
  createExportSourcePort,
  createImportLocalStatePort,
  createImportTargetPort,
} from '../package-ports';

/**
 * package 域生产路由（T12-05 归档迁移）。
 *
 * 直接复用 settings 域已验证的 package-ports 三端口装配，并补齐：
 * - verifyPackage（版本→完整性→签名→解密四步校验）；
 * - previewImport / previewMode（差异四分类与模式影响）；
 * - exportPackage / importPackage（全量作业，带进度事件）；
 * - 备份快照（settings 域的 backup-config 复用，快照列表/回滚）。
 */

export interface PackageDomainOptions {
  db: Database.Database;
  projectsDir: string;
  userId: string;
}

export function createPackageDomain(options: PackageDomainOptions): DomainRouter {
  const exportsDir = join(process.env['EC_ELECTRON_USER_DATA_DIR'] ?? '.', 'data', 'exports');

  const readBackupDir = (): string => {
    const row = options.db.prepare(`SELECT value FROM setting WHERE key = 'backup_dir'`).get() as
      { value: string | null } | undefined;
    return row?.value && row.value.length > 0 ? row.value : exportsDir;
  };

  const router: DomainRouter = async (method, params, ctx) => {
    switch (method) {
      case 'pickExportPath':
      case 'pickPackagePath': {
        // 文件对话框属渲染层 dialog 能力（Shell API 已有）；域内不重复实现。
        // 返回默认路径，让渲染层先走自己的 dialog.openFile/openDirectory。
        const defaultName = String(params['defaultName'] ?? `export-${Date.now()}.ecpkg`);
        return join(readBackupDir(), defaultName);
      }

      case 'exportPackage': {
        const request = params['request'] as Record<string, unknown>;
        const outputPath = String(request['outputPath'] ?? '');
        if (outputPath.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 outputPath');
        const selection = (request['selection'] ?? {}) as never;
        const password = typeof request['password'] === 'string' ? request['password'] : undefined;
        mkdirSync(dirname(outputPath), { recursive: true });

        ctx.emit({ type: 'package:progress', stage: 'enumerating', processed: 0, total: 0 });
        const result = await runExport(
          {
            outputPath,
            selection,
            redact: request['redact'] !== false,
            ...(password !== undefined ? { password } : {}),
          },
          createExportSourcePort({
            db: options.db,
            projectsDir: options.projectsDir,
            userId: options.userId,
          }),
        );
        ctx.emit({ type: 'package:progress', stage: 'done', processed: 1, total: 1 });
        return {
          outputPath: result.outputPath,
          archiveSizeBytes: result.archiveSizeBytes,
          rawSizeBytes: result.rawSizeBytes,
          durationMs: result.durationMs,
          counts: result.counts,
          excludeStats: result.excludeStats,
          redacted: request['redact'] !== false,
          redactionFindings: result.redactionFindings,
          selfCheckFindings: result.selfCheckFindings,
          encrypted: password !== undefined,
          warnings: result.warnings,
        };
      }

      case 'verifyPackage': {
        const packagePath = String(params['packagePath'] ?? '');
        const password = typeof params['password'] === 'string' ? params['password'] : undefined;
        if (!existsSync(packagePath))
          throw new ShellError('NOT_FOUND', `归档文件不存在：${packagePath}`);
        const report = verifyPackage(packagePath, password !== undefined ? { password } : {});
        return report;
      }

      case 'previewImport': {
        const packagePath = String(params['packagePath'] ?? '');
        const password = typeof params['password'] === 'string' ? params['password'] : undefined;
        const reader = EcpkgReader.open(packagePath, password !== undefined ? { password } : {});
        try {
          const objects = collectPackageObjects(reader);
          const preview = buildDiffPreview(
            objects,
            createImportLocalStatePort({
              db: options.db,
              projectsDir: options.projectsDir,
              userId: options.userId,
            }),
          );
          const counts = { added: 0, conflicted: 0, unchanged: 0, missing: 0 };
          for (const item of preview.items) counts[item.classification] += 1;
          return {
            items: preview.items.map((item) => ({
              incoming: {
                id: item.incoming.id,
                type: item.incoming.type,
                projectId: item.incoming.projectId,
                name: item.incoming.name,
                updatedAt: item.incoming.updatedAt,
              },
              local: item.local
                ? { id: item.local.id, name: item.local.name, updatedAt: item.local.updatedAt }
                : null,
              classification: item.classification,
            })),
            counts,
            missingLocals: [],
          };
        } finally {
          reader.close();
        }
      }

      case 'previewMode': {
        // 模式影响预览：按 mode 的语义给出计数（merge/full-restore 等的覆盖面估算）
        const mode = String(params['mode'] ?? 'merge');
        const packagePath = String(params['packagePath'] ?? '');
        const password = typeof params['password'] === 'string' ? params['password'] : undefined;
        const reader = EcpkgReader.open(packagePath, password !== undefined ? { password } : {});
        try {
          const objects = collectPackageObjects(reader);
          const preview = buildDiffPreview(
            objects,
            createImportLocalStatePort({
              db: options.db,
              projectsDir: options.projectsDir,
              userId: options.userId,
            }),
          );
          const conflicted = preview.items.filter(
            (item) => item.classification === 'conflicted',
          ).length;
          const added = preview.items.filter((item) => item.classification === 'added').length;
          const toApply = mode === 'full-restore' ? objects.length : added + conflicted;
          return {
            mode: mode as never,
            toApply,
            toOverwrite: mode === 'full-restore' ? conflicted : 0,
            toSkip: objects.length - toApply,
            summary:
              mode === 'full-restore'
                ? `完整恢复：${objects.length} 个对象全部写入（同名覆盖 ${conflicted} 个）`
                : `合并模式：新增 ${added}，冲突 ${conflicted}（默认保留本地）`,
          };
        } finally {
          reader.close();
        }
      }

      case 'importPackage': {
        const request = params['request'] as Record<string, unknown>;
        const packagePath = String(request['packagePath'] ?? '');
        const password = typeof request['password'] === 'string' ? request['password'] : undefined;
        if (!existsSync(packagePath))
          throw new ShellError('NOT_FOUND', `归档文件不存在：${packagePath}`);

        const reader = EcpkgReader.open(packagePath, password !== undefined ? { password } : {});
        let objects: PackageObject[] = [];
        try {
          objects = collectPackageObjects(reader);
        } finally {
          reader.close();
        }
        const localPort = createImportLocalStatePort({
          db: options.db,
          projectsDir: options.projectsDir,
          userId: options.userId,
        });
        const preview = buildDiffPreview(objects, localPort);
        const decisions = preview.items
          .filter((item) => item.classification === 'conflicted')
          .map((item) => ({
            id: item.incoming.id,
            resolution: ((
              request['decisions'] as Array<{ id: string; resolution: string }> | undefined
            )?.find((decision) => decision.id === item.incoming.id)?.resolution ??
              'keepLocal') as ConflictResolution,
          }));

        ctx.emit({
          type: 'package:progress',
          stage: 'importing',
          processed: 0,
          total: objects.length,
        });
        const report = await runImport(
          {
            packagePath,
            mode: (request['mode'] ?? 'merge') as never,
            decisions,
            ...(password !== undefined ? { password } : {}),
          },
          {
            local: localPort,
            target: createImportTargetPort({
              db: options.db,
              projectsDir: options.projectsDir,
              userId: options.userId,
            }),
          },
        );
        ctx.emit({
          type: 'package:progress',
          stage: 'done',
          processed: objects.length,
          total: objects.length,
        });
        return {
          mode: (request['mode'] ?? 'merge') as never,
          counts: report.counts,
          applied: {
            createdProjects: report.applied.createdProjects ?? 0,
            updatedProjects: report.applied.updatedProjects ?? 0,
            createdObjects: report.applied.createdObjects ?? 0,
            updatedObjects: report.applied.updatedObjects ?? 0,
            keptBothObjects: report.applied.keptBothObjects ?? 0,
            memoryCreated: report.applied.memoryCreated ?? 0,
            memoryUpdated: report.applied.memoryUpdated ?? 0,
            memorySuperseded: report.applied.memorySuperseded ?? 0,
            filesWritten: report.applied.filesWritten ?? 0,
          },
          resolutions: report.resolutions,
          failures: report.failures,
          reportPath: report.reportPath,
          durationMs: report.durationMs,
        };
      }

      case 'runHealing':
      case 'adoptAnchorCandidate': {
        // 自愈引擎（锚点重定位/链接修复）依赖 package-kit healing 完整装配（T12-05 收尾批）
        throw new ShellError(
          'NOT_SUPPORTED',
          `package.${method} 属自愈引擎完整装配（T12-05 收尾批）。导入导出与备份已可用。`,
        );
      }

      case 'getBackupSettings': {
        const dir = readBackupDir();
        const row = options.db
          .prepare(`SELECT value FROM setting WHERE key = 'backup_settings'`)
          .get() as { value: string | null } | undefined;
        const parsed = (() => {
          if (!row?.value) return null;
          try {
            return JSON.parse(row.value) as Record<string, unknown>;
          } catch {
            return null;
          }
        })();
        return {
          enabled: parsed?.['enabled'] === true,
          frequency: (parsed?.['frequency'] ?? 'daily') as never,
          timeOfDay: String(parsed?.['timeOfDay'] ?? '03:00'),
          targetDir: String(parsed?.['targetDir'] ?? dir),
          keepCount: Number(parsed?.['keepCount'] ?? 7),
        };
      }

      case 'saveBackupSettings': {
        const settings = params['settings'] as Record<string, unknown>;
        options.db
          .prepare(
            `INSERT INTO setting (key, value) VALUES ('backup_settings', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(JSON.stringify(settings));
        return undefined;
      }

      case 'createBackupNow': {
        const dir = readBackupDir();
        mkdirSync(dir, { recursive: true });
        const fileName = `ec-backup-${Date.now()}-manual.ecpkg`;
        const outputPath = join(dir, fileName);
        const result = await runExport(
          {
            outputPath,
            selection: { scope: 'all', projectIds: [], content: defaultContentSelection() },
            redact: true,
          },
          createExportSourcePort({
            db: options.db,
            projectsDir: options.projectsDir,
            userId: options.userId,
          }),
        );
        return {
          fileName,
          path: result.outputPath,
          createdAt: Date.now(),
          sizeBytes: result.archiveSizeBytes,
          scope: 'all',
        };
      }

      case 'listSnapshots': {
        const dir = readBackupDir();
        if (!existsSync(dir)) return [];
        const out: Array<{
          fileName: string;
          path: string;
          createdAt: number;
          sizeBytes: number;
          scope: string;
        }> = [];
        for (const entry of readdirSync(dir)) {
          if (!entry.startsWith('ec-backup-') || !entry.endsWith('.ecpkg')) continue;
          const full = join(dir, entry);
          const stats = statSync(full);
          out.push({
            fileName: entry,
            path: full,
            createdAt: stats.mtimeMs,
            sizeBytes: stats.size,
            scope: 'all',
          });
        }
        return out.sort((a, b) => b.createdAt - a.createdAt);
      }

      case 'restoreFromSnapshot': {
        const path = String(params['path'] ?? '');
        if (!existsSync(path)) throw new ShellError('NOT_FOUND', `快照不存在：${path}`);
        // 回滚 = 全量导入该快照（merge 模式 + 冲突 takeNew），回滚前先自动做安全快照
        const safeDir = readBackupDir();
        mkdirSync(safeDir, { recursive: true });
        const safePath = join(safeDir, `ec-backup-${Date.now()}-pre-restore.ecpkg`);
        await runExport(
          {
            outputPath: safePath,
            selection: { scope: 'all', projectIds: [], content: defaultContentSelection() },
            redact: true,
          },
          createExportSourcePort({
            db: options.db,
            projectsDir: options.projectsDir,
            userId: options.userId,
          }),
        );

        const reader = EcpkgReader.open(path, {});
        let objects: PackageObject[] = [];
        try {
          objects = collectPackageObjects(reader);
        } finally {
          reader.close();
        }
        const localPort = createImportLocalStatePort({
          db: options.db,
          projectsDir: options.projectsDir,
          userId: options.userId,
        });
        const preview = buildDiffPreview(objects, localPort);
        const decisions = preview.items
          .filter((item) => item.classification === 'conflicted')
          .map((item) => ({ id: item.incoming.id, resolution: 'takeNew' as ConflictResolution }));

        const report = await runImport(
          { packagePath: path, mode: 'merge' as never, decisions },
          {
            local: localPort,
            target: createImportTargetPort({
              db: options.db,
              projectsDir: options.projectsDir,
              userId: options.userId,
            }),
          },
        );
        return {
          mode: 'merge' as never,
          counts: report.counts,
          applied: {
            createdProjects: 0,
            updatedProjects: 0,
            createdObjects: report.applied.createdObjects ?? 0,
            updatedObjects: report.applied.updatedObjects ?? 0,
            keptBothObjects: 0,
            memoryCreated: report.applied.memoryCreated ?? 0,
            memoryUpdated: report.applied.memoryUpdated ?? 0,
            memorySuperseded: report.applied.memorySuperseded ?? 0,
            filesWritten: report.applied.filesWritten ?? 0,
          },
          resolutions: report.resolutions,
          failures: report.failures,
          reportPath: report.reportPath,
          durationMs: report.durationMs,
        };
      }

      case 'listExportPresets':
      case 'saveExportPreset':
      case 'deleteExportPreset': {
        const key = 'export_presets';
        if (method === 'listExportPresets') {
          const row = options.db.prepare(`SELECT value FROM setting WHERE key = ?`).get(key) as
            { value: string | null } | undefined;
          return row?.value ? (JSON.parse(row.value) as unknown[]) : [];
        }
        if (method === 'saveExportPreset') {
          const preset = params['preset'] as Record<string, unknown>;
          const row = options.db.prepare(`SELECT value FROM setting WHERE key = ?`).get(key) as
            { value: string | null } | undefined;
          const presets = row?.value ? (JSON.parse(row.value) as unknown[]) : [];
          const name = String(preset['name'] ?? '');
          const next = presets.filter((item) => (item as { name?: string })['name'] !== name);
          next.push(preset);
          options.db
            .prepare(
              `INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .run(key, JSON.stringify(next));
          return undefined;
        }
        const name = String(params['name'] ?? '');
        const row = options.db.prepare(`SELECT value FROM setting WHERE key = ?`).get(key) as
          { value: string | null } | undefined;
        const presets = row?.value ? (JSON.parse(row.value) as Array<{ name?: string }>) : [];
        const next = presets.filter((item) => item['name'] !== name);
        options.db
          .prepare(
            `INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(key, JSON.stringify(next));
        return undefined;
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `package 域未知方法：${method}`);
    }
  };

  return router;
}

/** 备份/快照默认内容选择（与导出面板的默认勾选一致；附件默认不打包） */
function defaultContentSelection(): ContentSelection {
  return {
    memory: { longterm: true, project: true, feature: true, page: true, issue: true },
    documents: true,
    code: true,
    pipeline: true,
    anchors: true,
    registry: true,
    attachments: false,
  };
}
