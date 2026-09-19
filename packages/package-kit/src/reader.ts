/**
 * `.ecpkg` 读取器（T8-01 / T8-03 校验前置）。
 *
 * 打开流程：
 * 1. 探测信封：`PK` 开头 = 明文 ZIP；`ECPKG` 开头 = 加密信封（需要口令解密到
 *    同目录临时文件，验证认证标签后才交给 ZIP 解析器；关闭时删除临时文件）；
 * 2. 解析 central directory（内存 O(条目数)）；
 * 3. 解析并校验 manifest.json（zod schema）。
 *
 * 校验（供 T8-03 导入流水线逐项调用）：
 * - `verifyIntegrity()`：按 checksums.sha256 逐文件重算 SHA-256，损坏时列出具体文件；
 * - `verifySignature(publicKeyPem)`：可选 Ed25519 校验；未提供公钥时返回 skipped。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isEncryptedPackage, unwrapWithPassword } from './container/envelope';
import { ZipReader, ZipReadError } from './container/zip';
import { PKG_CHECKSUM_PATH, PKG_MANIFEST_PATH, PKG_SIGNATURE_PATH } from './format/layout';
import { parseManifest, type EcpkgManifest } from './format/manifest';
import {
  parseChecksumFile,
  verifyChecksums,
  type ChecksumMap,
  type IntegrityReport,
} from './format/checksum';
import { parseSignatureFile, verifyManifestSignature } from './format/signature';

export interface EcpkgOpenOptions {
  /** 加密包必填；明文包忽略 */
  password?: string | undefined;
}

export interface SignatureVerificationResult {
  /** 包内是否带签名 */
  hasSignature: boolean;
  /** 校验结论：true / false；skipped（未配置公钥或包无签名）为 null */
  valid: boolean | null;
  /** 说明（含跳过原因） */
  detail: string;
}

export class EcpkgReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcpkgReadError';
    Object.setPrototypeOf(this, EcpkgReadError.prototype);
  }
}

export class EcpkgReader {
  private readonly zip: ZipReader;
  /** 加密包解密出的临时明文 ZIP（close 时删除） */
  private readonly decryptedTempPath: string | null;
  private manifestValue: EcpkgManifest;
  private readonly checksumMap: ChecksumMap;
  private readonly signatureText: string | null;
  private readonly encryptedFlag: boolean;

  private constructor(
    zip: ZipReader,
    manifestValue: EcpkgManifest,
    checksumMap: ChecksumMap,
    signatureText: string | null,
    encryptedFlag: boolean,
    decryptedTempPath: string | null,
  ) {
    this.zip = zip;
    this.manifestValue = manifestValue;
    this.checksumMap = checksumMap;
    this.signatureText = signatureText;
    this.encryptedFlag = encryptedFlag;
    this.decryptedTempPath = decryptedTempPath;
  }

  /** 打开 `.ecpkg`（同步）：信封探测 → 解密（如需） → ZIP 目录 → manifest 校验 */
  static open(filePath: string, options: EcpkgOpenOptions = {}): EcpkgReader {
    let zipPath = filePath;
    let decryptedTempPath: string | null = null;
    let encrypted = false;

    if (isEncryptedPackage(filePath)) {
      encrypted = true;
      if (options.password === undefined || options.password.length === 0) {
        throw new EcpkgReadError('该包已加密，必须提供口令才能打开');
      }
      decryptedTempPath = path.join(
        path.dirname(filePath),
        `${path.basename(filePath)}.decrypted.tmp`,
      );
      // unwrapWithPassword 失败时内部已清理临时文件并给出明确错误（PasswordError），此处直接上抛
      unwrapWithPassword(filePath, decryptedTempPath, options.password);
      zipPath = decryptedTempPath;
    }

    let zip: ZipReader;
    try {
      zip = ZipReader.open(zipPath);
    } catch (error) {
      if (decryptedTempPath !== null) {
        try {
          fs.unlinkSync(decryptedTempPath);
        } catch {
          /* 尽力清理 */
        }
      }
      if (error instanceof ZipReadError) {
        throw new EcpkgReadError(`包不是合法的归档：${error.message}`);
      }
      throw error;
    }

    try {
      if (!zip.has(PKG_MANIFEST_PATH)) {
        throw new EcpkgReadError('包内缺少 manifest.json，不是合法的 .ecpkg');
      }
      const manifest: EcpkgManifest = parseManifest(
        zip.readEntry(PKG_MANIFEST_PATH).toString('utf8'),
      );

      const checksumMap = zip.has(PKG_CHECKSUM_PATH)
        ? parseChecksumFile(zip.readEntry(PKG_CHECKSUM_PATH).toString('utf8'))
        : new Map<string, string>();

      const signatureText = zip.has(PKG_SIGNATURE_PATH)
        ? parseSignatureFile(zip.readEntry(PKG_SIGNATURE_PATH).toString('utf8'))
        : null;

      // manifest.encryption 与实际信封状态交叉确认（防"标记不一致"）
      const manifestEncrypted = manifest.encryption.mode === 'aes-256-gcm';
      if (manifestEncrypted !== encrypted) {
        throw new EcpkgReadError(
          manifestEncrypted
            ? 'manifest 声明已加密，但包体不是加密信封（文件可能被篡改）'
            : '包体是加密信封，但 manifest 未声明加密（文件可能被篡改）',
        );
      }

      return new EcpkgReader(
        zip,
        manifest,
        checksumMap,
        signatureText,
        encrypted,
        decryptedTempPath,
      );
    } catch (error) {
      zip.close();
      if (decryptedTempPath !== null) {
        try {
          fs.unlinkSync(decryptedTempPath);
        } catch {
          /* 尽力清理 */
        }
      }
      throw error;
    }
  }

