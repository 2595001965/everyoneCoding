/**
 * 七端命名预设（T7-01 要点 3，FR-UNI-02）。
 *
 * 目标端七选：Web / Android / iOS / HarmonyOS / Windows / Linux / macOS（PRD FR-AI-13）。
 * 各端差异集中在三处：
 *   1. **i18n 键模板**（Web/桌面 `page.<scope>.<name>.label`；鸿蒙 ArkTS 资源 `app.string.<scope>_<snake>`；
 *      Android `strings.xml` 的 `<scope>_<snake>`；iOS `<scope>.<name>.label`）
 *   2. **路由风格**（Web/桌面 kebab + 前导 `/`；鸿蒙 `pages/<Pascal>`（ArkTS 规范）；
 *      Android snake（无前导 `/`）；iOS camel）
 *   3. **合法字符与分隔符**（Android/iOS/鸿蒙标识符禁用 `-`，Web/桌面 CSS 类必须 kebab）
 *
 * 鸿蒙预设按 ArkTS 规范：组件名 PascalCase、资源引用走 `$r('app.string.xxx')`；
 * 桌面三端（Windows / Linux / macOS）与 Web 同风格（PRD FR-UNI-02 括注）。
 */

import type { IdentifierStyle, PinyinMode } from './identifier';

/** 七端（与 `@ec/designer` 的 PageDSL platform 枚举一致） */
export const NAMING_PLATFORMS = ['web', 'android', 'ios', 'harmonyos', 'windows', 'linux', 'macos'] as const;
export type NamingPlatform = (typeof NAMING_PLATFORMS)[number];

/** 八类标识符投影（PRD §6.2 `projections_json`） */
export const PROJECTION_KINDS = [
  'component',
  'variable',
  'cssClass',
  'i18nKey',
  'apiField',
  'methodName',
  'routeSegment',
  'testName',
] as const;
export type ProjectionKind = (typeof PROJECTION_KINDS)[number];

/** 投影类型的中文标签（UI 展示；标识符本身仍用英文，D-10） */
export const PROJECTION_LABELS: Readonly<Record<ProjectionKind, string>> = {
  component: '组件名',
  variable: '变量名 / 状态键',
  cssClass: 'CSS 类名',
  i18nKey: 'i18n Key',
  apiField: 'API 字段名',
  methodName: '后端方法名',
  routeSegment: '路由片段',
  testName: '测试用例名',
};

/** 资源引用风格（鸿蒙 ArkTS 与 Android XML 需要不同的引用表达式） */
export type ResourceReference = 'web' | 'arkts' | 'android-xml' | 'ios-strings';

/** 单条投影的命名规则 */
export interface ProjectionRule {
  /** 大小写风格（模板类投影可不设） */
  style?: IdentifierStyle | undefined;
  /** 模板（支持 `{Name}` `{name}` `{kebab}` `{snake}` `{CONSTANT}` `{scope}` `{label}`） */
  template?: string | undefined;
  /** 前置片段（如 `handle`） */
  prefix?: string | undefined;
  /** 后置片段 */
  suffix?: string | undefined;
  /** 长度上限 */
  maxLength: number;
  /** 明确禁止出现的字符（逐字符判定） */
  forbiddenChars: string;
  /** 期望的词分隔符；空串表示不出现分隔符 */
  separator: '-' | '_' | '';
}

export interface NamingPreset {
  id: string;
  platform: NamingPlatform;
  label: string;
  rules: Readonly<Record<ProjectionKind, ProjectionRule>>;
  resourceReference: ResourceReference;
  /** 该端特有的注意事项（写入注册表项与 UI 提示） */
  notes: readonly string[];
}

const L = 64;
const CSS_MAX = 48;
const I18N_MAX = 128;
const ROUTE_MAX = 96;

