import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { IpcDependencies, IpcMainLike, SafeStorageLike } from '../types';
import { CHANNELS } from '../channels';

/**
 * secure_store IPC：DPAPI 加密密钥环。
 * electron safeStorage 底层即 DPAPI（用户上下文）；密文落 userData/secure/<ns>.dat。
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
  if (!dir) throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', message: `非法命名空间: ${namespace}` }));
  return dir;
}

function sanitizeKey(key: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(key)) {
    throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', message: '键名只允许字母数字与 . _ -' }));
  }
  return key;
}

function storage(deps: IpcDependencies, safeStorage: SafeStorageLike): {
  write: (ns: string, key: string, value: string) => Promise<void>;
  read: (ns: string, key: string) => Promise<string | null>;
  remove: (ns: string, key: string) => Promise<void>;
  keys: (ns: string) => Promise<string[]>;
} {
  const dirOf = (ns: string): string => path.join(deps.secureDir, ns);
  const fileOf = (ns: string, key: string): string => path.join(dirOf(ns), `${key}.dat`);

  return {
    write: async (ns, key, value) => {
      await fsp.mkdir(dirOf(ns), { recursive: true });
      const cipher = safeStorage.encryptString(value);
      await fsp.writeFile(fileOf(ns, key), cipher);
    },
    read: async (ns, key) => {
      try {
        const cipher = await fsp.readFile(fileOf(ns, key));
        return safeStorage.decryptString(cipher);
      } catch {
        return null;
      }
    },
    remove: async (ns, key) => {
      await fsp.rm(fileOf(ns, key), { force: true });
    },
    keys: async (ns) => {
      try {
        const entries = await fsp.readdir(dirOf(ns));
        return entries.filter((name) => name.endsWith('.dat')).map((name) => name.slice(0, -4));
      } catch {
        return [];
      }
    },
  };
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

export function registerSecureStoreIpc(ipc: IpcMainLike, deps: IpcDependencies): void {
  ipc.handle(CHANNELS.secureStore.set, async (_event, payload) => {
    const { namespace, key, value } = payload as { namespace: string; key: string; value: string };
    const ns = validateNamespace(namespace);
    const safeKey = sanitizeKey(key);
    if (value.length === 0) {
      throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', message: '空值不允许写入密钥环' }));
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
