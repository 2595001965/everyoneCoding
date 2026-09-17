/**
 * 命名规则引擎（T7-01 要点 2，FR-UNI-02 / D-10）。
 *
 * 单一职责：把「用户可见规范名」+ 「生效命名规则」转换为**八类标识符投影**，
 * 并给出格式层面的校验（非法字符 / 长度 / 保留字）。
 *
 * 投影语义来自 PRD §15.1，以规范名「用户登录按钮」为例（Web 预设）：
 *
 * | 投影 | 结果 |
 * | --- | --- |
 * | component | `UserLoginButton` |
 * | variable | `userLoginButton` |
 * | cssClass | `user-login-button` |
 * | i18nKey | `page.login.userLoginButton.label` |
 * | apiField | `user_login_button` |
 * | methodName | `handleUserLoginButton` |
 * | routeSegment | `/user-login-button` |
 * | testName | `should render UserLoginButton` |
 *
 * ⚠️ 类型定义在 `registry-model.ts`（`ProjectionSet` / `RegistryEntityType`），此处为
 * `import type` 引用（编译期擦除），不产生运行时循环依赖。
 */

import { applyStyle, segmentWords, toIdentifier, type IdentifierStyle } from './identifier';
import {
  PROJECTION_KINDS,
  PROJECTION_LABELS,
  resourceReferenceOf,
  type ProjectionKind,
  type ProjectionRule,
  type ResolvedNamingRule,
} from './presets';
import type { ProjectionSet, RegistryEntityType } from '../registry-model';

/** 八类投影的完整取值 */
export type { ProjectionSet } from '../registry-model';

/** 各语言保留字（JS/TS、Java、Python、Dart、ArkTS 常用集合） */
export const RESERVED_WORDS: Readonly<Record<string, readonly string[]>> = {
  javascript: [
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
    'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
    'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
    'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'static',
    'private', 'public', 'protected', 'interface', 'implements', 'package', 'get', 'set',
  ],
  typescript: [
    'any', 'boolean', 'constructor', 'declare', 'never', 'number', 'object', 'readonly',
    'string', 'symbol', 'type', 'undefined', 'unknown', 'abstract', 'as', 'asserts', 'is',
    'keyof', 'namespace', 'satisfies', 'infer', 'global', 'module', 'require', 'out',
  ],
  java: [
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
    'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
    'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long',
    'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static',
    'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try',
    'void', 'volatile', 'while', 'var', 'record', 'sealed', 'permits', 'yield',
  ],
  python: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
    'None', 'True', 'False', 'self', 'cls', 'match', 'case',
  ],
  dart: [
    'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
    'continue', 'covariant', 'default', 'deferred', 'do', 'dynamic', 'else', 'enum', 'export',
    'extends', 'extension', 'external', 'factory', 'false', 'final', 'finally', 'for', 'function',
    'get', 'hide', 'if', 'implements', 'import', 'in', 'interface', 'is', 'late', 'library',
    'mixin', 'new', 'null', 'on', 'operator', 'part', 'required', 'rethrow', 'return', 'sealed',
    'set', 'show', 'static', 'super', 'switch', 'sync', 'this', 'throw', 'true', 'try', 'typedef',
    'var', 'void', 'when', 'while', 'with', 'yield',
  ],
  arkts: [
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
    'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'is',
    'let', 'new', 'null', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'static',
    'struct', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var',
    'void', 'while', 'with', 'yield', 'Builder', 'Entry', 'Component', 'State', 'Prop', 'Link',
    'Provide', 'Consume', 'Watch', 'ObjectLink', 'Observed',
  ],
};

/** 全部语言的保留字并集（大小写敏感：Python 的 `None` 与 JS 的 `none` 不同，故同时收录小写形式） */
export function allReservedWords(): ReadonlySet<string> {
  const set = new Set<string>();
  for (const words of Object.values(RESERVED_WORDS)) {
    for (const word of words) {
      set.add(word);
      set.add(word.toLowerCase());
    }
  }
  return set;
}

