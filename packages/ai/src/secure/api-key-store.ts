import type { SecureStore } from '@ec/core';

import { KEY_NAMESPACE, isTempKeyRef, keyRefOf } from '../domain/provider';

/** API Key 写入失败时只返回固定文案，不能把底层异常或明文带出。 */
export class KeyStoreError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Provider ${providerId} 的 API Key 操作失败`);
    this.name = 'KeyStoreError';
    this.providerId = providerId;
    Object.setPrototypeOf(this, KeyStoreError.prototype);
  }
}

/** AI Key 专用命名空间：与外壳 SecureNamespace 的 'ai-key' 对齐 */
type AiKeyNamespace = 'ai-key';

/**
 * API Key 存储（FR-MDL-09 / NFR-S-01）。
 * 明文只在调用栈内存中短暂存在，实际保存由 ShellHost.secureStore（DPAPI）完成。
 */
export class ApiKeyStore {
  constructor(private readonly store: SecureStore) {}

  /** 写入并返回可被真实外壳接受的引用名。 */
  async save(providerId: string, apiKey: string): Promise<string> {
    const ref = keyRefOf(providerId);
    try {
      await this.store.set(KEY_NAMESPACE, ref, apiKey);
      return ref;
    } catch {
      throw new KeyStoreError(providerId);
    }
  }

  async get(providerId: string): Promise<string | null> {
    try {
      return await this.store.get(KEY_NAMESPACE, keyRefOf(providerId));
    } catch {
      throw new KeyStoreError(providerId);
    }
  }

  /** 按「引用名」写入；连接测试与外部预写场景使用。 */
  async saveRef(ref: string, apiKey: string, namespace: AiKeyNamespace = KEY_NAMESPACE): Promise<string> {
    await this.store.set(namespace, ref, apiKey);
    return ref;
  }

  async getByRef(ref: string, namespace: AiKeyNamespace = KEY_NAMESPACE): Promise<string | null> {
    return this.store.get(namespace, ref);
  }

  async removeRef(ref: string, namespace: AiKeyNamespace = KEY_NAMESPACE): Promise<void> {
    await this.store.delete(namespace, ref);
  }

  /** 清理「连接测试」留下的临时引用；只允许清 temp- 前缀，误删正式 Key 的空间为零。 */
  async discardTemp(ref: string): Promise<void> {
    if (!isTempKeyRef(ref)) return;
    try {
      await this.store.delete(KEY_NAMESPACE, ref);
    } catch {
      // 清理失败无需打扰用户：临时 Key 不影响功能，只在密钥环里多一条待回收项
    }
  }

  async has(providerId: string): Promise<boolean> {
    try {
      return await this.store.has(KEY_NAMESPACE, keyRefOf(providerId));
    } catch {
      return false;
    }
  }

  async remove(providerId: string): Promise<void> {
    try {
      await this.store.delete(KEY_NAMESPACE, keyRefOf(providerId));
    } catch {
      throw new KeyStoreError(providerId);
    }
  }
}
