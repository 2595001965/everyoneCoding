/**
 * 全局统一重命名渲染层端口（T7-03 / T7-04 / T7-05）。
 *
 * 与 `GitApi` / `PreviewApi` / `NavApi` / `PipelineApi` 同一套做法：渲染层只认这个
 * `RenameApi` 接口，真实实现由外壳经 `globalThis.__EC_RENAME__` 注入
 * （见 `readInjectedRenameApi`）。渲染层**绝不**直接 `import { buildOccurrenceIndex } from '@ec/registry'`
 * ——索引构建需要 TypeScript 编译器（Node 侧），渲染层只用 `@ec/registry` 的 browser 入口
 * 里的纯逻辑（命名规则、冲突检测、影响面分组、四栏 diff、迁移脚本解析）。
 *
 * 硬约束：
 * - **AI 是代码与数据库脚本的唯一写入口**（D-04 / D-08）：本端口只提交"变更计划 + 勾选"，
 *   真实文件写入由外壳经端口完成，UI 不接触磁盘；
 * - **重命名仅项目内生效**（D-07 / FR-UNI-13）：`scopeNotice` 必须原样展示给用户；
 * - 破坏性操作（执行重命名、执行迁移、批量规范化）均由 UI 二次确认。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type {
  AliasEntry,
  AliasKind,
  ConflictCheckResult,
  MigrationExecutionResult,
  MigrationLogLine,
  MigrationPreview,
  NamingOverride,
  NamingPlatform,
  PendingCleanupItem,
  ProjectionSet,
  RegistryEntityType,
  RenameHistoryEntry,
  RenameTransactionResult,
  ResolvedNamingRule,
  SymbolTable,
  UndoResult,
  BatchPlan,
  BatchRenameResult,
  ImpactReport,
  UnifiedDiff,
} from '@ec/registry';

/** 端口注入键（外壳装配时写入） */
export const RENAME_API_GLOBAL_KEY = '__EC_RENAME__';

/** 项目中一个可重命名对象（注册表项的精简视图） */
export interface RenameTarget {
  registryId: string;
  entityType: RegistryEntityType;
  /** 稳定 ID（永不变更） */
  entityId: string;
  canonicalName: string;
  /** 当前八类投影 */
  projections: ProjectionSet;
  aliases: readonly AliasEntry[];
  syncState: 'synced' | 'drift_detected' | 'conflict';
  /** 所属页面 / 功能名（UI 分组展示） */
  ownerName: string | null;
}

/** 迁移规划请求 */
export interface MigrationPlanRequest {
  registryId: string;
  table: string;
  oldColumn: string;
  newColumn: string;
  columnType?: string | null | undefined;
  nullable?: boolean | null | undefined;
  dependents?: readonly string[] | undefined;
  dialect?: 'sqlite' | 'mysql' | 'postgres' | undefined;
}

/** 迁移规划失败（模型不可用等，如实上报） */
export interface MigrationPlanError {
  error: string;
  guidance: string;
}

/** 批量规划请求 */
export interface BatchPlanRequest {
  /** 指定对象批量改名；为空且 `normalize` 为 true 时走"一键全项目规范化" */
  items?: readonly { registryId: string; newName: string }[] | undefined;
  normalize?: boolean | undefined;
}

export interface RenameApi {
  readonly ready: boolean;
  readonly reason?: string | undefined;

  /** 项目上下文（平台、命名覆盖、符号表） */
  projectContext(): Promise<{
    projectId: string;
    projectName: string;
    platform: NamingPlatform;
    override: NamingOverride | null;
  }>;
  /** 生效命名规则（含项目级覆盖） */
  resolveRule(): Promise<ResolvedNamingRule>;
  /** 项目符号表（前端 / 后端 / 数据库），供冲突检测 */
  symbolTable(): Promise<SymbolTable>;
  /** 可重命名对象清单 */
  listTargets(): Promise<readonly RenameTarget[]>;

  /** 合法性校验（保留字 / 冲突 / 超长 / 非法字符）+ 3 个建议名 */
  check(input: { registryId: string; newName: string }): Promise<ConflictCheckResult>;
  /** 影响面分析（三级分组，warn 默认不勾选） */
  analyze(input: { registryId: string; newName: string }): Promise<ImpactReport>;
  /** 四栏 diff（由影响面 + 勾选构建） */
  buildDiff(input: {
    registryId: string;
    newName: string;
    selection?: readonly string[] | undefined;
    showRevisionMarks?: boolean | undefined;
  }): Promise<UnifiedDiff>;

