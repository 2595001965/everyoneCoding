/**
 * `.ecpkg` 写入器（T8-01）。
 *
 * 职责：把「条目 + manifest 元信息」组装为一个合法的 `.ecpkg` 文件。
 *
 * 写入顺序（与 §14.1 一致）：
 * 1. 内容条目（memory / documents / projects / attachments …）——逐条记账 SHA-256；
 * 2. `checksums.sha256`（覆盖第 1 步全部条目）；
 * 3. `signature.sig`（可选，对去掉 signature 字段的 manifest 规范化字节签名）；
 * 4. `manifest.json`（最后写入，本身不在 checksums 内——它是校验的根）。
 *
 * 落盘方式：全部写入 `<目标>.writing.tmp`，finalize 成功后原子替换目标路径
 * （硬约束 6：临时文件 + 原子替换）；中途 abort 不留半成品。
 *
 * 格式版本可用于兼容矩阵测试（默认取 FORMAT_VERSION，测试可显式覆盖）。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ZipWriter } from './container/zip';
import {
  PKG_CHECKSUM_PATH,
  PKG_MANIFEST_PATH,
  PKG_SIGNATURE_PATH,
  classifyLayoutPath,
  normalizePackagePath,
} from './format/layout';
import {
  buildManifest,
  parseManifest,
  type ContentKind,
  type EncryptionInfo,
  type EcpkgManifest,
  type ExportScope,
} from './format/manifest';
import { serializeChecksumFile, sha256Hex, type ChecksumMap } from './format/checksum';
import { FORMAT_VERSION } from './format/version';
import { signManifest } from './format/signature';

export interface EcpkgGeneratorInfo {
  app: string;
  version: string;
  platform: string;
}

export interface FinalizeMetaInput {
  generator: EcpkgGeneratorInfo;
  scope: ExportScope;
  includes: readonly ContentKind[];
  excludes: readonly string[];
  counts: EcpkgManifest['counts'];
  redacted: boolean;
  /** 仅作 manifest 标记；真正的信封加密由 encryptor 在 finalize 之后包裹 */
  encryption?: EncryptionInfo | undefined;
  /** 默认 FORMAT_VERSION；兼容矩阵测试可覆盖 */
  formatVersion?: string | undefined;
  /** 默认当前时间（ISO 8601） */
  exportedAt?: string | undefined;
  /** 提供则生成 Ed25519 签名并写入 signature.sig 与 manifest.signature */
  signWithPrivateKeyPem?: string | undefined;
}

export interface EcpkgFinalizeResult {
  outputPath: string;
  /** 包内条目总数（不含 manifest 与 checksums 自身） */
  entryCount: number;
  /** 文件总字节数（归档后） */
  archiveSizeBytes: number;
  /** manifest（已写入包内） */
  manifest: EcpkgManifest;
}

export class EcpkgWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcpkgWriteError';
    Object.setPrototypeOf(this, EcpkgWriteError.prototype);
  }
}

export class EcpkgWriter {
  private readonly zip: ZipWriter;
  private readonly tempPath: string;
  private readonly outputPath: string;
  private readonly checksums: ChecksumMap = new Map();
  private finalized = false;

  private constructor(outputPath: string) {
    this.outputPath = outputPath;
    this.tempPath = `${outputPath}.writing.tmp`;
    this.zip = ZipWriter.create(this.tempPath);
  }

  /** 创建写入器（目标文件在 finalize 前保持不动） */
  static create(outputPath: string): EcpkgWriter {
    return new EcpkgWriter(outputPath);
  }

  /** 写入文本条目（UTF-8），自动记账校验和 */
  writeTextEntry(entryPath: string, text: string): void {
    const normalized = this.normalize(entryPath);
    const content = Buffer.from(text, 'utf8');
    this.zip.addBuffer(normalized, content);
    this.checksums.set(normalized, sha256Hex(content));
  }

  /** 写入二进制条目，自动记账校验和 */
  writeBufferEntry(entryPath: string, data: Buffer): void {
    const normalized = this.normalize(entryPath);
    this.zip.addBuffer(normalized, data);
    this.checksums.set(normalized, sha256Hex(data));
  }

