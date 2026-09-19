/**
 * page-store：多页面集合状态（T3-07）。
 *
 * 职责：管理 PageDsl[]（多页面） + activePageId；提供页面的增删改查与回收站。
 * 设计约束：
 * - **不修改** store/editor-store.ts；本文件是独立的「多页面集合」状态层；
 * - 删除走**软删除**（进回收站），restorePage 可恢复，等价于「可撤销」；
 * - 内置页面模板（空白 / 登录 / 列表 / 详情 / 仪表盘）+ 复制现有页面作为模板。
 *
 * 组件通过 `MultiPageProvider` 注入实例，并经由 `useMultiPageStore` / `useMultiPageSnapshot`
 * 读取；测试可直接 new MultiPageStore() 使用（不依赖 React）。
 */
import * as React from 'react';

import { createElement, createEmptyPage, createLoginPageDsl, createPageDsl } from '../dsl/factory';
import { PLATFORMS } from '../dsl/types';
import type { PageDsl, Platform } from '../dsl/types';

export type PageTemplateId = 'blank' | 'login' | 'list' | 'detail' | 'dashboard';

export interface PageTemplateMeta {
  id: PageTemplateId;
  name: string;
  description: string;
}

/** 内置页面模板清单 */
export const PAGE_TEMPLATES: readonly PageTemplateMeta[] = [
  { id: 'blank', name: '空白页', description: '仅一个根容器' },
  { id: 'login', name: '登录页', description: '手机号 + 密码登录表单' },
  { id: 'list', name: '列表页', description: '标题 + 列表' },
  { id: 'detail', name: '详情页', description: '标题 + 详情卡片 + 操作' },
  { id: 'dashboard', name: '仪表盘', description: '标题 + 多卡片指标' },
] as const;

function cloneDsl(dsl: PageDsl): PageDsl {
  return JSON.parse(JSON.stringify(dsl)) as PageDsl;
}

/** 依据模板构造一个页面 DSL（id / projectId / route 由调用方给定） */
export function createPageFromTemplate(
  templateId: PageTemplateId,
  options: { id: string; projectId: string; name?: string; platform?: Platform; route?: string },
): PageDsl {
  const { id, projectId, name, platform = 'web', route } = options;
  switch (templateId) {
    case 'login': {
      const base = createLoginPageDsl();
      return { ...base, id, projectId, name: name ?? '登录页', route: route ?? `/${id}` };
    }
    case 'list': {
      const tree = createElement({
        id: `${id}-root`,
        type: 'Container',
        name: '页面',
        children: [
          createElement({
            id: `${id}-title`,
            type: 'Title',
            name: '标题',
            props: { text: name ?? '列表' },
          }),
          createElement({
            id: `${id}-list`,
            type: 'List',
            name: '列表',
            children: [1, 2, 3].map((i) =>
              createElement({ id: `${id}-item-${i}`, type: 'ListItem', name: `列表项 ${i}` }),
            ),
          }),
        ],
      });
      return createPageDsl({
        id,
        projectId,
        name: name ?? '列表页',
        platform,
        route: route ?? `/${id}`,
        tree,
      });
    }
    case 'detail': {
      const tree = createElement({
        id: `${id}-root`,
        type: 'Container',
        name: '页面',
        children: [
          createElement({
            id: `${id}-title`,
            type: 'Title',
            name: '标题',
            props: { text: name ?? '详情' },
          }),
          createElement({
            id: `${id}-card`,
            type: 'Card',
            name: '详情卡片',
            children: [
              createElement({
                id: `${id}-field1`,
                type: 'Text',
                name: '字段一',
                props: { text: '值一' },
              }),
              createElement({
                id: `${id}-field2`,
                type: 'Text',
                name: '字段二',
                props: { text: '值二' },
              }),
              createElement({
                id: `${id}-action`,
                type: 'Button',
                name: '操作按钮',
                props: { text: '提交' },
              }),
            ],
          }),
        ],
      });
      return createPageDsl({
        id,
        projectId,
        name: name ?? '详情页',
        platform,
        route: route ?? `/${id}`,
        tree,
      });
    }
    case 'dashboard': {
      const tree = createElement({
        id: `${id}-root`,
        type: 'Container',
        name: '页面',
        children: [
          createElement({
            id: `${id}-title`,
            type: 'Title',
            name: '标题',
            props: { text: name ?? '仪表盘' },
          }),
          createElement({
            id: `${id}-row`,
            type: 'Container',
            name: '指标行',
            children: [1, 2, 3].map((i) =>
              createElement({
                id: `${id}-metric-${i}`,
                type: 'Card',
                name: `指标卡 ${i}`,
                children: [
                  createElement({
                    id: `${id}-metric-${i}-v`,
                    type: 'Text',
                    name: '数值',
                    props: { text: `${i * 10}` },
                  }),
                ],
              }),
            ),
          }),
        ],
      });
      return createPageDsl({
        id,
        projectId,
        name: name ?? '仪表盘',
        platform,
        route: route ?? `/${id}`,
        tree,
      });
    }
    case 'blank':
    default:
      return createEmptyPage({
        id,
        projectId,
        name: name ?? '空白页',
        platform,
        route: route ?? `/${id}`,
      });
  }
}

export interface MultiPageSnapshot {
  pages: PageDsl[];
  activePageId: string | null;
  /** 回收站（软删除的页面，可恢复） */
  trash: PageDsl[];
}

