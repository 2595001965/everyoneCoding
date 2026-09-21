import { createContext, useContext, type ReactNode } from 'react';

import type { AssembledContext, ContextAssemblyRequest, ContextSources } from '@ec/ai';

/**
 * 上下文面板的端口（与记忆中心 `MemoryApi`、设置页 `AiSettingsApi` 同一套做法）。
 *
 * 为什么不让面板直接 new 一个 ContextEngine：
 * - 引擎需要 `ContextSources`（记忆 / 备注 / 设计器 / 文档 / 代码五个端口），
 *   这些端口的真实装配属于外壳（Electron 主进程 / Tauri 命令层）的职责；
 * - 备注来自 `@ec/designer`、记忆来自 `@ec/memory`，渲染层同时静态引入两者
 *   会把 better-sqlite3 拉进浏览器构建（Wave 2/3 已踩过）。
 *
 * 因此渲染层只认 {@link ContextPanelApi}，实现由外壳注入 `globalThis.__EC_AI_CONTEXT__`。
 */
export interface ContextPanelApi {
  /** 执行一次上下文组装（外壳内部持有 ContextEngine 与端口装配） */
  assemble(request: ContextAssemblyRequest): Promise<AssembledContext>;
  /** 端口是否就绪；false 时面板展示装配引导而不是空白 */
  readonly ready: boolean;
  /** 未就绪原因（面板顶部提示） */
  readonly reason?: string | undefined;
  /** 已装配的端口名（面板据此说明"哪些块会有内容"） */
  readonly availableSources?: readonly (keyof ContextSources)[] | undefined;
}

const ContextPanelContext = createContext<ContextPanelApi | null>(null);

export interface ContextPanelProviderProps {
  api: ContextPanelApi | null;
  children: ReactNode;
}

export function ContextPanelProvider({ api, children }: ContextPanelProviderProps): JSX.Element {
  return <ContextPanelContext.Provider value={api}>{children}</ContextPanelContext.Provider>;
}

/** 取实现；未注入返回 null（页面据此展示引导） */
export function useContextPanelOptional(): ContextPanelApi | null {
  return useContext(ContextPanelContext);
}

export function useContextPanelApi(): ContextPanelApi {
  const api = useContextPanelOptional();
  if (api === null) throw new Error('上下文面板未初始化：请先注入 ContextPanelApi');
  return api;
}

/** 端口注入键（外壳装配时写入；与 code-api / designer-api 同一约定） */
export const CONTEXT_API_GLOBAL_KEY = '__EC_AI_CONTEXT__';

/** 从全局读取外壳注入的实现（页面用） */
export function readInjectedContextApi(): ContextPanelApi | null {
  const injected = (globalThis as unknown as { __EC_AI_CONTEXT__?: ContextPanelApi })
    .__EC_AI_CONTEXT__;
  if (typeof injected !== 'object' || injected === null) return null;
  return typeof injected.assemble === 'function' ? injected : null;
}