  get manifest(): EcpkgManifest {
    return this.manifestValue;
  }

  /** 包体是否经过加密信封 */
  get encrypted(): boolean {
    return this.encryptedFlag;
  }

  /** 包内条目清单（不含 manifest / checksums 元数据也一并列出，按 ZIP 实际为准） */
  listEntries(): string[] {
    return this.zip.list().map((entry) => entry.path);
  }

  hasEntry(entryPath: string): boolean {
    return this.zip.has(entryPath);
  }

  /** 读取条目字节（单条目整体） */
  readEntryBuffer(entryPath: string): Buffer {
    return this.zip.readEntry(entryPath);
  }

  /** 读取条目文本（UTF-8） */
  readEntryText(entryPath: string): string {
    return this.zip.readEntry(entryPath).toString('utf8');
  }

  /** 流式解出条目到目标文件（大文件 / 附件用） */
  async extractEntryTo(entryPath: string, targetAbsolutePath: string): Promise<void> {
    await this.zip.extractEntryTo(entryPath, targetAbsolutePath);
  }

  /**
   * 全量完整性校验：按 checksums.sha256 逐文件重算 SHA-256。
   * 损坏 / 缺失都会列出**具体文件清单**；manifest 与 checksums 自身不在清单内
   * （manifest 是校验根，checksums 无法自证）。
   */
  async verifyIntegrity(): Promise<IntegrityReport> {
    if (this.checksumMap.size === 0) {
      return {
        ok: false,
        corrupted: [],
        missing: [{ path: PKG_CHECKSUM_PATH, reason: '包内缺少 checksums.sha256，无法校验完整性' }],
        checked: 0,
      };
    }
    return verifyChecksums(this.checksumMap, async (entryPath) => {
      if (!this.zip.has(entryPath)) return null;
      try {
        return this.zip.readEntry(entryPath);
      } catch {
        // ZIP 层 CRC 即已损坏：作为"哈希不符"处理，列出具体文件
        return Buffer.alloc(0);
      }
    });
  }

  /** 包内声明的文件数（checksums 条目数，供导入预览） */
  get declaredFileCount(): number {
    return this.checksumMap.size;
  }

  /**
   * 可选 Ed25519 签名校验。
   * - 包无签名 → `{ hasSignature: false, valid: null }`（未配置公钥时跳过）；
   * - 包有签名但调用方未提供公钥 → `{ hasSignature: true, valid: null }`（跳过并说明）；
   * - 提供公钥 → 严格校验，不符返回 `valid: false`（调用方据此中止导入）。
   */
  verifySignature(publicKeyPem?: string | undefined): SignatureVerificationResult {
    if (this.signatureText === null) {
      return {
        hasSignature: false,
        valid: null,
        detail: '包内无签名（signature.sig 不存在），跳过签名校验',
      };
    }
    const manifestSignature = this.manifestValue.signature;
    const signature = manifestSignature ?? this.signatureText;
    if (publicKeyPem === undefined || publicKeyPem.length === 0) {
      return { hasSignature: true, valid: null, detail: '包内带签名，但未配置公钥，跳过签名校验' };
    }
    const valid = verifyManifestSignature(
      this.manifestValue as unknown as Record<string, unknown>,
      signature,
      publicKeyPem,
    );
    return {
      hasSignature: true,
      valid,
      detail: valid ? '签名校验通过' : '签名校验失败：manifest 内容与签名不匹配（包可能被篡改）',
    };
  }

  /** 关闭并清理解密临时文件 */
  close(): void {
    this.zip.close();
    if (this.decryptedTempPath !== null) {
      try {
        fs.unlinkSync(this.decryptedTempPath);
      } catch {
        /* 尽力清理 */
      }
    }
  }
}
