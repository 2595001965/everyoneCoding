/**
 * 三级风险分级（T7-02 要点 5，FR-UNI-04）。
 *
 * | 级别 | 含义 | 默认勾选 |
 * | --- | --- | --- |
 * | `auto` | 安全，自动改：组件名、变量名、CSS 类、i18n key、逻辑结构、高置信文档/记忆提及 | ✅ |
 * | `confirm` | 需用户勾选：API 字段名、DTO 字段、Service 方法名、低置信语义命中 | ✅（可取消） |
 * | `warn` | 默认不改：数据库列名、已发布外部 API 路径、反射与动态调用 | ❌ |
 *
 * 分级规则是**数据**（`RiskRule[]`，首个命中生效），因此"分级规则可在设置中调整"
 * （FR-UNI-04 验收要点）只需替换 / 覆写规则表，无需改代码。
 *
 * 跨项目引用（FR-UNI-13 / D-07）不在本模块：索引只针对当前项目构建，
 * 结果集中**结构上不可能**出现跨项目条目（见 `impact-analyzer` 的断言）。
 */

import type { ProjectionKind } from '../naming/presets';
import type { HitRole, OccurrenceKind, RiskLevel } from './types';

/** 待分级信号（出现位置的抽象视图，代码/文档/记忆/逻辑四类统一） */
export interface RiskSignal {
  kind: OccurrenceKind;
  refPath: string;
  matchedSymbol: ProjectionKind | null;
  role: HitRole | null;
  confidence: number;
  detail: string | null;
}

/** 单条分级规则 */
export interface RiskRule {
  id: string;
  /** 中文标签（UI 的"分级规则设置"直接展示） */
  label: string;
  level: RiskLevel;
  /** 命中判定 */
  test: (signal: RiskSignal) => boolean;
}

/** 分级结果 */
export interface RiskClassification {
  level: RiskLevel;
  ruleId: string;
  reason: string;
}

/* --------------------------- 路径 / 内容特征判定 --------------------------- */

const DATABASE_PATH = /(^|\/)(migrations?|schema|ddl)(\/|\.)|\/(migrations?|schema|ddl)\/|\.sql$/i;
const PUBLISHED_API_PATH = /(^|\/)(api|routes?|openapi|swagger)(\/|\.)|openapi\.(json|ya?ml)$/i;
const EXTERNAL_SURFACE = /\.(json|ya?ml)$/i;

/** 逻辑结构（DSL）来源：节点名 / 绑定路径 / 动作目标 */
function isLogic(signal: RiskSignal): boolean {
  return signal.kind === 'logic';
}

/** 语义命中的高置信阈值（FR-UNI-08：≥0.8 自动改，<0.8 列为候选） */
export const SEMANTIC_AUTO_THRESHOLD = 0.8;

