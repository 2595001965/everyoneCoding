import type { SecureNamespace, ShellHost } from '@ec/shell-api';
import { ShellError, isShellError } from '@ec/shell-api';

/**
 * 密钥环：封装 ShellHost.secureStore（DPAPI）。
 *
 * 硬约束：
 * - 明文永不落地：只经外壳安全存储写入，密文由外壳负责
 * - 任何异常都不得把明文带进日志或错误信息
 * - listKeys 只返回键名，不返回任何值
 */

export class SecureStore {
  constructor(private readonly shell: ShellHost) {}

  private guard<T>(
    operation: string,
    namespace: SecureNamespace,
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return task().catch((error: unknown) => {
      if (isShellError(error)) throw error;
      // 错误信息中不得包含 key 的实际值（这里只带键名）
      throw new ShellError(
        'UNKNOWN',
        `密钥环操作 ${operation} 失败（${namespace}/${key}）：${error instanceof Error ? error.message : String(error)}`,
        undefined,
        this.shell.kind,
      );
    });
  }

  async set(namespace: SecureNamespace, key: string, value: string): Promise<void> {
    if (value.length === 0) {
      throw new ShellError('INVALID_ARGUMENT', '空值不允许写入密钥环', undefined, this.shell.kind);
    }
    await this.guard('set', namespace, key, () =>
      this.shell.secureStore.set(namespace, key, value),
    );
  }

  async get(namespace: SecureNamespace, key: string): Promise<string | null> {
    return this.guard('get', namespace, key, () => this.shell.secureStore.get(namespace, key));
  }

  async delete(namespace: SecureNamespace, key: string): Promise<void> {
    await this.guard('delete', namespace, key, () => this.shell.secureStore.delete(namespace, key));
  }

  async has(namespace: SecureNamespace, key: string): Promise<boolean> {
    return this.guard('has', namespace, key, () => this.shell.secureStore.has(namespace, key));
  }

  async listKeys(namespace: SecureNamespace): Promise<string[]> {
    return this.guard('listKeys', namespace, '*', () => this.shell.secureStore.listKeys(namespace));
  }
}
