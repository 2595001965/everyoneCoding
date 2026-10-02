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
import { providerModelIdOf } from '../domain/model-route';
import { modelFromRow, type Model, type ModelDiscovery, type ModelSource } from '../domain/model';

/**
 * 模型仓库。
 *
 * 关键点：
 * - 远程拉取（/models）写入时，已人工修正（manualOverride）的模型**不被覆盖**
 * - 单价缺失时 capability 里保留 null，费用统计显示「—」而不是 0
 * - 复合路由身份（V2-MDL-02）：每行带唯一 providerModelId；同一 Provider 内同名模型
 *   是同一条路由（唯一索引把关），跨 Provider 同名模型是不同路由，绝不合并
 */

export class ModelRepo {
  private readonly repo: Repository<ModelRow & Row>;
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this.repo = new Repository<ModelRow & Row>(db, 'model');
  }

  list(providerId: string): Model[] {
    return this.repo
      .findWhere({ provider_id: providerId }, { orderBy: 'name ASC' })
      .map(modelFromRow);
  }

  listAll(): Model[] {
    return this.repo.findWhere({}, { orderBy: 'name ASC' }).map(modelFromRow);
  }

  findById(id: string): Model | null {
    const row = this.repo.findById(id);
    return row ? modelFromRow(row) : null;
  }

  /** 按复合路由键取模型（V2-MDL-02 的规范查询入口） */
  findByRoute(providerModelId: string): Model | null {
    const rows = this.repo.findWhere({ provider_model_id: providerModelId }, { limit: 1 });
    const first = rows[0];
    return first ? modelFromRow(first) : null;
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
      provider_model_id: providerModelIdOf(providerId, name),
      canonical_vendor: null,
      canonical_model: null,
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
   * 幂等创建：同一条路由（Provider+模型名）已存在时原样返回，不产生重复行。
   * 手工添加、远程目录补齐共用这一入口；重复路由由数据库唯一索引最终把关。
   */
  createIfMissing(
    providerId: string,
    name: string,
    capability: Partial<ModelCapability> = {},
  ): { model: Model; created: boolean } {
    const existing = this.findByName(providerId, name);
    if (existing) return { model: existing, created: false };
    return { model: this.create(providerId, name, capability), created: true };
  }

  /** 登记模型官方身份（T17 目录核验后写入）；只作查询参考，不参与路由 */
  setCanonicalIdentity(
    id: string,
    identity: { canonicalVendor: string | null; canonicalModel: string | null },
  ): Model | null {
    const updated = this.repo.update(id, {
      canonical_vendor: identity.canonicalVendor,
      canonical_model: identity.canonicalModel,
    });
    return updated ? modelFromRow(updated) : null;
  }

  /**
   * 写入远程发现的模型列表。
   * 返回写入/跳过的数量，跳过项即被 manualOverride 保护或已存在。
   */
  upsertDiscovered(
    providerId: string,
    discovered: ModelDiscovery,
  ): { created: number; skipped: number } {
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
    const capability = options.keepManualFlag
      ? { ...merged, manualOverride: model.capability.manualOverride }
      : merged;

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
