import { createSecureFileStorage, decodeSecureKey, encodeSecureKey } from '../secure-storage';
import type { SafeStorageLike } from '../secure-storage';
import { GitCredentialStore } from '@ec/git';
import { SecureStore } from '@ec/core';
import type { SecureNamespace, ShellHost } from '@ec/shell-api';

/**
 * Git 凭据存储的生产装配（T12-04 实现要点 4：「凭据只能走 DPAPI/SSH agent，不落日志」）。
 *
 * ## 为什么需要一个适配层
 *
 * `GitCredentialStore` 生成的键形如 `origin:kind` / `origin:token`，
 * 而 Electron 密钥环的文件名白名单是 `[A-Za-z0-9._-]`。这个限制**不是洁癖**：
 * Windows 会把文件名里的 `:` 解释成 NTFS 备用数据流（ADS）—— 写入与读取都会
 * 返回成功，但 `readdir` 永远列不出该条目，于是 `listBindings()` 恒为空、
 * 用户以为"凭据没保存"，而磁盘上其实躺着一份谁也不知道的密文。
 *
 * 因此这里做**可逆编码**：远程名里的非安全字符编码成 `_` + 两位十六进制，
 * 字段名放在最后一个 `.` 之后（字段集合固定且不含 `.`，解析无歧义）。
 *
 * ## 为什么用 `SecureStore` 包一层
 *
 * `@ec/git` 只依赖 `SecureStore` 这个类（含私有成员，结构类型无法冒充）。
 * 我们构造一个最小的 ShellHost 桩，把 `secureStore` 换成编码键实现，
 * 从而**复用 GitCredentialStore 的全部领域逻辑**（HTTPS/SSH 分支、清除对侧残留、
 * 只回元信息不回密钥），不复制一份。
 */

/** GitCredentialStore 使用的字段后缀（与 packages/git/src/credentials.ts 保持一致） */
const KNOWN_FIELDS = new Set(['kind', 'username', 'token', 'keyPath', 'passphrase']);

/** 把 GitCredentialStore 的 `remote:field` 键拆开；不匹配时整体当作 remote、字段为 kind */
function splitKey(key: string): { remote: string; field: string } {
  const index = key.lastIndexOf(':');
  if (index > 0) {
    const field = key.slice(index + 1);
    if (KNOWN_FIELDS.has(field)) return { remote: key.slice(0, index), field };
  }
  return { remote: key, field: 'kind' };
}

function fileKeyOf(key: string): string {
  const { remote, field } = splitKey(key);
  return `${encodeSecureKey(remote)}.${field}`;
}

function gitKeyOf(fileKey: string): string | null {
  const index = fileKey.lastIndexOf('.');
  if (index <= 0) return null;
  const field = fileKey.slice(index + 1);
  if (!KNOWN_FIELDS.has(field)) return null;
  return `${decodeSecureKey(fileKey.slice(0, index))}:${field}`;
}

export interface CreateGitCredentialStoreOptions {
  secureDir: string;
  safeStorage: SafeStorageLike;
}

/**
 * 建立 Git 凭据存储。
 *
 * `safeStorage` 不可用时返回 `null` —— 由调用方（git 域）把凭据类方法报
 * `NOT_SUPPORTED` 并给出引导，**绝不降级成明文文件**。
 */
export function createGitCredentialStore(
  options: CreateGitCredentialStoreOptions,
): GitCredentialStore | null {
  if (!options.safeStorage.isEncryptionAvailable()) return null;

  const storage = createSecureFileStorage(options);
  const namespace: SecureNamespace = 'git-credential';

  const shellStub = {
    kind: 'electron',
    secureStore: {
      async set(_ns: SecureNamespace, key: string, value: string): Promise<void> {
        await storage.write(namespace, fileKeyOf(key), value);
      },
      async get(_ns: SecureNamespace, key: string): Promise<string | null> {
        return storage.read(namespace, fileKeyOf(key));
      },
      async delete(_ns: SecureNamespace, key: string): Promise<void> {
        await storage.remove(namespace, fileKeyOf(key));
      },
      async has(_ns: SecureNamespace, key: string): Promise<boolean> {
        return (await storage.read(namespace, fileKeyOf(key))) !== null;
      },
      async listKeys(_ns: SecureNamespace): Promise<string[]> {
        const files = await storage.keys(namespace);
        const keys: string[] = [];
        for (const file of files) {
          const key = gitKeyOf(file);
          if (key !== null) keys.push(key);
        }
        return keys;
      },
    },
  };

  return new GitCredentialStore({
    store: new SecureStore(shellStub as unknown as ShellHost),
  });
}
