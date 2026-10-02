/**
 * V2 公共契约 —— Agent 会话/任务/变更集/写租约（V2-T01；PRD §10、V2-AGT-*、§11.1）。
 *
 * 现状（T01 核验）：AI 生成会话态（AbortController/续写前缀）全内存、无会话实体、
 * 无多窗口；写入管线只有进程内 before 比对，无基线/租约/变更集。
 * 本契约为 T12（持久化会话协调器）与 T13（工作副本与安全合入）定义目标结构：
 *
 * - 窗口是视图，Session 是对话，Task 是目标，Run/Attempt 是执行与计费
 * - 同一数据域只有一个写协调器；租约带 fencing token，过期 owner 不得继续写
 * - ChangeSet 命名为 `WriteChangeSet`：`ChangeSet` 已被 @ec/registry 重命名域占用
 *   （packages/registry/src/rename-event.ts），跨包同名会撞 import
 */
import { z } from 'zod';
import {
  epochMsSchema,
  opaqueIdSchema,
  revisionSchema,
  sourceRevisionNullableSchema,
  ulidSchema,
  type SourceRevision,
} from './primitives';
import { moneyAmountSchema, type MoneyAmount } from './money';

/* ------------------------------ 预算 ------------------------------ */

export const budgetScopeSchema = z.enum(['session', 'task', 'day', 'month']);

/** 预算规格（V2-BILL-08）：limitMicros 为 null 表示未设上限（不等于 0 预算） */
export interface BudgetSpec {
  scope: z.infer<typeof budgetScopeSchema>;
  limit: MoneyAmount;
  /** 软阈值告警比例 0..1（默认 0.8 由实现层定，契约只约束范围） */
  alertRatio: number;
}

export const budgetSpecSchema = z.object({
  scope: budgetScopeSchema,
  limit: moneyAmountSchema,
  alertRatio: z.number().min(0).max(1),
});

/* ---------------------------- 上下文快照 ---------------------------- */

/** 下一请求上下文估算快照（V2-USG-05）；"已发送实测"与"下一请求估算"不得混存 */
export interface ContextSnapshot {
  computedAt: number | null;
  /** 估算的下一请求有效输入 token；null = 未知 */
  estimatedNextInputTokens: number | null;
  /** 该路由有效窗口；null = 未知（不得用硬编码 128k 顶替） */
  routeWindowTokens: number | null;
  /** 预留最大输出 */
  reservedOutputTokens: number | null;
}

export const contextSnapshotSchema = z.object({
  computedAt: epochMsSchema.nullable(),
  estimatedNextInputTokens: z.number().int().nonnegative().nullable(),
  routeWindowTokens: z.number().int().positive().nullable(),
  reservedOutputTokens: z.number().int().nonnegative().nullable(),
});

/* ---------------------------- 会话与任务 ---------------------------- */

export const sessionStatusSchema = z.enum(['active', 'paused', 'closed']);
export const taskStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_confirmation',
  'validating',
  'ready_to_merge',
  'merged',
  'completed',
  'failed',
  'cancelled',
  'conflicted',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * Agent 会话（对话与上下文）。多窗口观看同一 Session 只产生一个运行实例。
 * 存储目标位置：本地新表（T12 迁移追加，**拟新增**；现状无会话实体）。
 */