/** 中文页面关键字 → i18n / 路由的 scope 片段（可由 `scope` 参数覆盖） */
const SCOPE_KEYWORDS: Readonly<Record<string, string>> = {
  登录: 'login',
  注册: 'register',
  首页: 'home',
  欢迎: 'welcome',
  个人中心: 'profile',
  个人信息: 'profile',
  设置: 'settings',
  详情: 'detail',
  列表: 'list',
  搜索: 'search',
  工作台: 'workspace',
  仪表盘: 'dashboard',
  购物车: 'cart',
  订单: 'order',
  商品: 'product',
  支付: 'payment',
};

/** 从规范名推断页面 scope（无命中时返回 `common`） */
export function inferScope(canonicalName: string): string {
  for (const [keyword, scope] of Object.entries(SCOPE_KEYWORDS)) {
    if (canonicalName.includes(keyword)) return scope;
  }
  return 'common';
}

/** 模板上下文 */
export interface TemplateContext {
  words: readonly string[];
  scope: string;
  /** 显示文案（保留中文，D-10） */
  label: string;
}

/** 填充模板：`{Name}` `{name}` `{kebab}` `{snake}` `{CONSTANT}` `{scope}` `{label}` `{SCOPE}` */
export function fillTemplate(template: string, context: TemplateContext): string {
  const { words, scope, label } = context;
  return template
    .replace(/\{Name\}/g, applyStyle(words, 'pascal'))
    .replace(/\{name\}/g, applyStyle(words, 'camel'))
    .replace(/\{kebab\}/g, applyStyle(words, 'kebab'))
    .replace(/\{snake\}/g, applyStyle(words, 'snake'))
    .replace(/\{CONSTANT\}/g, applyStyle(words, 'constant'))
    .replace(/\{SCOPE\}/g, scope.toUpperCase())
    .replace(/\{scope\}/g, scope)
    .replace(/\{label\}/g, label);
}

export interface DeriveProjectionsOptions {
  entityType: RegistryEntityType;
  rule: ResolvedNamingRule;
  /** 页面上下文；缺省时按规范名推断（见 `inferScope`） */
  scope?: string | undefined;
}

export interface DerivedProjections {
  projections: ProjectionSet;
  words: readonly string[];
  scope: string;
  /** 派生过程中的提示（如"路由片段仅页面 / 功能级生效"），不阻断 */
  warnings: readonly string[];
}

