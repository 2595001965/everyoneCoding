/**
 * 项目域导出入口（T9-01）。
 *
 * 浏览器可达：本目录全部模块为纯逻辑 + 端口注入，禁止 import `@ec/git` /
 * `@ec/memory` / `@ec/designer`（会拉入 Node 侧或浏览器 UI 重依赖）。
 * `@ec/data` 仅用于 `newUlid`（其 browser 入口只导出纯函数）。
 */

export * from './project-types';
export * from './project-metrics';
export * from './project-service';
export * from './project-templates';
export * from './git-import';
export * from './doc-import';
