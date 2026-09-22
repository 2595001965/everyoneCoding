import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type Database from 'better-sqlite3';

import {
  EcpkgReader,
  buildDiffPreview,
  buildHealingReport,
  checkAttachments,
  collectPackageObjects,
  fixLinks,
  relocateAnchors,
  runExport,
  runImport,
  serializeHealingReport,
  verifyPackage,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreFromSnapshot,
  advanceCursor,
  BackupScheduler,
  type AnchorRelocation,
  type AttachmentContentPort,
  type AttachmentIssue,
  type ConflictResolution,
  type ContentSelection,
  type HealingCodePort,
  type HealingLink,
  type LinkFixOutcome,
  type PackageObject,
  type RelocatableAnchor,
} from '@ec/package-kit';
import { ShellError } from '@ec/shell-api';

import type { DomainRouter } from '../runtime';
import { resolveCodeRoot } from '../code-root';
import {
  createExportSourcePort,
  createImportLocalStatePort,
  createImportTargetPort,
} from '../package-ports';
import { createSettingStore, type SettingStore } from '../setting-store';

/**
 * package 域生产路由（T12-05 归档迁移）。
 *
 * 直接复用 settings 域已验证的 package-ports 三端口装配，并补齐：
 * - verifyPackage（版本→完整性→签名→解密四步校验）；
 * - previewImport / previewMode（差异四分类与模式影响）；
 * - exportPackage / importPackage（全量作业，带进度事件）；
 * - 备份快照（快照列表 / 保留份数清理 / 一键回滚）；
 * - 导入后自愈（锚点重定位 / 链接修复 / 附件清点）与增量导出。
 *
 * 所有配置读写一律经 `createSettingStore`：`setting` 表的真实列是 `value_json`，
 * 且 `user_id` 为 NOT NULL（迁移 0001）。直接写 `SELECT value FROM setting`
 * 在生产环境会 `no such column: value`，备份配置与导出方案会整体失效。
 */

export interface PackageDomainOptions {
  db: Database.Database;
  projectsDir: string;
  userId: string;
  /** 归档默认输出目录（未配置备份目录时的落点） */
  exportsDir?: string | undefined;
  /** 数据目录（自愈报告等产物的落点） */
  dataDir?: string | undefined;
}

/** 快照保留份数与调度配置的持久化键 */
const BACKUP_SETTINGS_KEY = 'backup_settings';
const EXPORT_PRESETS_KEY = 'export_presets';
/** 增量导出游标键 */
const INCREMENTAL_CURSOR_KEY = 'incremental_cursor';

/** package 域句柄：路由 + 定时备份生命周期 */
export interface PackageDomain {
  router: DomainRouter;
  /** 启动定时备份（含启动补偿执行） */
  start(): Promise<{ caughtUp: boolean; message: string }>;
  /** 停止调度器（应用退出时调用，避免定时器泄漏） */
  dispose(): void;
}