export interface AgentSession {
  sessionId: string;
  projectId: string | null;
  title: string | null;
  /** 当前默认路由（providerModelKey）；未选模型为 null */
  route: string | null;
  contextState: ContextSnapshot | null;
  /** 会话级预算；null = 未设置 */
  budget: z.infer<typeof budgetSpecSchema> | null;
  status: z.infer<typeof sessionStatusSchema>;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export const agentSessionSchema = z.object({
  sessionId: ulidSchema,
  projectId: ulidSchema.nullable(),
  title: z.string().min(1).nullable(),
  route: z
    .string()
    .regex(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}\/[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/)
    .nullable(),
  contextState: contextSnapshotSchema.nullable(),
  budget: budgetSpecSchema.nullable(),
  status: sessionStatusSchema,
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
  revision: revisionSchema,
});

/**
 * Agent 任务（一次工作目标）。readSet/writeSet 是授权边界：AI 写入只允许
 * 落在 writeSet 内（V2-API-11：过期索引定位不是写入授权）。
 */
export interface AgentTask {
  taskId: string;
  sessionId: string | null;
  projectId: string;
  objective: string;
  status: TaskStatus;
  /** 工作副本（Git worktree 或隔离副本，T13）；未创建时为 null */
  worktreeId: string | null;
  /** 任务启动时的源码基线（合入前重验） */
  baseRevision: SourceRevision | null;
  readSet: string[];
  writeSet: string[];
  budget: z.infer<typeof budgetSpecSchema> | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export const agentTaskSchema = z
  .object({
    taskId: ulidSchema,
    sessionId: opaqueIdSchema.nullable(),
    projectId: ulidSchema,
    objective: z.string().min(1),
    status: taskStatusSchema,
    worktreeId: opaqueIdSchema.nullable(),
    baseRevision: sourceRevisionNullableSchema,
    readSet: z.array(z.string().min(1)),
    writeSet: z.array(z.string().min(1)),
    budget: budgetSpecSchema.nullable(),
    createdAt: epochMsSchema,
    updatedAt: epochMsSchema,
    revision: revisionSchema,
  })
  .refine(
    (v) => !(v.status === 'running' && v.worktreeId === null && v.writeSet.length > 0),
    '运行中任务携带写集时必须有工作副本（不允许直接写共享目录）',
  );

/* ------------------------- 变更集与写租约 ------------------------- */

export const changeSetStatusSchema = z.enum([
  'draft',
  'awaiting_confirmation',
  'confirmed',
  'applied',
  'rejected',
  'superseded',
]);

export interface WriteChangeSetEntry {
  path: string;
  op: z.infer<typeof changeSetOpSchema>;
  /** 应用前内容哈希（冲突检测基线）；新建文件为 null */
  beforeHash: string | null;
  afterHash: string | null;
}

export const changeSetOpSchema = z.enum(['create', 'patch', 'delete']);

/**
 * 统一写入变更集（生成/重命名/接口修改共用的写入口契约，V2-API-11、T13）。
 * 命名为 WriteChangeSet：`ChangeSet` 已被 @ec/registry 占用（rename-event.ts）。
 */
export interface WriteChangeSet {
  changeSetId: string;
  taskId: string | null;
  projectId: string;
  baseRevision: SourceRevision | null;
  entries: WriteChangeSetEntry[];
  status: z.infer<typeof changeSetStatusSchema>;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export const writeChangeSetSchema = z.object({
  changeSetId: ulidSchema,
  taskId: opaqueIdSchema.nullable(),
  projectId: ulidSchema,
  baseRevision: sourceRevisionNullableSchema,
  entries: z.array(
    z.object({
      path: z
        .string()
        .min(1)
        .refine((v) => !v.includes('\\') && !/^[A-Za-z]:/.test(v), '必须是 POSIX 相对路径'),
      op: changeSetOpSchema,
      beforeHash: z.string().min(1).nullable(),
      afterHash: z.string().min(1).nullable(),
    }),
  ),
  status: changeSetStatusSchema,
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
  revision: revisionSchema,
});

/** 写租约：绑定数据域 + owner + 过期时间 + fencing token（V2-AGT-02/10.3） */
export interface WriteLease {
  leaseId: string;
  /** 数据域（workspace/data-profile 标识；跨进程锁的键） */
  dataDomain: string;
  owner: string;
  /** 单调递增的围栏令牌；存储层拒绝 token 小于当前值的写入 */
  fencingToken: number;
  acquiredAt: number;
  expiryAt: number;
}

export const writeLeaseSchema = z
  .object({
    leaseId: ulidSchema,
    dataDomain: opaqueIdSchema,
    owner: opaqueIdSchema,
    fencingToken: z.number().int().nonnegative(),
    acquiredAt: epochMsSchema,
    expiryAt: epochMsSchema,
  })
  .refine((v) => v.expiryAt > v.acquiredAt, 'expiryAt 必须晚于 acquiredAt');

/** 围栏校验：presented 小于已发放的最新 token 即过期 owner（不得继续写） */
export function assertFencingToken(latestIssued: number, presented: number): 'ok' | 'stale' {
  return presented >= latestIssued ? 'ok' : 'stale';
}
