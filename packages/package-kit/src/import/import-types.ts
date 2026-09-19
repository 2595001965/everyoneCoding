/**
 * 导入流水线契约类型（T8-03）。
 *
 * 本文件是**冻结接口**：T8-03 实现与 T8-04（自愈/增量）都依赖这里的签名，
 * 字段名与结构不得改动（需要扩展只能加可选字段）。
 *
 * 落库一律经 `ImportTargetPort` 注入——package-kit 不直接操作 SQLite；
 * 记忆条目的差异分类与合并计划复用 `@ec/memory` 的 `classifyImport` / `planMerge`（T2-07），
 * 文档 / 设计 DSL / 注册表对象用本文件的通用分类（id + updatedAt 口径）。
 */

import type { EcpkgManifest } from '../format/manifest';
import type { IntegrityReport } from '../format/checksum';

/** 五种导入模式（FR-PKG-08） */
export type ImportMode = 'full-restore' | 'merge' | 'memory-only' | 'documents-only' | 'code-only';

export const IMPORT_MODE_LABELS: Record<ImportMode, string> = {
  'full-restore': '完整恢复（覆盖同名项目）',
  merge: '合并（按 id + updatedAt 解决冲突）',
  'memory-only': '仅记忆',
  'documents-only': '仅文档',
  'code-only': '仅代码',
};

/** 差异分类（与 @ec/memory 的 ImportClassification 同口径） */
export type PackageDiffClassification = 'added' | 'conflicted' | 'unchanged' | 'missing';

/** 包内对象类别（冲突按类型批量决策的分组键） */
export type PackageObjectType =
  'memory' | 'document' | 'design' | 'registry' | 'code' | 'anchor' | 'pipeline';

/** 包内一个可比较对象（通用镜像，避免渲染层 / 包间运行时依赖） */
export interface PackageObject {
  /** 对象 id（ULID，稳定不变） */
  id: string;
  type: PackageObjectType;
  /** 所属项目（项目级对象才有；长期记忆为 null） */
  projectId: string | null;
  /** 展示名（冲突列表用） */
  name: string;
  updatedAt: number;
  /** 对象负载（JSON 字符串；代码文件为文本内容） */
  payload: string;
}

/** 单条差异 */
export interface PackageDiffItem {
  incoming: PackageObject;
  /** 本地同 id 对象，无则 null */
  local: PackageObject | null;
  classification: PackageDiffClassification;
}

/** 差异预览（FR-PKG-08 验收：新增/冲突/无变化/缺失 四类统计） */
export interface PackageDiffPreview {
  items: PackageDiffItem[];
  counts: Record<PackageDiffClassification, number>;
  /** 本地有、包里没有的对象（仅记忆模式下列出，提示"缺失"） */
  missingLocals: PackageObject[];
}

/** 逐条决策（FR-PKG-09：保留本地 / 采用包内 / 两者都保留） */
export type ConflictResolution = 'keepLocal' | 'takeNew' | 'keepBoth';

export interface ConflictDecision {
  /** incoming.id */
  id: string;
  resolution: ConflictResolution;
}

/** 合并计划中的单条产出 */
export interface ResolutionOutcome {
  id: string;
  resolution: ConflictResolution;
  /** takeNew/keepBoth 时为包内对象；keepLocal 时为本地对象 */
  incoming: PackageObject;
  /** keepBoth 时新建的对象（新 id，由冲突解决器生成） */
  created: PackageObject | null;
}

/** 冲突解决计划（纯数据，可审计） */
export interface ResolutionPlan {
  outcomes: ResolutionOutcome[];
  summary: { keepLocal: number; takeNew: number; keepBoth: number };
}

/** 按对象类型批量决策（FR-PKG-09：支持按类型批量） */
export function batchDecideByType(
  preview: PackageDiffPreview,
  byType: Partial<Record<PackageObjectType, ConflictResolution>>,
): ConflictDecision[] {
  const decisions: ConflictDecision[] = [];
  for (const item of preview.items) {
    const resolution = byType[item.incoming.type];
    if (resolution !== undefined) {
      decisions.push({ id: item.incoming.id, resolution });
    }
  }
  return decisions;
}

/* ------------------------------ 校验 ------------------------------ */

/** 校验失败原因分类（verifier 逐步校验，任一步失败即中止） */
export type VerifyFailureCode = 'version' | 'integrity' | 'signature' | 'password' | 'structure';

export interface VerifyStepResult {
  step: 'format-version' | 'integrity' | 'signature' | 'decrypt';
  ok: boolean;
  detail: string;
}

