/**
 * 结构精简器落地：把摘要写入记忆，并串起「精简 → 分层沉淀 → 增量 revision」全流程。
 *
 * 关键点：
 * - 先 condense，写页面记忆（scope=page，structured 为摘要）；
 * - 把摘要写入 repo.revisions（MemoryStructRevisionRepo，自动只留最近 5 次）；
 * - 把 project / feature 层 payload 分别 upsert 到对应 scope；
 * - **只有结构真正变化时才追加 revision**，并返回 diffDsl 计算出的 diff；
 * - 增量语义：diff 仅含变更子树 id（subtrees），不全量重算。
 *
 * 历史入口说明：本实现以 `setPrevious(dsl)` 作为"上一次 DSL"的可注入入口（推荐，diff 精度最高）。
 * 若未注入，则回退到 `repo.revisions.latest(memoryId).summary` 经 `diffSummary` 比较——
 * 注意 revision 仅存摘要，无法反推完整 DSL，故该路径的 diff 精度以摘要为准。
 * 不新增任何数据表。
 */

import type { MemoryRepo } from '../repo/memory-repo';
import { PageMemoryService } from '../service/page-memory';
import { ProjectMemoryService } from '../service/project-memory';
import { FeatureMemoryService } from '../service/feature-memory';
import type { MemoryLayer } from '../domain/scope';

import { condensePage, type CondensedSummary } from './condenser';
import { deriveLayerAssignments, type LayerAssignment } from './layer-dispatch';
import { DEFAULT_CONDENSER_RULES, mergeRules, type CondenserRules } from './rules';
import { diffDsl, diffSummary, hasStructuralChange, type CondensedDiff } from './diff';
import { enforceTokenBudget, type TokenEstimateEx } from './token-estimator';
import type { PageDsl } from './page-dsl';

export interface StructureCondenserDeps {
  repo: MemoryRepo;
  userId: string;
  rules?: Partial<CondenserRules>;
  tokenBudget?: number;
}

export interface CondenseResult {
  summary: CondensedSummary;
  tokens: TokenEstimateEx;
  truncated: boolean;
  assignments: LayerAssignment[];
}

export interface SyncResult {
  pageMemoryId: string;
  revision: number;
  diff: CondensedDiff | null;
  tokens: TokenEstimateEx;
  truncated: boolean;
}

export class StructureCondenser {
  private readonly repo: MemoryRepo;
  private readonly userId: string;
  private readonly rules: CondenserRules;
  private readonly tokenBudget: number;
  private previous: PageDsl | null = null;

  constructor(deps: StructureCondenserDeps) {
    this.repo = deps.repo;
    this.userId = deps.userId;
    this.rules = deps.rules ? mergeRules(deps.rules) : DEFAULT_CONDENSER_RULES;
    this.tokenBudget = deps.tokenBudget ?? 2000;
  }

  /** 注入"上一次的 DSL"，供增量 diff（推荐入口，精度最高） */
  setPrevious(dsl: PageDsl): void {
    this.previous = dsl;
  }

  /** 精简 + 预算裁剪 + 分层推导（不落库） */
  async condense(
    dsl: PageDsl,
    options?: { layerOverride?: MemoryLayer | null },
  ): Promise<CondenseResult> {
    const summary = condensePage(dsl, this.rules);
    const budget = enforceTokenBudget(summary, this.tokenBudget);
    const assignments = deriveLayerAssignments(
      dsl,
      budget.summary,
      options?.layerOverride !== undefined ? { layerOverride: options.layerOverride } : {},
    );
    return {
      summary: budget.summary,
      tokens: budget.tokens,
      truncated: budget.truncated,
      assignments,
    };
  }

  /** 落库：页面记忆 + 增量 revision + 项目/功能分层沉淀 */
  async sync(
    dsl: PageDsl,
    options?: { pageName?: string; layerOverride?: MemoryLayer | null },
  ): Promise<SyncResult> {
    const condensed = await this.condense(
      dsl,
      options?.layerOverride !== undefined ? { layerOverride: options.layerOverride } : {},
    );
    const summary = condensed.summary;
    const tokens = condensed.tokens;
    const truncated = condensed.truncated;
    const assignments = condensed.assignments;

    // 1) 写页面记忆（scope=page）
    const pageService = new PageMemoryService(this.repo, this.userId);
    const pageOutcome = pageService.upsert({
      projectId: dsl.projectId,
      pageId: dsl.id,
      featureId: dsl.featureId ?? null,
      pageName: options?.pageName ?? dsl.name,
      route: dsl.route,
      structured: {
        skeleton: summary.skeleton,
        blocks: summary.blocks,
        state: summary.state,
        events: summary.events,
        dataFlow: summary.dataFlow,
        apiDeps: summary.apiDeps,
      },
      content: '',
      options: { sourceType: 'auto_design', confidence: 0.9, importance: 3 },
    });
    const pageMemoryId = pageOutcome.item.id;

    // 2) 计算 diff（结构变化）
    let diff: CondensedDiff | null;
    if (this.previous) {
      diff = diffDsl(this.previous, dsl);
    } else {
      const latest = this.repo.revisions.latest(pageMemoryId);
      diff = latest ? diffSummary(latest.summary as unknown as CondensedSummary, summary) : null;
    }

    // 3) 仅结构真正变化时才追加 revision
    const changed = diff === null ? true : hasStructuralChange(diff);
    let revision = 0;
    if (changed) {
      const rev = this.repo.revisions.append({
        memoryId: pageMemoryId,
        pageId: dsl.id,
        summary: summary as unknown as Record<string, unknown>,
        tokenEstimate: tokens.tokens,
        truncated,
        diff,
      });
      revision = rev.revision;
      this.previous = dsl;
    } else {
      const latest = this.repo.revisions.latest(pageMemoryId);
      revision = latest?.revision ?? 0;
    }

    // 4) 分层沉淀：project / feature
    for (const a of assignments) {
      if (a.layer === 'project') {
        const ps = new ProjectMemoryService(this.repo, this.userId);
        const routes = a.payload['routes'];
        if (Array.isArray(routes) && routes.length > 0) {
          ps.upsertSection(dsl.projectId, 'routes', routes as string[], {
            sourceType: 'auto_design',
          });
        }
        const modules = a.payload['modules'];
        if (Array.isArray(modules) && modules.length > 0) {
          ps.upsertSection(dsl.projectId, 'modules', modules as string[], {
            sourceType: 'auto_design',
          });
        }
      } else if (a.layer === 'feature') {
        const fid = a.payload['featureId'];
        if (typeof fid === 'string') {
          const fs = new FeatureMemoryService(this.repo, this.userId);
          const featureNameRaw = a.payload['featureName'];
          const structured: Record<string, unknown> = { ...a.payload };
          delete structured['featureId'];
          delete structured['featureName'];
          fs.upsert({
            projectId: dsl.projectId,
            featureId: fid,
            featureName: typeof featureNameRaw === 'string' ? featureNameRaw : fid,
            structured,
            options: { sourceType: 'ai_summary', confidence: 0.85 },
          });
        }
      }
    }

    return { pageMemoryId, revision, diff, tokens, truncated };
  }
}
