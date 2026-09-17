/**
 * 结构精简规则（可配置）。
 *
 * 设计目标：在「保真度」与「token 体积」之间取平衡——
 * 剥离纯样式与装饰属性，保留组件类型、层级、绑定字段、事件目标与接口依赖。
 */

/** 精简规则 */
export interface CondenserRules {
  /** 保留的业务性 props 白名单（其余 props 一律丢弃） */
  keepProps: readonly string[];
  /** 明确丢弃的纯样式/装饰 props（即便不在 keepProps 命中也应丢弃） */
  dropProps: readonly string[];
  /** 明确丢弃的 style 键（纯样式一律剥离） */
  dropStyleKeys: readonly string[];
  /** 组件树最大深度，超过则折叠为占位节点 */
  maxDepth: number;
  /** 文本类 props 的最大长度，超出截断 */
  textMaxLength: number;
}

/** 默认规则 */
export const DEFAULT_CONDENSER_RULES: CondenserRules = {
  keepProps: [
    'placeholder',
    'label',
    'text',
    'value',
    'name',
    'type',
    'required',
    'validation',
    'api',
    'method',
    'route',
    'href',
    'src',
    'options',
    'disabled',
    'checked',
    'onChange',
    'onClick',
  ],
  dropProps: [],
  dropStyleKeys: [
    'color',
    'background',
    'backgroundColor',
    'backgroundImage',
    'fontSize',
    'fontFamily',
    'fontWeight',
    'fontStyle',
    'padding',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'margin',
    'marginTop',
    'marginRight',
    'marginBottom',
    'marginLeft',
    'border',
    'borderRadius',
    'borderColor',
    'borderWidth',
    'boxShadow',
    'width',
    'height',
    'opacity',
    'lineHeight',
    'letterSpacing',
    'textAlign',
    'display',
    'flex',
    'gap',
  ],
  maxDepth: 6,
  textMaxLength: 60,
};

/**
 * 基于默认规则合并补丁，得到一份完整规则。
 * 任一字段缺省时回退到默认值（不 mutate 入参）。
 */
export function mergeRules(patch: Partial<CondenserRules>): CondenserRules {
  return {
    keepProps: patch.keepProps ?? DEFAULT_CONDENSER_RULES.keepProps,
    dropProps: patch.dropProps ?? DEFAULT_CONDENSER_RULES.dropProps,
    dropStyleKeys: patch.dropStyleKeys ?? DEFAULT_CONDENSER_RULES.dropStyleKeys,
    maxDepth: patch.maxDepth ?? DEFAULT_CONDENSER_RULES.maxDepth,
    textMaxLength: patch.textMaxLength ?? DEFAULT_CONDENSER_RULES.textMaxLength,
  };
}

/** 判断某个 props 键是否应保留（业务性且非显式丢弃） */
export function isKeepProp(key: string, rules: CondenserRules): boolean {
  if (rules.dropProps.includes(key)) return false;
  return rules.keepProps.includes(key);
}

/** 判断某个 style 键是否应剥离 */
export function isDropStyleKey(key: string, rules: CondenserRules): boolean {
  return rules.dropStyleKeys.includes(key);
}
