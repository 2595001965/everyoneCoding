import { parsePageDsl } from './schema';
import type { PageDsl, PageRecord } from './types';
import { DSL_VERSION, migrateDsl } from './version';

/**
 * PageDSL 持久化（T3-01 要点 3）。
 *
 * - 每页一个 `<pageId>.dsl.json`；
 * - 文件为「信封 + 页面」结构：`{ dslVersion, page }`，信封版本用于升级迁移；
 * - 写入走 `@ec/core` 的 `FileService.writeAtomic()`（临时文件 → fsync → rename），
 *   中途失败不会在目标路径留下半截文件；
 * - 写出前先过 zod 校验，避免把非法结构落盘。
 *
 * 为了同时适配「真实文件系统」与「测试内存实现」，本模块只依赖一个结构化端口
 * `DslStorePort`；`@ec/core` 的 `FileService` 天然满足该端口（无需适配层）。
 */

export const DSL_FILE_SUFFIX = '.dsl.json';

/** 原子文件端口（由 `@ec/core` 的 FileService 满足） */
export interface DslStorePort {
  readText(path: string): Promise<string>;
  writeAtomic(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: 'utf8' | 'base64'; backup?: boolean },
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** 文件信封 */
export interface DslEnvelope {
  dslVersion: number;
  page: PageDsl;
}

export class DslParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'DslParseError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** `<pageId>.dsl.json` */
export function dslFileName(pageId: string): string {
  return `${pageId}${DSL_FILE_SUFFIX}`;
}

/** 拼接工作区内的 DSL 相对路径 */
export function pageDslPath(dir: string, pageId: string): string {
  const normalized = dir.replace(/[\\/]+$/, '');
  return `${normalized}/${dslFileName(pageId)}`;
}

export function isDslFileName(name: string): boolean {
  return name.endsWith(DSL_FILE_SUFFIX);
}

/** 从文件名反推 pageId */
export function pageIdFromFileName(name: string): string | null {
  if (!isDslFileName(name)) return null;
  const id = name.slice(0, -DSL_FILE_SUFFIX.length);
  return id.length > 0 ? id : null;
}

/** 序列化：输出带缩进的信封 JSON（便于 Git diff 与人工审阅） */
export function serializePageDsl(dsl: PageDsl, version: number = DSL_VERSION): string {
  const envelope: DslEnvelope = { dslVersion: version, page: dsl };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export interface DeserializeResult {
  dsl: PageDsl;
  /** 落盘/迁移后的版本 */
  version: number;
  /** 文件原始版本 */
  fromVersion: number;
  /** 实际执行的迁移起点 */
  applied: number[];
}

/**
 * 反序列化：支持两种文件形态
 * 1. 当前形态：`{ dslVersion, page }`
 * 2. v1 遗留形态：文件本身就是 PageDsl（无信封）→ 按版本 1 迁移
 */
export function deserializePageDsl(text: string): DeserializeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DslParseError('DSL 文件不是合法 JSON', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DslParseError('DSL 文件根节点必须是对象');
  }
  const record = parsed as Record<string, unknown>;
  const hasEnvelope =
    'page' in record && typeof record['page'] === 'object' && record['page'] !== null;
  const rawPage = hasEnvelope ? (record['page'] as Record<string, unknown>) : record;
  // 版本以信封声明为准；遗留的裸 PageDsl 文件没有版本字段，按 v1 迁移
  const declared =
    typeof record['dslVersion'] === 'number' ? Math.trunc(record['dslVersion']) : undefined;

  const migrated = migrateDsl(rawPage, declared === undefined ? {} : { from: declared });
  const dsl = parsePageDsl(migrated.value);
  return { dsl, version: migrated.to, fromVersion: migrated.from, applied: migrated.applied };
}

/** 原子保存：校验 → 序列化 → 单次原子写 */
export async function savePageDsl(store: DslStorePort, path: string, dsl: PageDsl): Promise<void> {
  const validated = parsePageDsl(dsl);
  const text = serializePageDsl(validated);
  await store.writeAtomic(path, text);
}

/** 加载：读文件 → 反序列化（含版本迁移）→ 返回带文件位置的记录 */
export async function loadPageDsl(store: DslStorePort, path: string): Promise<PageRecord> {
  const text = await store.readText(path);
  const result = deserializePageDsl(text);
  return { dsl: result.dsl, filePath: path, dslVersion: result.version };
}

/** 扫描目录下的全部页面 DSL 文件（仅返回文件名，路径由调用方拼接） */
export async function listPageDslFiles(
  store: DslStorePort & { list?(path: string): Promise<string[]> },
  dir: string,
): Promise<string[]> {
  if (typeof store.list !== 'function') return [];
  const entries = await store.list(dir);
  return entries
    .map((entry) => entry.replace(/\\/g, '/').split('/').pop() ?? entry)
    .filter(isDslFileName);
}
