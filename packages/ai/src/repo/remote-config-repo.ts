import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import { Repository, newUlid, type Row } from '@ec/data';
import type { RemoteConfigSourceRow } from '@ec/data';

import { httpUrlSchema } from '../domain/provider';
import type { RemoteFetchStatus } from '../remote-config/fetcher';

/**
 * 远程配置源仓库（FR-MDL-06 / 13）。
 *
 * 只是"用户自己填的 URL 清单"，平台不提供任何官方配置服务；
 * 未配置任何源时该能力默认关闭（UI 不展示相关入口）。
 */

export interface RemoteConfigSource {
  id: string;
  userId: string;
  name: string;
  url: string;
  publicKey: string | null;
  enabled: boolean;
  updateIntervalMin: number;
  lastFetchAt: number | null;
  lastStatus: RemoteFetchStatus | 'idle' | null;
  lastError: string | null;
  /** 最近一次成功拉取的正文（用于断网时回退与差异预览） */
  lastPayloadJson: string | null;
  appliedRevision: string | null;
  ackedRevision: string | null;
  createdAt: number;
  updatedAt: number;
}

export type RemoteConfigSourceInput = Pick<RemoteConfigSource, 'userId' | 'name' | 'url'> &
  Partial<Pick<RemoteConfigSource, 'publicKey' | 'enabled' | 'updateIntervalMin'>>;

export class RemoteConfigRepo {
  private readonly repo: Repository<RemoteConfigSourceRow & Row>;

  constructor(db: Database) {
    this.repo = new Repository<RemoteConfigSourceRow & Row>(db, 'remote_config_source');
  }

  list(userId: string): RemoteConfigSource[] {
    return this.repo.findWhere({ user_id: userId }, { orderBy: 'created_at ASC' }).map(toSource);
  }

  enabledSources(userId: string): RemoteConfigSource[] {
    return this.list(userId).filter((source) => source.enabled);
  }

  findById(id: string): RemoteConfigSource | null {
    const row = this.repo.findById(id);
    return row ? toSource(row) : null;
  }

  create(input: RemoteConfigSourceInput): RemoteConfigSource {
    const name = z.string().trim().min(1).max(128).parse(input.name);
    const url = httpUrlSchema.parse(input.url);
    const publicKey = input.publicKey?.trim() || null;
    const updateIntervalMin = input.updateIntervalMin ?? 1440;
    if (!Number.isInteger(updateIntervalMin) || updateIntervalMin < 1) {
      throw new Error('更新频率必须是正整数分钟');
    }
    const now = Date.now();
    const row: RemoteConfigSourceRow = {
      id: newUlid(),
      user_id: input.userId,
      name,
      url,
      public_key: publicKey,
      enabled: input.enabled ? 1 : 0,
      update_interval_min: updateIntervalMin,
      last_fetch_at: null,
      last_status: 'idle',
      last_error: null,
      last_payload_json: null,
      applied_revision: null,
      acked_revision: null,
      created_at: now,
      updated_at: now,
    };
    this.repo.insert(row as RemoteConfigSourceRow & Row);
    return toSource(row);
  }

  update(id: string, patch: Partial<RemoteConfigSourceInput>): RemoteConfigSource | null {
    const next: Partial<RemoteConfigSourceRow> = {};
    if (patch.name !== undefined) next['name'] = z.string().trim().min(1).max(128).parse(patch.name);
    if (patch.url !== undefined) next['url'] = httpUrlSchema.parse(patch.url);
    if (patch.publicKey !== undefined) next['public_key'] = patch.publicKey?.trim() || null;
    if (patch.enabled !== undefined) next['enabled'] = patch.enabled ? 1 : 0;
    if (patch.updateIntervalMin !== undefined) {
      if (!Number.isInteger(patch.updateIntervalMin) || patch.updateIntervalMin < 1) {
        throw new Error('更新频率必须是正整数分钟');
      }
      next['update_interval_min'] = patch.updateIntervalMin;
    }
    const updated = this.repo.update(id, next);
    return updated ? toSource(updated) : null;
  }

  /** 记录一次拉取结果（成功与失败都记，UI 展示"上次拉取"） */
  recordFetch(
    id: string,
    result: { status: RemoteFetchStatus; error?: string | null; payloadJson?: string | null; appliedRevision?: string | null },
  ): RemoteConfigSource | null {
    const patch: Partial<RemoteConfigSourceRow> = {
      last_fetch_at: Date.now(),
      last_status: result.status,
      last_error: result.error ?? null,
    };
    if (result.payloadJson !== undefined) patch['last_payload_json'] = result.payloadJson;
    if (result.appliedRevision !== undefined) patch['applied_revision'] = result.appliedRevision;
    const updated = this.repo.update(id, patch);
    return updated ? toSource(updated) : null;
  }

  /** 标记用户已确认某版本（拒绝更新后不再弹窗） */
  ackRevision(id: string, revision: string): RemoteConfigSource | null {
    const updated = this.repo.update(id, { acked_revision: revision });
    return updated ? toSource(updated) : null;
  }

  remove(id: string): boolean {
    return this.repo.remove(id);
  }
}

function toSource(row: RemoteConfigSourceRow): RemoteConfigSource {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    url: row.url,
    publicKey: row.public_key,
    enabled: row.enabled === 1,
    updateIntervalMin: row.update_interval_min,
    lastFetchAt: row.last_fetch_at,
    lastStatus: (row.last_status as RemoteConfigSource['lastStatus']) ?? null,
    lastError: row.last_error,
    lastPayloadJson: row.last_payload_json,
    appliedRevision: row.applied_revision,
    ackedRevision: row.acked_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
