import { createContext, useContext, type ReactNode } from 'react';
import { useStore, type StoreApi } from 'zustand';

import { editorStore, type EditorStore } from './editor-store';
import { EMPTY_PORTS, type DesignerPorts } from './ports';

/**
 * 设计器的依赖注入 Context（T3-01 之后的共享装配点）。
 *
 * - 组件通过 `useEditorState(selector)` 订阅文档 / 交互态；
 * - 通过 `useDesignerPorts()` 取外部能力（记忆、AI、预览）；
 * - 未注入任何东西时回退到模块单例 + 空端口集合 —— 页面展示引导而不是崩溃。
 */

export interface DesignerContextValue {
  store: StoreApi<EditorStore>;
  ports: DesignerPorts;
}

const DesignerContext = createContext<DesignerContextValue | null>(null);

export interface DesignerProviderProps {
  children: ReactNode;
  /** 缺省使用模块单例 */
  store?: StoreApi<EditorStore>;
  ports?: DesignerPorts;
}

export function DesignerProvider({ children, store, ports }: DesignerProviderProps): JSX.Element {
  const value: DesignerContextValue = { store: store ?? editorStore, ports: ports ?? EMPTY_PORTS };
  return <DesignerContext.Provider value={value}>{children}</DesignerContext.Provider>;
}

/** 取完整上下文（缺省回退到单例，保证组件在未被包裹时也能渲染） */
export function useDesignerContext(): DesignerContextValue {
  return useContext(DesignerContext) ?? { store: editorStore, ports: EMPTY_PORTS };
}

export function useDesignerStore(): StoreApi<EditorStore> {
  return useDesignerContext().store;
}

export function useDesignerPorts(): DesignerPorts {
  return useDesignerContext().ports;
}

/** 订阅编辑器状态切片 */
export function useEditorState<T>(selector: (state: EditorStore) => T): T {
  return useStore(useDesignerStore(), selector);
}