/** 校验报告（全部通过才允许进入差异预览 / 导入） */
export interface VerificationReport {
  ok: boolean;
  steps: VerifyStepResult[];
  /** 失败原因码（ok 时为 null） */
  failureCode: VerifyFailureCode | null;
  /** 面向用户的中文原因（"需升级" / 损坏文件清单 / 口令错误…） */
  failureMessage: string | null;
  /** 完整性明细（integrity 步骤） */
  integrity: IntegrityReport | null;
  manifest: EcpkgManifest;
}

/* ------------------------------ 落库端口 ------------------------------ */

/** 本地对象读取（差异分类用；外壳装配，测试用内存假实现） */
export interface ImportLocalStatePort {
  /** 本地全部项目 id 与 updatedAt（meta 级） */
  listProjects(): Array<{ id: string; name: string; updatedAt: number }>;
  /** 本地对象清单（按类型；mode 预览与冲突分类用） */
  listObjects(type: PackageObjectType, projectId: string | null): PackageObject[];
}

/**
 * 导入落库端口（外壳装配；测试用内存假实现）。
 *
 * 设计：`applyWrites` 一次性接收全部写意图——导入在**校验全通过之后**才执行，
 * 且由调用方保证先清点后落库；执行器逐条记录失败并在报告中返回（不抛异常），
 * 供"重试失败项"使用。绝不产生半导入状态的前提是前置校验全部通过。
 */
export interface ImportTargetPort {
  /** 写入/覆盖一个项目（full-restore 覆盖同名项目） */
  upsertProject(meta: { id: string; name: string; metaJson: string }): 'created' | 'updated';
  /** 写入对象；返回实际生效的写法 */
  putObject(object: PackageObject): 'created' | 'updated' | 'skipped';
  /** 写入原始文件（documents/<docId>/ 原文件、attachments 内容寻址文件） */
  putFile(packagePath: string, content: Buffer): 'created' | 'updated' | 'skipped';
  /** 记忆合并意图（复用 @ec/memory planMerge 的产出；keepLocal 不产生写） */
  applyMemoryMerge(intents: {
    toCreate: Array<{ json: string }>;
    toUpdate: Array<{ json: string }>;
    toSupersede: string[];
  }): { created: number; updated: number; superseded: number };
}

/* ------------------------------ 导入报告 ------------------------------ */

export interface ImportReportData {
  mode: ImportMode;
  /** 四类统计 */
  counts: { added: number; conflicted: number; unchanged: number; missing: number };
  /** 实际落库统计 */
  applied: {
    createdProjects: number;
    updatedProjects: number;
    createdObjects: number;
    updatedObjects: number;
    keptBothObjects: number;
    memoryCreated: number;
    memoryUpdated: number;
    memorySuperseded: number;
    filesWritten: number;
  };
  /** 冲突决策摘要 */
  resolutions: { keepLocal: number; takeNew: number; keepBoth: number };
  /** 失败清单（可重试） */
  failures: Array<{ path: string; reason: string }>;
  /** 导出为文件（JSON 报告）的目标路径；未导出为 null */
  reportPath: string | null;
  durationMs: number;
}

/** 导入请求（T8-03 的 ImportJob 输入） */
export interface ImportJobRequest {
  packagePath: string;
  mode: ImportMode;
  /** 加密包口令 */
  password?: string | undefined;
  /** 签名公钥（提供则强制校验） */
  signaturePublicKeyPem?: string | undefined;
  /** 冲突逐条决策（conflicted 条目必须显式决策，默认不覆盖） */
  decisions: readonly ConflictDecision[];
  /** 按类型批量决策（逐条决策优先） */
  batchDecisions?: Partial<Record<PackageObjectType, ConflictResolution>> | undefined;
  /** 差异预览结果由调用方传入（先 preview 再导入，两段式） */
  preview?: PackageDiffPreview | undefined;
  onProgress?:
    | ((stage: string, processed: number, total: number, currentFile: string | null) => void)
    | undefined;
}

/** 模式影响预览（mode-selector：导入前展示将新增/覆盖/跳过多少对象） */
export interface ModePreview {
  mode: ImportMode;
  /** 将写入的对象数 */
  toApply: number;
  /** 将覆盖的本地对象数 */
  toOverwrite: number;
  /** 将跳过的对象数（模式不涵盖的类别） */
  toSkip: number;
  /** 各类别明细 */
  byType: Record<PackageObjectType, { apply: number; overwrite: number; skip: number }>;
  /** 说明文案 */
  summary: string;
}
