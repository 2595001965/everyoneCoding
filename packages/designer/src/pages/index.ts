/**
 * 多页面与路由（T3-07）对外 API。
 * 主会话据此在 packages/designer/src/index.ts 接线。
 */
export { PageTree } from './PageTree';
export type { PageTreeProps } from './PageTree';
export { PageNode } from './PageNode';
export type { PageNodeProps } from './PageNode';
export { RouteGraph } from './RouteGraph';
export type { RouteGraphProps } from './RouteGraph';
export { RouteEditor } from './RouteEditor';
export type { RouteEditorProps } from './RouteEditor';

export {
  generateRouteTable,
  detectRouteIssues,
  parseRouteParams,
  normalizePath,
  buildRouteEdges,
  patchPageEventAction,
  useRouteMemorySync,
} from './route-table';
export type { RouteEdge } from './route-table';

export {
  MultiPageStore,
  MultiPageProvider,
  useMultiPageStore,
  useMultiPageSnapshot,
  multiPageStore,
  PAGE_TEMPLATES,
  createPageFromTemplate,
} from './page-store';
export type {
  MultiPageSnapshot,
  CreatePageInput,
  PageTemplateId,
  PageTemplateMeta,
} from './page-store';
