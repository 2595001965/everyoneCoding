/**
 * V2 公共契约 —— 接口端点与调用关系（V2-T01；PRD §6、V2-API-*、§11.1）。
 *
 * 现状（T01 核验）：仓库没有真实 HTTP 接口索引——现状是页面 DSL 上的
 * `apiDeps: string[]` 生成期字符串 + 预览域按 OpenAPI 围栏做 Mock 匹配。
 * 本契约为 T09 建立真实索引的目标结构：
 *
 * - 稳定身份：`endpointId`（ULID）跨重扫保持；路由身份另存
 *   `serviceId + method + normalizedPath`（路径修改不抹历史，PRD §6.3）
 * - 多服务同路径不合并：路由身份含 serviceId（V2-API-01）
 * - 路径参数统一 `:id` → `{id}`（V2-API-02）；动态/无法解析的表达式不猜，标待确认
 * - 创建时间三分来源：tool_event（工具内新建，可靠）/ git_inferred（Git 历史推断）/
 *   unknown（未知，置 firstSeenAt 排序）；文件 mtime **不是**合法来源（枚举层排除）
 */
import { z } from 'zod';
import { epochMsSchema, opaqueIdSchema, revisionSchema, ulidSchema } from './primitives';
import { sourceRefSchema } from './element-anchor';

export const httpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

/**
 * 规范化路径模板：
 * - Express/Koa 风格 `:param` → `{param}`；保留 OpenAPI 原生 `{param}`
 * - 去除查询串；折叠重复斜杠；去尾斜杠（根路径除外）
 * - 无法静态解析的段原样保留，由调用方标 pending_confirmation（本函数不猜）
 */
export function normalizePathTemplate(rawPath: string): string {
  const withoutQuery = rawPath.split('?')[0] ?? rawPath;
  const collapsed = withoutQuery.replace(/\/{2,}/g, '/');
  const segments = collapsed.split('/');
  const normalized = segments.map((seg) =>
    seg.startsWith(':') && seg.length > 1 ? `{${seg.slice(1)}}` : seg,
  );
  let joined = normalized.join('/');
  if (joined.length > 1 && joined.endsWith('/')) joined = joined.slice(0, -1);
  return joined === '' ? '/' : joined;
}

/** 路由身份：同一项目内据此判重（多服务同路径 → 不同身份） */
export interface ApiRouteIdentity {
  serviceId: string;
  method: HttpMethod;
  normalizedPath: string;
}

export const apiRouteIdentitySchema = z.object({
  serviceId: opaqueIdSchema,
  method: httpMethodSchema,
  normalizedPath: z.string().startsWith('/'),
});

/** 路由身份键：`{serviceId}#{METHOD} {path}`（仅用于索引/比对，不替代 endpointId） */
export function apiRouteKeyOf(identity: ApiRouteIdentity): string {
  return `${identity.serviceId}#${identity.method} ${identity.normalizedPath}`;
}

export const createdAtSourceSchema = z.enum(['tool_event', 'git_inferred', 'unknown']);
export type CreatedAtSource = z.infer<typeof createdAtSourceSchema>;

export const apiEndpointStatusSchema = z.enum(['active', 'removed', 'pending_confirmation']);

/**
 * HTTP 接口端点（后端对外路由）。实现链路节点（Service 方法等）不是端点，
 * 由 T09 以 sourceRef/关系表达；第三方请求不属于本实体。
 * 存储目标位置：本地新表 `api_endpoint`（T09 迁移追加，**拟新增**）。
 */
export interface ApiEndpoint {
  endpointId: string;
  projectId: string;
  serviceId: string;
  method: HttpMethod;
  /** 源码/契约中的原始路径（未规范化） */
  rawPath: string;
  normalizedPath: string;
  /** 首次识别证据；后续扫描可补充，由关系表承载多证据 */
  contractSource: z.infer<typeof contractSourceSchema> | null;
  sourceRef: z.infer<typeof sourceRefSchema> | null;
  featureIds: string[];
  /** 可靠创建时间；unknown 来源时必须为 null（PRD §6.3：未知≠编造） */
  createdAt: number | null;
  createdAtSource: CreatedAtSource;
  /** 首次被本工具发现的时间（未知创建时间的接口以此稳定排序） */
  firstSeenAt: number;
  updatedAt: number;
  revision: number;
  status: z.infer<typeof apiEndpointStatusSchema>;
}

export const contractSourceSchema = z.enum([
  'openapi',
  'router_decl',
  'runtime_observed',
  'user_defined',
]);

export const apiEndpointSchema = z
  .object({
    endpointId: ulidSchema,
    projectId: ulidSchema,
    serviceId: opaqueIdSchema,
    method: httpMethodSchema,
    rawPath: z.string().min(1),
    normalizedPath: z.string().startsWith('/'),
    contractSource: contractSourceSchema.nullable(),
    sourceRef: sourceRefSchema.nullable(),
    featureIds: z.array(ulidSchema),
    createdAt: epochMsSchema.nullable(),
    createdAtSource: createdAtSourceSchema,
    firstSeenAt: epochMsSchema,
    updatedAt: epochMsSchema,
    revision: revisionSchema,
    status: apiEndpointStatusSchema,
  })
  .refine(
    (v) => !(v.createdAtSource === 'tool_event' && v.createdAt === null),
    'tool_event 来源必须带可靠 createdAt',
  )
  .refine(
    (v) => !(v.createdAtSource === 'unknown' && v.createdAt !== null),
    'unknown 来源不得携带 createdAt（混用时间会伪造证据）',
  )
  .refine(
    (v) => !(v.createdAt !== null && v.createdAt > v.firstSeenAt),
    'createdAt 不得晚于 firstSeenAt',
  );

/** 前端调用点 / 页面元素 / 契约操作与端点的关系（一个端点可有多个调用点，也可未被调用） */
export interface ApiRelation {
  relationId: string;
  endpointId: string;
  callerKind: z.infer<typeof callerKindSchema>;
  /** elementId / 源码位置引用 / OpenAPI operationId 等（callerKind 决定语义） */
  callerRef: string | null;
  evidenceKind: z.infer<typeof evidenceKindSchema>;
  /** 0..1；null = 未量化（不猜测为满分或零分） */
  confidence: number | null;
  confirmedByUser: boolean;
  updatedAt: number;
  revision: number;
}

export const callerKindSchema = z.enum(['element', 'source_call', 'contract', 'runtime']);
export const evidenceKindSchema = z.enum([
  'explicit_call',
  'contract_operation',
  'runtime_observed',
  'inferred',
]);

export const apiRelationSchema = z
  .object({
    relationId: ulidSchema,
    endpointId: ulidSchema,
    callerKind: callerKindSchema,
    callerRef: z.string().min(1).nullable(),
    evidenceKind: evidenceKindSchema,
    confidence: z.number().min(0).max(1).nullable(),
    confirmedByUser: z.boolean(),
    updatedAt: epochMsSchema,
    revision: revisionSchema,
  })
  .refine(
    (v) => !(v.evidenceKind === 'inferred' && v.confirmedByUser === false && v.confidence === null),
    '未经用户确认且未量化的推断关系必须给出 confidence，否则降级为待确认',
  );
