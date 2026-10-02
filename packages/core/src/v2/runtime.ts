/**
 * V2 公共契约 —— 运行实例（V2-T01；PRD §11.1 RuntimeInstance、V2-SRC-06/07）。
 *
 * 现状（T01 核验）：预览域按 `projectId` 键控单实例（`Map<projectId, PreviewInstance>`），
 * 状态纯内存、无 runtimeId 概念。本契约为 T06（真实前后端托管）引入运行实例身份：
 * 同一项目可有多个运行实例（不同工作副本/任务），端口/代理映射按实例记录。
 */
import { z } from 'zod';
import { epochMsSchema, opaqueIdSchema, revisionSchema, ulidSchema } from './primitives';

export const runtimeServiceKindSchema = z.enum(['frontend', 'backend']);
export type RuntimeServiceKind = z.infer<typeof runtimeServiceKindSchema>;

export const runtimeStatusSchema = z.enum([
  'preparing',
  'starting',
  'ready',
  'degraded',
  'stopping',
  'stopped',
  'failed',
]);
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

/** 实例内一个受管服务的端口/地址映射（端口冲突重分配后必须同步代理基址，V2-SRC-07） */
export interface RuntimeServiceEndpoint {
  serviceId: string;
  kind: RuntimeServiceKind;
  /** null = 尚未监听或未探测到 */
  port: number | null;
  /** 预览访问基址（如 http://127.0.0.1:5173） */
  baseUrl: string | null;
  /** 健康检查路径（就绪判定依据之一，不是仅看"启动成功"日志） */
  healthPath: string | null;
}

export const runtimeServiceEndpointSchema = z.object({
  serviceId: opaqueIdSchema,
  kind: runtimeServiceKindSchema,
  port: z.number().int().gte(0).lte(65535).nullable(),
  baseUrl: z.string().url().nullable(),
  healthPath: z
    .string()
    .regex(/^\/.*$/, '健康路径必须是 / 开头的路径')
    .nullable(),
});

/**
 * 一次受管运行（前端/后端进程编排单元）。
 * 键控迁移方向：preview-domain 由 projectId 单例改为 runtimeId 多实例（T06）。
 */
export interface RuntimeInstance {
  runtimeId: string;
  projectId: string;
  /** 归属任务（多窗口 Agent 隔离运行时）；非任务运行为 null */
  taskId: string | null;
  /** 所属工作副本（T13）；直接运行主目录时为 null */
  worktreeId: string | null;
  /** 运行 cwd（授权根目录内的实际工作目录） */
  cwd: string;
  services: RuntimeServiceEndpoint[];
  status: RuntimeStatus;
  /** 写协调器 owner（T12）；单机直运行为 null */
  owner: string | null;
  startedAt: number | null;
  updatedAt: number;
  revision: number;
}

export const runtimeInstanceSchema = z
  .object({
    runtimeId: ulidSchema,
    projectId: ulidSchema,
    taskId: opaqueIdSchema.nullable(),
    worktreeId: opaqueIdSchema.nullable(),
    cwd: z.string().min(1),
    services: z.array(runtimeServiceEndpointSchema),
    status: runtimeStatusSchema,
    owner: opaqueIdSchema.nullable(),
    startedAt: epochMsSchema.nullable(),
    updatedAt: epochMsSchema,
    revision: revisionSchema,
  })
  .refine(
    (v) => !(v.status === 'ready' && v.services.length === 0),
    'ready 实例至少要有一个受管服务（就绪判定基于服务健康，不是空壳）',
  )
  .refine((v) => !(v.status === 'ready' && v.startedAt === null), 'ready 实例必须有 startedAt');