export interface CreatePageInput {
  id: string;
  projectId: string;
  name?: string;
  platform?: Platform;
  route?: string;
  template?: PageTemplateId;
  /** 以现有页面作为模板复制 */
  sourceDsl?: PageDsl;
}

/**
 * 多页面集合状态（纯 JS 类，可被 React 直接订阅，也可在测试中独立使用）。
 */
export class MultiPageStore {
  private state: MultiPageSnapshot;
  private listeners = new Set<() => void>();

  constructor(initial?: { pages?: PageDsl[]; activePageId?: string | null }) {
    const pages = initial?.pages ?? [];
    this.state = {
      pages,
      activePageId: initial?.activePageId ?? pages[0]?.id ?? null,
      trash: [],
    };
  }

  getSnapshot = (): MultiPageSnapshot => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  private set(next: MultiPageSnapshot): void {
    this.state = next;
    this.listeners.forEach((cb) => cb());
  }

  /** 非回收站页面列表 */
  list(): PageDsl[] {
    return this.state.pages;
  }

  /** 回收站页面列表 */
  getTrash(): PageDsl[] {
    return this.state.trash;
  }

  active(): PageDsl | null {
    return this.state.pages.find((p) => p.id === this.state.activePageId) ?? null;
  }

  /** 按端分组（排除回收站） */
  pagesByPlatform(): Record<Platform, PageDsl[]> {
    const groups = {} as Record<Platform, PageDsl[]>;
    for (const platform of PLATFORMS) groups[platform] = [];
    for (const page of this.state.pages) groups[page.platform].push(page);
    return groups;
  }

  createPage(input: CreatePageInput): PageDsl {
    let dsl: PageDsl;
    if (input.sourceDsl) {
      dsl = cloneDsl(input.sourceDsl);
      dsl.id = input.id;
      dsl.projectId = input.projectId;
      dsl.name = input.name ?? `${input.sourceDsl.name} 副本`;
      dsl.route = input.route ?? `${input.sourceDsl.route}-copy`;
    } else {
      const templateOptions: {
        id: string;
        projectId: string;
        name?: string;
        platform?: Platform;
        route?: string;
      } = { id: input.id, projectId: input.projectId };
      if (input.name !== undefined) templateOptions.name = input.name;
      if (input.platform !== undefined) templateOptions.platform = input.platform;
      if (input.route !== undefined) templateOptions.route = input.route;
      dsl = createPageFromTemplate(input.template ?? 'blank', templateOptions);
    }
    this.set({ ...this.state, pages: [...this.state.pages, dsl], activePageId: dsl.id });
    return dsl;
  }

  renamePage(id: string, name: string): void {
    this.set({
      ...this.state,
      pages: this.state.pages.map((p) => (p.id === id ? { ...p, name } : p)),
    });
  }

  duplicatePage(id: string): PageDsl | null {
    const source = this.state.pages.find((p) => p.id === id);
    if (!source) return null;
    const newId = `${id}-copy-${this.state.pages.length + 1}`;
    const copy = cloneDsl(source);
    copy.id = newId;
    copy.name = `${source.name} 副本`;
    copy.route = `${source.route}-copy`;
    this.set({ ...this.state, pages: [...this.state.pages, copy], activePageId: newId });
    return copy;
  }

  /** 软删除：移入回收站（可恢复） */
  removePage(id: string): void {
    const target = this.state.pages.find((p) => p.id === id);
    if (!target) return;
    const pages = this.state.pages.filter((p) => p.id !== id);
    const activePageId =
      this.state.activePageId === id ? (pages[0]?.id ?? null) : this.state.activePageId;
    this.set({ pages, activePageId, trash: [...this.state.trash, target] });
  }

  /** 从回收站恢复 */
  restorePage(id: string): void {
    const target = this.state.trash.find((p) => p.id === id);
    if (!target) return;
    const trash = this.state.trash.filter((p) => p.id !== id);
    const pages = this.state.pages.some((p) => p.id === id)
      ? this.state.pages
      : [...this.state.pages, target];
    this.set({ pages, activePageId: this.state.activePageId ?? target.id, trash });
  }

  setActive(id: string): void {
    if (!this.state.pages.some((p) => p.id === id)) return;
    this.set({ ...this.state, activePageId: id });
  }

  /** 整体替换某页面 DSL（路由编辑等写回使用） */
  updatePageDsl(id: string, dsl: PageDsl): void {
    this.set({
      ...this.state,
      pages: this.state.pages.map((p) => (p.id === id ? dsl : p)),
    });
  }
}

/** 模块默认实例：未显式注入 Provider 时使用，避免组件崩溃 */
export const multiPageStore: MultiPageStore = new MultiPageStore();

const PageStoreContext = React.createContext<MultiPageStore | null>(null);

export interface MultiPageProviderProps {
  store?: MultiPageStore;
  children: React.ReactNode;
}

export function MultiPageProvider({ store, children }: MultiPageProviderProps): React.ReactElement {
  return React.createElement(
    PageStoreContext.Provider,
    { value: store ?? multiPageStore },
    children,
  );
}

export function useMultiPageStore(): MultiPageStore {
  return React.useContext(PageStoreContext) ?? multiPageStore;
}

/** 订阅多页面快照（useSyncExternalStore 保证并发安全） */
export function useMultiPageSnapshot(): MultiPageSnapshot {
  const store = useMultiPageStore();
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
}
