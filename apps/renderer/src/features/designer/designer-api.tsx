/**
 * 设计器端口（T12-01 / T12-02）。
 *
 * 与 `GitApi` / `PreviewApi` 同一套做法：渲染层只认这个 `DesignerPortApi` 接口，
 * 真实实现由外壳经 `globalThis.__EC_DESIGNER__` 注入（见 `readInjectedDesignerApi`）。
 * 渲染层**绝不**直接 import better-sqlite3 / node:fs —— DSL 落盘、页面表登记、
 * 页面记忆（含结构精简）都在外壳侧完成。
 *
 * 契约说明：
 * - DSL 以「信封 + 页面」结构跨进程（`{ dslVersion, page }`，见 `@ec/designer` 的
 *   `DslEnvelope`），页面本体须先过 `@ec/designer` 的 zod 校验再落盘（外壳侧职责）；
 * - `writePageStructure` 只传 DSL 原文：结构摘要由外壳用 `@ec/memory` 的精简器生成，
 *   渲染层的 browser 入口不含 condenser（Wave 2 的 better-sqlite3 污染教训）。
 */
export interface DesignerPortApi {
  /** 打开项目（幂等建出工程目录与页面目录） */
  openProject(projectId: string): Promise<{ projectId: string }>;
  /** 页面清单（文件系统扫描，坏文件跳过） */
  listPages(projectId: string): Promise<readonly DesignerPageSummary[]>;
  /** 读取页面 DSL 信封 */
  loadPage(projectId: string, pageId: string): Promise<unknown>;
  /** 原子保存页面 DSL 信封（临时文件 → rename） */
  savePage(projectId: string, envelope: unknown): Promise<{ pageId: string; savedAt: number }>;
  /** 新建页面（登记 page 行 + 落 DSL 文件 + 登记重命名注册表） */
  createPage(
    projectId: string,
    input: { name: string; route: string; platform?: string },
  ): Promise<unknown>;
  /** 页面结构摘要写入页面记忆（外壳负责精简、去重与版本号） */
  writePageStructure(input: {
    projectId: string;
    pageId: string;
    pageName: string;
    route?: string;
    dsl: unknown;
  }): Promise<unknown>;
  /** 页面记忆的结构变更台账（供 StructurePreview 展示） */
  listStructureRevisions(pageId: string): Promise<DesignerStructureRevision[]>;
  /** 项目记忆的路由总表写入（写前读、合并、写回） */
  upsertRoutes(projectId: string, routes: readonly unknown[]): Promise<unknown>;
  /** 项目记忆的路由总表读取 */
  readRoutes(projectId: string): Promise<readonly unknown[]>;
  /** AI 生成页面候选（AI 栈未装配时外壳如实报 NOT_SUPPORTED + 引导） */
  generatePage(
    projectId: string,
    request: { prompt: string; platform?: string; route?: string },
  ): Promise<{
    candidate: unknown;
    raw: string;
    model: string;
    /**
     * 外壳侧对**原始候选**的校验结论（渲染层仍会走 `dslFromAi` 的归一化修复）。
     * 两者含义不同：这里是"模型给的 JSON 是否直接合规"，`dslFromAi` 是"能否救回来"。
     */
    validation?: { ok: boolean; issues: readonly string[] };
  }>;
  /** 备注（FR-ANN）读取：按项目 + 目标类型/目标 + 状态筛选 */
  readNotes(input: {
    projectId: string;
    targetType?: DesignerNoteTargetType;
    targetId?: string;
    status?: 'open' | 'resolved';
  }): Promise<readonly DesignerNoteRecord[]>;
  /** 备注新建（优先级由领域规则派生，禁止事项恒为最高） */
  saveNote(input: {
    projectId: string;
    targetType: DesignerNoteTargetType;
    targetId: string;
    type?: DesignerNoteType;
    title?: string;
    /** 纯文本快捷入口（自动切成段落块） */
    text?: string;
    manualPriority?: number | null;
  }): Promise<DesignerNoteRecord>;
  /** 备注修改（版本 +1、历史留痕由领域层负责） */
  updateNote(input: {
    projectId: string;
    id: string;
    patch: {
      type?: DesignerNoteType;
      title?: string;
      text?: string;
      status?: 'open' | 'resolved';
      manualPriority?: number | null;
    };
  }): Promise<DesignerNoteRecord>;
  /** 标记已解决 / 重新打开 */
  setNoteStatus(input: {
    projectId: string;
    id: string;
    status: 'open' | 'resolved';
  }): Promise<DesignerNoteRecord>;
  /** 物理删除（调用方负责二次确认） */
  removeNote(input: { projectId: string; id: string }): Promise<{ removed: boolean }>;
  /** 目标 id → 未解决备注数（元素角标与图层树图标） */
  noteBadges(input: {
    projectId: string;
    targetType: DesignerNoteTargetType;
  }): Promise<Record<string, number>>;
}

export const DESIGNER_NOTE_TARGET_TYPES = ['element', 'page', 'feature'] as const;
export type DesignerNoteTargetType = (typeof DESIGNER_NOTE_TARGET_TYPES)[number];

/** 六类备注（与 `@ec/designer/notes` 的 NoteType 对齐） */
export const DESIGNER_NOTE_TYPES = [
  'business_rule',
  'validation',
  'interaction',
  'todo',
  'question',
  'forbidden',
] as const;
export type DesignerNoteType = (typeof DESIGNER_NOTE_TYPES)[number];

/** 备注读取结果的最小契约（面板渲染用；完整对象由外壳透传） */
export interface DesignerNoteRecord {
  id: string;
  projectId: string;
  targetType: DesignerNoteTargetType;
  targetId: string;
  type: DesignerNoteType;
  title: string;
  status: 'open' | 'resolved';
  priority: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface DesignerPageSummary {
  pageId: string;
  name: string;
  route: string | null;
}

export interface DesignerStructureRevision {
  revision: number;
  tokenEstimate: number;
  createdAt: number;
}

/** 端口注入键（外壳装配时写入） */
export const DESIGNER_API_GLOBAL_KEY = '__EC_DESIGNER__';

/** 读取外壳注入的实现；未注入返回 null（页面展示装配引导） */
export function readInjectedDesignerApi(): DesignerPortApi | null {
  const injected = (globalThis as unknown as Record<string, unknown>)[DESIGNER_API_GLOBAL_KEY];
  if (typeof injected !== 'object' || injected === null) return null;
  const candidate = injected as Record<string, unknown>;
  const looksLikeApi =
    typeof candidate['listPages'] === 'function' && typeof candidate['savePage'] === 'function';
  return looksLikeApi ? (injected as DesignerPortApi) : null;
}
