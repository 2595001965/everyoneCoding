import { z } from 'zod';
import type { ModelRow } from '@ec/data';

import { DEFAULT_CAPABILITY, capabilitySchema, type ModelCapability } from './capability';

/**
 * 模型（内部模型，屏蔽 provider 差异）。
 *
 * `id` 为本地 ULID；`name` 是发给服务端的模型标识（如 `gpt-4o`、`claude-3-5-sonnet`）。
 * `source` 记录该模型的来源，UI 需据实展示（远程拉取 / 手动填写 / 本地缓存）。
 */

export type ModelSource = 'remote' | 'manual' | 'cache';

export interface Model {
  id: string;
  providerId: string;
  /** 服务端模型标识 */
  name: string;
  displayName: string | null;
  capability: ModelCapability;
  /** 乐观锁版本 */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** 模型发现结果：来源与备注用于在 UI 上解释"这批模型从哪来" */
export interface ModelDiscovery {
  models: Model[];
  source: ModelSource;
  note?: string | undefined;
}

export const modelNameSchema = z.string().trim().min(1, '模型名不能为空').max(200);

export const createModelSchema = z.object({
  providerId: z.string().min(1),
  name: modelNameSchema,
  displayName: z.string().trim().max(200).nullish(),
  capability: capabilitySchema.partial().optional(),
});

export type CreateModelInput = z.infer<typeof createModelSchema>;

/** 反序列化：DB 行 → 内部模型 */
export function modelFromRow(row: ModelRow): Model {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    displayName: row.display_name,
    capability: parseOr(row.capabilities_json),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOr(json: string | null): ModelCapability {
  if (!json) return { ...DEFAULT_CAPABILITY };
  try {
    const parsed = capabilitySchema.safeParse(JSON.parse(json) as unknown);
    return parsed.success ? parsed.data : { ...DEFAULT_CAPABILITY };
  } catch {
    return { ...DEFAULT_CAPABILITY };
  }
}

export function displayNameOf(model: Pick<Model, 'name' | 'displayName'>): string {
  return model.displayName && model.displayName.trim().length > 0 ? model.displayName : model.name;
}
