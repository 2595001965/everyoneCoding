import type { AnchorDeclaration } from '../anchors/anchor-model';
import type { FileAction, GenerationOutput } from '../generate/output-schema';

/**
 * 代码写入管线的共享类型（T4-05）。
 *
 * 单独成文件的原因与 `context-types` 相同：策略（apply-strategy/*）与流水线
 * （write-pipeline）互相引用，把契约放中间可避免循环导入。
 *
 * 硬约束（D-04 / FR-AI-11）：**不存在"用户手动编辑代码"的模式**。
 * 三种模式都是"AI 产出的内容如何落到磁盘"：
 * - `create`：整体新建（文件已存在则拒绝，改为重新生成补丁）
 * - `patch`：增量补丁（unified diff）
 * - `preview`：先给人看 diff，确认后**同样由 AI 侧应用**（不是让人去手改）
 */

export const WRITE_MODES = ['create', 'patch', 'preview'] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

export const WRITE_MODE_LABELS: Record<WriteMode, string> = {
  create: '新建文件',
  patch: '增量补丁',
  preview: '预览后应用',
};

/** 工作区文件系统端口（外壳适配 @ec/core 的 FileService / shell-api fs） */
export interface WorkspaceFileSystem {
  readText(path: string): Promise<string | null>;
  /** 必须走「临时文件 + 原子替换」（NFR-R-02） */
  writeAtomic(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** 供冲突检测：文件大小（内容哈希由实现方决定是否提供） */
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  mkdir?(path: string): Promise<void>;
}

export interface WritePlanEntry {
  path: string;
  action: FileAction;
  language: string;
  /** 计划写入的内容（delete 为空串） */
  content: string;
  /** 读取时的磁盘内容（新文件为 null） */
  before: string | null;
  /** 应用后的内容（无法计算时为 null，例如被阻塞） */
  after: string | null;
  /** 是否被拒绝（冲突 / 补丁无法应用 / 越界） */
  blocked: boolean;
  /** 拒绝原因（UI 直接展示） */
  blockReason: string | null;
  /** 是否真的产生变更（内容与磁盘一致时为 false，可跳过写入） */
  changed: boolean;
  /** 用户是否勾选应用该文件（diff 面板可按文件选择） */
  selected: boolean;
}

export interface WritePlan {
  id: string;
  mode: WriteMode;
  entries: WritePlanEntry[];
  createdAt: number;
  /** 来源生成结果的说明与决策（结果页展示） */
  summary: string;
  /** 生成结果里声明的锚点（应用成功后由 T4-06 落库） */
  anchors: AnchorDeclaration[];
  /** 本次上下文注入过的备注 id（便于结果页标注「已遵循备注 #id」） */
  noteIds: string[];
  addedLines: number;
  removedLines: number;
  /** 被拒绝的文件数 */
  blockedCount: number;
}

export interface WriteResult {
  ok: boolean;
  planId: string;
  applied: string[];
  skipped: string[];
  /** 出错时已回滚的路径 */
  rolledBack: string[];
  error: string | null;
}

export type WriteEvent =
  | { type: 'file-written'; path: string }
  | { type: 'applied'; planId: string; paths: string[]; anchors: AnchorDeclaration[] }
  | { type: 'rolled-back'; planId: string; paths: string[]; reason: string }
  | { type: 'anchors-written'; anchors: AnchorDeclaration[] }
  | { type: 'external-change'; path: string; changeType: 'create' | 'modify' | 'remove' };

export type WriteEventListener = (event: WriteEvent) => void;

/** 从生成结果构造写入计划的入参 */
export interface PlanWriteInput {
  output: GenerationOutput;
  mode: WriteMode;
  /** 仅应用选中的文件（按 file / hunk 选择后的结果） */
  selectedPaths?: readonly string[] | undefined;
  noteIds?: readonly string[] | undefined;
}

/** 补丁应用结果 */
export interface PatchApplyResult {
  ok: boolean;
  after: string | null;
  error: string | null;
  /** 应用的 hunk 数 */
  hunks: number;
}

/**
 * 代码视图层的错误：把"只读被拒"与"技术故障"区分开。
 * UI 据此展示「交给 AI 修改」引导，而不是"保存失败"这类误导性文案。
 */
export class CodeViewError extends Error {
  readonly userMessage: string;
  readonly action: string;

  constructor(message: string, options: { userMessage?: string; action?: string } = {}) {
    super(message);
    this.name = 'CodeViewError';
    this.userMessage = options.userMessage ?? '无法读取该文件。';
    this.action = options.action ?? '请确认文件仍在工作区内，或刷新文件列表后重试。';
    Object.setPrototypeOf(this, CodeViewError.prototype);
  }
}
