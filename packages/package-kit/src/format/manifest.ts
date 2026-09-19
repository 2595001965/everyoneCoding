/**
 * `manifest.json` 领域模型（T8-01 / PRD §14.1 字段表 + §13.4 示例）。
 *
 * 字段与 §13.4 示例逐项对齐：
 * formatVersion / generator{app,version,platform} / exportedAt / scope /
 * includes[] / excludes[] / counts{...} / checksums{algorithm,entries} /
 * encryption{mode,kdf,iterations} / redacted / signature(可选)。
 *
 * zod 校验：导入端先过 schema 再谈兼容，字段缺失或类型不对直接明确报错。
 */
import { z } from 'zod';

/** 语义化版本三段式 */
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 内容选择种类（includes 的合法值，PRD §14.1：记忆层级、文档、代码、流水线、锚点） */
export const CONTENT_KINDS = [
  'memory',
  'documents',
  'design',
  'code',
  'pipeline',
  'anchors',
  'registry',
  'attachments',
] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** 导出范围 */
export const EXPORT_SCOPES = ['all', 'project', 'selected'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

/** 未加密标记 */
export interface EncryptionNone {
  mode: 'none';
}

/** AES-256-GCM 加密标记（口令 PBKDF2 派生，口令本身绝不写入包内） */
export interface EncryptionAes {
  mode: 'aes-256-gcm';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
}

export type EncryptionInfo = EncryptionNone | EncryptionAes;

/** `.ecpkg` 清单（对应包根 manifest.json） */
export interface EcpkgManifest {
  /** 包格式版本（语义化），导入端据此选择兼容策略 */
  formatVersion: string;
  /** 生成方：客户端版本与平台 */
  generator: { app: string; version: string; platform: string };
  /** 导出时间戳（ISO 8601） */
  exportedAt: string;
  /** 导出范围 */
  scope: ExportScope;
  /** 包含的内容种类 */
  includes: ContentKind[];
  /** 排除规则（glob 片段，如 node_modules/**） */
  excludes: string[];
  /** 各类对象数量（导入前预览用） */
  counts: {
    projects: number;
    memoryItems: number;
    documents: number;
    pages: number;
    codeFiles: number;
  };
  /** 完整性校验：逐文件 SHA-256 清单所在文件 */
  checksums: { algorithm: 'sha-256'; entries: string };
  /** 加密标记 */
  encryption: EncryptionInfo;
  /** 是否执行了敏感信息脱敏 */
  redacted: boolean;
  /** 可选 Ed25519 签名（ed25519:<base64>），权威载体是 signature.sig */
  signature?: string | undefined;
}

/* ------------------------------ zod schema ------------------------------ */

const nonNegativeInt = z.number().int().min(0);

export const ecpkgManifestSchema: z.ZodType<EcpkgManifest> = z.object({
  formatVersion: z
    .string()
    .regex(semverPattern, 'formatVersion 必须是 major.minor.patch 语义化版本'),
  generator: z.object({
    app: z.string().min(1),
    version: z.string().min(1),
    platform: z.string().min(1),
  }),
  exportedAt: z.string().min(1),
  scope: z.enum(EXPORT_SCOPES),
  includes: z.array(z.enum(CONTENT_KINDS)),
  excludes: z.array(z.string()),
  counts: z.object({
    projects: nonNegativeInt,
    memoryItems: nonNegativeInt,
    documents: nonNegativeInt,
    pages: nonNegativeInt,
    codeFiles: nonNegativeInt,
  }),
  checksums: z.object({
    algorithm: z.literal('sha-256'),
    entries: z.string().min(1),
  }),
  encryption: z.union([
    z.object({ mode: z.literal('none') }),
    z.object({
      mode: z.literal('aes-256-gcm'),
      kdf: z.literal('PBKDF2-SHA256'),
      iterations: z.number().int().positive(),
    }),
  ]),
  redacted: z.boolean(),
  signature: z.string().optional(),
});

/** 校验并解析 manifest；失败时抛出含具体字段路径的错误 */
export function parseManifest(raw: string): EcpkgManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = ecpkgManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('；');
    throw new Error(`manifest.json 校验失败：${issues}`);
  }
  return result.data;
}

/**
 * 构造新 manifest（写入端使用）。
 * encryption 缺省为 none；signature 由签名流程回填。
 */
export function buildManifest(input: {
  formatVersion: string;
  generator: { app: string; version: string; platform: string };
  exportedAt: string;
  scope: ExportScope;
  includes: readonly ContentKind[];
  excludes: readonly string[];
  counts: EcpkgManifest['counts'];
  checksumsEntryFile?: string | undefined;
  encryption?: EncryptionInfo | undefined;
  redacted: boolean;
}): EcpkgManifest {
  const encryption: EncryptionInfo =
    input.encryption !== undefined ? input.encryption : { mode: 'none' };
  const manifest: EcpkgManifest = {
    formatVersion: input.formatVersion,
    generator: input.generator,
    exportedAt: input.exportedAt,
    scope: input.scope,
    includes: [...input.includes],
    excludes: [...input.excludes],
    counts: { ...input.counts },
    checksums: { algorithm: 'sha-256', entries: input.checksumsEntryFile ?? 'checksums.sha256' },
    encryption,
    redacted: input.redacted,
  };
  const result = ecpkgManifestSchema.safeParse(manifest);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')} ${issue.message}`)
      .join('；');
    throw new Error(`构造 manifest 失败：${issues}`);
  }
  return manifest;
}
