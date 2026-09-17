import { z } from 'zod';

import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from './update/update-policy';

/**
 * 设置 schema（zod 单一数据源）。
 *
 * - 全局设置 + 项目级设置两层，项目级覆盖全局
 * - 带版本号与迁移函数，旧版本配置自动升级而非丢弃
 * - 非法值一律被 zod 拦截，不允许脏配置进入运行时
 */

export const SETTINGS_VERSION = 1;

export const languageSchema = z.enum(['zh-CN', 'en-US']);
export const themeSchema = z.enum(['light', 'dark', 'system']);
/** AI 写入策略三档 */
export const writePolicySchema = z.enum(['auto', 'confirm', 'manual']);
export const commitConventionSchema = z.enum(['conventional', 'none']);

export const aiSettingsSchema = z.object({
  /** 默认 Provider id，空串表示未配置 */
  defaultProviderId: z.string().default(''),
  /** 记忆写入策略：自动 / 写入前确认 / 仅手动 */
  memoryWritePolicy: writePolicySchema.default('confirm'),
  /** 代码写入策略 */
  codeWritePolicy: writePolicySchema.default('confirm'),
  /** 请求超时（毫秒） */
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  /** 是否允许上报 AI 请求内容（默认 false） */
  allowContentUpload: z.boolean().default(false),
});

export const gitSettingsSchema = z.object({
  commitConvention: commitConventionSchema.default('conventional'),
  autoCommitOnGenerate: z.boolean().default(false),
  authorName: z.string().default(''),
  authorEmail: z.string().default(''),
});

export const privacySettingsSchema = z.object({
  /** 遥测默认关闭，需显式授权（NFR-S-03） */
  telemetryEnabled: z.boolean().default(false),
  crashReportEnabled: z.boolean().default(true),
});

/**
 * 编辑器偏好（FR-SET-01：字体与编辑器偏好，即时生效）。
 * 代码视图只读（D-04），这里的偏好作用于**只读视图的呈现**（字号 / 换行 / 等宽字体）。
 */
export const editorSettingsSchema = z.object({
  /** 等宽字体族，空串表示使用默认 */
  fontFamily: z.string().default(''),
  fontSize: z.number().int().min(10).max(32).default(14),
  /** 长行自动换行 */
  wordWrap: z.boolean().default(true),
  /** 显示行号 */
  lineNumbers: z.boolean().default(true),
  /** 保存时自动格式化（交给 AI 通道执行，非手动编辑） */
  formatOnSave: z.boolean().default(false),
});

/**
 * 自动更新偏好（FR-SET-05）。
 *
 * 用 `z.ZodType<UpdateSettings, …>` 标注：schema 的**输出**必须与领域层的
 * `UpdateSettings` 完全一致，两边漂移会直接编译不过（而不是运行期静默丢字段）。
 */
export const updateSettingsSchema: z.ZodType<UpdateSettings, z.ZodTypeDef, unknown> = z.object({
  autoCheck: z.boolean().default(DEFAULT_UPDATE_SETTINGS.autoCheck),
  checkIntervalMs: z
    .number()
    .int()
    .min(60 * 60 * 1000)
    .max(30 * 24 * 60 * 60 * 1000)
    .default(DEFAULT_UPDATE_SETTINGS.checkIntervalMs),
  channel: z.enum(['stable', 'beta']).default(DEFAULT_UPDATE_SETTINGS.channel),
  autoDownload: z.boolean().default(DEFAULT_UPDATE_SETTINGS.autoDownload),
  allowDeferred: z.boolean().default(DEFAULT_UPDATE_SETTINGS.allowDeferred),
});

export const globalSettingsSchema = z.object({
  language: languageSchema.default('zh-CN'),
  theme: themeSchema.default('light'),
  /** 本地数据目录（FR-SET-03） */
  dataDir: z.string().default(''),
  /** 工作区根目录 */
  workspaceRoot: z.string().default(''),
  ai: aiSettingsSchema.default(() => aiSettingsSchema.parse({})),
  git: gitSettingsSchema.default(() => gitSettingsSchema.parse({})),
  privacy: privacySettingsSchema.default(() => privacySettingsSchema.parse({})),
  editor: editorSettingsSchema.default(() => editorSettingsSchema.parse({})),
  update: updateSettingsSchema.default(() => ({ ...DEFAULT_UPDATE_SETTINGS })),
  /** 命令 id -> 快捷键（如 'app.save': 'Ctrl+S'） */
  keymap: z.record(z.string()).default({}),
});

export const projectSettingsSchema = z.object({
  /** 未设置时继承全局策略 */
  memoryWritePolicy: writePolicySchema.nullable().default(null),
  codeWritePolicy: writePolicySchema.nullable().default(null),
  /** 命名规则 id（M15） */
  namingRuleId: z.string().default('default'),
  /** 目标端（七端矩阵），为空表示未选择 */
  targetPlatforms: z.array(z.string()).default([]),
  /** 默认技术栈标签，供 S3 生成参考 */
  techStack: z.record(z.string()).default({}),
});

export const settingsSchema = z.object({
  version: z.number().int().default(SETTINGS_VERSION),
  global: globalSettingsSchema,
  /** projectId -> 项目级设置 */
  projects: z.record(projectSettingsSchema).default({}),
});

export type GlobalSettings = z.infer<typeof globalSettingsSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type WritePolicy = z.infer<typeof writePolicySchema>;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = globalSettingsSchema.parse({});
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = projectSettingsSchema.parse({});

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({
  version: SETTINGS_VERSION,
  global: DEFAULT_GLOBAL_SETTINGS,
  projects: {},
});

/**
 * 配置迁移：把任意历史版本 JSON 升级到当前版本。
 * 策略：逐段深合并默认值后再用 zod 收口，未知键被剥掉、缺失键补默认，
 * 保证旧配置不丢、坏配置不炸（v0 扁平配置 / 缺段配置都能安全升级）。
 */
export function migrateSettings(raw: unknown): Settings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const rawGlobal = (input['global'] ?? {}) as Record<string, unknown>;
  const rawProjects = (input['projects'] ?? {}) as Record<string, Record<string, unknown>>;

  const defaults = DEFAULT_GLOBAL_SETTINGS;
  const global = globalSettingsSchema.parse({
    ...defaults,
    ...rawGlobal,
    ai: { ...defaults.ai, ...((rawGlobal['ai'] ?? {}) as object) },
    git: { ...defaults.git, ...((rawGlobal['git'] ?? {}) as object) },
    privacy: { ...defaults.privacy, ...((rawGlobal['privacy'] ?? {}) as object) },
    editor: { ...defaults.editor, ...((rawGlobal['editor'] ?? {}) as object) },
    update: { ...defaults.update, ...((rawGlobal['update'] ?? {}) as object) },
    keymap: (rawGlobal['keymap'] ?? defaults.keymap) as Record<string, string>,
  });

  const projects: Record<string, ProjectSettings> = {};
  for (const [projectId, value] of Object.entries(rawProjects)) {
    if (value === null || typeof value !== 'object') continue;
    projects[projectId] = projectSettingsSchema.parse(value);
  }

  return settingsSchema.parse({ version: SETTINGS_VERSION, global, projects });
}