/** 生成一条投影规则（带默认值，减少预设表噪音） */
function rule(input: {
  style?: IdentifierStyle;
  template?: string;
  prefix?: string;
  suffix?: string;
  maxLength?: number;
  forbiddenChars?: string;
  separator?: '-' | '_' | '';
}): ProjectionRule {
  return {
    style: input.style,
    template: input.template,
    prefix: input.prefix,
    suffix: input.suffix,
    maxLength: input.maxLength ?? L,
    forbiddenChars: input.forbiddenChars ?? '',
    separator: input.separator ?? '',
  };
}

/** Web / 桌面三端共用的规则集 */
function webLikeRules(): Record<ProjectionKind, ProjectionRule> {
  return {
    component: rule({ style: 'pascal' }),
    variable: rule({ style: 'camel' }),
    cssClass: rule({ style: 'kebab', maxLength: CSS_MAX, separator: '-' }),
    i18nKey: rule({ template: 'page.{scope}.{name}.label', maxLength: I18N_MAX }),
    apiField: rule({ style: 'snake', separator: '_' }),
    methodName: rule({ style: 'pascal', prefix: 'handle' }),
    routeSegment: rule({ style: 'kebab', prefix: '/', maxLength: ROUTE_MAX, separator: '-' }),
    testName: rule({ template: 'should render {Name}', maxLength: I18N_MAX }),
  };
}

const WEB_PRESET: NamingPreset = {
  id: 'web-default',
  platform: 'web',
  label: 'Web（原生网页）',
  resourceReference: 'web',
  notes: ['CSS 类名走 kebab-case，可直接作为选择器使用', 'i18n 键形如 page.<页面>.<变量名>.label'],
  rules: webLikeRules(),
};

const DESKTOP_NOTES = ['桌面端与 Web 同风格（FR-UNI-02）', '窗口 / 菜单快捷键文案不入标识符'];

const WINDOWS_PRESET: NamingPreset = {
  id: 'windows-default',
  platform: 'windows',
  label: 'Windows 桌面（Tauri 2）',
  resourceReference: 'web',
  notes: DESKTOP_NOTES,
  rules: webLikeRules(),
};

const LINUX_PRESET: NamingPreset = {
  id: 'linux-default',
  platform: 'linux',
  label: 'Linux 桌面（Tauri 2）',
  resourceReference: 'web',
  notes: DESKTOP_NOTES,
  rules: webLikeRules(),
};

const MACOS_PRESET: NamingPreset = {
  id: 'macos-default',
  platform: 'macos',
  label: 'macOS 桌面（Tauri 2）',
  resourceReference: 'web',
  notes: DESKTOP_NOTES,
  rules: webLikeRules(),
};

const ANDROID_PRESET: NamingPreset = {
  id: 'android-default',
  platform: 'android',
  label: 'Android（Flutter）',
  resourceReference: 'android-xml',
  notes: [
    '标识符禁用 `-`（Kotlin / Java 语法限制），分隔符统一用 `_`',
    'strings.xml 的 key 用 snake_case，资源引用走 @string/<key>',
    '导航路由无前导 `/`（Flutter Navigator 命名路由）',
  ],
  rules: {
    component: rule({ style: 'pascal', forbiddenChars: '-' }),
    variable: rule({ style: 'camel', forbiddenChars: '-' }),
    cssClass: rule({ style: 'snake', maxLength: CSS_MAX, separator: '_', forbiddenChars: '-' }),
    i18nKey: rule({ template: '{scope}_{snake}', maxLength: I18N_MAX, forbiddenChars: '-' }),
    apiField: rule({ style: 'snake', separator: '_', forbiddenChars: '-' }),
    methodName: rule({ style: 'camel', prefix: 'handle', forbiddenChars: '-' }),
    routeSegment: rule({ style: 'snake', prefix: '', maxLength: ROUTE_MAX, separator: '_', forbiddenChars: '-' }),
    testName: rule({ template: 'should render {Name}', maxLength: I18N_MAX, forbiddenChars: '-' }),
  },
};

