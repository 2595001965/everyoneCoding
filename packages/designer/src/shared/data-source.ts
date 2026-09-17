import type { ElementNode, PageDsl, PageStateVar, StateType } from '../dsl/types';
import { walkElements } from '../dsl/traverse';
import { collectExpressionPaths } from './expression';

/**
 * 页面数据源目录（T3-08 产出，T3-05 的 BindingPanel 消费）—— **跨模块冻结契约**。
 *
 * 职责：把「页面状态变量」与「接口响应字段」统一成可枚举的路径清单，
 * 供绑定选择器（BindingPicker）与属性面板的下拉展开，避免两处各写一套路径推导。
 */

/** 接口字段（用于路径展开） */
export interface DataField {
  name: string;
  type: StateType;
  children?: DataField[];
}

/** 页面状态定义（复用 DSL 的 PageStateVar，别名便于绑定面板语义化命名） */
export type StateDef = PageStateVar;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** 接口定义（来自页面 apiDeps 或项目接口清单） */
export interface ApiDef {
  id: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  /** 来源：页面 apiDeps 自动收集 / 项目接口清单（功能记忆） */
  source: 'apiDeps' | 'catalog';
  requestFields?: DataField[];
  responseFields?: DataField[];
}

/** 数据源目录 */
export interface DataSourceCatalog {
  pageId: string;
  states: StateDef[];
  apis: ApiDef[];
}

/** 平铺后的可选路径（BindingPicker 直接渲染） */
export interface DataSourceRef {
  kind: 'state' | 'api';
  /** 状态名或接口 id */
  id: string;
  /** 绑定表达式文本，如 `user.list[0].name` / `response.data.token` */
  path: string;
  /** 显示文案（中文） */
  label: string;
  type: string;
  /** 缩进层级（0 为根） */
  depth: number;
}

function methodFromPath(path: string): HttpMethod {
  // 无显式方法时按约定推断：/api/**/create|login|submit 等按 POST，其余 GET
  return /\/(create|update|delete|login|logout|submit|save|register|reset)\b/i.test(path) ? 'POST' : 'GET';
}

/** 构造接口定义（apiDeps 自动收集） */
export function apiDefFromPath(path: string, extra: Partial<ApiDef> = {}): ApiDef {
  return {
    id: path,
    method: extra.method ?? methodFromPath(path),
    path,
    source: extra.source ?? 'apiDeps',
    ...(extra.summary !== undefined ? { summary: extra.summary } : {}),
    ...(extra.requestFields !== undefined ? { requestFields: extra.requestFields } : {}),
    ...(extra.responseFields !== undefined ? { responseFields: extra.responseFields } : {}),
  };
}

/**
 * 组装数据源目录。
 * @param dsl 页面 DSL
 * @param catalogApis 项目接口清单（可选，用于补全请求 / 响应字段）
 */
export function getDataSources(dsl: PageDsl, catalogApis: readonly ApiDef[] = []): DataSourceCatalog {
  const apis: ApiDef[] = dsl.apiDeps.map((path) => {
    const known = catalogApis.find((api) => api.id === path || api.path === path);
    return known ?? apiDefFromPath(path);
  });
  // 接口清单里额外定义、但页面未引用的接口也纳入（供用户选择后自动写入 apiDeps）
  for (const api of catalogApis) {
    if (!apis.some((item) => item.id === api.id || item.path === api.path)) apis.push(api);
  }
  return { pageId: dsl.id, states: dsl.state.map((item) => ({ ...item })), apis };
}

/** 从 API 响应体平铺路径（`response.` 前缀对齐常见后端包装） */
export function flattenApiFields(api: ApiDef, prefix = 'response'): DataSourceRef[] {
  const out: DataSourceRef[] = [];
  const walk = (fields: readonly DataField[], base: string, depth: number): void => {
    for (const field of fields) {
      const path = `${base}.${field.name}`;
      out.push({ kind: 'api', id: api.id, path, label: field.name, type: field.type, depth });
      if (field.children !== undefined) walk(field.children, path, depth + 1);
    }
  };
  walk(api.responseFields ?? [], prefix, 0);
  return out;
}

/** 平铺全部可选路径（状态优先，随后是接口） */
export function listDataSourcePaths(catalog: DataSourceCatalog): DataSourceRef[] {
  const refs: DataSourceRef[] = catalog.states.map((state) => ({
    kind: 'state',
    id: state.name,
    path: state.name,
    label: state.description !== undefined && state.description.length > 0 ? `${state.name}（${state.description}）` : state.name,
    type: state.type,
    depth: 0,
  }));
  for (const api of catalog.apis) refs.push(...flattenApiFields(api));
  return refs;
}

/** 按路径查状态定义 */
export function findStateDef(catalog: DataSourceCatalog, name: string): StateDef | null {
  return catalog.states.find((state) => state.name === name) ?? null;
}

/** 按路径查接口定义（取根段匹配） */
export function findApiDef(catalog: DataSourceCatalog, path: string): ApiDef | null {
  const root = path.split(/[.[]/, 1)[0] ?? path;
  return catalog.apis.find((api) => api.id === root || api.path === root) ?? null;
}

/**
 * 引用检查：找出所有 bindings / 条件 / 事件参数中引用了给定路径的元素。
 * 供 T3-08「删除被引用状态前警告」与 T3-07「路由参数影响面」复用。
 */
export function findReferencingElements(dsl: PageDsl, path: string): ElementNode[] {
  const needle = path.trim();
  if (needle.length === 0) return [];
  const out: ElementNode[] = [];
  for (const { node } of walkElements(dsl.tree)) {
    const bindings = Object.values(node.bindings ?? {});
    const inBindings = bindings.some((value) => value === needle || collectExpressionPaths(value).includes(needle));
    const inProps = JSON.stringify(node.props ?? {}).includes(needle);
    if (inBindings || inProps) out.push(node);
  }
  return out;
}

/** 数据源提供者：以 pageId 为入口的解析器（供 BindingPanel 注入） */
export function createDataSourceProvider(input: {
  getDsl: (pageId: string) => PageDsl | null;
  apis?: readonly ApiDef[];
}): (pageId: string) => DataSourceCatalog | null {
  return (pageId) => {
    const dsl = input.getDsl(pageId);
    return dsl === null ? null : getDataSources(dsl, input.apis ?? []);
  };
}
