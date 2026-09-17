import type { Database } from 'better-sqlite3';
import { Repository, newUlid, type Row } from '@ec/data';
import type { ModelRow } from '@ec/data';

import {
  mergeCapability,
  parseCapability,
  serializeCapability,
  type CapabilityPatch,
  type ModelCapability,
} from '../domain/capability';
import { modelFromRow, type Model, type ModelDiscovery, type ModelSource } from '../domain/model';

/**
 * 模型仓库。
 *
 * 关键点：
 * - 远程拉取（/models）写入时，已人工修正（manualOverride）的模型**不被覆盖**
 * - 单价缺失时 capability 里保留 null，费用统计显示「—」而不是 0
 */

export class ModelRepo {
  private readonly repo: Repository<ModelRow & Row>;

  constructor(private readonly db: Database) {
    this.repo = new Repository<ModelRow & Row>(db, 'model');
  }

  list(providerId: string): Model[] {
    return this.repo.findWhere({ provider_id: providerId }, { orderBy: 'name ASC' }).map(modelFromRow);
  }

  listAll(): Model[] {
    return this.repo.findWhere({}, { orderBy: 'name ASC' }).map(modelFromRow);
  }

  findById(id: string): Model | null {
    const row = this.repo.findById(id);
    return row ? modelFromRow(row) : null;
  }

  findByName(providerId: string, name: string): Model | null {
    const rows = this.repo.findWhere({ provider_id: providerId, name }, { limit: 1 });
    const first = rows[0];
    return first ? modelFromRow(first) : null;
  }

  create(providerId: string, name: string, capability: Partial<ModelCapability> = {}): Model {
    const now = Date.now();
    const row: ModelRow = {
      id: newUlid(),
      provider_id: providerId,
      name,
      display_name: null,
      context_window: capability.contextWindow ?? null,
      max_output: capability.maxOutput ?? null,
      capabilities_json: serializeCapability({ ...parseCapability(null), ...capability }),
      version: 1,
      created_at: now,
      updated_at: now,
    };
    this.repo.insert(row as ModelRow & Row);
    return modelFromRow(row);
  }

  /**
   * 写入远程发现的模型列表。
   * 返回写入/跳过的数量，跳过项即被 manualOverride 保护或已存在。
   */
  upsertDiscovered(providerId: string, discovered: ModelDiscovery): { created: number; skipped: number } {
    const run = this.db.transaction(() => {
      let created = 0;
      let skipped = 0;
      for (const model of discovered.models) {
        const existing = this.findByName(providerId, model.name);
        if (existing) {
          if (existing.capability.manualOverride) {
            skipped += 1;
            continue;
          }
          this.updateCapability(
            existing.id,
            {
              contextWindow: model.capability.contextWindow,
              maxOutput: model.capability.maxOutput,
              supportsTools: model.capability.supportsTools,
              supportsVision: model.capability.supportsVision,
            },
            { overwrite: true, keepManualFlag: true },
          );
          skipped += 1;
          continue;
        }
        this.create(providerId, model.name, {
          ...model.capability,
          manualOverride: false,
        });
        created += 1;
      }
      return { created, skipped };
    });
    return run();
  }

  /** 就地修正能力矩阵（能力表格编辑）；修正后打上 manualOverride */
  updateCapability(
    id: string,
    patch: CapabilityPatch,
    options: { overwrite?: boolean; keepManualFlag?: boolean; expectedVersion?: number } = {},
  ): Model | null {
    const row = this.repo.findById(id);
    if (!row) return null;
    const model = modelFromRow(row);
    const merged = mergeCapability(model.capability, patch, {
      ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
    });
    const capability = options.keepManualFlag ? { ...merged, manualOverride: model.capability.manualOverride } : merged;

    const updated = this.repo.update(
      id,
      {
        context_window: capability.contextWindow,
        max_output: capability.maxOutput,
        capabilities_json: serializeCapability(capability),
      },
      options.expectedVersion,
    );
    return updated ? modelFromRow(updated) : null;
  }

  setDisplayName(id: string, displayName: string | null): Model | null {
    const updated = this.repo.update(id, { display_name: displayName });
    return updated ? modelFromRow(updated) : null;
  }

  removeByProvider(providerId: string): number {
    return this.db.prepare('DELETE FROM model WHERE provider_id = ?').run(providerId).changes;
  }

  remove(id: string): boolean {
    return this.repo.remove(id);
  }

  /** 供 UI 标注模型来源 */
  static source(provider: { manualModels: string[] }, modelName: string): ModelSource {
    return provider.manualModels.includes(modelName) ? 'manual' : 'remote';
  }
}
