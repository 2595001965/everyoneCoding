import { clamp01 } from '../domain/memory-item';
import type { MemoryCategory } from './extractor';

/**
 * 信号强度评估（FR-MEM-08 / FR-MEM-09）。
 *
 * 职责：判断一条"候选偏好"是否足够稳定、值得沉淀为长期记忆。
 *
 * 核心规则（验收钉死）：
 * - 同一偏好历史上出现 ≥2 次，或文本含明确指令词（"以后都…""不要…""统一用…"等）
 *   时，置信度必须能越过 0.8 阈值（分档：高 >0.8）。
 * - "含『以后都…』的语句被识别且置信度 ≥0.8" 是硬性验收项（见 T2-04 验收）。
 *
 * 置信度算式（详见 {@link assessSignal}）：
 *   confidence = clamp01( base + 0.4 * max(0, occurrences-1) + 0.4 * imperativeBonus )
 *   - base：模型给出的基础置信度，缺省 0.5；
 *   - occurrences：该偏好历史上出现的次数（含本次，从 1 起算），每多出现 1 次 +0.4；
 *   - imperativeBonus：命中明确指令词时取 1，否则 0，命中即 +0.4（直接越过 0.8）。
 *   因此：
 *     · 含指令词（occurrences=1, base=0.5）→ 0.5+0.4 = 0.9（>0.8，高）
 *     · 仅重复出现 2 次（无指令词, base=0.5）→ 0.5+0.4 = 0.9（>0.8，高）
 *     · 单次且无指令词（base=0.5）→ 0.5（中）
 */

/** 明确指令词（中英文）。命中其一即视为"强意图、可沉淀为长期约定"。 */
export const IMPERATIVE_PATTERNS: readonly string[] = [
  '以后都',
  '以后',
  '不要',
  '别',
  '统一用',
  '统一',
  '禁止',
  '必须',
  '一律',
  '默认',
  'always',
  'never',
  'must',
  'do not',
  'prefer',
] as const;

export type SignalLevel = 'low' | 'medium' | 'high';

export interface SignalAssessment {
  /** 0–1 综合置信度 */
  confidence: number;
  /** 分档：低 <0.5 / 中 0.5–0.8 / 高 >0.8 */
  level: SignalLevel;
  /** 该偏好历史上出现的次数（含本次） */
  signalCount: number;
  /** 是否命中明确指令词 */
  hasImperative: boolean;
  /** 命中的具体指令词 */
  matchedImperatives: string[];
}

/**
 * 识别文本中的明确指令词（大小写不敏感，中文词原样匹配）。
 * 返回所有命中的词（按 {@link IMPERATIVE_PATTERNS} 顺序、去重）。
 */
export function detectImperatives(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const pattern of IMPERATIVE_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) matched.push(pattern);
  }
  return matched;
}

/** 由置信度推导分档：高 >0.8，中 0.5–0.8，低 <0.5。 */
export function levelOf(confidence: number): SignalLevel {
  if (confidence > 0.8) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

/**
 * 评估一条候选偏好的信号强度。
 *
 * @param input.text 候选偏好文本（标题 + 正文 + 证据片段），用于指令词识别
 * @param input.occurrences 该偏好历史上出现的次数（含本次，最小 1）
 * @param input.baseConfidence 模型给出的基础置信度 0–1，缺省 0.5
 * @param input.category 记忆类别（仅用于透传/可观测，不影响计算）
 *
 * @example
 * // 含「以后都」的语句：hasImperative=true 且 confidence=0.9（>0.8）
 * assessSignal({ text: '以后都用 TypeScript', occurrences: 1 });
 */
export function assessSignal(input: {
  text: string;
  /** 该偏好历史上出现过的次数（含本次） */
  occurrences: number;
  /** 模型给出的基础置信度，0–1 */
  baseConfidence?: number;
  category?: MemoryCategory;
}): SignalAssessment {
  const matched = detectImperatives(input.text);
  const hasImperative = matched.length > 0;
  const base = clamp01(input.baseConfidence ?? 0.5);
  const occurrences = Math.max(1, Math.floor(input.occurrences));
  const confidence = clamp01(base + 0.4 * Math.max(0, occurrences - 1) + 0.4 * (hasImperative ? 1 : 0));
  return {
    confidence,
    level: levelOf(confidence),
    signalCount: occurrences,
    hasImperative,
    matchedImperatives: matched,
  };
}
