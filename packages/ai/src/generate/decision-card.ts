import type { GenerationOutput, ReferencedMemory } from './output-schema';

/**
 * 决策说明卡片（T4-04 要点 5 / FR-AI-07 / NFR-U-02）。
 *
 * 硬性口径：**四要素 100% 覆盖** —— 引用记忆、选型理由、潜在风险、未覆盖点。
 * 缺任何一项，生成结果页都要显式标红（`complete = false` + `missing[]`），
 * 而不是默默折叠起来。这正是"生成可解释性"能被验收的方式。
 */

export const MEMORY_LAYER_LABELS: Record<string, string> = {
  longterm: '长期记忆',
  project: '项目记忆',
  feature: '功能记忆',
  page: '页面记忆',
  element: '元素组成',
  issue: '问题记忆',
};

export interface DecisionMemoryRef extends ReferencedMemory {
  /** 中文层级名（面板展示） */
  layerLabel: string;
}

export interface DecisionCardModel {
  referencedMemory: DecisionMemoryRef[];
  rationale: string;
  risks: string[];
  uncovered: string[];
  /** 生成时实际注入过的备注 id（T4-02 的 noteIds） */
  followedNoteIds: string[];
  /** 四要素是否齐备 */
  complete: boolean;
  /** 缺失的要素（中文名） */
  missing: string[];
  /** 是否走了降级解析（降级结果的决策说明可信度更低，需显式提示） */
  degraded: boolean;
}

export interface ToDecisionCardOptions {
  /** 本次上下文实际注入的备注 id（标注"已遵循备注 #id"） */
  noteIds?: readonly string[] | undefined;
  /** 上下文实际注入的记忆 id（用于校验 decision.referencedMemory 是否完整） */
  memoryIds?: readonly string[] | undefined;
  degraded?: boolean | undefined;
}

export function toDecisionCard(
  output: GenerationOutput,
  options: ToDecisionCardOptions = {},
): DecisionCardModel {
  const decision = output.decision;
  const referencedMemory: DecisionMemoryRef[] = decision.referencedMemory.map((memory) => ({
    ...memory,
    layerLabel: MEMORY_LAYER_LABELS[memory.layer] ?? memory.layer,
  }));

  const missing: string[] = [];
  if (referencedMemory.length === 0) missing.push('引用记忆');
  if (decision.rationale.trim().length === 0) missing.push('选型理由');
  if (decision.risks.filter((risk) => risk.trim().length > 0).length === 0)
    missing.push('潜在风险');
  if (decision.uncovered.filter((item) => item.trim().length > 0).length === 0)
    missing.push('未覆盖点');

  return {
    referencedMemory,
    rationale: decision.rationale,
    risks: decision.risks.filter((risk) => risk.trim().length > 0),
    uncovered: decision.uncovered.filter((item) => item.trim().length > 0),
    followedNoteIds: [...(options.noteIds ?? [])],
    complete: missing.length === 0,
    missing,
    degraded: options.degraded ?? false,
  };
}

/**
 * 模型声明的引用记忆与上下文实际注入的记忆做一致性校验。
 * 返回"声明了但没注入"（可能是幻觉）与"注入了但没声明"（可能是漏引）两组 id。
 */
export function auditDecisionMemory(
  output: GenerationOutput,
  injectedMemoryIds: readonly string[],
): { hallucinated: string[]; underCited: string[] } {
  const declared = new Set(output.decision.referencedMemory.map((memory) => memory.id));
  const injected = new Set(injectedMemoryIds);
  return {
    hallucinated: [...declared].filter((id) => !injected.has(id)),
    underCited: [...injected].filter((id) => !declared.has(id)),
  };
}

/** 一行摘要（卡片折叠状态下的提示文案） */
export function describeDecisionCard(model: DecisionCardModel): string {
  if (model.complete) {
    return `已引用 ${model.referencedMemory.length} 条记忆，给出 ${model.risks.length} 项风险与 ${model.uncovered.length} 项未覆盖点`;
  }
  return `决策说明不完整，缺少：${model.missing.join('、')}`;
}
