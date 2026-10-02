/**
 * V2 公共契约 —— 源码接入与工程识别（V2-T01；PRD §4、V2-SRC-03/04、§11.1）。
 *
 * 现状（T01 核验）：
 * - 项目来源只有 blank/template/git_import/doc_import 四类；**没有**本地文件夹与 ZIP
 * - `ProjectProfile` 在 core/git-import（导入画像）与 preview/project-detector
 *   （运行画像）是两个同名异义类型——本契约统一为 SourceDetection，旧名不动，
 *   由 T05 消歧
 * - 本契约的 `v2SourceKind` 与现有 `ProjectSourceKind`（V1 四类）是并列集合：
 *   V1 值继续用于旧项目行；V2 导入走 v2SourceKind（T04 落库时映射存储）
 *
 * 安全约束固化在 schema 层：RunPlan 只携带环境变量**名称**，
 * 值必须留在本地受保护配置（strict 模式拒绝多余字段，防密钥混入契约）。
 */
import { z } from 'zod';
import {
  epochMsSchema,
  opaqueIdSchema,
  revisionSchema,
  sourceRevisionNullableSchema,
  ulidSchema,
} from './primitives';

/** V2 源码接入方式（PRD V2-SRC-01：打开文件夹为默认，另保留复制/克隆/ZIP） */
export const v2SourceKindSchema = z.enum([
  /** 直接关联用户选定的原目录（默认；不复制不转换） */
  'existing_folder',
  /** 复制到新目录后的副本 */
  'copied_folder',
  /** Git 克隆到用户选定新目录 */
  'git_clone',
  /** ZIP 解压到新目录 */
  'zip_extract',
]);
export type V2SourceKind = z.infer<typeof v2SourceKindSchema>;

/**
 * 项目源码接入记录（本地实体；路径与凭据不上传平台，PRD §11.1）。
 * 存储目标位置：扩展现有 project 表或新表 project_source（T04 迁移，**拟新增**）。
 */
export interface ProjectSource {
  projectId: string;
  sourceKind: V2SourceKind;
  /** 授权根目录（路径防护边界；仅本地持有） */
  authorizedRootPath: string;
  /** 原始来源（clone URL / ZIP 原件路径 / 复制源目录）；existing_folder 时等于授权根 */
  originPath: string | null;
  git: { branch: string | null; commit: string | null } | null;
  /** 接入时的源码修订（增量索引基线，V2-SRC-09） */
  sourceRevision: z.infer<typeof sourceRevisionNullableSchema>;
  createdAt: number;
  updatedAt: number;
}

export const projectSourceSchema = z.object({
  projectId: ulidSchema,
  sourceKind: v2SourceKindSchema,
  authorizedRootPath: z.string().min(1),
  originPath: z.string().min(1).nullable(),
  git: z
    .object({ branch: z.string().min(1).nullable(), commit: z.string().min(1).nullable() })
    .nullable(),
  sourceRevision: sourceRevisionNullableSchema,
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});

/** 识别证据（可追溯：证据不足不得宣称支持，V2-SRC-03） */
export const detectionEvidenceKindSchema = z.enum([
  'config_file',
  'lock_file',
  'directory_layout',
  'script_field',
  'user_input',
]);
export type DetectionEvidenceKind = z.infer<typeof detectionEvidenceKindSchema>;

export interface DetectionEvidence {
  kind: DetectionEvidenceKind;
  /** 项目内相对路径（user_input 证据可为描述性文本） */
  path: string;
  detail: string | null;
}

export const detectionEvidenceSchema = z.object({
  kind: detectionEvidenceKindSchema,
  path: z.string().min(1),
  detail: z.string().min(1).nullable(),
});

export const supportLevelSchema = z.enum(['supported', 'partial', 'unsupported', 'unknown']);
export type SupportLevel = z.infer<typeof supportLevelSchema>;

/** 运行计划（PRD V2-SRC-04）。env 只允许**变量名**——strict 拒绝夹带值/密钥 */
export interface RunPlan {
  cwd: string;
  services: Array<{
    serviceId: string;
    role: 'install' | 'frontend' | 'backend';
    command: string;
    args: string[];
    portHint: number | null;
  }>;
  /** 按启动顺序排列的 serviceId（install 先于服务） */
  startupOrder: string[];
  envVarNames: string[];
}

export const runPlanSchema = z
  .object({
    cwd: z.string().min(1),
    services: z.array(
      z.object({
        serviceId: opaqueIdSchema,
        role: z.enum(['install', 'frontend', 'backend']),
        command: z.string().min(1),
        args: z.array(z.string()),
        portHint: z.number().int().gte(0).lte(65535).nullable(),
      }),
    ),
    startupOrder: z.array(z.string().min(1)),
    envVarNames: z.array(z.string().min(1)),
  })
  .strict()
  .refine(
    (v) => new Set(v.startupOrder).size === v.startupOrder.length,
    'startupOrder 不得含重复 serviceId',
  );

/** 单个子工程的识别结论 */
export interface SubProjectDetection {
  subProjectId: string;
  role: z.infer<typeof subProjectRoleSchema>;
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  /** 候选入口（目录相对路径；多应用必须让用户选，V2-SRC-03） */
  entryHints: string[];
  supportLevel: z.infer<typeof supportLevelSchema>;
  /** 0..1；null = 未量化置信度 */
  confidence: number | null;
  evidence: z.infer<typeof detectionEvidenceSchema>[];
  suggestedRunPlan: z.infer<typeof runPlanSchema> | null;
}

export const subProjectRoleSchema = z.enum([
  'frontend',
  'backend',
  'fullstack',
  'library',
  'unknown',
]);

export const subProjectDetectionSchema = z.object({
  subProjectId: opaqueIdSchema,
  role: subProjectRoleSchema,
  language: z.string().min(1).nullable(),
  framework: z.string().min(1).nullable(),
  packageManager: z.string().min(1).nullable(),
  entryHints: z.array(z.string().min(1)),
  supportLevel: supportLevelSchema,
  confidence: z.number().min(0).max(1).nullable(),
  evidence: z.array(detectionEvidenceSchema),
  suggestedRunPlan: runPlanSchema.nullable(),
});

/**
 * 一次静态识别结果（可重建的派生数据，源码才是事实来源，PRD §2.3.1）。
 * 单仓多应用：subProjects 多于一个可运行前端/后端时 UI 必须让用户选择。
 */
export interface SourceDetection {
  detectionId: string;
  projectId: string;
  /** 扫描器版本（识别口径演进后旧结果可判过期） */
  scannerVersion: string;
  scannedAt: number;
  subProjects: z.infer<typeof subProjectDetectionSchema>[];
  /** 信任确认门槛（首次安装/运行前必须用户确认，V2-SRC-05） */
  requiresConfirmation: boolean;
  notes: string[] | null;
  revision: number;
}

export const sourceDetectionSchema = z.object({
  detectionId: ulidSchema,
  projectId: ulidSchema,
  scannerVersion: z.string().min(1),
  scannedAt: epochMsSchema,
  subProjects: z.array(subProjectDetectionSchema),
  requiresConfirmation: z.boolean(),
  notes: z.array(z.string().min(1)).nullable(),
  revision: revisionSchema,
});
