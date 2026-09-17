import type { ComponentType, ReactNode } from 'react';

import type { ElementNode } from '../dsl/types';
import type { PropSchema } from './prop-schema';

/**
 * 组件注册表（T3-04 产出）—— **跨模块冻结契约**。
 *
 * 每个可拖入画布的组件都有一份元信息（含属性 JSON Schema 与嵌套规则），
 * 供：组件面板（T3-03）、属性面板（T3-05）、图层树（T3-06）、
 * AI 生成结果校验（T3-11 组件白名单）共同消费。
 */

/** 组件面板分组 */
export const COMPONENT_GROUPS = ['基础', '布局', '表单', '数据展示', '业务组件', '自定义'] as const;
export type ComponentGroup = (typeof COMPONENT_GROUPS)[number];

/** 设计器内组件渲染入参（纯受控展示，不持有业务状态） */
export interface ComponentRenderProps {
  node: ElementNode;
  /** design = 设计器（带占位与提示）；preview = 预览（真实交互） */
  mode: 'design' | 'preview';
  /** preview 模式下的运行时变量表 */
  scope?: Record<string, unknown>;
  /** 已渲染的子节点 */
  children?: ReactNode;
}

export interface ComponentMeta {
  type: string;
  /** 中文显示名（D-10） */
  displayName: string;
  group: ComponentGroup;
  description?: string;
  /** 内联 SVG 图标 id（见 icon-set.ts） */
  icon: string;
  defaultProps: Record<string, unknown>;
  defaultStyle: Record<string, unknown>;
  /** 是否接受子节点（嵌套规则） */
  acceptsChildren: boolean;
  propSchema: PropSchema;
}

export interface ComponentRegistration {
  meta: ComponentMeta;
  renderer?: ComponentType<ComponentRenderProps>;
}

export class ComponentRegistry {
  private readonly entries = new Map<string, ComponentRegistration>();

  /** 注册（重复注册同一 type 会抛错，避免静默覆盖内置组件） */
  register(registration: ComponentRegistration): void {
    const { type } = registration.meta;
    if (this.entries.has(type)) throw new Error(`组件已注册：${type}`);
    this.entries.set(type, registration);
  }

  /** 覆盖注册（自定义组件替换内置 / 热更新场景） */
  override(registration: ComponentRegistration): void {
    this.entries.set(registration.meta.type, registration);
  }

  unregister(type: string): boolean {
    return this.entries.delete(type);
  }

  has(type: string): boolean {
    return this.entries.has(type);
  }

  get(type: string): ComponentMeta | null {
    return this.entries.get(type)?.meta ?? null;
  }

  registration(type: string): ComponentRegistration | null {
    return this.entries.get(type) ?? null;
  }

  /** 渲染器（未注册渲染器时返回 null，由画布降级为占位框） */
  rendererFor(type: string): ComponentType<ComponentRenderProps> | null {
    return this.entries.get(type)?.renderer ?? null;
  }

  /** 是否接受子节点（未注册组件按容器处理，避免拖拽被无谓拒绝） */
  acceptsChildren(type: string): boolean {
    return this.entries.get(type)?.meta.acceptsChildren ?? true;
  }

  list(group?: ComponentGroup): ComponentMeta[] {
    const all = [...this.entries.values()].map((entry) => entry.meta);
    const filtered = group === undefined ? all : all.filter((meta) => meta.group === group);
    return filtered.sort((a, b) => {
      const groupDiff = COMPONENT_GROUPS.indexOf(a.group) - COMPONENT_GROUPS.indexOf(b.group);
      return groupDiff !== 0 ? groupDiff : a.type.localeCompare(b.type);
    });
  }

  /** 分组清单（仅返回有组件的分组，保持面板顺序） */
  groups(): Array<{ group: ComponentGroup; components: ComponentMeta[] }> {
    return COMPONENT_GROUPS.map((group) => ({ group, components: this.list(group) })).filter(
      (item) => item.components.length > 0,
    );
  }

  /** 类型白名单（T3-11 校验 AI 生成结果 / 导入外部 DSL） */
  types(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 全局默认注册表（内置组件在 components/index.ts 中注册） */
export const componentRegistry = new ComponentRegistry();

/** 自定义组件注册入参（运行时注册，T3-04 验收项） */
export interface CustomComponentInput {
  meta: ComponentMeta;
  renderer?: ComponentType<ComponentRenderProps>;
}

export function registerCustomComponent(input: CustomComponentInput, registry: ComponentRegistry = componentRegistry): ComponentMeta {
  const meta: ComponentMeta = { ...input.meta, group: input.meta.group ?? '自定义' };
  registry.override({ meta, ...(input.renderer !== undefined ? { renderer: input.renderer } : {}) });
  return meta;
}
