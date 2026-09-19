import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import {
  aiErrorFromUnknown,
  AI_RPC_METHODS,
  isAiRpcMethod,
  type AiControlServiceHost,
  type AiRpcRequest,
  type AiRpcResponse,
  type AiStreamEvent,
  type AiStreamRequest,
} from '@ec/shell-api';
import { SecureStore } from '@ec/core';
import { Migrator } from '@ec/data';
import type { SecureNamespace } from '@ec/shell-api';
import { createAiStack } from '@ec/ai';
import type { SafeStorageLike } from '../types';

declare module 'better-sqlite3' {}
export interface ElectronAiRuntimeOptions {
  dataDir: string;
  secureDir: string;
  migrationsDir: string;
  safeStorage: SafeStorageLike | null;
  userId?: string;
}

const KEY_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const namespaces = new Set<SecureNamespace>([
  'ai-key',
  'oauth-token',
  'git-credential',
  'app-secret',
]);

export async function createElectronAiRuntime(
  options: ElectronAiRuntimeOptions,
): Promise<AiControlServiceHost> {
  if (!options.dataDir || !options.secureDir) throw new Error('AI runtime 目录不能为空');
  if (!options.safeStorage || !options.safeStorage.isEncryptionAvailable()) {
    throw new Error(
      JSON.stringify({
        code: 'ENCRYPT_FAILED',
        message: '系统安全存储不可用，AI Key 不会降级为明文存储',
      }),
    );
  }
  await fsp.mkdir(options.dataDir, { recursive: true });
  await fsp.mkdir(options.secureDir, { recursive: true });
  const db = new Database(join(options.dataDir, 'everyonecoding.sqlite'));
  const migrationsDir = resolveMigrations(options.migrationsDir);
  Migrator.fromDirectory(db, migrationsDir).up();
  const userId = options.userId ?? 'local-user';
  ensureUser(db, userId);

  const secureApi = createDpapiStore(options.safeStorage, options.secureDir);
  const secure = new SecureStore({ kind: 'electron', secureStore: secureApi } as never);
  const stack = createAiStack({ db, secureStore: secure, userId });
  const aborters = new Map<string, AbortController>();
  const control = stack.control;

  const invoke = async (request: AiRpcRequest): Promise<AiRpcResponse> => {
    if (
      !request ||
      typeof request.requestId !== 'string' ||
      !isAiRpcMethod(request.method, AI_RPC_METHODS)
    ) {
      return {
        requestId: request?.requestId ?? 'invalid',
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'AI RPC 方法不在白名单内' },
      };
    }
    try {
      const params = asRecord(request.params);
      const result = await routeInvoke(control, request.method, params);
      return { requestId: request.requestId, ok: true, result };
    } catch (error) {
      const mapped = aiErrorFromUnknown(error);
      return { requestId: request.requestId, ok: false, error: mapped };
    }
  };

  const stream = (request: AiStreamRequest, emit: (event: AiStreamEvent) => void): void => {
    const controller = new AbortController();
    aborters.set(request.requestId, controller);
    void (async () => {
      try {
        const purpose = request.purpose as Parameters<typeof stack.gateway.chat>[0]['purpose'];
        const messages = request.messages as Parameters<typeof stack.gateway.chat>[0]['messages'];
        for await (const chunk of stack.gateway.chat({
          userId,
          purpose,
          messages,
          ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
          ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
          ...(request.providerId !== undefined ? { providerId: request.providerId } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
          signal: controller.signal,
        })) {
          if (chunk.type === 'done') emit(chunk);
          else if (chunk.type === 'error')
            emit({ type: 'error', error: aiErrorFromUnknown(chunk.error) });
          else
            emit({
              type: 'chunk',
              payload: chunk as unknown as { type: string; [key: string]: unknown },
            });
        }
      } catch (error) {
        emit({ type: 'error', error: aiErrorFromUnknown(error) });
        emit({ type: 'done', finishReason: 'error', partial: true });
      } finally {
        aborters.delete(request.requestId);
      }
    })();
  };

  return {
    invoke,
    stream,
    abort(requestId) {
      aborters.get(requestId)?.abort();
    },
    async dispose() {
      for (const controller of aborters.values()) controller.abort();
      aborters.clear();
      await stack.dispose();
      db.close();
    },
  };
}

/**
 * 定位 SQLite 迁移目录。
 *
 * 为什么不能只依赖固定相对层级：主进程源码在 `src/main/index.ts`，而 esbuild
 * 产物在 `dist/main/index.cjs`，两者相对仓库根的深度不同；打包进 asar 后又不同。
 * 因此以「源码深度 / 产物深度 / 工作目录 / 可执行文件目录」为起点**逐级向上**探测，
 * 命中即用，避免把层级写死。
 */
function resolveMigrations(preferred: string): string {
  const rel = ['packages', 'data', 'migrations'];
  const starts = [preferred, process.cwd(), dirname(process.execPath)];
  const candidates: string[] = [
    preferred,
    join(dirname(process.execPath), 'resources', 'migrations'),
  ];
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(join(dir, ...rel));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const found = candidates.find((candidate) => existsSync(join(candidate, '0001_init.sql')));
  if (!found) throw new Error('找不到 SQLite 迁移目录');
  return found;
}

