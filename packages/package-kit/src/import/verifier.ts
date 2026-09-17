/**
 * 导入校验器（T8-03）。
 *
 * 依次执行四步校验：① 格式版本（兼容性）② 包结构（§14.1）③ 完整性（逐文件 SHA-256）
 * ④ 签名（可选 Ed25519）⑤ 解密（open 阶段已完成，仅记录结果）。
 *
 * 硬约束：**任一步失败立即中止**，不再继续后续步骤，直接进入失败报告。
 * 解密（口令）在 `EcpkgReader.open` 阶段完成；口令错误抛 `PasswordError`，
 * 映射为 `password` 失败码，面向用户提示"口令错误或包已损坏"。
 */

import { EcpkgReader } from '../reader';
import { PasswordError } from '../container/envelope';
import { checkFormatCompatibility } from '../format/version';
import { assertLayoutStructure } from '../format/layout';
import type { EcpkgManifest } from '../format/manifest';
import type { IntegrityReport } from '../format/checksum';
import type {
  VerificationReport,
  VerifyFailureCode,
  VerifyStepResult,
} from './import-types';

/** verifyPackage 的可选项 */
export interface VerifyOptions {
  /** 加密包口令 */
  password?: string | undefined;
  /** 签名公钥（提供则强制校验，不符即失败） */
  signaturePublicKeyPem?: string | undefined;
  /** 客户端支持的格式版本（缺省取 FORMAT_VERSION） */
  clientFormatVersion?: string | undefined;
}

/** 校验失败时的统一构造 */
function makeFailure(input: {
  code: VerifyFailureCode;
  message: string;
  steps: VerifyStepResult[];
  manifest: EcpkgManifest;
  integrity: IntegrityReport | null;
}): VerificationReport {
  return {
    ok: false,
    steps: input.steps,
    failureCode: input.code,
    failureMessage: input.message,
    integrity: input.integrity,
    manifest: input.manifest,
  };
}

/** 无法读取 manifest 时的占位（口令错误 / 包损坏场景） */
function placeholderManifest(): EcpkgManifest {
  return {
    formatVersion: '0.0.0',
    generator: { app: 'unknown', version: 'unknown', platform: 'unknown' },
    exportedAt: '',
    scope: 'all',
    includes: [],
    excludes: [],
    counts: { projects: 0, memoryItems: 0, documents: 0, pages: 0, codeFiles: 0 },
    checksums: { algorithm: 'sha-256', entries: '' },
    encryption: { mode: 'none' },
    redacted: false,
  };
}

/**
 * 校验一个 `.ecpkg` 是否可安全导入。
 *
 * @returns 成功 `ok: true`；失败 `ok: false` 且带 `failureCode` / `failureMessage`。
 */
export async function verifyPackage(packagePath: string, options: VerifyOptions = {}): Promise<VerificationReport> {
  const steps: VerifyStepResult[] = [];
  let reader: EcpkgReader | null = null;

  try {
    // ① 打开（可能抛 PasswordError → 口令错误；或 EcpkgReadError → 结构/格式问题）
    reader = EcpkgReader.open(packagePath, { password: options.password });
    const entries = reader.listEntries();

    // 包结构断言（open 之后执行；违反 §14.1 → structure 失败码）
    const violations = assertLayoutStructure(entries);
    if (violations.length > 0) {
      const detail = violations.map((v) => `${v.path}（${v.reason}）`).join('；');
      return makeFailure({
        code: 'structure',
        message: `包结构不符合规范：${detail}`,
        steps,
        manifest: reader.manifest,
        integrity: null,
      });
    }
    steps.push({ step: 'format-version', ok: true, detail: `已识别包格式版本 ${reader.manifest.formatVersion}` });

    // 格式版本兼容性（requires-upgrade → version 失败码，消息含"需升级"与版本号）
    const compat = checkFormatCompatibility(reader.manifest.formatVersion, options.clientFormatVersion);
    if (compat.status === 'requires-upgrade') {
      return makeFailure({
        code: 'version',
        message: compat.message ?? '包格式版本不兼容，需升级客户端后再导入',
        steps,
        manifest: reader.manifest,
        integrity: null,
      });
    }

    // ② 完整性（逐文件重算 SHA-256；损坏/缺失列出具体文件）
    const integrity = await reader.verifyIntegrity();
    if (!integrity.ok) {
      const names = [
        ...integrity.corrupted.map((c) => c.path),
        ...integrity.missing.map((m) => m.path),
      ];
      const shown = names.slice(0, 5).join('、') + (names.length > 5 ? ` 等 ${names.length} 个文件` : '');
      return makeFailure({
        code: 'integrity',
        message: `包完整性校验未通过，损坏/缺失文件：${shown}`,
        steps,
        manifest: reader.manifest,
        integrity,
      });
    }
    steps.push({ step: 'integrity', ok: true, detail: `完整性校验通过（已校验 ${integrity.checked} 个文件）` });

    // ③ 签名（包带签名且提供公钥时强制校验；valid===false → signature 失败码）
    const sig = reader.verifySignature(options.signaturePublicKeyPem);
    if (sig.hasSignature && options.signaturePublicKeyPem !== undefined && sig.valid === false) {
      return makeFailure({
        code: 'signature',
        message: sig.detail || '签名校验失败：manifest 与签名不匹配',
        steps,
        manifest: reader.manifest,
        integrity,
      });
    }
    steps.push({ step: 'signature', ok: true, detail: sig.detail });

    // ④ 解密（open 阶段已完成，仅记录结果：是否加密包 + 解密是否成功）
    steps.push({
      step: 'decrypt',
      ok: true,
      detail: reader.encrypted ? '加密包，口令正确并已成功解密' : '明文包，无需解密',
    });

    return {
      ok: true,
      steps,
      failureCode: null,
      failureMessage: null,
      integrity,
      manifest: reader.manifest,
    };
  } catch (error) {
    if (error instanceof PasswordError) {
      return makeFailure({
        code: 'password',
        message: '口令错误或包已损坏',
        steps: [...steps, { step: 'format-version', ok: false, detail: '解密失败' }],
        manifest: placeholderManifest(),
        integrity: null,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return makeFailure({
      code: 'structure',
      message: `无法打开包：${message}`,
      steps,
      manifest: placeholderManifest(),
      integrity: null,
    });
  } finally {
    reader?.close();
  }
}
