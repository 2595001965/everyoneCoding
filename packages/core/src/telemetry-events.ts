/**
 * 关键路径埋点事件目录（T10-01 / NFR-M-02 / NFR-S-03）。
 *
 * 设计约束：
 * - **payload 只含事件名、维度 id、耗时与结果状态**——严禁包含任何用户内容、
 *   代码、记忆正文、提示词或文档文本（`assertEventPayloadSafe` 白名单断言兜底）。
 * - 事件名与维度字段在此集中声明，调用方不得自造字段；新增关键路径时
 *   在 `KEY_EVENTS` 补登记，覆盖率统计（`KEY_EVENT_NAMES`）才会认账。
 */

/** 允许出现在 payload 里的维度字段白名单（大小写不敏感匹配键名） */
export const PAYLOAD_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  'name',
  'result', // 'success' | 'failure' | 'cancelled' | 'skipped'
  'durationms', // 耗时（毫秒）
  'errorkind', // 错误类别（枚举名，非错误文本）
  // —— 维度 id（均为内部 ULID / 枚举值，不含业务文本）——
  'projectid',
  'stage', // 流水线阶段枚举：S1..S7
  'platform', // 目标端枚举：web/android/...
  'providerid',
  'modelid',
  'purpose', // AI 用途枚举
  'templateid',
  'sourcekind', // 项目来源枚举
  'count', // 条目计数（如冲突条数）
  'bytes', // 体积（字节）
  'version', // 版本号字符串（不含正文）
  'locale', // 界面语言
]);

/** 单条埋点事件的固定形状（结构上不允许任意键） */
export interface TelemetryEventPayload {
  name: string;
  result: 'success' | 'failure' | 'cancelled' | 'skipped';
  durationMs?: number | undefined;
  errorKind?: string | undefined;
  dims?: Record<string, string | number | boolean> | undefined;
}

/** 关键路径事件名清单（覆盖率统计的分子分母都用它） */
export const KEY_EVENT_NAMES = [
  // 项目（工作台）
  'project.create',
  'project.open',
  'project.delete',
  'project.archive',
  'project.restore',
  'project.duplicate',
  'project.import_git',
  'project.import_doc',
  'project.create_template',
  // 流水线
  'pipeline.stage_advance',
  'pipeline.stage_rollback',
  'pipeline.stage_confirm',
  'pipeline.generate_start',
  'pipeline.generate_end',
  'pipeline.recovery_restore',
  // 设计器
  'designer.page_create',
  'designer.page_save',
  'designer.ai_generate',
  // 记忆
  'memory.capture',
  'memory.promotion', // 提示卡一键建卡
  'memory.question_resolve',
  // Git
  'git.init',
  'git.commit',
  'git.push',
  'git.branch_create',
  'git.merge',
  'git.rollback',
  // 重命名
  'rename.transaction',
  'rename.undo',
  // 归档（.ecpkg）
  'package.export',
  'package.import',
  'package.backup',
  // 账号
  'auth.login',
  'auth.logout',
  'auth.bind',
  'auth.unbind',
  // AI 网关
  'ai.request',
  // 更新
  'app.update_check',
  'app.update_apply',
  // 错误
  'app.error',
] as const;

export type KeyEventName = (typeof KEY_EVENT_NAMES)[number];

/** 判定事件是否属于关键路径（用于覆盖率统计分母） */
export function isKeyEventName(name: string): name is KeyEventName {
  return (KEY_EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * 事件 payload 安全断言：字段必须全部落在白名单内。
 * 测试（telemetry-events.test.ts）逐事件校验，新增调用点若夹带内容字段会直接红。
 */
export function assertEventPayloadSafe(payload: TelemetryEventPayload): void {
  const dims = payload.dims ?? {};
  for (const key of Object.keys(dims)) {
    if (!PAYLOAD_FIELD_ALLOWLIST.has(key.toLowerCase())) {
      throw new Error(
        `遥测字段白名单违规："${key}" 不在上报允许字段内（只允许维度 id / 耗时 / 结果状态，禁止任何内容字段）`,
      );
    }
    const value = dims[key];
    if (typeof value === 'string' && value.length > 200) {
      throw new Error(`遥测维度值过长（${key}，${value.length} 字符）：疑似夹带内容字段`);
    }
  }
}

/** 构造一条合法埋点（入口统一走这里，避免调用方手搓结构） */
export function buildEvent(
  name: KeyEventName,
  result: TelemetryEventPayload['result'],
  extra?: {
    durationMs?: number;
    errorKind?: string;
    dims?: Record<string, string | number | boolean>;
  },
): TelemetryEventPayload {
  const payload: TelemetryEventPayload = {
    name,
    result,
    ...(extra?.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(extra.durationMs)) } : {}),
    ...(extra?.errorKind !== undefined ? { errorKind: extra.errorKind } : {}),
    ...(extra?.dims !== undefined ? { dims: extra.dims } : {}),
  };
  assertEventPayloadSafe(payload);
  return payload;
}