const IOS_PRESET: NamingPreset = {
  id: 'ios-default',
  platform: 'ios',
  label: 'iOS（Flutter / Swift）',
  resourceReference: 'ios-strings',
  notes: [
    '标识符禁用 `-`，分隔符统一用 `_`',
    'i18n 键形如 <页面>.<变量名>.label（Localizable.strings）',
    '导航路由用 camelCase',
  ],
  rules: {
    component: rule({ style: 'pascal', forbiddenChars: '-' }),
    variable: rule({ style: 'camel', forbiddenChars: '-' }),
    cssClass: rule({ style: 'snake', maxLength: CSS_MAX, separator: '_', forbiddenChars: '-' }),
    i18nKey: rule({ template: '{scope}.{name}.label', maxLength: I18N_MAX, forbiddenChars: '-' }),
    apiField: rule({ style: 'snake', separator: '_', forbiddenChars: '-' }),
    methodName: rule({ style: 'camel', prefix: 'handle', forbiddenChars: '-' }),
    routeSegment: rule({ style: 'camel', prefix: '', maxLength: ROUTE_MAX, forbiddenChars: '-' }),
    testName: rule({ template: 'should render {Name}', maxLength: I18N_MAX, forbiddenChars: '-' }),
  },
};

const HARMONYOS_PRESET: NamingPreset = {
  id: 'harmonyos-default',
  platform: 'harmonyos',
  label: 'HarmonyOS（ArkTS + ArkUI）',
  resourceReference: 'arkts',
  notes: [
    'ArkTS 规范：组件名 PascalCase，资源引用走 $r(\'app.string.<key>\')',
    '页面路由为 pages/<Pascal>（ArkUI 页面栈路径）',
    '资源 key 禁用 `-`，分隔符用 `_`',
  ],
  rules: {
    component: rule({ style: 'pascal', forbiddenChars: '-' }),
    variable: rule({ style: 'camel', forbiddenChars: '-' }),
    cssClass: rule({ style: 'snake', maxLength: CSS_MAX, separator: '_', forbiddenChars: '-' }),
    i18nKey: rule({ template: 'app.string.{scope}_{snake}', maxLength: I18N_MAX, forbiddenChars: '-' }),
    apiField: rule({ style: 'snake', separator: '_', forbiddenChars: '-' }),
    methodName: rule({ style: 'camel', prefix: 'handle', forbiddenChars: '-' }),
    routeSegment: rule({ style: 'pascal', prefix: 'pages/', maxLength: ROUTE_MAX, forbiddenChars: '-' }),
    testName: rule({ template: 'should render {Name}', maxLength: I18N_MAX, forbiddenChars: '-' }),
  },
};

/** 七端预设表 */
export const PLATFORM_PRESETS: Readonly<Record<NamingPlatform, NamingPreset>> = {
  web: WEB_PRESET,
  android: ANDROID_PRESET,
  ios: IOS_PRESET,
  harmonyos: HARMONYOS_PRESET,
  windows: WINDOWS_PRESET,
  linux: LINUX_PRESET,
  macos: MACOS_PRESET,
};

/** 项目级命名覆盖（写进项目设置，作用于该项目的全部标识符） */
export interface NamingOverride {
  /** 覆盖预设 id（留空表示沿用平台预设） */
  presetId?: string | undefined;
  /** 中文解析模式覆盖 */
  mode?: PinyinMode | undefined;
  /** 项目术语表（中文 → 英文 / 拼音），优先级高于内置词表 */
  dictionary?: Readonly<Record<string, string>> | undefined;
  /** 逐投影覆盖长度上限 */
  maxLength?: Partial<Record<ProjectionKind, number>> | undefined;
  /** 逐投影局部覆盖（样式 / 前后缀 / 模板 / 禁用字符 / 分隔符） */
  rules?: Partial<Record<ProjectionKind, Partial<ProjectionRule>>> | undefined;
  /** 资源引用风格覆盖 */
  resourceReference?: ResourceReference | undefined;
  /** 全局补充禁用字符（追加到每条投影规则） */
  extraForbiddenChars?: string | undefined;
}

