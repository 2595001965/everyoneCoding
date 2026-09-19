import type { Database } from 'better-sqlite3';
import { Repository, newUlid, type Row } from '@ec/data';
import type { ProviderRow } from '@ec/data';

import { keyRefOf, filterSafeHeaders, providerFromRow, type Provider } from '../domain/provider';
import { parseCreateProvider, type CreateProviderInput } from '../dto/create-provider';
import { parseUpdateProvider, type UpdateProviderInput } from '../dto/update-provider';
import { SecureRefRepo } from './secure-ref-repo';
import type { ApiKeyStore } from '../secure/api-key-store';

/**
 * Provider 仓库。
 *
 * - 读写 `provider` 表，乐观锁由 Repository 提供（表含 version 列）
 * - API Key 不落库：明文交给 ApiKeyStore（DPAPI），DB 只保留引用名
 * - 涉及 Key 的写操作是异步的（密钥环 IO），纯 DB 查询保持同步
 */

export interface ProviderListOptions {
  /** 只返回启用项（默认 false：设置页需要看到全部） */
  enabledOnly?: boolean;
}

export class ProviderRepo {
  private readonly repo: Repository<ProviderRow & Row>;
  private readonly refs: SecureRefRepo;

  constructor(
    private readonly db: Database,
    private readonly keys: ApiKeyStore | null = null,
  ) {
    this.repo = new Repository<ProviderRow & Row>(db, 'provider');
    this.refs = new SecureRefRepo(db);
  }

  list(userId: string, options: ProviderListOptions = {}): Provider[] {
    const rows = this.repo.findWhere({ user_id: userId }, { orderBy: 'sort_order ASC, name ASC' });
    return rows
      .filter((row) => (options.enabledOnly ? row.enabled === 1 : true))
      .map(providerFromRow);
  }

  findById(id: string): Provider | null {
    const row = this.repo.findById(id);
    return row ? providerFromRow(row) : null;
  }

  count(userId: string): number {
    return this.repo.count({ user_id: userId });
  }

  /** 新建；传入 apiKey 时先写密钥环再落库（失败则不产生脏记录） */
  async create(input: CreateProviderInput): Promise<Provider> {
    // 兜底校验：仓库是最后一道防线，非法 baseUrl / 超时不得进入数据库
    const data = parseCreateProvider(input);
    const id = newUlid();
    let keyRef: string | null = null;
    if (data.keyRef) {
      // 顺序：草稿 Key 转正（可能失败）→ 再登记 secure_ref → 最后落 provider
      const plain = await this.requireKeys().getByRef(data.keyRef);
      if (plain === null) {
        throw new Error('Key 引用已失效，请重新填写 API Key 后再保存');
      }
      await this.requireKeys().save(id, plain);
      await this.requireKeys().removeRef(data.keyRef);
      keyRef = this.refs.ensure(data.userId, 'api_key', keyRefOf(id));
    }

    const now = Date.now();
    const row: ProviderRow = {
      id,
      user_id: data.userId,
      name: data.name,
      protocol: data.protocol,
      base_url: data.baseUrl,
      api_key_ref: keyRef,
      headers_json: JSON.stringify(filterSafeHeaders(data.headers)),
      default_timeout: data.timeoutMs,
      supports_stream: bool(data.supportsStream),
      supports_tools: bool(data.supportsTools),
      supports_vision: bool(data.supportsVision),
      enabled: bool(data.enabled),
      sort_order: data.order,
      version: 1,
      manual_models_json: JSON.stringify(data.manualModels),
      created_at: now,
      updated_at: now,
    };
    this.repo.insert(row as ProviderRow & Row);
    return providerFromRow(row);
  }

  /**
   * 更新。
   * @param expectedVersion 传入即启用乐观锁，版本不符抛 ConflictError
   * @param apiKey undefined 不改；null 删除；字符串写入密钥环
   */
  async update(
    id: string,
    patch: UpdateProviderInput,
    expectedVersion?: number,
  ): Promise<Provider | null> {
    const current = this.repo.findById(id);
    if (!current) return null;
    const data = parseUpdateProvider(patch);
    // 乐观锁校验必须先于密钥环写入，冲突时不得改动 Key。
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      const { ConflictError } = await import('@ec/data');
      throw new ConflictError('provider', id, expectedVersion);
    }

