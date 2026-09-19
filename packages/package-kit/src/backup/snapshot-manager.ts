/**
 * 备份快照管理（T8-04 要点 6 / FR-PKG-13：快照生成、清点、保留份数、一键回滚）。
 *
 * 职责边界：本模块管理**快照文件的生命周期**（命名 / 清点 / 清理 / 回滚编排），
 * 不直接执行导出与导入——那两步经函数端口注入，由外壳接 T8-02 的导出流水线
 * 与 T8-03 的导入流水线（full-restore 模式）。这样快照管理可以独立测试，
 * 也避免 backup 在编译期依赖 export/import 的具体实现。
 *
 * 回滚语义（硬约束 6：破坏性操作二次确认 + 可撤销）：
 * 1. **回滚前先把当前工作区备份**（安全快照，文件名带 `-pre-restore`）；
 * 2. 再以 full-restore 语义导入所选快照；
 * 3. 返回安全快照位置——回滚错了还能再滚回来（可撤销）。
 *
 * 保留份数：`pruneSnapshots(targetDir, keepCount)` 按 createdAt 从旧到新删除，
 * 只删本模块命名规范（`ec-backup-*.ecpkg`）的文件，绝不碰目录里其他文件。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ImportReportData } from '../import/import-types';

/** 快照记录（UI 列表用） */
export interface SnapshotRecord {
  fileName: string;
  absolutePath: string;
  createdAt: number;
  sizeBytes: number;
  /** 备注来源：定时备份 / 手动 / 回滚前安全快照 */
  origin: 'scheduled' | 'manual' | 'pre-restore';
}

/** 快照文件的命名规范：ec-backup-<时间戳>-<origin>.ecpkg */
export function snapshotFileName(now: Date, origin: SnapshotRecord['origin']): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const serial = pad(now.getTime() % 1000, 3);
  return `ec-backup-${stamp}-${serial}-${origin}.ecpkg`;
}

const SNAPSHOT_PATTERN = /^ec-backup-(\d{8}-\d{6})-(\d{3})-(scheduled|manual|pre-restore)\.ecpkg$/;

/** 从文件名解析创建时间（本地时区）；不匹配命名规范返回 null */
function parseSnapshotCreatedAt(fileName: string): number | null {
  const match = SNAPSHOT_PATTERN.exec(fileName);
  if (match === null) return null;
  const stamp = match[1]!;
  const serial = Number(match[2]);
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(9, 11));
  const minute = Number(stamp.slice(11, 13));
  const second = Number(stamp.slice(13, 15));
  return new Date(year, month - 1, day, hour, minute, second, serial).getTime();
}

function originOfFileName(fileName: string): SnapshotRecord['origin'] | null {
  const match = SNAPSHOT_PATTERN.exec(fileName);
  if (match === null) return null;
  return match[3] as SnapshotRecord['origin'];
}

/** 生成快照（调用 createFile 完成实际导出；本函数负责命名与登记） */
export async function createSnapshot(options: {
  targetDir: string;
  now: Date;
  origin: SnapshotRecord['origin'];
  /** 外壳注入：把当前工作区全量导出为 `<absolutePath>` 的 .ecpkg */
  createFile: (absolutePath: string) => Promise<void>;
}): Promise<SnapshotRecord> {
  if (!fs.existsSync(options.targetDir)) {
    fs.mkdirSync(options.targetDir, { recursive: true });
  }
  let fileName = snapshotFileName(options.now, options.origin);
  let absolutePath = path.join(options.targetDir, fileName);
  // 同秒冲突兜底（串行场景罕见，防御性处理）
  let attempt = 1;
  while (fs.existsSync(absolutePath)) {
    fileName = `ec-backup-${options.now.getTime()}-${attempt}-${options.origin}.ecpkg`;
    absolutePath = path.join(options.targetDir, fileName);
    attempt += 1;
  }
  await options.createFile(absolutePath);
  return {
    fileName,
    absolutePath,
    createdAt: parseSnapshotCreatedAt(fileName) ?? options.now.getTime(),
    sizeBytes: fs.statSync(absolutePath).size,
    origin: options.origin,
  };
}

/** 清点目录内全部快照（按创建时间倒序）；非快照命名的文件忽略 */
export function listSnapshots(targetDir: string): SnapshotRecord[] {
  if (!fs.existsSync(targetDir)) return [];
  const records: SnapshotRecord[] = [];
  for (const fileName of fs.readdirSync(targetDir)) {
    const origin = originOfFileName(fileName);
    if (origin === null) continue;
    const absolutePath = path.join(targetDir, fileName);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) continue;
    records.push({
      fileName,
      absolutePath,
      createdAt: parseSnapshotCreatedAt(fileName) ?? stat.mtimeMs,
      sizeBytes: stat.size,
      origin,
    });
  }
  records.sort((a, b) => b.createdAt - a.createdAt);
  return records;
}

/**
 * 保留份数清理：超出 keepCount 的最旧快照删除。
 * 返回被删除的文件名清单；`deletedUnknown` 为 true 时表示目录里有无法解析
 * 创建时间的快照命名文件（保持不动并在报告中说明）。
 */
export function pruneSnapshots(
  targetDir: string,
  keepCount: number,
): { deleted: string[]; kept: string[]; deletedUnknown: boolean } {
  const snapshots = listSnapshots(targetDir);
  const deleted: string[] = [];
  const deletedUnknownNames: string[] = [];
  const kept: string[] = [];

  const parsable = snapshots.filter(
    (snapshot) => parseSnapshotCreatedAt(snapshot.fileName) !== null,
  );
  const unparsable = snapshots.filter(
    (snapshot) => parseSnapshotCreatedAt(snapshot.fileName) === null,
  );

  // 倒序（最新在前），保留前 keepCount 个
  parsable.forEach((snapshot, index) => {
    if (index < keepCount) {
      kept.push(snapshot.fileName);
      return;
    }
    try {
      fs.unlinkSync(snapshot.absolutePath);
      deleted.push(snapshot.fileName);
    } catch {
      // 删除失败（被占用等）：保留并继续，不中断
      kept.push(snapshot.fileName);
    }
  });
  for (const snapshot of unparsable) {
    kept.push(snapshot.fileName);
    deletedUnknownNames.push(snapshot.fileName);
  }

  return { deleted, kept, deletedUnknown: deletedUnknownNames.length > 0 };
}

export interface RestoreResult {
  /** 回滚前自动创建的安全快照（回滚错了可以再滚回来） */
  safetySnapshot: SnapshotRecord;
  /** 以 full-restore 语义导入所选快照的报告 */
  report: ImportReportData;
}

/**
 * 从快照一键回滚工作区。
 *
 * 顺序固定：先安全快照（当前状态）→ 再导入所选快照（full-restore）。
 * `importFullRestore` 由外壳注入（内部走 T8-03 的导入流水线）。
 */
export async function restoreFromSnapshot(options: {
  snapshotPath: string;
  now: Date;
  createFile: (absolutePath: string) => Promise<void>;
  importFullRestore: (snapshotAbsolutePath: string) => Promise<ImportReportData>;
}): Promise<RestoreResult> {
  if (!fs.existsSync(options.snapshotPath)) {
    throw new Error(`快照不存在：${options.snapshotPath}`);
  }
  const safetySnapshot = await createSnapshot({
    targetDir: path.dirname(options.snapshotPath),
    now: options.now,
    origin: 'pre-restore',
    createFile: options.createFile,
  });
  const report = await options.importFullRestore(options.snapshotPath);
  return { safetySnapshot, report };
}
