/**
 * 普通 ZIP 导出与 EveryoneCoding 本地数据快照读取。
 *
 * ZIP 容器复用 package-kit 现有 ZipReader/ZipWriter。源码 ZIP 不带产品元数据；
 * 完整数据快照仅附加一个可读的 everyonecoding-backup.json，供独立恢复流程使用。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import type { ExportScope } from '../format/manifest';
import { ZipReader, ZipWriter } from '../container/zip';
import type { VerificationReport } from '../import/import-types';

export const STANDARD_BACKUP_METADATA_PATH = 'everyonecoding-backup.json';

const backupMetadataSchema = z.object({
  format: z.literal('everyonecoding-local-backup'),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  scope: z.enum(['all', 'project', 'selected']),
  includes: z.array(z.string()),
  redacted: z.boolean(),
  entries: z.array(
    z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
});

const MAX_STANDARD_ENTRIES = 65_535;
const MAX_STANDARD_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_STANDARD_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_STANDARD_RATIO = 1_000;

export type StandardBackupMetadata = z.infer<typeof backupMetadataSchema>;

export interface PackageArchiveReader {
  readonly manifest: { scope: ExportScope; incremental?: { since: number } | undefined };
  listEntries(): string[];
  readEntryBuffer(entryPath: string): Buffer;
  readEntryText(entryPath: string): string;
  close(): void;
}

function safeArchivePath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-zA-Z]:/.test(value) ||
    value.includes('\\') ||
    value.includes(':')
  ) {
    throw new Error(`ZIP 条目路径不安全：${value}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`ZIP 条目路径不安全：${value}`);
  }
  return value;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** 普通 ZIP 写入薄包装：原子落盘；完整备份仅携带可读校验元数据。 */
export class StandardZipWriter {
  private readonly zip: ZipWriter;
  private readonly tempPath: string;
  private readonly outputPath: string;
  private readonly hashes = new Map<string, string>();
  private readonly foldedPaths = new Set<string>();
  private closed = false;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
    this.tempPath = `${outputPath}.writing.tmp`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    this.zip = ZipWriter.create(this.tempPath);
  }

  writeTextEntry(entryPath: string, text: string): void {
    const safe = safeArchivePath(entryPath);
    this.assertUnique(safe);
    const data = Buffer.from(text, 'utf8');
    this.zip.addBuffer(safe, data);
    this.hashes.set(safe, sha256(data));
  }

  writeBufferEntry(entryPath: string, data: Buffer): void {
    const safe = safeArchivePath(entryPath);
    this.assertUnique(safe);
    this.zip.addBuffer(safe, data);
    this.hashes.set(safe, sha256(data));
  }

  async writeFileEntry(entryPath: string, sourcePath: string): Promise<void> {
    const safe = safeArchivePath(entryPath);
    this.assertUnique(safe);
    await this.zip.addFile(safe, sourcePath);
    this.hashes.set(safe, sha256File(sourcePath));
  }

  finalizeBackup(input: {
    scope: ExportScope;
    includes: readonly string[];
    redacted: boolean;
    exportedAt?: string;
  }): void {
    this.writeTextEntry(
      STANDARD_BACKUP_METADATA_PATH,
      JSON.stringify(
        {
          format: 'everyonecoding-local-backup',
          version: 1,
          exportedAt: input.exportedAt ?? new Date().toISOString(),
          scope: input.scope,
          includes: [...input.includes],
          redacted: input.redacted,
          entries: [...this.hashes.entries()]
            .filter(([entryPath]) => entryPath !== STANDARD_BACKUP_METADATA_PATH)
            .map(([entryPath, digest]) => ({ path: entryPath, sha256: digest })),
        },
        null,
        2,
      ),
    );
    this.closeAndCommit();
  }

  finalizeSource(): void {
    this.closeAndCommit();
  }

  abort(): void {
    if (!this.closed) {
      this.zip.abort();
      this.closed = true;
    }
    try {
      fs.unlinkSync(this.tempPath);
    } catch {
      // best-effort cleanup
    }
  }

  private closeAndCommit(): void {
    if (this.closed) throw new Error('ZIP 已结束');
    this.zip.close();
    this.closed = true;
    fs.renameSync(this.tempPath, this.outputPath);
  }

  private assertUnique(entryPath: string): void {
    const folded = entryPath.toLocaleLowerCase('en-US');
    if (this.foldedPaths.has(folded))
      throw new Error(`ZIP 内存在重复或大小写冲突路径：${entryPath}`);
    if (this.hashes.size >= MAX_STANDARD_ENTRIES) throw new Error('ZIP 条目数超过标准限制');
    this.foldedPaths.add(folded);
  }
}