/**
 * 默认规则表。**顺序即优先级**（首个命中生效）：warn → confirm → auto → 兜底。
 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  {
    id: 'warn.database-column',
    label: '数据库列名（warn：默认不改，需走迁移脚本）',
    level: 'warn',
    test: (s) => s.kind === 'code' && DATABASE_PATH.test(s.refPath),
  },
  {
    id: 'warn.published-api-path',
    label: '已发布外部 API 路径（warn）',
    level: 'warn',
    test: (s) =>
      (s.matchedSymbol === 'routeSegment' || s.matchedSymbol === 'apiField') &&
      (PUBLISHED_API_PATH.test(s.refPath) || EXTERNAL_SURFACE.test(s.refPath)),
  },
  {
    id: 'warn.dynamic-access',
    label: '反射 / 动态调用（warn：字符串承载的方法名无法静态校验）',
    level: 'warn',
    test: (s) => s.role === 'string-literal' && (s.matchedSymbol === 'methodName' || s.matchedSymbol === 'apiField'),
  },
  {
    id: 'confirm.api-field',
    label: 'API 字段 / DTO 字段（confirm：前后端契约需确认）',
    level: 'confirm',
    test: (s) => s.matchedSymbol === 'apiField',
  },
  {
    id: 'confirm.method-name',
    label: 'Service / Controller 方法名（confirm）',
    level: 'confirm',
    test: (s) => s.matchedSymbol === 'methodName',
  },
  {
    id: 'confirm.member-access',
    label: '成员访问（confirm：接收者可能是 this / 外部对象）',
    level: 'confirm',
    test: (s) => s.role === 'member-access',
  },
  {
    id: 'confirm.low-confidence',
    label: '低置信语义命中（confirm：列为候选由用户逐条采纳）',
    level: 'confirm',
    test: (s) => s.confidence < SEMANTIC_AUTO_THRESHOLD,
  },
  {
    id: 'auto.logic',
    label: '逻辑结构（auto：DSL 节点名 / 绑定路径 / 动作目标）',
    level: 'auto',
    test: isLogic,
  },
  {
    id: 'auto.code-identifier',
    label: '组件名 / 变量名 / CSS 类 / i18n key（auto）',
    level: 'auto',
    test: (s) =>
      s.kind === 'code' &&
      (s.matchedSymbol === 'component' ||
        s.matchedSymbol === 'variable' ||
        s.matchedSymbol === 'cssClass' ||
        s.matchedSymbol === 'i18nKey'),
  },
  {
    id: 'auto.doc',
    label: '文档提及（auto：需求 / 技术 / 关联文档同步修改）',
    level: 'auto',
    test: (s) => s.kind === 'doc',
  },
  {
    id: 'auto.memory',
    label: '记忆提及（auto：置信度 ≥0.8 自动改）',
    level: 'auto',
    test: (s) => s.kind === 'memory',
  },
  {
    id: 'confirm.unknown',
    label: '未归类位置（confirm：保守处理）',
    level: 'confirm',
    test: () => true,
  },
];

/** 分级配置（可在设置中整体替换或局部覆写级别） */
export interface RiskConfig {
  rules: readonly RiskRule[];
}

/** 默认配置 */
export function defaultRiskConfig(): RiskConfig {
  return { rules: DEFAULT_RISK_RULES };
}

/**
 * 按设置覆写级别（FR-UNI-04："分级规则可在设置中调整"）。
 *
 * `overrides` 形如 `{ 'confirm.api-field': 'warn' }`。
 */
export function applyRiskOverrides(
  config: RiskConfig,
  overrides: Readonly<Record<string, RiskLevel>>,
): RiskConfig {
  return {
    rules: config.rules.map((rule) => {
      const level = overrides[rule.id];
      return level === undefined ? rule : { ...rule, level };
    }),
  };
}

/** 单条信号分级（首个命中的规则生效） */
export function classifyRisk(signal: RiskSignal, config: RiskConfig = defaultRiskConfig()): RiskClassification {
  for (const rule of config.rules) {
    if (rule.test(signal)) {
      return { level: rule.level, ruleId: rule.id, reason: rule.label };
    }
  }
  return { level: 'confirm', ruleId: 'confirm.unknown', reason: '未归类位置（confirm：保守处理）' };
}

/** 分批：三级分组结果（供影响面面板直接渲染） */
export function isSelectedByDefault(level: RiskLevel): boolean {
  return level !== 'warn';
}

/** 级别中文标签 */
export const RISK_LEVEL_LABELS: Readonly<Record<RiskLevel, string>> = {
  auto: '自动区（安全，直接修改）',
  confirm: '确认区（需你勾选）',
  warn: '警告区（默认不改）',
};

/** 级别说明（UI 顶部提示文案） */
export const RISK_LEVEL_HINTS: Readonly<Record<RiskLevel, string>> = {
  auto: '组件名、变量名、CSS 类、i18n key、逻辑结构与高置信文档/记忆提及，可直接修改。',
  confirm: 'API 字段、DTO 字段、Service 方法名与低置信候选，需要你确认后才会修改。',
  warn: '数据库列名、已发布外部 API 路径、反射与动态调用，默认不改；数据库改名请走迁移脚本（D-08）。',
};