function ensureUser(db: Database.Database, userId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO user (id, login, display_name, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)`,
  ).run(userId, userId, '本地用户', now, now);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function routeInvoke(
  control: ReturnType<typeof createAiStack>['control'],
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'listProviders':
      return control.listProviders();
    case 'createProvider':
      return control.createProvider(params as never);
    case 'updateProvider':
      return control.updateProvider(String(params['id']), params['patch'] ?? params);
    case 'removeProvider':
      return control.removeProvider(String(params['id']));
    case 'setProviderEnabled':
      return control.setProviderEnabled(String(params['id']), Boolean(params['enabled']));
    case 'reorderProviders':
      return control.reorderProviders(params['orderedIds'] as string[]);
    case 'testConnection':
      return control.testConnection(String(params['providerId']));
    case 'testDraftConnection': {
      const raw = (params['input'] ?? {}) as Record<string, unknown>;
      const keyRef = typeof params['keyRef'] === 'string' ? params['keyRef'] : null;
      return control.testDraftConnection(raw as never, keyRef);
    }
    case 'persistApiKey': {
      const apiKey = params['apiKey'];
      if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('缺少 API Key');
      const preferred = typeof params['keyRef'] === 'string' ? params['keyRef'] : null;
      return control.persistApiKey({ apiKey, keyRef: preferred });
    }
    case 'discardTempKey': {
      const keyRef = typeof params['keyRef'] === 'string' ? params['keyRef'] : null;
      await control.discardTempKey(keyRef);
      return true;
    }
    case 'listModels':
      return control.listModels(String(params['providerId']));
    case 'listAllModels':
      return control.listAllModels();
    case 'refreshModels':
      return control.refreshModels(String(params['providerId']));
    case 'addManualModel':
      return control.addManualModel(String(params['providerId']), String(params['name']));
    case 'updateCapability':
      return control.updateCapability(String(params['modelId']), params['patch'] as never);
    case 'getBinding':
      return control.getBinding();
    case 'saveBinding':
      return control.saveBinding(params['binding'] as never);
    case 'monthlyUsage':
      return control.monthlyUsage();
    case 'usageByModel':
      return control.usageByModel();
    case 'budgetConfig':
      return control.budgetConfig();
    case 'setBudget':
      return control.setBudget(params as never);
    case 'setLimits':
      return control.setLimits(String(params['providerId']), params['limits'] as never);
    case 'setProxy':
      return control.setProxy((params['proxy'] ?? null) as never);
    case 'testProxy':
      return control.testProxy(params['target'] as never);
    case 'listRemoteSources':
      return control.listRemoteSources();
    case 'createRemoteSource':
      return control.createRemoteSource(params as never);
    case 'updateRemoteSource':
      return control.updateRemoteSource(String(params['id']), params['patch'] as never);
    case 'removeRemoteSource':
      return control.removeRemoteSource(String(params['id']));
    case 'fetchRemoteSource':
      return control.fetchRemoteSource(String(params['id']));
    case 'previewRemoteSource':
      return control.previewRemoteSource(String(params['id']));
    case 'applyRemoteSource':
      return control.applyRemoteSource(String(params['id']), params['options'] as never);
    case 'ackRemoteRevision':
      return control.ackRemoteRevision(String(params['id']), String(params['revision']));
    case 'refreshRemoteSourcesOnBoot':
      return control.refreshRemoteSourcesOnBoot();
    default:
      throw new Error(`不支持的 AI 方法：${method}`);
  }
}

export function createDpapiStore(safeStorage: SafeStorageLike, root: string) {
  const fileOf = (namespace: SecureNamespace, key: string): string => {
    if (!namespaces.has(namespace) || !KEY_PATTERN.test(key)) throw new Error('密钥引用名非法');
    return join(root, namespace, `${key}.dat`);
  };
  return {
    async set(namespace: SecureNamespace, key: string, value: string): Promise<void> {
      const file = fileOf(namespace, key);
      await fsp.mkdir(join(root, namespace), { recursive: true });
      await fsp.writeFile(file, safeStorage.encryptString(value));
    },
    async get(namespace: SecureNamespace, key: string): Promise<string | null> {
      try {
        return safeStorage.decryptString(await fsp.readFile(fileOf(namespace, key)));
      } catch {
        return null;
      }
    },
    async delete(namespace: SecureNamespace, key: string): Promise<void> {
      await fsp.rm(fileOf(namespace, key), { force: true });
    },
    async has(namespace: SecureNamespace, key: string): Promise<boolean> {
      return (await this.get(namespace, key)) !== null;
    },
    async listKeys(namespace: SecureNamespace): Promise<string[]> {
      try {
        return (await fsp.readdir(join(root, namespace)))
          .filter((name) => name.endsWith('.dat'))
          .map((name) => name.slice(0, -4));
      } catch {
        return [];
      }
    },
  };
}