/** 完整备份读取器：只接受标准 ZIP + 可读备份 sidecar，不参与源码 ZIP 导入。 */
export class StandardBackupReader implements PackageArchiveReader {
  private readonly zip: ZipReader;
  readonly metadata: StandardBackupMetadata;
  readonly manifest: PackageArchiveReader['manifest'];

  private constructor(zip: ZipReader, metadata: StandardBackupMetadata) {
    this.zip = zip;
    this.metadata = metadata;
    this.manifest = { scope: metadata.scope };
  }

  static open(filePath: string): StandardBackupReader {
    const zip = ZipReader.open(filePath);
    try {
      const listed = zip.list();
      if (listed.length > MAX_STANDARD_ENTRIES) throw new Error('ZIP 条目数超过安全限制');
      const paths = new Set<string>();
      const folded = new Set<string>();
      let totalSize = 0;
      for (const entry of listed) {
        const normalized = safeArchivePath(entry.path);
        if (paths.has(normalized) || folded.has(normalized.toLocaleLowerCase('en-US'))) {
          throw new Error(`ZIP 内存在重复或大小写冲突路径：${entry.path}`);
        }
        paths.add(normalized);
        folded.add(normalized.toLocaleLowerCase('en-US'));
        if (entry.uncompressedSize > MAX_STANDARD_ENTRY_BYTES) {
          throw new Error(`ZIP 单条目超过安全限制：${entry.path}`);
        }
        totalSize += entry.uncompressedSize;
        if (totalSize > MAX_STANDARD_TOTAL_BYTES) throw new Error('ZIP 展开总大小超过安全限制');
        if (
          entry.uncompressedSize > 1024 * 1024 &&
          entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_STANDARD_RATIO
        ) {
          throw new Error(`ZIP 条目压缩比超过安全限制：${entry.path}`);
        }
      }
      if (!zip.has(STANDARD_BACKUP_METADATA_PATH)) {
        throw new Error('此 ZIP 不含 EveryoneCoding 本地备份信息；请使用源码导入或旧包迁移流程。');
      }
      const metadataEntry = zip
        .list()
        .find((entry) => entry.path === STANDARD_BACKUP_METADATA_PATH);
      if (metadataEntry && metadataEntry.uncompressedSize > 64 * 1024 * 1024) {
        throw new Error('备份描述文件超过安全限制');
      }
      const raw = JSON.parse(
        zip.readEntry(STANDARD_BACKUP_METADATA_PATH).toString('utf8'),
      ) as unknown;
      const metadata = backupMetadataSchema.parse(raw);
      const checksumPaths = new Set<string>();
      for (const entry of metadata.entries) {
        const safe = safeArchivePath(entry.path);
        if (safe === STANDARD_BACKUP_METADATA_PATH || checksumPaths.has(safe) || !zip.has(safe)) {
          throw new Error(`备份校验清单无效：${entry.path}`);
        }
        checksumPaths.add(safe);
        if (sha256(zip.readEntry(safe)) !== entry.sha256) {
          throw new Error(`备份内容校验失败：${safe}`);
        }
      }
      const expected = paths.size - 1;
      if (checksumPaths.size !== expected) throw new Error('备份校验清单与 ZIP 内容不一致');
      return new StandardBackupReader(zip, metadata);
    } catch (error) {
      zip.close();
      throw error;
    }
  }

  listEntries(): string[] {
    return this.zip.list().map((entry) => entry.path);
  }

  readEntryBuffer(entryPath: string): Buffer {
    return this.zip.readEntry(entryPath);
  }

  readEntryText(entryPath: string): string {
    return this.zip.readEntry(entryPath).toString('utf8');
  }

  close(): void {
    this.zip.close();
  }
}

/** ZIP 结构、备份描述和每个文件的 SHA-256 均通过后才允许进入恢复预览。 */
export function verifyStandardBackup(filePath: string): VerificationReport {
  try {
    const reader = StandardBackupReader.open(filePath);
    const entryCount = reader.metadata.entries.length;
    reader.close();
    return {
      ok: true,
      steps: [
        { step: 'format-version', ok: true, detail: '标准 ZIP 结构与备份描述可读取' },
        { step: 'integrity', ok: true, detail: `已校验 ${entryCount} 个数据文件 SHA-256` },
      ],
      failureCode: null,
      failureMessage: null,
      integrity: null,
      manifest: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const integrityFailure = message.includes('校验失败') || message.includes('校验清单');
    return {
      ok: false,
      steps: [
        {
          step: 'format-version',
          ok: !message.includes('ZIP') && !message.includes('EOCD'),
          detail: message,
        },
        { step: 'integrity', ok: false, detail: message },
      ],
      failureCode: integrityFailure ? 'integrity' : 'structure',
      failureMessage: message,
      integrity: null,
      manifest: null,
    };
  }
}
