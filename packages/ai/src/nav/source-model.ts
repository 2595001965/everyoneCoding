import type { CodeAnchor } from '../anchors';

/**
 * 导航与跳转（T6-07）中立输入模型与数据源端口。
 *
 * 这一层是**纯逻辑 + 端口注入**：不依赖任何 Node 侧实现（无 `node:*` / `better-sqlite3` /
 * `ts-morph`），可安全进入 `browser.ts` 被渲染层引用。所有外部数据（锚点、页面、接口、
 * 数据表、测试用例、技术文档、后端模块、代码文件）都通过 `NavSourcePort` 由外壳注入，
 * 导航层只做只读查询与纯计算。
 */

/** 跳转目标类型（FR-NAV-02 的四类 + 元素 / 页面 / 后端模块） */
export type NavTargetKind =
  | 'backend-api'
  | 'backend-module'
  | 'db-table'
  | 'test-case'
  | 'doc-section'
  | 'element'
  | 'page';

/** 跳转目标类型中文标签 */
export const NAV_TARGET_LABELS: Record<NavTargetKind, string> = {
  'backend-api': '后端接口',
  'backend-module': '后端模块',
  'db-table': '数据库表',
  'test-case': '测试用例',
  'doc-section': '技术文档章节',
  element: '页面元素',
  page: '页面',
};

/** 单条可跳转目标（悬停 / Ctrl+点击 / 关系图通用） */
export interface NavTarget {
  /** 稳定 id（kind + 关键字段拼出，例如 `anchor:anc-1` / `api:api-login`） */
  id: string;
  kind: NavTargetKind;
  /** 中文 / 原名展示 */
  label: string;
  /** 副标题（如文件相对路径 + 符号） */
  detail: string;
  /** 工作区相对路径（设计器元素 / 页面为 null） */
  filePath: string | null;
  symbol: string | null;
  startLine: number | null;
  endLine: number | null;
  /**
   * 层级：Controller 方法=0 → Service=1 → 数据访问层=2 → 测试=3 → 其它=4
   * 用于跳转下拉的分组排序。
   */
  layer: number;
  /** 相关度原始分（未封顶，0 以上；越大越靠前） */
  score: number;
  /** 命中理由，用于可解释性展示（例如 "锚点置信度 0.9" / "命名匹配 login" / "就近 同文件"） */
  reasons: string[];
}

/**
 * 候选过滤：按类型 / 关键词 / 数量上限裁剪，返回新数组（不修改入参）。
 * 关键词同时匹配 label / detail / kind / reasons，便于 UI 做统一检索。
 */
export function filterNavTargets(
  targets: readonly NavTarget[],
  options: { kinds?: readonly NavTargetKind[]; keyword?: string; limit?: number },
): NavTarget[] {
  let result: NavTarget[] = [...targets];

  if (options.kinds !== undefined && options.kinds.length > 0) {
    const allowed = new Set(options.kinds);
    result = result.filter((target) => allowed.has(target.kind));
  }

  if (options.keyword !== undefined) {
    const keyword = options.keyword.trim().toLowerCase();
    if (keyword.length > 0) {
      result = result.filter((target) => {
        const haystack = `${target.label} ${target.detail} ${target.kind} ${target.reasons.join(' ')}`.toLowerCase();
        return haystack.includes(keyword);
      });
    }
  }

  if (options.limit !== undefined && options.limit > 0) {
    result = result.slice(0, options.limit);
  }

  return result;
}

/* ------------------------------ 设计器投影 ------------------------------ */

/** 设计器元素轻量投影 */
export interface NavElementRef {
  elementId: string;
  name: string;
  type: string;
  pageId: string;
  pageName: string;
}

/** 设计器页面轻量投影 */
export interface NavPageRef {
  pageId: string;
  name: string;
  route: string;
  featureId: string | null;
  elements: readonly NavElementRef[];
  apiDeps: readonly string[];
}

/** 后端接口清单项 */
export interface NavApiRef {
  id: string;
  name: string;
  method: string;
  path: string;
  module: string | null;
}

/** 数据库表清单项 */
export interface NavTableRef {
  id: string;
  name: string;
  module: string | null;
  columns?: readonly string[];
}

/** 测试用例清单项 */
export interface NavTestRef {
  id: string;
  name: string;
  filePath: string;
  coversApi: string | null;
}

/** 技术文档章节清单项 */
export interface NavDocSectionRef {
  id: string;
  title: string;
  documentId: string;
  documentTitle: string;
  anchor: string;
}

/** 后端模块清单项 */
export interface NavModuleRef {
  id: string;
  name: string;
  filePath: string;
  role: 'controller' | 'service' | 'repo' | 'other';
}

/**
 * 供外部（外壳）注入的数据源：全部为只读查询。
 * 禁止在此发起网络请求或文件写入——生产环境由外壳把 `@ec/memory` 的各类表映射成这些投影。
 */
export interface NavSourcePort {
  /** 全量锚点（生产由 shell 把 @ec/memory 的 code_anchor 表映射成 CodeAnchor） */
  listAnchors(): readonly CodeAnchor[];
  /** 页面与元素（设计器 DSL 的轻量投影） */
  listPages(): readonly NavPageRef[];
  /** 后端接口清单（技术文档 / 功能记忆） */
  listApis(): readonly NavApiRef[];
  /** 数据库表清单 */
  listTables(): readonly NavTableRef[];
  /** 测试用例清单 */
  listTests(): readonly NavTestRef[];
  /** 技术文档章节清单 */
  listDocSections(): readonly NavDocSectionRef[];
  /** 后端模块清单 */
  listModules(): readonly NavModuleRef[];
  /** 读取代码文件内容（只读；用于反向跳转扫描 anchor 注释标记） */
  readFile(path: string): string | null;
  /** 代码文件清单（只读） */
  listCodeFiles(): readonly string[];
}

/**
 * 空实现：外壳未注入时 UI 展示引导而不是崩溃。
 * 所有查询返回空，文件读取返回 null。
 */
export const EMPTY_NAV_SOURCE: NavSourcePort = {
  listAnchors: () => [],
  listPages: () => [],
  listApis: () => [],
  listTables: () => [],
  listTests: () => [],
  listDocSections: () => [],
  listModules: () => [],
  readFile: () => null,
  listCodeFiles: () => [],
};