function capitalizeWord(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

/** 单条投影的派生（供 `deriveProjections` 与"逐投影重算"共用） */
export function projectOne(
  kind: ProjectionKind,
  canonicalName: string,
  options: DeriveProjectionsOptions,
): string {
  const { rule, scope } = options;
  const effectiveScope = scope ?? inferScope(canonicalName);
  const naming = {
    mode: rule.mode,
    dictionary: rule.dictionary,
  } as const;
  const projectionRule: ProjectionRule = rule.preset.rules[kind];
  const words = segmentWords(canonicalName, naming);
  if (projectionRule.template !== undefined) {
    return fillTemplate(projectionRule.template, {
      words,
      scope: effectiveScope,
      label: canonicalName,
    });
  }
  const style: IdentifierStyle = projectionRule.style ?? 'camel';
  const core = toIdentifier(canonicalName, { ...naming, style });
  const prefix = projectionRule.prefix ?? '';
  /**
   * 前缀拼接的大小写处理：camel 风格下 `handle` + `userLoginButton` 会得到
   * `handleuserLoginButton`（首字母没跟着大写，肉眼就是 bug），因此要把核心的首字母提上来。
   * pascal 风格本来就是大写开头，kebab / snake 风格则绝不能在中间插入大写。
   */
  const coreWithCase = prefix.length > 0 && style === 'camel' ? capitalizeWord(core) : core;
  return `${prefix}${coreWithCase}${projectionRule.suffix ?? ''}`;
}

/**
 * 派生八类投影。
 *
 * - 路由片段对 `element` 级对象仍会派生（便于页面内锚点复用），但在 `warnings` 中提示
 *   "仅页面 / 功能级生效"（PRD §15.1 括注）；
 * - i18n 键的 `<scope>` 缺省由规范名推断，可由调用方显式指定。
 */
export function deriveProjections(
  canonicalName: string,
  options: DeriveProjectionsOptions,
): DerivedProjections {
  const scope = options.scope ?? inferScope(canonicalName);
  const naming = { mode: options.rule.mode, dictionary: options.rule.dictionary } as const;
  const words = segmentWords(canonicalName, naming);
  const projections = {} as ProjectionSet;
  for (const kind of PROJECTION_KINDS) {
    projections[kind] = projectOne(kind, canonicalName, { ...options, scope });
  }
  const warnings: string[] = [];
  if (options.entityType === 'element') {
    warnings.push('routeSegment 仅页面 / 功能级生效；元素级投影仅供容器页面复用');
  }
  return { projections, words, scope, warnings };
}

/** 逐投影重算（"一键全项目命名规范化"按此对齐，FR-UNI-14） */
export function reproject(
  canonicalName: string,
  kinds: readonly ProjectionKind[],
  options: DeriveProjectionsOptions,
): Partial<ProjectionSet> {
  const scope = options.scope ?? inferScope(canonicalName);
  const out: Partial<ProjectionSet> = {};
  for (const kind of kinds) {
    out[kind] = projectOne(kind, canonicalName, { ...options, scope });
  }
  return out;
}

/** 投影格式违规（非法字符 / 超长） */
export interface ProjectionFormatIssue {
  kind: ProjectionKind;
  value: string;
  reason: 'illegal_char' | 'too_long' | 'forbidden_char' | 'bad_separator';
  detail: string;
}

/** 期望分隔符校验：kebab 投影不得出现 `_`，snake 投影不得出现 `-` */
function separatorIssue(value: string, separator: ProjectionRule['separator']): string | null {
  if (separator === '-') {
    if (value.includes('_')) return '期望 kebab-case（分隔符为 `-`），实际出现 `_`';
  } else if (separator === '_') {
    if (value.includes('-')) return '期望 snake_case（分隔符为 `_`），实际出现 `-`';
  } else if (value.includes('-')) {
    return '该投影不允许出现分隔符 `-`';
  }
  return null;
}

/** 校验八类投影的格式（字符 / 长度 / 分隔符），供"AI 生成后一致性校验"调用 */
export function validateProjectionFormat(
  projections: Partial<ProjectionSet>,
  rule: ResolvedNamingRule,
): ProjectionFormatIssue[] {
  const issues: ProjectionFormatIssue[] = [];
  for (const kind of PROJECTION_KINDS) {
    const value = projections[kind];
    if (value === undefined || value.length === 0) continue;
    const projectionRule: ProjectionRule = rule.preset.rules[kind];
    for (const char of projectionRule.forbiddenChars) {
      if (value.includes(char)) {
        issues.push({
          kind,
          value,
          reason: 'forbidden_char',
          detail: `${PROJECTION_LABELS[kind]} 禁止包含字符 \`${char}\``,
        });
      }
    }
    if (value.length > projectionRule.maxLength) {
      issues.push({
        kind,
        value,
        reason: 'too_long',
        detail: `${PROJECTION_LABELS[kind]} 长度 ${value.length} 超过上限 ${projectionRule.maxLength}`,
      });
    }
    // 模板类投影（i18n / 测试用例名）自带 `.` 与空格，只做禁用字符与长度校验
    if (projectionRule.template !== undefined) continue;
    if (/[^0-9A-Za-z_\-./$@]/.test(value)) {
      issues.push({
        kind,
        value,
        reason: 'illegal_char',
        detail: `${PROJECTION_LABELS[kind]} 含非法字符`,
      });
      continue;
    }
    const bad = separatorIssue(value, projectionRule.separator);
    if (bad !== null) {
      issues.push({ kind, value, reason: 'bad_separator', detail: `${PROJECTION_LABELS[kind]}：${bad}` });
    }
  }
  return issues;
}

/** 生成资源引用表达式（鸿蒙 ArkTS / Android / iOS / Web，预设决定语法） */
export function projectionResourceReference(
  rule: ResolvedNamingRule,
  projections: Pick<ProjectionSet, 'i18nKey'>,
): string {
  return resourceReferenceOf(rule.preset.resourceReference, projections.i18nKey);
}
