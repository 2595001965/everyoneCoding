import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, type RankedList } from '../rrf';

const keyword: RankedList = {
  source: 'keyword',
  items: [
    { id: 'A', rank: 1, score: 0.9 },
    { id: 'B', rank: 2, score: 0.6 },
    { id: 'C', rank: 3, score: 0.3 },
  ],
};

const semantic: RankedList = {
  source: 'semantic',
  items: [
    { id: 'B', rank: 1, score: 0.95 },
    { id: 'C', rank: 2, score: 0.7 },
    { id: 'D', rank: 3, score: 0.4 },
  ],
};

describe('reciprocalRankFusion', () => {
  it('排序稳定：同一输入多次调用顺序完全一致', () => {
    const base = reciprocalRankFusion([keyword, semantic]);
    for (let i = 0; i < 10; i++) {
      expect(reciprocalRankFusion([keyword, semantic])).toEqual(base);
    }
  });

  it('单路输入退化为该路顺序', () => {
    const fused = reciprocalRankFusion([keyword]);
    expect(fused.map((f) => f.id)).toEqual(['A', 'B', 'C']);
  });

  it('双路融合：两路皆命中的项获得更高融合分', () => {
    const fused = reciprocalRankFusion([keyword, semantic]);
    const b = fused.find((f) => f.id === 'B');
    const a = fused.find((f) => f.id === 'A');
    expect(b).toBeTruthy();
    expect(a).toBeTruthy();
    // B 在两路都出现，融合分应高于仅关键词路出现的 A
    expect(b!.fusedScore).toBeGreaterThan(a!.fusedScore);
  });

  it('权重生效：keyword 权重置 0 时语义路主导排序', () => {
    const fused = reciprocalRankFusion([keyword, semantic], { weights: { keyword: 0, semantic: 1 } });
    const order = fused.map((f) => f.id);
    const cIdx = order.indexOf('C');
    const aIdx = order.indexOf('A');
    // C 仅在语义路（rank2），A 仅在关键词路（rank1）；keyword 权重为 0 时 C 应排在 A 之前
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeLessThan(aIdx);
  });

  it('同融合分按 id 升序（确定性 tie-break）', () => {
    const tieA: RankedList = { source: 'keyword', items: [{ id: 'Z', rank: 1, score: 1 }] };
    const tieB: RankedList = { source: 'semantic', items: [{ id: 'A', rank: 1, score: 1 }] };
    const fused = reciprocalRankFusion([tieA, tieB]);
    // Z 与 A 融合分相同（各 1/61），按 id 升序 → A 在前
    expect(fused.map((f) => f.id)).toEqual(['A', 'Z']);
  });
});
