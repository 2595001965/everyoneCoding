/**
 * 失效链接修复（T8-04 要点 2 / FR-PKG-10）。
 *
 * 导入时 keepBoth 会给记忆/文档生成**新 id**，指向旧 id 的关联随之失效。
 * 修复策略（保守优先，绝不瞎连）：
 * 1. 目标 id 仍然存在 → `ok`（无需处理）；
 * 2. 目标 id 丢失但**目标名精确匹配唯一**（或归一化后唯一）→ 重定向，`fixed`；
 * 3. 目标名相似度 ≥0.8 的候选恰好一个 → 重定向，`fixed`（相似度复用 @ec/ai 的
 *    `nameSimilarity`，与锚点重定位同一套打分）；
 * 4. 零候选或多候选 → `unresolvable`，列入报告由用户处理。
 */
import { nameSimilarity } from '@ec/ai';

import type { HealingLink, LinkFixOutcome } from './healing-types';

/** 可用目标清单：id → 展示名（外壳装配；测试用内存假实现） */
export interface LinkTargetIndex {
  memory: ReadonlyMap<string, string>;
  document: ReadonlyMap<string, string>;
}

/** 相似度阈值：名称归一化后 ≥ 该值且候选唯一才自动重定向 */
export const LINK_FIX_SIMILARITY_THRESHOLD = 0.8;

function normalizeName(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

/** 修复一批链接；不改写存储（返回意图，由外壳/导入流程应用） */
export function fixLinks(links: readonly HealingLink[], index: LinkTargetIndex): LinkFixOutcome[] {
  const outcomes: LinkFixOutcome[] = [];

  for (const link of links) {
    const targets = link.targetType === 'memory' ? index.memory : index.document;

    // ① 目标仍在
    if (targets.has(link.targetId)) {
      outcomes.push({ ...link, status: 'ok', newTargetId: null, detail: '目标仍存在，链接有效' });
      continue;
    }

    // ②③ 按名称找候选：先精确（归一化相等），再相似度
    const targetName = link.targetName ?? '';
    const exact = targetName.length > 0
      ? [...targets.entries()].filter(([, name]) => normalizeName(name) === normalizeName(targetName))
      : [];
    let candidates = exact;
    if (candidates.length === 0 && targetName.length > 0) {
      candidates = [...targets.entries()].filter(
        ([, name]) => nameSimilarity(name, targetName) >= LINK_FIX_SIMILARITY_THRESHOLD,
      );
    }

    if (candidates.length === 1) {
      const [newTargetId, matchedName] = candidates[0]!;
      outcomes.push({
        ...link,
        status: 'fixed',
        newTargetId,
        detail: `目标 id 已变化，按名称「${targetName} → ${matchedName}」重定向`,
      });
      continue;
    }

    outcomes.push({
      ...link,
      status: 'unresolvable',
      newTargetId: null,
      detail:
        candidates.length === 0
          ? `目标（${link.targetType} ${link.targetId}）已不存在，且按名称「${targetName || '未提供'}」找不到候选`
          : `目标（${link.targetType} ${link.targetId}）已不存在，按名称找到 ${candidates.length} 个候选，无法自动决定`,
    });
  }

  return outcomes;
}
