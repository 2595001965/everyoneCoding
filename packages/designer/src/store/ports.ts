import type { DslStorePort } from '../dsl/serialize';
import type { PageDsl, RouteEntry } from '../dsl/types';

/**
 * 设计器的外部依赖端口（依赖注入，禁止直接 import 具体实现）。
 *
 * 与 `features/settings` 的 `AiSettingsApi`、`features/memory` 的 `MemoryApi` 同一套做法：
 * - 渲染层与设计器领域层只认这些接口；
 * - 生产环境由外壳（Electron 主进程 / Tauri 命令层）适配到 `@ec/memory`、`@ec/ai`、`@ec/preview`；
 * - 组件与领域测试注入内存假实现，既不碰 SQLite 也不发起网络请求。
 *
 * 特别说明（重要）：设计器**不直接依赖 `@ec/memory`**。
 * 记忆包根入口会传递依赖 `@ec/data`（better-sqlite3），一旦被渲染层运行时引用，
 * 浏览器构建就会引入 Node 原生模块。因此精简沉淀、项目记忆写入一律走下面的端口。
 */

/** 页面记忆写入（外壳适配 @ec/memory 的 T2-06 精简器 + PageMemoryService） */
export interface PageMemoryPort {
  /** 结构摘要写入页面记忆；实现方负责精简、去重与版本号 */
  writePageStructure(input: {
    projectId: string;
    pageId: string;
    dsl: PageDsl;
  }): void | Promise<void>;
  /** 读取最近若干次结构变更（供 StructurePreview 展示） */
  listStructureRevisions?(
    pageId: string,
  ): Array<{ revision: number; tokenEstimate: number; createdAt: number; changed?: string[] }>;
}

/** 项目记忆的路由总表读写（外壳适配 ProjectMemoryService.mergeRoutes） */
export interface ProjectRouteMemoryPort {
  /** 合并写入路由总表（写前读、合并、写回，带乐观锁由实现方负责） */
  upsertRoutes(input: { projectId: string; routes: readonly RouteEntry[] }): void | Promise<void>;
  /** 读取现有路由（冲突检测与展示） */
  readRoutes?(projectId: string): readonly RouteEntry[];
}

/** AI 生成界面的请求 / 结果（T3-11） */
export interface GenerationRequest {
  /** 自然语言描述 */
  prompt: string;
  projectId: string;
  platform: PageDsl['platform'];
  route: string;
  /** 上传的草图（dataURL 或本地路径），仅在 supportsVision 时允许 */
  sketch?: { kind: 'dataUrl' | 'path'; value: string };
  /** 目标元素规模提示 */
  elementBudget?: number;
}

export interface GenerationResult {
  /** 模型返回的候选 JSON（未校验） */
  candidate: unknown;
  /** 原始文本（解析失败时用于降级展示） */
  raw: string;
  /** 使用的模型标识（用于可解释性） */
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

/** 界面生成端口（外壳适配 @ec/ai 网关的 interface 用途） */
export interface DesignGenerationPort {
  /** 是否具备视觉能力（false 时 UI 禁用草图上传，T3-11 验收） */
  readonly supportsVision: boolean;
  generatePage(request: GenerationRequest): Promise<GenerationResult>;
}

/** 预览数据层（T3-09 flow-runtime 的 request 动作消费） */
export interface IRequester {
  request(input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; data: unknown }>;
}

/** 符号索引端口（T3-09 校验 request 动作引用的接口是否已定义） */
export interface ApiCatalogPort {
  /** 返回项目已定义的接口清单（功能记忆 / 接口清单） */
  listApis(projectId: string): readonly string[];
}

/** 动作流运行时上下文依赖 */
export interface FlowRuntimePorts {
  requester?: IRequester;
  /** 页面路由表（navigate 动作的目标存在性校验与执行） */
  routes?: () => readonly RouteEntry[];
  /** 提示消息（toast 动作） */
  notify?: (input: { type: 'success' | 'error' | 'info' | 'warning'; message: string }) => void;
  /** 导航执行（预览模式） */
  navigate?: (path: string, params?: Record<string, unknown>) => void;
}

/** 设计器的全部可注入依赖 */
export interface DesignerPorts {
  /** DSL 文件读写（生产由 @ec/core FileService 满足） */
  files?: DslStorePort;
  /** 页面记忆 */
  memory?: PageMemoryPort;
  /** 项目记忆 */
  projectMemory?: ProjectRouteMemoryPort;
  /** AI 生成界面 */
  design?: DesignGenerationPort;
  /** 预览数据层 */
  requester?: IRequester;
  /** 项目接口清单 */
  apiCatalog?: ApiCatalogPort;
  /** 动作流运行时 */
  flow?: FlowRuntimePorts;
  /** 时钟注入（快照定时、时间戳），便于测试可控 */
  clock?: () => number;
  /** 空闲检测（自动快照只在空闲时执行） */
  isIdle?: () => boolean;
}

/** 空端口集合：所有能力缺省不可用，UI 据此禁用入口而不是崩溃 */
export const EMPTY_PORTS: DesignerPorts = {};
