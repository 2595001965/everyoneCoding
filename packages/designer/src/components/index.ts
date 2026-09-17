/**
 * 组件库桶文件（T3-04）。
 *
 * 汇总 12 类基础组件 + 3 类业务组件的元信息与渲染器，并通过
 * `registerBuiltinComponents()` 注册到指定注册表（默认全局单例）。
 * 导出 `BUILTIN_COMPONENT_METAS` 供测试与 AI 组件白名单直接消费。
 */

import type {
  ComponentMeta,
  ComponentRegistration,
  ComponentRegistry,
} from '../registry/component-registry';
import { componentRegistry } from '../registry/component-registry';

import { ButtonMeta, ButtonRenderer } from './Button';
import { ContainerMeta, ContainerRenderer } from './Container';
import { FormMeta, FormRenderer } from './Form';
import { ImageMeta, ImageRenderer } from './Image';
import { InputMeta, InputRenderer } from './Input';
import { ListMeta, ListRenderer } from './List';
import { ModalMeta, ModalRenderer } from './Modal';
import { NavbarMeta, NavbarRenderer } from './Navbar';
import { SelectMeta, SelectRenderer } from './Select';
import { TableMeta, TableRenderer } from './Table';
import { TabsMeta, TabsRenderer } from './Tabs';
import { TextMeta, TextRenderer } from './Text';
import { LoginCardMeta, LoginCardRenderer } from './business/LoginCard';
import { DashboardTemplateMeta, DashboardTemplateRenderer } from './business/DashboardTemplate';
import { ListPageTemplateMeta, ListPageTemplateRenderer } from './business/ListPageTemplate';

export { ButtonMeta, ButtonRenderer } from './Button';
export { ContainerMeta, ContainerRenderer } from './Container';
export { FormMeta, FormRenderer } from './Form';
export { ImageMeta, ImageRenderer } from './Image';
export { InputMeta, InputRenderer } from './Input';
export { ListMeta, ListRenderer } from './List';
export { ModalMeta, ModalRenderer } from './Modal';
export { NavbarMeta, NavbarRenderer } from './Navbar';
export { SelectMeta, SelectRenderer } from './Select';
export { TableMeta, TableRenderer } from './Table';
export { TabsMeta, TabsRenderer } from './Tabs';
export { TextMeta, TextRenderer } from './Text';
export { LoginCardMeta, LoginCardRenderer } from './business/LoginCard';
export { DashboardTemplateMeta, DashboardTemplateRenderer } from './business/DashboardTemplate';
export { ListPageTemplateMeta, ListPageTemplateRenderer } from './business/ListPageTemplate';

/** 全部内置组件元信息（固定顺序，便于面板分组与白名单） */
export const BUILTIN_COMPONENT_METAS: ComponentMeta[] = [
  ContainerMeta,
  TextMeta,
  ImageMeta,
  ButtonMeta,
  InputMeta,
  SelectMeta,
  TableMeta,
  ListMeta,
  FormMeta,
  ModalMeta,
  TabsMeta,
  NavbarMeta,
  LoginCardMeta,
  DashboardTemplateMeta,
  ListPageTemplateMeta,
];

/** 元信息 → 注册项 */
function toRegistration(
  meta: ComponentMeta,
  renderer: ComponentRegistration['renderer'],
): ComponentRegistration {
  return { meta, ...(renderer !== undefined ? { renderer } : {}) };
}

/** 注册全部内置组件到指定注册表（默认全局单例） */
export function registerBuiltinComponents(registry: ComponentRegistry = componentRegistry): void {
  for (const meta of BUILTIN_COMPONENT_METAS) {
    if (!registry.has(meta.type)) registry.register(toRegistration(meta, rendererFor(meta.type)));
  }
}

/** 按类型取渲染器（与元信息一一对应） */
function rendererFor(type: string): ComponentRegistration['renderer'] {
  switch (type) {
    case 'Container':
      return ContainerRenderer;
    case 'Text':
      return TextRenderer;
    case 'Image':
      return ImageRenderer;
    case 'Button':
      return ButtonRenderer;
    case 'Input':
      return InputRenderer;
    case 'Select':
      return SelectRenderer;
    case 'Table':
      return TableRenderer;
    case 'List':
      return ListRenderer;
    case 'Form':
      return FormRenderer;
    case 'Modal':
      return ModalRenderer;
    case 'Tabs':
      return TabsRenderer;
    case 'Navbar':
      return NavbarRenderer;
    case 'LoginCard':
      return LoginCardRenderer;
    case 'DashboardTemplate':
      return DashboardTemplateRenderer;
    case 'ListPageTemplate':
      return ListPageTemplateRenderer;
    default:
      return undefined;
  }
}
