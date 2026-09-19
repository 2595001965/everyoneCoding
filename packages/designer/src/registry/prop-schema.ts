/**
 * 属性 JSON Schema 规范（T3-04 产出，T3-05 的 SchemaForm 消费）—— **跨模块冻结契约**。
 *
 * 属性用 JSON Schema 描述，属性面板据此**自动生成表单**，组件库新增字段无需改面板代码。
 * 采用简化子集（而非完整 JSON Schema），覆盖设计器实际需要的控件类型与条件显隐。
 */

/** 属性控件类型 */
export const PROP_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'enum',
  'color',
  'size',
  'spacing',
  'shadow',
  'border',
  'json',
  'columns',
  'image',
  'options',
] as const;

export type PropFieldType = (typeof PROP_FIELD_TYPES)[number];

/** 属性分组（面板内折叠区） */
export const PROP_GROUPS = [
  '内容',
  '外观',
  '布局',
  '间距',
  '文字',
  '边框',
  '交互',
  '数据',
  '高级',
] as const;
export type PropGroup = (typeof PROP_GROUPS)[number];

export interface PropEnumOption {
  value: string;
  label: string;
}

/** 条件显隐：字段仅在满足条件时显示（如 `variant === 'primary'` 时才显示 `block`） */
export interface PropVisibleWhen {
  field: string;
  equals?: unknown;
  in?: readonly unknown[];
  truthy?: boolean;
}

export interface PropField {
  /** props 中的键名（英文） */
  key: string;
  /** 中文标签 */
  label: string;
  type: PropFieldType;
  group: PropGroup;
  default?: unknown;
  options?: readonly PropEnumOption[];
  min?: number;
  max?: number;
  step?: number;
  /** 单位提示（px / % / em） */
  unit?: string;
  placeholder?: string;
  description?: string;
  visibleWhen?: PropVisibleWhen;
}

/** 组件属性 schema */
export interface PropSchema {
  fields: PropField[];
}

/** 定义字段（提供默认分组的便捷构造） */
export function defineField(field: PropField): PropField {
  return field;
}

/** 组合字段定义列表 */
export function defineSchema(fields: readonly PropField[]): PropSchema {
  return { fields: [...fields] };
}

/** 取 schema 的默认值集合 */
export function schemaDefaults(schema: PropSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

/** 按分组聚合（保持 PROP_GROUPS 顺序，未知分组排到末尾） */
export function groupFields(schema: PropSchema): Array<{ group: PropGroup; fields: PropField[] }> {
  const buckets = new Map<PropGroup, PropField[]>();
  for (const field of schema.fields) {
    const list = buckets.get(field.group) ?? [];
    list.push(field);
    buckets.set(field.group, list);
  }
  return [...buckets.entries()]
    .sort((a, b) => PROP_GROUPS.indexOf(a[0]) - PROP_GROUPS.indexOf(b[0]))
    .map(([group, fields]) => ({ group, fields }));
}

/** 条件显隐判定 */
export function fieldVisible(field: PropField, values: Record<string, unknown>): boolean {
  const rule = field.visibleWhen;
  if (rule === undefined) return true;
  const current = values[rule.field];
  if (rule.equals !== undefined) return current === rule.equals;
  if (rule.in !== undefined) return rule.in.includes(current);
  if (rule.truthy !== undefined) return Boolean(current) === rule.truthy;
  return true;
}

/** 可见字段（供 SchemaForm 过滤） */
export function visibleFields(schema: PropSchema, values: Record<string, unknown>): PropField[] {
  return schema.fields.filter((field) => fieldVisible(field, values));
}

/** schema 自检：返回问题列表（空数组为通过） */
export function validatePropSchema(schema: PropSchema): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const field of schema.fields) {
    if (field.key.trim().length === 0) issues.push('存在未命名字段 key');
    if (seen.has(field.key)) issues.push(`字段 key 重复：${field.key}`);
    seen.add(field.key);
    if (field.label.trim().length === 0) issues.push(`字段 ${field.key} 缺少中文标签`);
    if (field.type === 'enum' && (field.options === undefined || field.options.length === 0)) {
      issues.push(`枚举字段 ${field.key} 缺少 options`);
    }
    if (
      field.visibleWhen !== undefined &&
      !seen.has(field.visibleWhen.field) &&
      !schema.fields.some((item) => item.key === field.visibleWhen?.field)
    ) {
      issues.push(`字段 ${field.key} 的 visibleWhen 引用了不存在的字段 ${field.visibleWhen.field}`);
    }
  }
  return issues;
}
