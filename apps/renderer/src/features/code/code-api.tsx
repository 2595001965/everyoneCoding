import { createContext, useContext, type ReactNode } from 'react';

import type { GenerationOutput, WriteMode, WritePlan, WriteResult } from '@ec/ai';
import type { ApiEditTargetRequest } from '@ec/registry';

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
  apply(plan: WritePlan, confirmation?: { migrationConfirmed?: boolean }): Promise<WriteResult>;
  /** 把重改要求交回 AI 对话（预填上下文） */
  requestRework(request: ReworkRequest): Promise<void>;
  /**
   * 以已组装的上下文生成代码（真实模型、流式；FR-AI-03/05/06）。
   * 成功时同时经 `subscribeWritePlan` 回流计划（source = 'generate'）。
   * 可选：未装配 AI 的外壳不提供，UI 据此隐藏入口并给出引导。
   */
  generate?(request: CodeGenerateRequest): Promise<CodeGenerateResult>;
  /** 中断进行中的生成（已生成部分保留，可「继续生成」） */
  abortGeneration?(): Promise<boolean>;
}

export type CodeGenerationTarget =
  'backend-code' | 'frontend-code' | 'mobile-code' | 'harmony-code' | 'desktop-code';

export interface CodeGenerateRequest {
  /** 上下文面板组装结果的 system / user（用户可能已就地编辑过） */
  system?: string;
  user?: string;
  target?: CodeGenerationTarget;
  noteIds?: readonly string[];
  /** V2-D09 API / verified runtime-element target; the main process resolves it again. */
  apiEditTarget?: ApiEditTargetRequest;
  /** D07 isolated task snapshot; current preserves local uncommitted work by default. */
  baseline?: 'head' | 'current';
  /** true = 从上次被中断处继续 */
  continue?: boolean;
}

export interface CodeGenerateResult {
  status: 'planned' | 'aborted' | 'degraded';
  plan: WritePlan | null;
  raw: string;
  partial: boolean;
  attempts: number;
  model: string | null;
  summary: string | null;
  issues: readonly string[];
}

/** 生成流事件（开始 / 增量 / 结束） */
export type CodeGenerationEvent =
  | { type: 'started'; target: string; resumed: boolean }
  | { type: 'delta'; text: string }
  | { type: 'done'; status: CodeGenerateResult['status'] };

export interface ExternalChangeHint {
  path: string;
  /** 展示文案 */
  message: string;
  actions: readonly { key: 'rollback' | 'regenerate'; label: string }[];
}

/**
 * AI 重改产生的写入计划（两段式回执）。
 *
 * `requestRework` 的返回类型是 `Promise<void>`：一次重改要经过"真实模型调用 →
 * 输出契约解析 → 生成计划"三段，耗时不可控，且计划**不能由主进程自行落盘**
 * （必须先给人看 diff）。因此计划经域事件回流，由 UI 渲染 DiffView，
 * 用户确认后再调 `write.apply` 走同一份事务。
 */
export interface WritePlanHint {
  plan: WritePlan;
  /** 计划来源：'rework' = 由「交给 AI 修改」触发 */
  source: string;
}

export interface CodeViewApi {
  files: CodeFileApi;
  write: CodeWriteApi;
  /** 订阅外部改动提示（可选：未接入时为 null） */
  subscribeExternalChanges?(listener: (change: ExternalChangeHint) => void): () => void;
  /** 订阅 AI 重改产出的写入计划（未接入时不订阅） */
  subscribeWritePlan?(listener: (hint: WritePlanHint) => void): () => void;
  /** 订阅代码生成流（未接入时不订阅） */
  subscribeGeneration?(listener: (event: CodeGenerationEvent) => void): () => void;
  /** Persistent D06/D07 agent sessions and asynchronous task commands. */
  agent?: AgentTaskApi;
}

export interface AgentTaskRecord {
  task: {
    taskId: string;
    sessionId: string | null;
    objective: string;
    status: string;
    updatedAt: number;
  };
  executionState: string;
  result: unknown;
  error: string | null;
}

export interface AgentTaskSnapshot {
  session: { sessionId: string; title: string | null; status: string } | null;
  tasks: AgentTaskRecord[];
  events: Array<{
    eventId: string;
    type: string;
    occurredAt: number;
    taskId: string | null;
    payload: unknown;
  }>;
  cursor: number;
}

export interface AgentTaskApi {
  startTask(input: {
    projectId: string;
    sessionId: string;
    idempotencyKey: string;
    objective: string;
  }): Promise<AgentTaskRecord>;
  snapshot(projectId: string, sessionId: string, after: number): Promise<AgentTaskSnapshot>;
  cancel(projectId: string, taskId: string): Promise<boolean>;
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

/** 端口注入键（外壳装配时写入） */
export const CODE_API_GLOBAL_KEY = '__EC_CODE__';

/** 从全局读取外壳注入的实现 */
export function readInjectedCodeApi(): CodeViewApi | null {
  const injected = (globalThis as unknown as { __EC_CODE__?: CodeViewApi })[CODE_API_GLOBAL_KEY];
  if (typeof injected !== 'object' || injected === null) return null;
  return injected.files !== undefined && injected.write !== undefined ? injected : null;
}