  /** 从磁盘流式写入大文件条目（1MB 分块，内存只与块相关），自动记账校验和 */
  async writeFileEntry(entryPath: string, sourceAbsolutePath: string): Promise<void> {
    const normalized = this.normalize(entryPath);
    await this.zip.addFile(normalized, sourceAbsolutePath);
    // 分块流式写入不再整体回读：对源文件独立计算 SHA-256 与包内内容一致
    // （两者字节同源；除非源文件在写入中途被外部修改——那种情况由导入端完整性校验兜底）
    const digest = sha256OfFile(sourceAbsolutePath);
    this.checksums.set(normalized, digest);
  }

  /** 当前已写入的条目清单（供导出任务做进度 / counts 统计） */
  writtenEntries(): string[] {
    return this.zip.entries().map((record) => record.path);
  }

  /**
   * 收尾：写 checksums.sha256 → 可选 signature.sig → manifest.json，
   * 关闭 ZIP 并原子替换目标文件。
   */
  finalize(meta: FinalizeMetaInput): EcpkgFinalizeResult {
    if (this.finalized) throw new EcpkgWriteError('EcpkgWriter 已 finalize，不能重复收尾');

    // 基础 manifest（signature 由签名流程回填）
    const manifest = buildManifest({
      formatVersion: meta.formatVersion ?? FORMAT_VERSION,
      generator: meta.generator,
      exportedAt: meta.exportedAt ?? new Date().toISOString(),
      scope: meta.scope,
      includes: [...meta.includes],
      excludes: [...meta.excludes],
      counts: meta.counts,
      encryption: meta.encryption,
      redacted: meta.redacted,
    });

    // ③ 可选签名：对"去掉 signature 字段的 manifest 规范化字节"签名
    //    （必须先写 signature.sig 并记账，再写 checksums.sha256，清单才能覆盖签名文件）
    if (meta.signWithPrivateKeyPem !== undefined) {
      const signature = signManifest(
        manifest as unknown as Record<string, unknown>,
        meta.signWithPrivateKeyPem,
      );
      manifest.signature = signature;
      const signatureText = `${signature}\n`;
      this.zip.addText(PKG_SIGNATURE_PATH, signatureText);
      this.checksums.set(PKG_SIGNATURE_PATH, sha256Hex(Buffer.from(signatureText, 'utf8')));
    }

    // ② 校验和清单（不含 manifest 自身，也不含 checksums 自身——自引用无意义）
    const checksumText = serializeChecksumFile(this.checksums);
    this.zip.addText(PKG_CHECKSUM_PATH, checksumText);

    // ④ manifest.json 最后写入（校验的根，不入 checksums）
    const manifestText = JSON.stringify(manifest, null, 2);
    this.zip.addText(PKG_MANIFEST_PATH, manifestText);
    parseManifest(manifestText); // 写出前自检：保证包内 manifest 一定过 schema

    this.zip.close();
    this.finalized = true;

    fs.renameSync(this.tempPath, this.outputPath);
    const archiveSizeBytes = fs.statSync(this.outputPath).size;

    return {
      outputPath: this.outputPath,
      entryCount: this.checksums.size,
      archiveSizeBytes,
      manifest,
    };
  }

  /** 中止：丢弃临时文件（用于导出失败的清理） */
  abort(): void {
    if (!this.finalized) {
      this.zip.abort();
    }
    try {
      fs.unlinkSync(this.tempPath);
    } catch {
      /* 尽力清理 */
    }
  }

  private normalize(entryPath: string): string {
    const normalized = normalizePackagePath(entryPath);
    if (normalized === PKG_MANIFEST_PATH || normalized === PKG_CHECKSUM_PATH) {
      throw new EcpkgWriteError(`条目 ${normalized} 由 finalize 自动生成，不允许手工写入`);
    }
    if (classifyLayoutPath(normalized) === 'unknown') {
      throw new EcpkgWriteError(`条目不属于 §14.1 布局：${normalized}`);
    }
    return normalized;
  }
}

/** 流式计算文件 SHA-256（分块，内存只与块相关） */
function sha256OfFile(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** 供导出任务生成不冲突的临时文件名（同目录，保证 rename 原子性） */
export function tempPathFor(outputPath: string): string {
  return path.join(path.dirname(outputPath), `${path.basename(outputPath)}.writing.tmp`);
}
