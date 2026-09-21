import type { IpcDependencies, IpcMainLike, SafeStorageLike } from '../types';
import { createSecureFileStorage, isSafeSecureKey, type SecureFileStorage } from '../secure-storage';
import { CHANNELS } from '../channels';

/**
 * secure_store IPC：DPAPI 加密密钥环。
 *
 * 底层的"加密 + 落盘"已下沉到 `main/secure-storage.ts`（域层的 git 凭据要复用同一份
 * 实现，但域不该 import ipc 模块）。本文件只保留 **IPC 边界该做的事**：
 * 命名空间白名单、键名白名单、参数校验与错误码包装。
 *
 * 磁盘上只允许出现密文，任何异常不得把明文带出主进程。
 */

const NAMESPACE_DIR: Record<string, string> = {
  'ai-key': 'ai-key',
  'oauth-token': 'oauth-token',
  'git-credential': 'git-credential',
  'app-secret': 'app-secret',
};

function validateNamespace(namespace: string): string {
  const dir = NAMESPACE_DIR[namespace];
  if (!dir)
    throw new Error(
      JSON.stringify({ code: 'INVALID_ARGUMENT', message: `非法命名空间: ${namespace}` }),
    );
  return dir;
}

function sanitizeKey(key: string): string {
  if (!isSafeSecureKey(key)) {
    throw new Error(
      JSON.stringify({ code: 'INVALID_ARGUMENT', message: '键名只允许字母数字与 . _ -' }),
    );
  }
  return key;
}

/** 当 safeStorage 不可用（如 Linux 无 keyring）时明确拒绝，绝不降级为明文 */
function requireSafeStorage(deps: IpcDependencies): SafeStorageLike {
  const safeStorage = deps.safeStorage;
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    throw new Error(
      JSON.stringify({ code: 'ENCRYPT_FAILED', message: '系统安全存储不可用，无法加密保存密钥' }),
    );
  }
  return safeStorage;
}

function storage(deps: IpcDependencies, safeStorage: SafeStorageLike): SecureFileStorage {
  return createSecureFileStorage({ secureDir: deps.secureDir, safeStorage });
}

export function registerSecureStoreIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  ipc.handle(CHANNELS.secureStore.set, async (_event, payload) => {
    const { namespace, key, value } = payload as { namespace: string; key: string; value: string };
    const ns = validateNamespace(namespace);
    const safeKey = sanitizeKey(key);
    if (value.length === 0) {
      throw new Error(
        JSON.stringify({ code: 'INVALID_ARGUMENT', message: '空值不允许写入密钥环' }),
      );
    }
    const store = storage(deps, requireSafeStorage(deps));
    await store.write(ns, safeKey, value);
    return undefined;
  });

  ipc.handle(CHANNELS.secureStore.get, async (_event, payload) => {
    const { namespace, key } = payload as { namespace: string; key: string };
    const ns = validateNamespace(namespace);
    const safeKey = sanitizeKey(key);
    const store = storage(deps, requireSafeStorage(deps));
    return store.read(ns, safeKey);
  });

  ipc.handle(CHANNELS.secureStore.delete, async (_event, payload) => {
    const { namespace, key } = payload as { namespace: string; key: string };
    const ns = validateNamespace(namespace);
    const safeKey = sanitizeKey(key);
    const store = storage(deps, requireSafeStorage(deps));
    await store.remove(ns, safeKey);
    return undefined;
  });

  ipc.handle(CHANNELS.secureStore.has, async (_event, payload) => {
    const { namespace, key } = payload as { namespace: string; key: string };
    const ns = validateNamespace(namespace);
    const safeKey = sanitizeKey(key);
    const store = storage(deps, requireSafeStorage(deps));
    return (await store.read(ns, safeKey)) !== null;
  });

  ipc.handle(CHANNELS.secureStore.listKeys, async (_event, payload) => {
    const { namespace } = payload as { namespace: string };
    const ns = validateNamespace(namespace);
    const store = storage(deps, requireSafeStorage(deps));
    return store.keys(ns);
  });
}
