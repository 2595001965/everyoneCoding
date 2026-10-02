/**
 * V2 公共契约 —— 基础原语（V2-T01）。
 *
 * 本目录是 PRD V2（docs/PRD-EveryoneCoding-V2.md §11）定义的跨领域公共契约层：
 * 只依赖 zod，**禁止任何 Node 运行时依赖**（renderer 经 `browser` 条件直接导入）。
 *
 * primitives 固化四件跨领域语义：
 * - ID：全库统一 26 位 ULID 字符串（与数据层 ids.ts 的生成格式一致），
 *   契约层只做格式校验，不负责生成（生成留在宿主侧）
 * - 时间：一律毫秒时间戳（INTEGER ms，与现有 schema 一致）；不使用 ISO 字符串混存
 * - 版本：行级乐观锁 version（单调整数）+ 源码修订 SourceRevision（git commit / 内容哈希）
 * - 未知值：`null` 表达未知，**绝不回退为 0**；每个可未知字段必须能回答"来自哪里"
 *   （ProvenanceKind / 领域专属 source 枚举），UI 据此区分实测/估算/推断/未知
 */
import { z } from 'zod';

/* ------------------------------- ID ------------------------------- */

/** 26 位 ULID（Crockford Base32，前 10 位为毫秒时间戳）。全库主键统一格式 */
export type Ulid = string;

/** Crockford Base32 字母表（ULID 规范）：排除 I / L / O / U */
const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export function isUlid(value: unknown): value is Ulid {
  return typeof value === 'string' && ULID_RE.test(value);
}

export const ulidSchema = z.string().regex(ULID_RE, '必须是 26 位 ULID（Crockford Base32）');

/** 任意字符串标识（logicalRequestId / 外部系统 ID 等非 ULID 场景） */
export const opaqueIdSchema = z.string().min(1).max(256);

/* ------------------------------ 时间 ------------------------------ */

/** 毫秒时间戳（Unix epoch ms）。与现有数据层全库约定一致（INTEGER ms） */
export type EpochMs = number;

export const epochMsSchema = z.number().int().nonnegative();

/* --------------------------- 来源与置信 --------------------------- */

/**
 * 数据来源口径（PRD §2.3.5「明确事实与估算」）：
 * - measured：工具直接实测（如上游最终 usage）
 * - reported：外部系统上报（如平台网关计量）
 * - estimated：本产品估算（必须展示"估算"标记）
 * - inferred：从证据推断（如 Git 历史推断创建时间）
 * - unknown：未知；**未知不是 0**，UI 必须显式呈现
 */
export const provenanceKind = z.enum(['measured', 'reported', 'estimated', 'inferred', 'unknown']);
export type ProvenanceKind = z.infer<typeof provenanceKind>;

/* ------------------------------ 版本 ------------------------------ */

/** 行级乐观锁版本号（单调递增整数，与现有各表 version 字段同义） */
export const revisionSchema = z.number().int().nonnegative();

/** 源码修订：锚点/变更集/任务基线用来判断"写入时源码是否还是当时那份" */
export interface SourceRevision {
  /** Git commit SHA（完整 40 位十六进制）；非 Git 或未知为 null */
  gitCommit: string | null;
  /** 内容哈希（算法前缀 + 十六进制，如 `sha256:…`）；无法计算为 null */
  contentHash: string | null;
}

export const sourceRevisionSchema = z
  .object({
    gitCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/, '必须是完整 40 位 commit SHA')
      .nullable(),
    contentHash: z
      .string()
      .regex(/^[a-z0-9]+:[0-9a-f]+$/, '格式：`<算法>:<十六进制>`，如 sha256:…')
      .nullable(),
  })
  .refine(
    (v) => v.gitCommit !== null || v.contentHash !== null,
    'SourceRevision 至少要有 gitCommit 或 contentHash 之一，全 null 请直接用 null',
  );

/** SourceRevision（可空整体）：无任何修订信息时整体为 null，不构造空对象 */
export const sourceRevisionNullableSchema = sourceRevisionSchema.nullable();

/* --------------------------- 通用辅助类型 --------------------------- */

/** 关键字备注列表（可空 = 无备注） */
export const notesSchema = z.array(z.string().min(1)).nullable();