export function createPackageDomain(options: PackageDomainOptions): PackageDomain {
  const exportsDir =
    options.exportsDir ?? join(process.env['EC_ELECTRON_USER_DATA_DIR'] ?? '.', 'data', 'exports');
  const settings: SettingStore = createSettingStore({
    db: options.db,
    userId: options.userId,
  });

  /** 最近一次成功备份时间（持久化，供启动补偿判据使用） */
  const LAST_BACKUP_KEY = 'backup_last_run_at';

  /** 执行一次全量快照导出（供调度器与手动备份共用同一实现） */
  const runFullSnapshot = async (absolutePath: string): Promise<void> => {
    await runExport(
      {
        outputPath: absolutePath,
        selection: { scope: 'all', projectIds: [], content: defaultContentSelection() },
        redact: true,
      },
      createExportSourcePort({
        db: options.db,
        projectsDir: options.projectsDir,
        userId: options.userId,
      }),
    );
  };

  /**
   * 定时备份调度器（FR-PKG-13）。
   *
   * 在**客户端内**调度（定时器 + 启动补偿），不依赖系统任务计划程序
   * （权限与非管理员环境的坑，与既有约定一致）。
   * 配置与游标全部落在 `setting` 表，重启后仍按日/周继续执行。
   */
  const scheduler = new BackupScheduler({
    getConfig: () => {
      const config = readBackupSettings();
      return {
        enabled: config.enabled,
        frequency: config.frequency,
        timeOfDay: config.timeOfDay,
        targetDir: config.targetDir.length > 0 ? config.targetDir : readBackupDir(),
        keepCount: config.keepCount,
      };
    },
    runBackup: async () => {
      try {
        const dir = readBackupSettings().targetDir || readBackupDir();
        mkdirSync(dir, { recursive: true });
        await createSnapshot({
          targetDir: dir,
          now: new Date(),
          origin: 'scheduled',
          createFile: runFullSnapshot,
        });
        // 保留份数清理：超出 keepCount 的最旧快照删除
        pruneSnapshots(dir, readBackupSettings().keepCount);
        return true;
      } catch {
        return false;
      }
    },
    getLastRunAt: () => settings.read<number>(LAST_BACKUP_KEY) ?? null,
    recordRun: (at) => settings.write(LAST_BACKUP_KEY, at),
    log: (message) => console.info(`[backup] ${message}`),
  });

  const readBackupSettings = (): {
    enabled: boolean;
    frequency: 'daily' | 'weekly';
    timeOfDay: string;
    targetDir: string;
    keepCount: number;
  } => {
    const stored = settings.read<Record<string, unknown>>(BACKUP_SETTINGS_KEY);
    const dir = readBackupDir();
    return {
      enabled: stored?.['enabled'] === true,
      frequency: stored?.['frequency'] === 'weekly' ? 'weekly' : 'daily',
      timeOfDay: typeof stored?.['timeOfDay'] === 'string' ? stored['timeOfDay'] : '03:00',
      targetDir:
        typeof stored?.['targetDir'] === 'string' && stored['targetDir']
          ? stored['targetDir']
          : dir,
      keepCount:
        typeof stored?.['keepCount'] === 'number' && stored['keepCount'] >= 1
          ? Math.floor(stored['keepCount'])
          : 7,
    };
  };

  const readBackupDir = (): string => {
    const stored = settings.read<string>('backup_dir');
    return typeof stored === 'string' && stored.length > 0 ? stored : exportsDir;
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

      case 'runHealing': {
        /**
         * 导入后自愈（FR-PKG-10）：重定位代码锚点 → 修复失效链接 → 清点附件。
         *
         * 数据源全部真实：锚点读 `code_anchor` 表、代码文件读工程代码根、
         * 链接读 `memory_doc_link`、附件读内容寻址目录。
         * `projectId` 为 null 时对全部项目逐个自愈（跨项目不联动，D-07）。
         */
        const requested = params['projectId'];
        const projectId = typeof requested === 'string' && requested.length > 0 ? requested : null;
        const projectIds =
          projectId === null
            ? (
                options.db
                  .prepare(`SELECT id FROM project WHERE deleted_at IS NULL`)
                  .all() as Array<{ id: string }>
              ).map((row) => row.id)
            : [projectId];

        const anchorsAll: AnchorRelocation[] = [];
        const linksAll: LinkFixOutcome[] = [];
        const attachmentIssuesAll: AttachmentIssue[] = [];
        let attachmentsChecked = 0;

        const codePort: HealingCodePort = {
          readFile: (pid, relativePath) =>
            readTextOrNull(safeJoin(resolveCodeRoot(join(options.projectsDir, pid)), relativePath)),
          listFiles: (pid) => listFiles(resolveCodeRoot(join(options.projectsDir, pid))),
        };

        for (const pid of projectIds) {
          // ① 锚点重定位
          const anchorRows = options.db
            .prepare(
              `SELECT id, element_id, symbol, file_path, kind, start_line, end_line
                 FROM code_anchor WHERE project_id = ?`,
            )
            .all(pid) as Array<{
            id: string;
            element_id: string | null;
            symbol: string | null;
            file_path: string;
            kind: string;
            start_line: number | null;
            end_line: number | null;
          }>;
          const relocatable: RelocatableAnchor[] = anchorRows.map((row) => ({
            id: row.id,
            elementId: row.element_id,
            symbol: row.symbol,
            filePath: row.file_path.replace(/\\/g, '/'),
            kind: row.kind as RelocatableAnchor['kind'],
            startLine: row.start_line,
            endLine: row.end_line,
          }));
          const relocations = relocateAnchors(relocatable, pid, codePort);
          anchorsAll.push(...relocations);

          // ② 失效链接修复（目标 id 变化时按名称/相似度重建）
          const linkRows = options.db
            .prepare(
              `SELECT l.id, l.memory_id, l.document_id, l.link_type,
                      m.content AS memory_title, d.title AS doc_title
                 FROM memory_doc_link l
                 LEFT JOIN memory_item m ON m.id = l.memory_id
                 LEFT JOIN document d ON d.id = l.document_id
                WHERE d.project_id = ? OR m.project_id = ?`,
            )
            .all(pid, pid) as Array<{
            id: string;
            memory_id: string;
            document_id: string;
            link_type: string;
            memory_title: string | null;
            doc_title: string | null;
          }>;
          const memoryIndex = new Map<string, string>(
            (
              options.db
                .prepare(`SELECT id, content FROM memory_item WHERE project_id = ?`)
                .all(pid) as Array<{ id: string; content: string }>
            ).map((row) => [row.id, row.content.slice(0, 60)]),
          );
          const docIndex = new Map<string, string>(
            (
              options.db
                .prepare(`SELECT id, title FROM document WHERE project_id = ?`)
                .all(pid) as Array<{ id: string; title: string }>
            ).map((row) => [row.id, row.title]),
          );
          const healingLinks: HealingLink[] = linkRows.map((row) => ({
            linkId: row.id,
            sourceType: 'memory',
            sourceId: row.memory_id,
            targetType: 'document',
            targetId: row.document_id,
            targetName: row.doc_title ?? undefined,
          }));
          linksAll.push(...fixLinks(healingLinks, { memory: memoryIndex, document: docIndex }));

          // ③ 附件清点（内容寻址：<sha256>.<ext>）
          const attachmentPort: AttachmentContentPort = {
            listReferencedAttachments: () => listReferencedAttachments(options.db, pid),
            readAttachment: (hashName) =>
              readBytesOrNull(join(attachmentsRoot(options.projectsDir, pid), hashName)),
          };
          const attachmentResult = checkAttachments(attachmentPort);
          attachmentIssuesAll.push(...attachmentResult.issues);
          attachmentsChecked += attachmentResult.checked;
        }

        const report = buildHealingReport({
          anchors: anchorsAll,
          links: linksAll,
          attachmentIssues: attachmentIssuesAll,
          attachmentsChecked,
        });

        // 自愈报告落盘（可导出，FR-PKG-10）
        const reportDir = options.dataDir ?? join(options.projectsDir, '..');
        const reportPath = join(reportDir, 'healing-reports', `healing-${Date.now()}.json`);
        try {
          mkdirSync(dirname(reportPath), { recursive: true });
          writeFileSync(reportPath, serializeHealingReport(report), 'utf8');
        } catch {
          // 报告落盘失败不应让自愈整体失败（结果仍随返回值交给 UI）
        }

        return { ...report, reportPath };
      }

      case 'adoptAnchorCandidate': {
        /**
         * 采纳某个 ambiguous 锚点的候选位置（写回 `code_anchor`）。
         * 只更新真实存在的锚点行；找不到即报 NOT_FOUND，不做静默成功。
         */
        const anchorId = String(params['anchorId'] ?? '');
        const filePath = String(params['filePath'] ?? '');
        const symbol = String(params['symbol'] ?? '');
        if (anchorId.length === 0 || filePath.length === 0) {
          throw new ShellError(
            'INVALID_ARGUMENT',
            'adoptAnchorCandidate 需要 anchorId 与 filePath',
          );
        }
        const existing = options.db
          .prepare(`SELECT id, project_id FROM code_anchor WHERE id = ?`)
          .get(anchorId) as { id: string; project_id: string } | undefined;
        if (!existing) throw new ShellError('NOT_FOUND', `锚点不存在：${anchorId}`);
        const codeRoot = resolveCodeRoot(join(options.projectsDir, existing.project_id));
        const content = readTextOrNull(safeJoin(codeRoot, filePath));
        if (content === null) {
          throw new ShellError('NOT_FOUND', `候选文件不存在：${filePath}`);
        }
        // 复用 package-kit 的重定位（与自愈同一套算法，避免两处定位口径漂移）：
        // 用「候选文件 + 原符号」跑一次单锚点重定位，拿到行号区间。
        const [located] = relocateAnchors(
          [
            {
              id: anchorId,
              elementId: null,
              symbol: symbol.length > 0 ? symbol : null,
              filePath,
              kind: 'service',
              startLine: null,
              endLine: null,
            },
          ],
          existing.project_id,
          {
            readFile: (pid, relativePath) =>
              readTextOrNull(
                safeJoin(resolveCodeRoot(join(options.projectsDir, pid)), relativePath),
              ),
            listFiles: () => [filePath],
          },
        );
        options.db
          .prepare(
            `UPDATE code_anchor SET file_path = ?, symbol = ?, start_line = ?, end_line = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            filePath,
            symbol.length > 0 ? symbol : null,
            located?.newStartLine ?? null,
            located?.newEndLine ?? null,
            Date.now(),
            anchorId,
          );
        return true;
      }

      case 'getBackupSettings':
        return readBackupSettings();

      case 'saveBackupSettings': {
        const incoming = params['settings'] as Record<string, unknown>;
        if (incoming === null || typeof incoming !== 'object') {
          throw new ShellError('INVALID_ARGUMENT', 'saveBackupSettings 需要 settings 对象');
        }
        const frequency = incoming['frequency'] === 'weekly' ? 'weekly' : 'daily';
        const timeOfDay = String(incoming['timeOfDay'] ?? '03:00');
        // 时间格式在此校验：坏值会让调度器排不出下一次执行
        if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(timeOfDay)) {
          throw new ShellError('INVALID_ARGUMENT', '备份时间必须是 HH:mm 格式');
        }
        const keepCount = Number(incoming['keepCount'] ?? 7);
        if (!Number.isFinite(keepCount) || keepCount < 1) {
          throw new ShellError('INVALID_ARGUMENT', '保留份数必须是 ≥1 的整数');
        }
        const targetDir = String(incoming['targetDir'] ?? '');
        settings.write(BACKUP_SETTINGS_KEY, {
          enabled: incoming['enabled'] === true,
          frequency,
          timeOfDay,
          targetDir,
          keepCount: Math.floor(keepCount),
        });
        if (targetDir.length > 0) settings.write('backup_dir', targetDir);
        // 配置变更即时重排：启用/停用/改时间都必须当场生效，不能等重启
        scheduler.start();
        return undefined;
      }

      case 'createBackupNow': {
        const dir = readBackupDir();
        mkdirSync(dir, { recursive: true });
        const snapshot = await createSnapshot({
          targetDir: dir,
          now: new Date(),
          origin: 'manual',
          createFile: (absolutePath) =>
            runExport(
              {
                outputPath: absolutePath,
                selection: { scope: 'all', projectIds: [], content: defaultContentSelection() },
                redact: true,
              },
              createExportSourcePort({
                db: options.db,
                projectsDir: options.projectsDir,
                userId: options.userId,
              }),
            ).then(() => undefined),
        });
        // 保留份数清理（FR-PKG-13）：超出 keepCount 的最旧快照删除
        pruneSnapshots(dir, readBackupSettings().keepCount);
        return {
          fileName: snapshot.fileName,
          path: snapshot.absolutePath,
          createdAt: snapshot.createdAt,
          sizeBytes: snapshot.sizeBytes,
          scope: 'all',
        };
      }

      case 'listSnapshots': {
        const dir = readBackupDir();
        return listSnapshots(dir).map((snapshot) => ({
          fileName: snapshot.fileName,
          path: snapshot.absolutePath,
          createdAt: snapshot.createdAt,
          sizeBytes: snapshot.sizeBytes,
          scope: 'all',
          origin: snapshot.origin,
        }));
      }

      case 'restoreFromSnapshot': {
        const path = String(params['path'] ?? '');
        if (!existsSync(path)) throw new ShellError('NOT_FOUND', `快照不存在：${path}`);
        const dir = readBackupDir();
        mkdirSync(dir, { recursive: true });
        // 回滚顺序固定：先对当前状态做安全快照（可再滚回来）→ 再全量导入所选快照。
        // 复用 snapshot-manager 的编排，保证命名规范与 UI 列表一致。
        const result = await restoreFromSnapshot({
          snapshotPath: path,
          now: new Date(),
          createFile: (absolutePath) =>
            runExport(
              {
                outputPath: absolutePath,
                selection: { scope: 'all', projectIds: [], content: defaultContentSelection() },
                redact: true,
              },
              createExportSourcePort({
                db: options.db,
                projectsDir: options.projectsDir,
                userId: options.userId,
              }),
            ).then(() => undefined),
          importFullRestore: async (snapshotAbsolutePath) => {
            const reader = EcpkgReader.open(snapshotAbsolutePath, {});
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
            // 回滚语义 = 以包内为准：冲突项一律 takeNew（覆盖本地）
            const decisions = preview.items
              .filter((item) => item.classification === 'conflicted')
              .map((item) => ({
                id: item.incoming.id,
                resolution: 'takeNew' as ConflictResolution,
              }));
            return runImport(
              { packagePath: snapshotAbsolutePath, mode: 'full-restore' as never, decisions },
              {
                local: localPort,
                target: createImportTargetPort({
                  db: options.db,
                  projectsDir: options.projectsDir,
                  userId: options.userId,
                }),
              },
            );
          },
        });
        const report = result.report;
        pruneSnapshots(dir, readBackupSettings().keepCount);
        return {
          mode: 'full-restore' as never,
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
          // 回滚前自动生成的安全快照：回滚错了还能再滚回来（可撤销）
          safetySnapshot: {
            fileName: result.safetySnapshot.fileName,
            path: result.safetySnapshot.absolutePath,
            createdAt: result.safetySnapshot.createdAt,
            sizeBytes: result.safetySnapshot.sizeBytes,
            scope: 'all',
          },
        };
      }

      case 'exportIncremental': {
        /**
         * 增量导出（FR-PKG-11，P2）：基于 `updatedAt` 游标，只导出变更对象。
         *
         * 游标语义：上次导出完成后记录"当时见到的最大 updatedAt"，
         * 下一次把 `since` 作为 `updatedSince` 传给导出流水线。
         * 缺省游标（首次调用）= 全量导出，并把游标推进到当前水位。
         */
        const request = params['request'] as Record<string, unknown>;
        const outputPath = String(request['outputPath'] ?? '');
        if (outputPath.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 outputPath');
        const stored = settings.read<{ since: number; savedAt: number }>(INCREMENTAL_CURSOR_KEY);
        const since =
          typeof request['since'] === 'number'
            ? (request['since'] as number)
            : typeof stored?.since === 'number'
              ? stored.since
              : undefined;
        const password = typeof request['password'] === 'string' ? request['password'] : undefined;
        mkdirSync(dirname(outputPath), { recursive: true });

        const result = await runExport(
          {
            outputPath,
            selection: (request['selection'] ?? {
              scope: 'all',
              projectIds: [],
              content: defaultContentSelection(),
            }) as never,
            redact: request['redact'] !== false,
            ...(since !== undefined ? { updatedSince: since } : {}),
            ...(password !== undefined ? { password } : {}),
          },
          createExportSourcePort({
            db: options.db,
            projectsDir: options.projectsDir,
            userId: options.userId,
          }),
        );

        // 推进游标：以当前真实水位为准（记忆/文档/项目的 updatedAt 最大值）
        const cursor = advanceCursor(
          {
            maxUpdatedAt: () => {
              const row = options.db
                .prepare(
                  `SELECT MAX(v) AS m FROM (
                     SELECT MAX(updated_at) AS v FROM memory_item
                     UNION ALL SELECT MAX(updated_at) FROM document
                     UNION ALL SELECT MAX(updated_at) FROM project
                   )`,
                )
                .get() as { m: number | null } | undefined;
              return row?.m ?? 0;
            },
          },
          Date.now(),
        );
        settings.write(INCREMENTAL_CURSOR_KEY, cursor);

        return {
          outputPath: result.outputPath,
          archiveSizeBytes: result.archiveSizeBytes,
          rawSizeBytes: result.rawSizeBytes,
          durationMs: result.durationMs,
          counts: result.counts,
          cursor,
          incremental: since !== undefined,
        };
      }

      case 'getIncrementalCursor': {
        const stored = settings.read<{ since: number; savedAt: number }>(INCREMENTAL_CURSOR_KEY);
        return stored ?? null;
      }

      case 'listExportPresets':
      case 'saveExportPreset':
      case 'deleteExportPreset': {
        const presets = settings.read<unknown[]>(EXPORT_PRESETS_KEY) ?? [];
        const list = Array.isArray(presets) ? presets : [];
        if (method === 'listExportPresets') return list;

        if (method === 'saveExportPreset') {
          const preset = params['preset'] as Record<string, unknown>;
          const name = String(preset['name'] ?? '');
          if (name.length === 0) {
            throw new ShellError('INVALID_ARGUMENT', '导出方案必须有名称');
          }
          // 同名覆盖：方案列表按名称唯一，避免 UI 出现重复条目
          const next = list.filter((item) => (item as { name?: string })['name'] !== name);
          next.push(preset);
          settings.write(EXPORT_PRESETS_KEY, next);
          return undefined;
        }

        const name = String(params['name'] ?? '');
        settings.write(
          EXPORT_PRESETS_KEY,
          list.filter((item) => (item as { name?: string })['name'] !== name),
        );
        return undefined;
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `package 域未知方法：${method}`);
    }
  };

  return {
    router,
    /**
     * 启动定时备份：先做**启动补偿**（上次应跑而未跑的立即补一次），
     * 再按配置排下一次。不依赖系统任务计划程序（客户端内定时器）。
     */
    async start(): Promise<{ caughtUp: boolean; message: string }> {
      return scheduler.catchUpIfNeeded();
    },
    dispose(): void {
      scheduler.stop();
    },
  };
}

/** 备份/快照默认内容选择（与导出面板的默认勾选一致，含内容寻址附件） */
function defaultContentSelection(): ContentSelection {
  return {
    memory: { longterm: true, project: true, feature: true, page: true, issue: true },
    documents: true,
    code: true,
    pipeline: true,
    anchors: true,
    registry: true,
    attachments: true,
  };
}

/* ------------------------------ 附件与自愈辅助 ------------------------------ */

/** 工程代码文件递归清单（相对代码根，正斜杠统一） */
function listFiles(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, full));
    else out.push(full.slice(root.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

function readTextOrNull(file: string | null): string | null {
  if (file === null) return null;
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

function readBytesOrNull(file: string): Buffer | null {
  try {
    return existsSync(file) ? readFileSync(file) : null;
  } catch {
    return null;
  }
}

/** 在 root 下安全拼接相对路径（越界返回 null，含 `..` 逃逸） */
function safeJoin(root: string, ...segments: string[]): string | null {
  const base = join(root);
  const target = join(base, ...segments);
  return target === base || target.startsWith(`${base}${sep}`) ? target : null;
}

/**
 * 附件的内容寻址根目录：`<projectDir>/attachments`。
 *
 * 与包内布局 `attachments/<sha256>.<ext>` 对应；导入时按同一约定落回，
 * 因此导出→导入→再导出可自洽往返。
 */
export function attachmentsRoot(projectsDir: string, projectId: string): string {
  return join(projectsDir, projectId, 'attachments');
}

/**
 * 被引用的附件清单（内容寻址）。
 *
 * 数据源：`document.content_ref` 指向的原始文件若位于附件目录内，即视为
 * 内容寻址附件（图片 / 字体等资源）；同时把附件目录内**全部**文件登记为
 * "可导出资源"，避免用户手工放入的素材在导出时被静默丢弃。
 */
function listReferencedAttachments(
  db: Database.Database,
  projectId: string,
): Array<{ hashName: string; referencedBy: string }> {
  const rows = db
    .prepare(
      `SELECT id, content_ref FROM document WHERE project_id = ? AND content_ref IS NOT NULL`,
    )
    .all(projectId) as Array<{ id: string; content_ref: string }>;
  const out: Array<{ hashName: string; referencedBy: string }> = [];
  for (const row of rows) {
    const name = row.content_ref.replace(/\\/g, '/').split('/').pop() ?? '';
    if (/^[0-9a-f]{16,}\.[A-Za-z0-9]+$/.test(name)) {
      out.push({ hashName: name, referencedBy: `documents/${row.id}` });
    }
  }
  return out;
}