/** 已解析的命名规则（引擎实际使用的形态） */
export interface ResolvedNamingRule {
  preset: NamingPreset;
  /** 生效的模式与术语表 */
  mode: PinyinMode;
  dictionary: Readonly<Record<string, string>>;
  /** 规则 id：预设 id 或 `project:<presetId>` */
  ruleId: string;
  /** 是否被项目级覆盖过 */
  overridden: boolean;
}

/** 按 id 查预设（支持 `web-default`、`web`、`project:web-default` 三种写法） */
export function findPreset(id: string): NamingPreset | null {
  const normalized = id.startsWith('project:') ? id.slice('project:'.length) : id;
  for (const platform of NAMING_PLATFORMS) {
    const preset = PLATFORM_PRESETS[platform];
    if (preset.id === normalized || preset.platform === normalized) return preset;
  }
  return null;
}

/** 合并项目级覆盖，产出新的预设对象（不修改基座，可安全缓存） */
export function mergePreset(base: NamingPreset, override: NamingOverride = {}): NamingPreset {
  const rules = {} as Record<ProjectionKind, ProjectionRule>;
  for (const kind of PROJECTION_KINDS) {
    const original = base.rules[kind];
    const patch = override.rules?.[kind] ?? {};
    const maxLength = override.maxLength?.[kind] ?? patch.maxLength ?? original.maxLength;
    const extra = override.extraForbiddenChars ?? '';
    rules[kind] = {
      style: patch.style ?? original.style,
      template: patch.template ?? original.template,
      prefix: patch.prefix ?? original.prefix,
      suffix: patch.suffix ?? original.suffix,
      maxLength,
      forbiddenChars: dedupeChars(original.forbiddenChars + (patch.forbiddenChars ?? '') + extra),
      separator: patch.separator ?? original.separator,
    };
  }
  return {
    id: base.id,
    platform: base.platform,
    label: base.label,
    resourceReference: override.resourceReference ?? base.resourceReference,
    notes: base.notes,
    rules,
  };
}

function dedupeChars(input: string): string {
  return [...new Set([...input])].join('');
}

/**
 * 解析生效的命名规则。
 *
 * 优先级：`override.presetId`（项目覆盖）> `platform` 预设 > Web 预设。
 */
export function resolveNamingRule(input: {
  platform?: NamingPlatform | undefined;
  override?: NamingOverride | undefined;
} = {}): ResolvedNamingRule {
  const override = input.override ?? {};
  const requested = override.presetId !== undefined ? findPreset(override.presetId) : null;
  const byPlatform = input.platform !== undefined ? PLATFORM_PRESETS[input.platform] : undefined;
  const base = requested ?? byPlatform ?? WEB_PRESET;
  const hasOverride =
    Object.keys(override).length > 0 &&
    (override.rules !== undefined ||
      override.maxLength !== undefined ||
      override.mode !== undefined ||
      override.dictionary !== undefined ||
      override.resourceReference !== undefined ||
      override.extraForbiddenChars !== undefined);
  return {
    preset: hasOverride ? mergePreset(base, override) : base,
    mode: override.mode ?? 'english',
    dictionary: override.dictionary ?? {},
    ruleId: hasOverride ? `project:${base.id}` : base.id,
    overridden: hasOverride,
  };
}

/** 生成资源引用表达式（鸿蒙 / Android 的引用语法与 Web 不同） */
export function resourceReferenceOf(reference: ResourceReference, i18nKey: string): string {
  switch (reference) {
    case 'arkts':
      return `$r('${i18nKey}')`;
    case 'android-xml':
      return `@string/${i18nKey}`;
    case 'ios-strings':
      return `NSLocalizedString("${i18nKey}", comment: "")`;
    default:
      return `t('${i18nKey}')`;
  }
}
