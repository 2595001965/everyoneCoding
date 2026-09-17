import type { Database } from 'better-sqlite3';
import { MemoryRepo } from '../repo/memory-repo';
import type { MemoryItem, MemoryStatus } from '../domain/memory-item';
import type { MemoryLayer, MemoryScope } from '../domain/scope';
import type { EmbeddingPort } from './embedder';
import { FtsKeywordSearcher, type KeywordHitEx, type SnippetRange } from './fts-search';
import { VecSearcher, type VectorHitEx } from './vector-search';
import { reciprocalRankFusion, type RankedList, type RrfOptions } from './rrf';

/**
 * 双路召回编排：关键词路（FTS5 / LIKE）+ 语义路（sqlite-vec + 嵌入器），
 * 经 RRF 融合为一个稳定排序，并标注每条命中来自哪一路、附高亮 snippet。
 *
 * 核心不变量：**任一一路不可用都不报错、不阻塞**——降级为另一路继续返回结果，
 * 并在 {@link HybridDiagnostics} 里如实标注降级原因。
 */

export interface HybridSearchOptions {
  userId: string;
  projectId?: string | null;
  scopes?: readonly MemoryScope[];
  layers?: readonly MemoryLayer[];
  tags?: readonly string[];
  status?: MemoryStatus | readonly MemoryStatus[];
  limit?: number;
  keywordLimit?: number;
  vectorLimit?: number;
  /** 融合分低于该值的结果被丢弃（0–1） */
  minScore?: number;
  rrf?: RrfOptions;
}

export interface HybridHit {
  id: string;
  /** 融合分（RRF 输出） */
  score: number;
  matchedBy: 'keyword' | 'semantic' | 'both';
  snippet: { text: string; ranges: SnippetRange[] } | null;
  item: MemoryItem | null;
}

export interface HybridDiagnostics {
  keywordMode: 'fts5' | 'like';
  keywordDegradedReason: string | null;
  semanticAvailable: boolean;
  semanticReason: string | null;
  tookMs: number;
}

export interface HybridSearchResult {
  hits: HybridHit[];
  diagnostics: HybridDiagnostics;
}

export interface HybridSearcherDeps {
  db: Database;
  embedder: EmbeddingPort;
  keyword?: FtsKeywordSearcher;
  vector?: VecSearcher;
  /** 语义路维度；传给 VecSearcher，确保 vec0 虚表按正确维度创建 */
  dimensions?: number;
}

function nowMs(): number {
  return Date.now();
}

/** 把一路命中的有序列表（按 score 降序）转成带 rank 的 RankedList */
function toRankedList(source: 'keyword' | 'semantic', hits: Array<{ id: string; score: number }>): RankedList {
  const sorted = [...hits].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    source,
    items: sorted.map((hit, index) => ({ id: hit.id, rank: index + 1, score: hit.score })),
  };
}

export class HybridSearcher {
  private readonly db: Database;
  private readonly embedder: EmbeddingPort;
  private readonly keyword: FtsKeywordSearcher;
  private readonly vector: VecSearcher | null;
  private readonly dimensions: number;

  constructor(deps: HybridSearcherDeps) {
    this.db = deps.db;
    this.embedder = deps.embedder;
    this.dimensions = deps.dimensions ?? 8;
    this.keyword = deps.keyword ?? new FtsKeywordSearcher(deps.db);
    this.vector = deps.vector ?? new VecSearcher(deps.db, { dimensions: this.dimensions });
  }

  async search(query: string, options: HybridSearchOptions): Promise<HybridSearchResult> {
    const started = nowMs();

    // 1) 候选集收敛：scope / projectId / layers / tags / status / userId
    const repo = new MemoryRepo(this.db);
    const listQuery: Parameters<MemoryRepo['list']>[0] = { userId: options.userId };
    if (options.scopes) listQuery.scopes = options.scopes;
    if (options.layers) listQuery.layers = options.layers;
    if (options.projectId !== undefined) listQuery.projectId = options.projectId;
    if (options.tags) listQuery.tags = options.tags;
    if (options.status !== undefined) listQuery.status = options.status;
    const candidates = repo.list(listQuery);
    const candidateIds = candidates.map((item) => item.id);
    const itemById = new Map<string, MemoryItem>(candidates.map((item) => [item.id, item]));

    // 2) 关键词路
    const keywordLimit = options.keywordLimit ?? options.limit ?? 50;
    const keywordHits: KeywordHitEx[] = this.keyword.search(query, {
      limit: keywordLimit,
      filterIds: candidateIds,
    });
    const keywordById = new Map<string, KeywordHitEx>(keywordHits.map((hit) => [hit.id, hit]));

    // 3) 语义路（可选，失败即降级）
    let semanticHits: VectorHitEx[] = [];
    let semanticAvailable = false;
    let semanticReason: string | null = null;

    if (this.vector && this.vector.available && this.embedder.available()) {
      try {
        const outcome = await this.embedder.embed([query]);
        if (outcome.ok) {
          const queryVec = outcome.vectors[0];
          if (queryVec && queryVec.length > 0) {
            const vectorLimit = options.vectorLimit ?? options.limit ?? 20;
            semanticHits = this.vector.search(queryVec, {
              limit: vectorLimit,
              filterIds: candidateIds,
            });
            semanticAvailable = true;
          } else {
            semanticReason = '网关返回的查询向量为空';
          }
        } else {
          semanticReason = outcome.reason;
        }
      } catch (error) {
        semanticReason = error instanceof Error ? error.message : String(error);
      }
    } else if (!this.embedder.available()) {
      // 优先反映「未配置向量化模型」：这是语义检索的顶层开关
      semanticReason = '未配置向量化模型，语义检索已关闭';
    } else if (this.vector && !this.vector.available) {
      semanticReason = this.vector.reason ?? 'sqlite-vec 扩展不可用，语义检索已关闭';
    }

    const semanticById = new Map<string, VectorHitEx>(semanticHits.map((hit) => [hit.id, hit]));

    // 4) RRF 融合
    const lists: RankedList[] = [
      toRankedList('keyword', keywordHits.map((hit) => ({ id: hit.id, score: hit.score }))),
      toRankedList('semantic', semanticHits.map((hit) => ({ id: hit.id, score: hit.similarity }))),
    ];
    const fused = reciprocalRankFusion(lists, options.rrf);

    // 5) 组装命中
    const limit = options.limit ?? 20;
    const minScore = options.minScore ?? 0;
    const hits: HybridHit[] = [];
    for (const f of fused) {
      if (f.fusedScore < minScore) continue;
      const inKeyword = keywordById.has(f.id);
      const inSemantic = semanticById.has(f.id);
      const matchedBy: HybridHit['matchedBy'] = inKeyword && inSemantic ? 'both' : inKeyword ? 'keyword' : 'semantic';
      const kwHit = keywordById.get(f.id);
      hits.push({
        id: f.id,
        score: f.fusedScore,
        matchedBy,
        // snippet 优先复用关键词路（含命中区间）；语义路单独命中则无 snippet
        snippet: kwHit ? kwHit.snippet : null,
        item: itemById.get(f.id) ?? null,
      });
      if (hits.length >= limit) break;
    }

    const diagnostics: HybridDiagnostics = {
      keywordMode: this.keyword.mode,
      keywordDegradedReason: this.keyword.degradedReason,
      semanticAvailable,
      semanticReason,
      tookMs: nowMs() - started,
    };

    return { hits, diagnostics };
  }
}
