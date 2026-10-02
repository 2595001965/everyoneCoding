/**
 * V2 公共契约 —— 运行元素到源码的锚点（V2-T01；PRD §5.2、V2-DOM-03/05、§11.1）。
 *
 * 现状（T01 核验）：现有 `CodeAnchor`（@ec/ai anchors）靠生成期注释标记 +
 * AST 校验三重锚定，`commitSha` 占位恒空、校验态落库即丢失、无内容指纹。
 * 本契约为 T08（静态 HTML/React/Vue 映射）定义目标结构：
 *
 * - 运行实例与源码节点分离：`runtimeId`（哪个运行实例）≠ `sourceRef`（哪个源码位置）
 * - 不把 CSS selector 当永久唯一 ID；列表实例用 `instanceHint` 表达
 * - source map 只是证据之一；无法定位时 `confidence: 'unresolved'` + `invalidReason`，
 *   **禁止编造行号**（schema 层强制 unresolved 必须给原因）
 * - `revision` 记录锚定时的源码修订，写入前据此判断是否过期（V2-API-11）
 */
import { z } from 'zod';
import {
  epochMsSchema,
  opaqueIdSchema,
  revisionSchema,
  ulidSchema,
  sourceRevisionNullableSchema,
  type SourceRevision,
} from './primitives';

/** 源码位置引用（文件 + 行区间 + 符号）；无法定位的项整体为 null，不构造假引用 */
export interface SourceRef {
  /** 项目内相对路径（POSIX 分隔符） */
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  /** 符号名（组件/函数/变量）；文件级定位为 null */
  symbol: string | null;
}

export const sourceRefSchema = z
  .object({
    filePath: z
      .string()
      .min(1)
      .refine((v) => !v.includes('\\'), 'filePath 必须用 POSIX 分隔符（项目内相对路径）')
      .refine((v) => !/^[A-Za-z]:/.test(v), 'filePath 不得是绝对路径'),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
    symbol: z.string().min(1).nullable(),
  })
  .refine(
    (v) => v.startLine === null || v.endLine === null || v.startLine <= v.endLine,
    'startLine 不得大于 endLine',
  );

/** 映射手段（V2-DOM-04/05：开发期编译插桩或映射，仅本地预览生效） */
export const mappingKindSchema = z.enum([
  'static_html',
  'react_compiled',
  'vue_compiled',
  'sourcemap',
  'unknown',
]);
export type MappingKind = z.infer<typeof mappingKindSchema>;

export const anchorConfidenceSchema = z.enum(['exact', 'likely', 'ambiguous', 'unresolved']);
export type AnchorConfidence = z.infer<typeof anchorConfidenceSchema>;

/**
 * 运行页面元素 ↔ 源码节点锚点。
 * 存储目标位置：扩展现有 code_anchor 或新表（T08 决定；迁移追加，**拟新增**）。
 */
export interface ElementAnchor {
  anchorId: string;
  projectId: string;
  /** 所属运行实例（V2-DOM-03）；导入尚未运行时为 null */
  runtimeId: string | null;
  /** 页面路由（SPA 路由变化后锚点需重验） */
  pageRoute: string | null;
  /** 元素身份（designer elementId 或 DOM 选取卡发出的元素标识） */
  elementId: string | null;
  sourceRef: SourceRef | null;
  /** 所属组件候选符号 */
  componentSymbol: string | null;
  /** 列表/循环实例线索（如 keyed item 标识）；共享组件不带实例时为 null */
  instanceHint: string | null;
  /** 锚定时的源码修订（写入前重验，过期即拒） */
  sourceRevision: SourceRevision | null;
  mappingKind: MappingKind;
  confidence: AnchorConfidence;
  /** 失效/降级原因；confidence 为 unresolved 时必须给出 */
  invalidReason: string | null;
  capturedAt: number;
  updatedAt: number;
  /** 行级乐观锁版本 */
  revision: number;
}

export const elementAnchorSchema = z
  .object({
    anchorId: ulidSchema,
    projectId: ulidSchema,
    runtimeId: opaqueIdSchema.nullable(),
    pageRoute: z.string().min(1).nullable(),
    elementId: opaqueIdSchema.nullable(),
    sourceRef: sourceRefSchema.nullable(),
    componentSymbol: z.string().min(1).nullable(),
    instanceHint: z.string().min(1).nullable(),
    sourceRevision: sourceRevisionNullableSchema,
    mappingKind: mappingKindSchema,
    confidence: anchorConfidenceSchema,
    invalidReason: z.string().min(1).nullable(),
    capturedAt: epochMsSchema,
    updatedAt: epochMsSchema,
    revision: revisionSchema,
  })
  .refine(
    (v) => !(v.confidence === 'unresolved' && v.invalidReason === null),
    'unresolved 锚点必须说明原因（明确降级，不虚构定位）',
  )
  .refine(
    (v) => !(v.confidence === 'exact' && v.sourceRef === null),
    'exact 置信度必须有 sourceRef（没有源码位置不得声称精确定位）',
  );
