/**
 * 出现位置索引的公共契约（T7-02，FR-UNI-04 / FR-UNI-06 / PRD §6.2 `occurrence`）。
 *
 * 索引的四个来源：**代码（AST）/ 文档 / 记忆 / 逻辑结构**。所有来源统一产出
 * `Occurrence`，再交给 `risk-classifier` 做三级风险分级。
 *
 * 代码侧是**硬约束**（FR-UNI-06）：必须 AST 作用域感知，禁止纯文本替换；
 * 同名局部变量、注释中的同名文本、第三方库同名符号**均不得**被索引为可改项。
 */

import type { ProjectionKind } from '../naming/presets';
import type { ProjectionSet, RegistryEntityType } from '../registry-model';
import type { LineContext } from './text-utils';

/* ------------------------------- 枚举 ------------------------------- */

/** 命中来源（PRD §6.2 `occurrence.kind`） */
export const OCCURRENCE_KINDS = ['code', 'doc', 'memory', 'logic'] as const;
export type OccurrenceKind = (typeof OCCURRENCE_KINDS)[number];

/** 三级风险（FR-UNI-04） */
export const RISK_LEVELS = ['auto', 'confirm', 'warn'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** 索引状态：代码变更后置 `stale`，支持增量重建 */
export const OCCURRENCE_STATUSES = ['active', 'stale'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** 命中的语法角色（代码侧） */
export const HIT_ROLES = [
  'declaration',
  'import',
  'call',
  'type-reference',
  'member-access',
  'jsx-tag',
  'binding',
  'property-key',
  'string-literal',
] as const;
export type HitRole = (typeof HIT_ROLES)[number];

/** 支持解析的源码语言 */
export const SOURCE_LANGUAGES = ['ts', 'tsx', 'js', 'jsx', 'python', 'java'] as const;
export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];

/* ------------------------------- 领域对象 ------------------------------- */

/** 代码列表：AST 解析产出的原始命中（尚未落库、尚未分级） */
export interface RawHit {
  refPath: string;
  /** 1 基行号 */
  line: number;
  /** 1 基列号 */
  column: number;
  /** 命中符号长度（列范围 = column .. column + length - 1） */
  length: number;
  /** 命中的投影类型；`null` 表示命中规范名本身 */
  matchedSymbol: ProjectionKind | null;
  /** 命中的符号文本 */
  symbol: string;
  role: HitRole;
  /** 置信度：AST 精确命中为 1.0；成员访问等次要位置可略低 */
  confidence: number;
  /** ±3 行上下文（展开查看用，可缺省） */
  context: LineContext | null;
  /** 备注（例如"成员访问：接收者非 this，需人工确认"） */
  note: string | null;
}

/** 可改项（落库前的完整描述） */
export interface Occurrence {
  id: string;
  registryId: string;
  kind: OccurrenceKind;
  /** 代码：文件路径；文档：文档 id；记忆：记忆条目 id；逻辑：DSL 节点 id */
  refPath: string;
  /** 代码 `file:line:col`；文档段落锚点；记忆 `条目id + 字段名`；逻辑 `节点路径` */
  locator: string | null;
  matchedSymbol: ProjectionKind | null;
  /** 命中的具体符号文本 */
  symbol: string;
  confidence: number;
  riskLevel: RiskLevel;
  status: OccurrenceStatus;
  /** 代码侧语法角色；非代码来源为 null */
  role: HitRole | null;
  /** 当前位置的 ±3 行上下文（仅代码侧） */
  context: LineContext | null;
  /** 补充说明（语义匹配置信度来源、warn 原因等） */
  detail: string | null;
  /**
   * 记忆层级（仅 `kind === 'memory'` 时有值：longterm / project / feature / page / issue）。
   *
   * ⚠️ **不入库**：`occurrence` 表按 PRD §6.2 无此列。它的唯一用途是在影响面分析中
   * 排除 `longterm`（FR-UNI-13 / D-07：长期记忆由用户在记忆中心自行维护，重命名不自动改）。
   */
  scopeLayer?: string | null | undefined;
  /**
   * 承载者 id（逻辑结构为 DSL 节点 id、锚点为锚点 id、记忆为条目 id、代码 / 文档为 null）。
   *
   * ⚠️ **不入库**：执行器需要它才能精确定位承载点。跨会话的撤销依赖
   * `rename_event.changeset_json` 里的 `UndoPatch.carrier`，而非本字段。
   */
  carrierId?: string | null | undefined;
  /**
   * 承载字段（逻辑结构：`name` / `identifier` / `binding` / `action`；
   * 文档：块类型；代码 / 记忆：null）。同样**不入库**，仅供执行器定位。
   */
  carrierField?: string | null | undefined;
  createdAt: number;
  updatedAt: number;
}

/** 镜像 `@ec/data` 的 `occurrence` 表列（顺序与 DDL 一致） */
export interface OccurrenceRecord {
  id: string;
  registry_id: string;
  kind: OccurrenceKind;
  ref_path: string;
  locator: string | null;
  matched_symbol: string | null;
  confidence: number;
  risk_level: RiskLevel;
  status: OccurrenceStatus;
  created_at: number;
  updated_at: number;
}

/** `occurrence` 的列清单（与迁移 SQL 逐列比对） */
export const OCCURRENCE_COLUMNS: readonly (keyof OccurrenceRecord)[] = [
  'id',
  'registry_id',
  'kind',
  'ref_path',
  'locator',
  'matched_symbol',
  'confidence',
  'risk_level',
  'status',
  'created_at',
  'updated_at',
];

/* ------------------------------- 索引输入 ------------------------------- */

/** 待索引的工程文件 */
export interface IndexSourceFile {
  /** 相对项目根的路径（正斜杠） */
  path: string;
  content: string;
  /** 语言；缺省按扩展名推断 */
  language?: SourceLanguage | undefined;
}

/** 文档来源（需求文档 / 技术文档 / 关联文档） */
export interface DocSource {
  /** 文档 id */
  id: string;
  title: string;
  /** Markdown 正文（段落锚点按标题 id 生成） */
  content: string;
  /** 文档类型，用于展示与风险判定 */
  type?: 'requirement' | 'tech' | 'related' | undefined;
}

/** 记忆来源（五层记忆；由外壳从 `@ec/memory` 适配成该结构） */
export interface MemorySource {
  id: string;
  /** 记忆层级：longterm / project / feature / page / issue */
  layer: string;
  title: string;
  /** 逻辑结构 JSON（精确匹配，confidence 1.0） */
  structured: unknown;
  /** 正文（语义匹配，带置信度） */
  content: string;
}

/** 逻辑结构来源（PageDSL 的节点名 / 绑定路径 / 事件动作目标） */
export interface LogicSourceNode {
  /** 所属 DSL 文档 id（页面 / 功能），逻辑结构变更的落点 */
  documentId: string;
  /** 节点 id */
  id: string;
  /** 节点类型（Container / Button / State / Action …） */
  type: string;
  /** 显示名（中英文均可能） */
  name: string;
  /** 变量名 / 状态键 */
  identifier?: string | undefined;
  /** 绑定路径（如 `state.userLoginButton`） */
  bindings?: readonly string[] | undefined;
  /** 事件动作目标（如 `handleUserLoginButton`） */
  actions?: readonly string[] | undefined;
  children?: readonly LogicSourceNode[] | undefined;
}

/* ------------------------------- 索引输出 ------------------------------- */

/** 能力降级记录（工具链不可用时如实上报，绝不静默跳过） */
export interface ParserDegradation {
  /** 降级的语言 / 来源 */
  language: SourceLanguage | 'doc' | 'logic';
  /** 降级原因（如"未检测到 libcst"） */
  reason: string;
  /** 采用的替代方案 */
  fallback: string;
}

/** 索引构建统计（性能验收 NFR-P-06 ≤1.5s） */
export interface IndexBuildStats {
  filesScanned: number;
  linesScanned: number;
  code: number;
  doc: number;
  memory: number;
  logic: number;
  total: number;
  elapsedMs: number;
}

/* ------------------------------- AST 解析契约 ------------------------------- */

/** 待匹配的符号目标 */
export interface SymbolTarget {
  kind: ProjectionKind;
  value: string;
}

export interface AstParseInput {
  path: string;
  content: string;
  targets: readonly SymbolTarget[];
  /** 上下文行数（默认 3） */
  contextRadius?: number | undefined;
}

export interface AstParseResult {
  hits: RawHit[];
  /** 该语言解析器的降级信息（未降级为 null） */
  degradation: ParserDegradation | null;
}

/** 语言解析器（TS/JS、Python、Java 各自实现同一接口） */
export interface AstParser {
  readonly language: SourceLanguage;
  parse(input: AstParseInput): AstParseResult;
}

/**
 * 外部解析器端口（可选增强）。
 *
 * Python 的 libcst 与 Java 的 JavaParser 属外部工具链；装配时若可用，
 * 由外壳注入本端口，`ast/index.ts` 会**优先**使用它，否则回退到内置解析器
 * 并在结果中记录 `ParserDegradation`（FR-UNI-06 的降级口径）。
 */
export interface ExternalAstParserPort {
  language: SourceLanguage;
  /** 返回 null 表示该端口当前不可用（例如 Python 解释器缺失） */
  parse(input: AstParseInput): AstParseResult | null;
}

/* ------------------------------- 投影分类 ------------------------------- */

/**
 * 只可能出现在**标识符位置**的投影。
 *
 * 这些投影在代码里是标识符，因此**只索引标识符位置**，绝不匹配字符串字面量
 * （避免"字符串里的同名文本"被误改，FR-UNI-06 反例之一）。
 */
export const IDENTIFIER_PROJECTIONS: readonly ProjectionKind[] = [
  'component',
  'variable',
  'cssClass',
  'apiField',
  'methodName',
];

/**
 * 只可能出现在**字符串字面量 / 模板字符串**中的投影。
 *
 * i18n key、路由片段、测试用例名在代码里本就是字符串内容；对它们做
 * **精确整串匹配**是语义正确的（字符串是它们的唯一载体），不属于"误伤字符串"。
 */
export const STRING_PROJECTIONS: readonly ProjectionKind[] = [
  'i18nKey',
  'routeSegment',
  'testName',
];

/** 把投影集合拆成两类目标 */
export function splitTargets(projections: Partial<ProjectionSet>): {
  identifiers: SymbolTarget[];
  strings: SymbolTarget[];
} {
  const identifiers: SymbolTarget[] = [];
  const strings: SymbolTarget[] = [];
  for (const kind of IDENTIFIER_PROJECTIONS) {
    const value = projections[kind];
    if (value !== undefined && value.length > 0) identifiers.push({ kind, value });
  }
  for (const kind of STRING_PROJECTIONS) {
    const value = projections[kind];
    if (value !== undefined && value.length > 0) strings.push({ kind, value });
  }
  return { identifiers, strings };
}

/** 文档 / 记忆 / 逻辑结构扫描器的公共输入 */
export interface ScanContext {
  registryId: string;
  entityType: RegistryEntityType;
  canonicalName: string;
  projections: ProjectionSet;
  scope: string;
  now: number;
}
