/**
 * 倒数排名融合（Reciprocal Rank Fusion, RRF）。
 *
 * 用于把「关键词路」与「语义路」两个异构排序融合成一个稳定排序，
 * 不依赖各路分数的绝对值（bm25 与 cosine 量纲不同，直接加权相加无意义）。
 *
 * 公式：`fusedScore(id) = Σ_i  w_i / (k + rank_i)`，其中 rank 从 1 开始。
 * 默认 `k = 60`（经验值，削弱头部过强项的主导），权重默认两路均为 1（等权）。
 */

export interface RankedItem {
  id: string;
  /** 该路内的排名，从 1 开始 */
  rank: number;
  /** 该路原始分数（仅用于 diagnostics / 调试，不参与融合计算） */
  score: number;
}

export interface RankedList {
  source: 'keyword' | 'semantic';
  items: RankedItem[];
}

export interface RrfOptions {
  /** 排名平滑常数，默认 60 */
  k?: number;
  /** 各路权重，默认两路均为 1 */
  weights?: { keyword?: number; semantic?: number };
}

export interface RrfContribution {
  source: 'keyword' | 'semantic';
  rank: number;
  /** 该路原始分数 */
  score: number;
}

export interface RrfFused {
  id: string;
  fusedScore: number;
  contributions: RrfContribution[];
}

/**
 * 融合多路排序。
 *
 * 性质（便于测试断言）：
 * - **稳定性**：相同输入多次调用，输出顺序完全一致——排序先按 `fusedScore` 降序，
 *   同分再按 `id` 升序（确定性 tie-break）。
 * - **单路退化**：只传一路时，结果就是该路的顺序（权重影响绝对分值但不影响顺序）。
 * - **权重生效**：把某路权重置 0，则该路不参与融合，另一路主导排序。
 */
export function reciprocalRankFusion(
  lists: readonly RankedList[],
  options: RrfOptions = {},
): RrfFused[] {
  const k = options.k ?? 60;
  const wKeyword = options.weights?.keyword ?? 1;
  const wSemantic = options.weights?.semantic ?? 1;

  const weightOf = (source: 'keyword' | 'semantic'): number =>
    source === 'keyword' ? wKeyword : wSemantic;

  const map = new Map<string, RrfFused>();

  for (const list of lists) {
    const weight = weightOf(list.source);
    for (const item of list.items) {
      const contribution = weight / (k + item.rank);
      const existing = map.get(item.id);
      if (existing) {
        existing.fusedScore += contribution;
        existing.contributions.push({ source: list.source, rank: item.rank, score: item.score });
      } else {
        map.set(item.id, {
          id: item.id,
          fusedScore: contribution,
          contributions: [{ source: list.source, rank: item.rank, score: item.score }],
        });
      }
    }
  }

  return [...map.values()].sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
