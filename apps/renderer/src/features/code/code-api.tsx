import { createContext, useContext, type ReactNode } from 'react';

import type { GenerationOutput, WriteMode, WritePlan, WriteResult } from '@ec/ai';

/**
 * 代码视图的端口（与记忆中心 `MemoryApi`、上下文面板 `ContextPanelApi` 同一套做法）。
 *
 * 渲染层只认这些接口：真实实现由外壳装配（工作区文件服务 + WritePipeline +
 * ExternalChangeWatcher），未注入时展示初始化引导，而不是崩溃或伪造数据。
 *
 * 特别注意：**没有"保存代码"这类方法** —— 代码只能由 AI 写入（D-04）。
 * 界面上的任何修改诉求都必须走 {@link CodeWriteApi.requestRework}。
 */
export interface CodeFileEntry {
  path: string;
  language: string;
}

export interface CodeFileApi {
  /** 列出工作区可查看的代码文件（只读） */
  listFiles(): Promise<readonly CodeFileEntry[]>;
  /** 读取文件内容（只读；调用方负责按只读方式渲染） */
  readFile(path: string): Promise<string>;
}

export interface ReworkRequest {
  /** 已整理好的重改指令（由 `WritePipeline.buildReworkInstruction` 生成） */
  instruction: string;
  /** 选中范围的差异上下文 */
  context: string;
  /** 涉及文件 */
  paths: readonly string[];
}

export interface CodeWriteApi {
  /** 生成写入计划（不落盘；create / patch / preview 三种模式共用） */
  plan(input: {
    output: GenerationOutput;
    mode: WriteMode;
    noteIds?: readonly string[];
  }): Promise<WritePlan>;
  /** 应用计划（校验后由 AI 侧执行，事务性） */
  apply(plan: WritePlan): Promise<WriteResult>;
  /** 把重改要求交回 AI 对话（预填上下文） */
  requestRework(request: ReworkRequest): Promise<void>;
}

export interface ExternalChangeHint {
  path: string;
  /** 展示文案 */
  message: string;
  actions: readonly { key: 'rollback' | 'regenerate'; label: string }[];
}

export interface CodeViewApi {
  files: CodeFileApi;
  write: CodeWriteApi;
  /** 订阅外部改动提示（可选：未接入时为 null） */
  subscribeExternalChanges?(listener: (change: ExternalChangeHint) => void): () => void;
}

const CodeViewContext = createContext<CodeViewApi | null>(null);

export interface CodeViewProviderProps {
  api: CodeViewApi | null;
  children: ReactNode;
}

export function CodeViewProvider({ api, children }: CodeViewProviderProps): JSX.Element {
  return <CodeViewContext.Provider value={api}>{children}</CodeViewContext.Provider>;
}

export function useCodeViewOptional(): CodeViewApi | null {
  return useContext(CodeViewContext);
}

export function useCodeViewApi(): CodeViewApi {
  const api = useContext(CodeViewContext);
  if (api === null) throw new Error('代码视图未初始化：请先注入 CodeViewApi');
  return api;
}

/** 从全局读取外壳注入的实现 */
export function readInjectedCodeApi(): CodeViewApi | null {
  const injected = (globalThis as unknown as { __EC_CODE__?: CodeViewApi }).__EC_CODE__;
  if (typeof injected !== 'object' || injected === null) return null;
  return injected.files !== undefined && injected.write !== undefined ? injected : null;
}
