import type { Database } from 'better-sqlite3';
import { Repository, newUlid, type Row } from '@ec/data';
import type { AiModelConfigRow } from '@ec/data';

import {
  DEFAULT_PURPOSE_BINDING,
  purposeBindingSchema,
  purposeSchema,
  type AiPurpose,
  type PurposeBinding,
} from '../domain/purpose-binding';

/**
 * 用途绑定仓库（FR-MDL-05）。
 *
 * 每用户一行 `ai_model_config`：绑定映射与"全部使用默认模型"开关一起原子写入。
 */

export class PurposeBindingRepo {
  private readonly repo: Repository<AiModelConfigRow & Row>;

  constructor(db: Database) {
    this.repo = new Repository<AiModelConfigRow & Row>(db, 'ai_model_config');
  }

  get(userId: string): PurposeBinding {
    const rows = this.repo.findWhere({ user_id: userId }, { limit: 1 });
    const row = rows[0];
    if (!row) return { ...DEFAULT_PURPOSE_BINDING, bindings: {} };
    return decode(row);
  }

  save(userId: string, binding: PurposeBinding): PurposeBinding {
    const existing = this.repo.findWhere({ user_id: userId }, { limit: 1 })[0];
    if (!existing) {
      const now = Date.now();
      this.repo.insert({
        id: newUlid(),
        user_id: userId,
        purpose_bindings_json: JSON.stringify(binding.bindings),
        use_default_for_all: binding.useDefaultForAll ? 1 : 0,
        default_model_id: binding.defaultModelId,
        created_at: now,
        updated_at: now,
      });
      return binding;
    }
    const updated = this.repo.update(existing.id, {
      purpose_bindings_json: JSON.stringify(binding.bindings),
      use_default_for_all: binding.useDefaultForAll ? 1 : 0,
      default_model_id: binding.defaultModelId,
    });
    return updated ? decode(updated) : binding;
  }

  /** 单用途绑定/解绑 */
  setBinding(userId: string, purpose: AiPurpose, modelId: string | null): PurposeBinding {
    const current = this.get(userId);
    const bindings = { ...current.bindings };
    if (modelId === null) delete bindings[purpose];
    else bindings[purpose] = modelId;
    return this.save(userId, { ...current, bindings });
  }

  setUseDefaultForAll(userId: string, useDefaultForAll: boolean): PurposeBinding {
    return this.save(userId, { ...this.get(userId), useDefaultForAll });
  }

  setDefaultModel(userId: string, modelId: string | null): PurposeBinding {
    return this.save(userId, { ...this.get(userId), defaultModelId: modelId });
  }
}

function decode(row: AiModelConfigRow): PurposeBinding {
  let bindings: PurposeBinding['bindings'] = {};
  try {
    const parsed: unknown = JSON.parse(row.purpose_bindings_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const purpose = purposeSchema.safeParse(key);
        if (purpose.success && typeof value === 'string') bindings[purpose.data] = value;
      }
    }
  } catch {
    bindings = {};
  }
  const parsed = purposeBindingSchema.safeParse({
    bindings,
    useDefaultForAll: row.use_default_for_all === 1,
    defaultModelId: row.default_model_id,
  });
  return parsed.success ? parsed.data : { ...DEFAULT_PURPOSE_BINDING, bindings };
}