  /** 事务化执行（AST 重构 → 文档 → 记忆 → 逻辑结构 → 注册表与锚点） */
  execute(input: {
    registryId: string;
    newName: string;
    selection: readonly string[];
    aliasKinds?: readonly AliasKind[] | undefined;
    showRevisionMarks?: boolean | undefined;
  }): Promise<RenameTransactionResult>;
  /** 一键撤销 */
  undo(input: { eventId: string }): Promise<UndoResult>;
  /** 重命名历史（时间倒序） */
  history(): Promise<readonly RenameHistoryEntry[]>;

  /** 数据库迁移：AI 生成脚本 + 预览（D-08：默认只生成不执行） */
  planMigration(input: MigrationPlanRequest): Promise<MigrationPreview | MigrationPlanError>;
  /** 数据库迁移：确认后一键执行 */
  runMigration(input: {
    migrationId: string;
    confirmed: boolean;
    secondConfirmed?: boolean | undefined;
  }): Promise<MigrationExecutionResult>;
  /** 订阅迁移执行日志（返回退订函数；外壳不支持时返回 noop） */
  subscribeMigrationLog(listener: (line: MigrationLogLine) => void): () => void;

  /** 别名"待清理"清单 */
  pendingCleanup(): Promise<readonly PendingCleanupItem[]>;
  /** 一键清理别名 */
  cleanAliases(input: {
    items: readonly { registryId: string; kind: AliasKind; name: string }[];
  }): Promise<number>;

  /** 批量重命名 / 一键全项目命名规范化（含 diff 预览与事务回滚） */
  planBatch(input: BatchPlanRequest): Promise<BatchPlan>;
  /** 批量执行 */
  runBatch(input: {
    batchId: string;
    selection?: Readonly<Record<string, readonly string[]>> | undefined;
  }): Promise<BatchRenameResult>;
}

/** 未装配外壳时的降级实现（UI 展示引导页而不是崩溃） */
export function createUnavailableRenameApi(reason: string): RenameApi {
  const fail = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    ready: false,
    reason,
    projectContext: fail,
    resolveRule: fail,
    symbolTable: fail,
    listTargets: fail,
    check: fail,
    analyze: fail,
    buildDiff: fail,
    execute: fail,
    undo: fail,
    history: fail,
    planMigration: fail,
    runMigration: fail,
    subscribeMigrationLog: () => () => undefined,
    pendingCleanup: fail,
    cleanAliases: fail,
    planBatch: fail,
    runBatch: fail,
  };
}

/** 读取外壳注入的实现 */
export function readInjectedRenameApi(): RenameApi | null {
  const scope = globalThis as Record<string, unknown>;
  const injected = scope[RENAME_API_GLOBAL_KEY];
  if (injected === undefined || injected === null) return null;
  return injected as RenameApi;
}

const RenameApiContext = createContext<RenameApi | null>(null);

export interface RenameApiProviderProps {
  api?: RenameApi | undefined;
  children: ReactNode;
}

export function RenameApiProvider({ api, children }: RenameApiProviderProps): JSX.Element {
  const value = useMemo<RenameApi>(() => {
    if (api !== undefined) return api;
    return (
      readInjectedRenameApi() ??
      createUnavailableRenameApi('未检测到重命名服务：请在桌面端外壳中打开本项目（渲染层需安装 __EC_RENAME__ 端口）')
    );
  }, [api]);
  return <RenameApiContext.Provider value={value}>{children}</RenameApiContext.Provider>;
}

/** 读取端口；未注入时返回降级实现（不抛错，便于页面统一展示引导） */
export function useRenameApi(): RenameApi {
  return useContext(RenameApiContext) ?? createUnavailableRenameApi('重命名面板必须在 RenameApiProvider 内使用');
}

export function useRenameApiOptional(): RenameApi | null {
  return useContext(RenameApiContext);
}

/**
 * 异步数据读取 hook：统一 loading / error / reload 语义。
 *
 * 依赖用 `depsKey`（字符串指纹）而不是对象引用——调用方常在渲染期新建请求对象，
 * 依赖对象本身会形成「渲染 → 组装 → setState → 再组装」死循环（Wave 4 已踩过）。
 */
export function useRenameResource<T>(
  loader: (api: RenameApi) => Promise<T>,
  depsKey: string,
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const api = useRenameApi();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;
    if (api.ready === false) {
      setData(null);
      setLoading(false);
      setError(api.reason ?? '重命名服务不可用');
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setError(null);
    void loaderRef
      .current(api)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // depsKey 是调用方给出的数据指纹（字符串），nonce 用于手动 reload
  }, [api, depsKey, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { data, loading, error, reload };
}
