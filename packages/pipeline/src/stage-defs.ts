/**
 * S1–S7 七阶段定义（T5-01 要点 1 / PRD §7.1）。
 *
 * 每阶段固定四件事：输入、产出物类型、完成条件、可否跳过。
 * 定义是**纯数据**，状态机与 UI 共用同一份，避免"PRD 说一套、代码做一套"。
 *
 * 产出物类型与 @ec/data 的 `artifactType` 枚举对齐：
 * requirement_doc / design_dsl / tech_doc / code_patch。
 * S5 逐个生成会产生多个 code_patch 产物（每个节点一个），由 artifact-store 管理。
 */

/** 流水线阶段（与 @ec/data schema 的 pipelineStage 枚举逐字对齐） */
export const PIPELINE_STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** 阶段状态（与 @ec/data schema 的 runStatus 枚举逐字对齐） */
export const STAGE_STATUSES = [
  'pending',
  'running',
  'awaiting_confirm',
  'confirmed',
  'stale',
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  pending: '未开始',
  running: '进行中',
  awaiting_confirm: '待确认',
  confirmed: '已确认',
  stale: '已过期',
};

/** 阶段产出物类型（与 @ec/data schema 的 artifactType 枚举逐字对齐） */
export const ARTIFACT_TYPES = ['requirement_doc', 'design_dsl', 'tech_doc', 'code_patch'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  requirement_doc: '需求文档',
  design_dsl: '界面设计 DSL',
  tech_doc: '技术文档',
  code_patch: '代码产物',
};

/** 单个阶段的静态定义（PRD §7.1 的表格化） */
export interface StageDef {
  /** 阶段号（S1–S7） */
  id: PipelineStage;
  /** 中文名 */
  name: string;
  /** 输入（阶段开始前必须就绪的东西） */
  inputs: readonly string[];
  /** 产出物类型 */
  artifactType: ArtifactType;
  /** 产出物中文名（步骤条与产物面板标题用） */
  artifactLabel: string;
  /** 完成条件（awaiting_confirm → confirmed 的业务判据，UI 展示给用户） */
  completionCondition: string;
  /** 能否被用户显式跳过（S6 集成联调与 S7 交付维护在简单项目里可跳过） */
  skippable: boolean;
}

export const STAGE_DEFS: Readonly<Record<PipelineStage, StageDef>> = {
  S1: {
    id: 'S1',
    name: '需求文档生成',
    inputs: ['用户自然语言描述'],
    artifactType: 'requirement_doc',
    artifactLabel: '需求文档',
    completionCondition: '用户确认需求文档（满意并进入下一阶段）',
    skippable: false,
  },
  S2: {
    id: 'S2',
    name: '界面设计',
    inputs: ['需求文档'],
    artifactType: 'design_dsl',
    artifactLabel: '页面 DSL',
    completionCondition: '用户确认设计稿',
    skippable: false,
  },
  S3: {
    id: 'S3',
    name: '技术文档生成',
    inputs: ['需求文档', '页面结构', '记忆（长期 / 项目）', '技术选型问卷结果'],
    artifactType: 'tech_doc',
    artifactLabel: '技术文档',
    completionCondition: '用户确认技术文档',
    skippable: false,
  },
  S4: {
    id: 'S4',
    name: '功能与页面拆分',
    inputs: ['技术文档'],
    artifactType: 'tech_doc',
    artifactLabel: '拆分结果（功能树 + 页面清单 + 拓扑）',
    completionCondition: '用户确认拆分结果',
    skippable: false,
  },
  S5: {
    id: 'S5',
    name: '逐个生成',
    inputs: ['拆分结果', '全部记忆', '依赖接口契约'],
    artifactType: 'code_patch',
    artifactLabel: '逐节点代码产物',
    completionCondition: '全部节点生成完成',
    skippable: false,
  },
  S6: {
    id: 'S6',
    name: '集成联调',
    inputs: ['生成的代码'],
    artifactType: 'code_patch',
    artifactLabel: '可运行项目 + 预览环境',
    completionCondition: '项目启动成功且冒烟用例通过',
    skippable: true,
  },
  S7: {
    id: 'S7',
    name: '交付与维护',
    inputs: ['可运行项目'],
    artifactType: 'code_patch',
    artifactLabel: 'Git 仓库 + 部署配置',
    completionCondition: '用户确认交付',
    skippable: true,
  },
};

/** 阶段顺序数组（拓扑序即阶段天然顺序） */
export const STAGE_ORDER: readonly PipelineStage[] = PIPELINE_STAGES;

/** 上一阶段；S1 无上游返回 null */
export function previousStage(stage: PipelineStage): PipelineStage | null {
  const index = STAGE_ORDER.indexOf(stage);
  if (index <= 0) return null;
  return STAGE_ORDER[index - 1] ?? null;
}

/** 下一阶段；S7 无下游返回 null */
export function nextStage(stage: PipelineStage): PipelineStage | null {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0 || index >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[index + 1] ?? null;
}

/** from 是否在 to 之前（严格） */
export function isBefore(from: PipelineStage, to: PipelineStage): boolean {
  return STAGE_ORDER.indexOf(from) < STAGE_ORDER.indexOf(to);
}

/** (from, to] 区间的全部阶段（不含 from，含 to） */
export function stagesAfter(from: PipelineStage, to: PipelineStage = 'S7'): PipelineStage[] {
  const fromIndex = STAGE_ORDER.indexOf(from);
  const toIndex = STAGE_ORDER.indexOf(to);
  if (fromIndex < 0 || toIndex <= fromIndex) return [];
  return STAGE_ORDER.slice(fromIndex + 1, toIndex + 1);
}
