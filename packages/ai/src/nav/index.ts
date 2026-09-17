/**
 * 导航与跳转（T6-07）子域出口。
 *
 * 纯逻辑 + 端口注入：不引入 Node IO / SQLite，可安全进入 `browser.ts` 被渲染层引用。
 * 覆盖：数据源端口、悬停目标解析、Ctrl+点击跳转、反向跳转、关系图。
 */

export * from './source-model';
export * from './target-resolver';
export * from './jump-service';
export * from './reverse-jump';
export * from './relation-graph';