    const next: Partial<ProviderRow> = {};
    if (data.name !== undefined) next['name'] = data.name;
    if (data.protocol !== undefined) next['protocol'] = data.protocol;
    if (data.baseUrl !== undefined) next['base_url'] = data.baseUrl;
    if (data.headers !== undefined)
      next['headers_json'] = JSON.stringify(filterSafeHeaders(data.headers));
    if (data.timeoutMs !== undefined) next['default_timeout'] = data.timeoutMs;
    if (data.supportsStream !== undefined) next['supports_stream'] = bool(data.supportsStream);
    if (data.supportsTools !== undefined) next['supports_tools'] = bool(data.supportsTools);
    if (data.supportsVision !== undefined) next['supports_vision'] = bool(data.supportsVision);
    if (data.enabled !== undefined) next['enabled'] = bool(data.enabled);
    if (data.order !== undefined) next['sort_order'] = data.order;
    if (data.manualModels !== undefined)
      next['manual_models_json'] = JSON.stringify(data.manualModels);

    if (data.keyRef !== undefined && data.keyRef !== null) {
      const plain = await this.requireKeys().getByRef(data.keyRef);
      if (plain === null) {
        throw new Error('Key 引用已失效，请重新填写 API Key 后再保存');
      }
      await this.requireKeys().save(id, plain);
      await this.requireKeys().removeRef(data.keyRef);
      next['api_key_ref'] = this.refs.ensure(this.userIdOf(id) ?? '', 'api_key', keyRefOf(id));
    } else if (data.keyRef === null) {
      if (this.keys) await this.keys.remove(id);
      this.refs.removeByPath(keyRefOf(id));
      next['api_key_ref'] = null;
    }

    const updated = this.repo.update(id, next, expectedVersion);
    return updated ? providerFromRow(updated) : null;
  }

  /** 单独保存明文 Key（编辑页"重新粘贴 Key"场景） */
  async saveApiKey(providerId: string, apiKey: string): Promise<Provider | null> {
    await this.requireKeys().save(providerId, apiKey);
    const ref = this.refs.ensure(this.userIdOf(providerId) ?? '', 'api_key', keyRefOf(providerId));
    const updated = this.repo.update(providerId, { api_key_ref: ref });
    return updated ? providerFromRow(updated) : null;
  }

  async removeApiKey(providerId: string): Promise<Provider | null> {
    if (this.keys) await this.keys.remove(providerId);
    this.refs.removeByPath(keyRefOf(providerId));
    const updated = this.repo.update(providerId, { api_key_ref: null });
    return updated ? providerFromRow(updated) : null;
  }

  private userIdOf(providerId: string): string | null {
    return this.repo.findById(providerId)?.['user_id'] ?? null;
  }

  /** 暴露密钥环（供服务层读写草稿 Key）；未配置时返回 null */
  keyStore(): ApiKeyStore | null {
    return this.keys;
  }

  /** 读取明文 Key（仅内存使用，绝不写日志） */
  async getApiKey(providerId: string): Promise<string | null> {
    if (!this.keys) return null;
    const provider = this.findById(providerId);
    if (provider && provider.keyRef === null) return null;
    return this.keys.get(providerId);
  }

  setEnabled(id: string, enabled: boolean): Provider | null {
    const updated = this.repo.update(id, { enabled: bool(enabled) });
    return updated ? providerFromRow(updated) : null;
  }

  /** 批量重排：按传入顺序重写 sort_order（事务内完成） */
  reorder(orderedIds: readonly string[]): void {
    const run = this.db.transaction(() => {
      orderedIds.forEach((id, index) => {
        this.repo.update(id, { sort_order: index });
      });
    });
    run();
  }

  async remove(id: string): Promise<boolean> {
    // 顺序：先删 provider（解除外键）→ 再删引用记录 → 最后清密钥环
    const removed = this.repo.remove(id);
    this.refs.removeByPath(keyRefOf(id));
    if (this.keys) await this.keys.remove(id);
    return removed;
  }

  private requireKeys(): ApiKeyStore {
    if (!this.keys) throw new Error('ProviderRepo 未配置 ApiKeyStore，无法保存 API Key');
    return this.keys;
  }
}

function bool(value: boolean | undefined): 0 | 1 {
  return value ? 1 : 0;
}

export { keyRefOf };
