/**
 * 重命名执行器契约（T7-04 要点 2）。
 *
 * 事务化执行顺序（PRD §15.2 ⑤）：
 * `code-ast`（AST 级重构）→ `doc-replace`（文档替换）→ `memory-update`（记忆更新）
 * → `logic-recalc`（逻辑结构重算）→ `anchor-sync`（注册表与 Code Anchor 更新）。
 *
 * 每个执行器只负责自己那一栏，并且必须：
 * - 先**读现状、后写**，写入前把原文快照交给事务（供整体回滚）；
 * - 写入前校验"待替换位置上的文本确实等于旧符号"，位置漂移则**跳过并记失败**
 *   （绝不盲替换 —— FR-UNI-06 的作用域保护在写入侧的延伸）；
 * - 返回可序列化的 `UndoPatch` 描述（写进 `rename_event.changeset_json` 供审计），
 *   真正的字节级还原由事务持有的 `FileSnapshot` 完成。
 *
 * 所有端口由外壳注入：注册表包不 import `node:fs` / `@ec/memory` / `@ec/designer`。
 */

import type { ProjectionKind } from '../naming/presets';
import type { OccurrenceKind } from '../occurrence/types';

/* ------------------------------- 变更记录 ------------------------------- */

/** 一条待执行的变更（由影响面报告的勾选项展开而来） */
export interface ChangeRecord {
  /** 出现位置 id */
  id: string;
  column: OccurrenceKind;
  /**
   * 落点路径：
   * - `code` / `doc`：文件路径
   * - `memory`：记忆条目 id
   * - `logic`：DSL 文档 id（页面 / 功能）
   */
  refPath: string;
  locator: string | null;
  /** 承载者 id（逻辑结构为 DSL 节点 id；其余为 null） */
  carrierId: string | null;
  /** 承载字段（逻辑结构：name / identifier / binding / action） */
  carrierField: string | null;
  matchedSymbol: ProjectionKind | null;
  /** 旧符号文本 */
  target: string;
  /** 新符号文本 */
  replacement: string;
  /** 代码侧：1 基行列（来自 AST，执行前会复核） */
  line: number | null;
  columnNumber: number | null;
}

/** 可序列化的反向补丁（审计 + 诊断用；字节级还原用快照） */
export interface UndoPatch {
  column: OccurrenceKind;
  refPath: string;
  locator: string | null;
  /** 变更后文本（撤销时作为"查找目标"） */
  from: string;
  /** 变更前文本（撤销时作为"替换为"） */
  to: string;
  /** 承载位置（memory 字段路径 / DSL 节点字段 / 锚点 id 等） */
  carrier: string | null;
}

/* ------------------------------- 文件快照 ------------------------------- */

/**
 * 文件级快照（事务临时区备份；撤销与失败回滚的唯一字节依据）。
 *
 * `column` 用于撤销时把快照派发给正确的执行器（code 走文件端口、doc 走文档端口）——
 * 两者都用 `refPath` 定位，但承载端口不同，必须区分。
 */
export interface FileSnapshot {
  column: OccurrenceKind;
  refPath: string;
  /** 变更前内容；`null` 表示文件此前不存在（撤销时删除） */
  before: string | null;
  /** 备份文件路径（写入事务临时区，跨会话撤销用；未落备份时为 null） */
  backupPath: string | null;
}

/* ------------------------------- 端口 ------------------------------- */

/** 文件系统端口（外壳用 `@ec/core` 的 file-service 实现，保证原子写与路径越界防护） */
export interface FileSystemPort {
  read(refPath: string): string | null;
  /** 原子写（临时文件 + 替换） */
  write(refPath: string, content: string): void;
  exists(refPath: string): boolean;
}

/** 记忆写入端口（外壳适配 `@ec/memory`） */
export interface MemoryWritePort {
  /** 更新 `structured` 逻辑结构 JSON 中的某个字符串叶（按 JSON 路径） */
  setStructured(itemId: string, jsonPath: string, value: string): void;
  /** 更新正文提及（按出现位置逐处替换，避免全局盲替换） */
  replaceInContent(itemId: string, from: string, to: string, occurrenceIndex: number): void;
  /** 读取现状（用于快照） */
  read(itemId: string): { structured: unknown; content: string } | null;
  /** 还原到给定内容（撤销） */
  restore(itemId: string, snapshot: { structured: unknown; content: string }): void;
}

