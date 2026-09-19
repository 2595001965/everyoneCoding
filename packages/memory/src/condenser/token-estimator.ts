/**
 * Token 估算与预算裁剪（本地启发式，不依赖 @ec/ai）。
 *
 * 说明：本地估算非精确分词，仅供结构精简器控制单页面摘要体积（目标 ≤2k tokens）。
 * CJK 约 1 token/字，ASCII 约 4 字符/token，标点与空白按 1/4 token 计，并给出 ±15% 的 margin。
 */

import type { CondensedSummary } from './condenser';

/** token 估算结果（estimated 恒为 true，表示这是本地启发式而非精确分词） */
export interface TokenEstimateEx {
  tokens: number;
  estimated: true;
  margin: number;
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一汉字
    (code >= 0x3040 && code <= 0x30ff) || // 假名
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0xff00 && code <= 0xffef) // 全角字符
  );
}

/**
 * 估算文本 token 数（本地启发式）。
 * @returns estimated 恒为 true，margin 为 ±15% 容差（向上取整）。
 */
export function estimateTextTokens(text: string): TokenEstimateEx {
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCjk(code)) cjk += 1;
    else if (code < 0x80) ascii += 1;
    else other += 1;
  }
  const raw = cjk * 1 + ascii / 4 + other * 0.25;
  const tokens = Math.max(1, Math.round(raw));
  const margin = Math.ceil(tokens * 0.15);
  return { tokens, estimated: true, margin };
}

/** 结构开销常数：JSON 序列化后的键名与括号等固定开销 */
const STRUCT_OVERHEAD = 8;

/** 估算摘要的 token 数（对 JSON 序列化结果估算，并加上结构开销常数） */
export function estimateSummaryTokens(summary: CondensedSummary): TokenEstimateEx {
  const json = JSON.stringify(summary);
  const base = estimateTextTokens(json);
  const tokens = base.tokens + STRUCT_OVERHEAD;
  return { tokens, estimated: true, margin: Math.ceil(tokens * 0.15) };
}

function cloneSummary(summary: CondensedSummary): CondensedSummary {
  return JSON.parse(JSON.stringify(summary)) as CondensedSummary;
}

/** 计算元素深度（基于 elementIndex 的 parentId 链） */
function computeDepths(index: CondensedSummary['elementIndex']): Map<string, number> {
  const depths = new Map<string, number>();
  const resolve = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const info = index[id];
    if (!info || info.parentId === null) {
      depths.set(id, 0);
      return 0;
    }
    const d = resolve(info.parentId) + 1;
    depths.set(id, d);
    return d;
  };
  for (const id of Object.keys(index)) resolve(id);
  return depths;
}

/** 截断 skeleton：保留前缀（含顶层结构），末尾追加可见裁剪标记 */
function cropSkeleton(skeleton: string): string {
  const marker = '…(已裁剪)';
  if (skeleton.endsWith(marker)) return skeleton;
  const keep = Math.max(skeleton.length - Math.floor(skeleton.length / 2), 20);
  return `${skeleton.slice(0, keep)}${marker}`;
}

/**
 * 按预算裁剪摘要：超限时按优先级依次裁剪并置 truncated=true。
 * 裁剪顺序：① 深层元素的 boundProps → ② dataFlow → ③ skeleton 深层内容（保留顶层结构）→ ④ blocks。
 * 被砍掉的信息会在 summary 留下可见痕迹（skeleton 末尾追加「…(已裁剪)」）。
 *
 * @param budget 默认 2000 tokens
 */
export function enforceTokenBudget(
  summary: CondensedSummary,
  budget: number = 2000,
): { summary: CondensedSummary; tokens: TokenEstimateEx; truncated: boolean } {
  const initial = estimateSummaryTokens(summary);
  if (initial.tokens <= budget) {
    return { summary, tokens: initial, truncated: false };
  }

  let work = cloneSummary(summary);
  let tokens = initial;
  const reestimate = (): void => {
    tokens = estimateSummaryTokens(work);
  };

  // ① 先砍深层元素的 boundProps
  const depths = computeDepths(work.elementIndex);
  for (const id of Object.keys(work.elementIndex)) {
    const info = work.elementIndex[id];
    if (!info) continue;
    if ((depths.get(id) ?? 0) >= 3) {
      work.elementIndex[id] = {
        type: info.type,
        parentId: info.parentId,
        boundProps: [],
        featureRef: info.featureRef,
      };
    }
  }
  reestimate();

  // ② 再砍 dataFlow
  if (tokens.tokens > budget) {
    work = { ...work, dataFlow: [] };
    reestimate();
  }

  // ③ 截断 skeleton 的深层括号内容（保留顶层结构）
  if (tokens.tokens > budget) {
    work = { ...work, skeleton: cropSkeleton(work.skeleton) };
    reestimate();
  }

  // ④ 最后截断 blocks
  if (tokens.tokens > budget) {
    work = {
      ...work,
      blocks: work.blocks.slice(0, Math.max(1, Math.floor(work.blocks.length / 2))),
    };
    reestimate();
  }

  return { summary: work, tokens, truncated: true };
}