/** 逻辑结构（DSL）写入端口（外壳适配 `@ec/designer`） */
export interface LogicWritePort {
  /** 读取 DSL 文档（按页面 / 功能 id） */
  readDocument(documentId: string): unknown;
  /** 重命名 DSL 承载点：节点名 / 变量名 / 绑定路径 / 动作目标 */
  rename(input: {
    documentId: string;
    nodeId: string;
    field: 'name' | 'identifier' | 'binding' | 'action';
    from: string;
    to: string;
  }): void;
  /** 重算并回写逻辑结构摘要（调用 T2-06 的结构精简） */
  recalcSummary(documentId: string): void;
  /** 还原整份 DSL（撤销） */
  restore(documentId: string, snapshot: unknown): void;
}

/** Code Anchor 同步端口（外壳适配 `@ec/ai/src/anchors`，保证 Ctrl+点击不失效） */
export interface AnchorSyncPort {
  /** 读取锚点上的当前符号文本 */
  read(anchorId: string): string | null;
  /** 更新锚点符号（并记录重定位） */
  update(anchorId: string, to: string): void;
  /** 还原锚点符号（撤销） */
  restore(anchorId: string, from: string): void;
  /** 列出与某符号相关的锚点 id */
  findBySymbol(symbol: string): readonly string[];
}

/** 文档写入端口（需求 / 技术 / 关联文档） */
export interface DocWritePort {
  read(documentId: string): string | null;
  /** 写入（保留修订记录；`showRevisionMarks` 为 false 时写入"干净"文本） */
  write(documentId: string, content: string): void;
}

/** 执行上下文 */
export interface ExecutionContext {
  projectId: string;
  /** 是否保留 / 显示修订标记（FR-UNI-09） */
  showRevisionMarks: boolean;
  files: FileSystemPort;
  docs: DocWritePort;
  memory: MemoryWritePort;
  logic: LogicWritePort;
  anchors: AnchorSyncPort;
  /** 事务临时区目录（备份落盘）；为 null 时不落盘备份 */
  backupDir: string | null;
  now: number;
  /** 中断信号：事务可在任意步骤响应中断并整体回滚（NFR-P-07） */
  signal?: AbortSignal | undefined;
}

/* ------------------------------- 执行结果 ------------------------------- */

export interface ExecutorResult {
  column: OccurrenceKind;
  /** 实际写入的处数 */
  applied: number;
  /** 因位置漂移 / 不可定位而跳过 */
  skipped: number;
  /** 失败原因（非空即视为执行失败，事务据此回滚） */
  failures: string[];
  undo: UndoPatch[];
  /** 文件快照（供事务整体回滚） */
  snapshots: FileSnapshot[];
  /** 记忆 / 逻辑 / 锚点快照（供撤销） */
  stateSnapshots: ExecutorStateSnapshot[];
  warnings: string[];
}

/** 非文件类快照（记忆条目 / DSL 文档 / 锚点） */
export interface ExecutorStateSnapshot {
  kind: 'memory' | 'logic' | 'anchor';
  id: string;
  payload: unknown;
}

/** 符号替换对（锚点同步按"符号"而非"位置"工作） */
export interface SymbolPair {
  from: string;
  to: string;
  /** 该符号对应的投影类型；命中规范名本身时为 null */
  matchedSymbol: ProjectionKind | null;
}

/** 执行器输入 */
export interface ExecutorInput {
  /** 逐处变更（由影响面报告的勾选项展开） */
  changes: readonly ChangeRecord[];
  /** 全部符号替换对（供 `anchor-sync` 反查锚点） */
  symbolPairs: readonly SymbolPair[];
}

/** 执行器标识（**不等于** column：`anchor-sync` 与 `logic-recalc` 同属逻辑结构变更） */
export const EXECUTOR_IDS = [
  'code-ast',
  'doc-replace',
  'memory-update',
  'logic-recalc',
  'anchor-sync',
] as const;
export type ExecutorId = (typeof EXECUTOR_IDS)[number];

/** 执行器 */
export interface RenameExecutor {
  /** 执行器标识 */
  readonly id: ExecutorId;
  /** 消费的出现位置类别 */
  readonly column: OccurrenceKind;
  /** 中文名称（UI 的四栏标题） */
  readonly label: string;
  apply(input: ExecutorInput, context: ExecutionContext): ExecutorResult;
  /** 反向执行（一键撤销 / 失败回滚由事务统一调度） */
  revert(result: ExecutorResult, context: ExecutionContext): void;
}

/** 空结果（无待改项） */
export function emptyResult(column: OccurrenceKind): ExecutorResult {
  return {
    column,
    applied: 0,
    skipped: 0,
    failures: [],
    undo: [],
    snapshots: [],
    stateSnapshots: [],
    warnings: [],
  };
}
