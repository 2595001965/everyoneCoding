/** 浏览器条件入口：只导出协议无关值与类型，禁止引入 Node IO 或 SQLite。 */
export * from './domain/provider';
export * from './domain/model';
export * from './domain/capability';
export * from './domain/purpose-binding';
export * from './dto/create-provider';
export * from './dto/update-provider';
export * from './core/message';
export * from './core/tool';
export * from './core/usage';
export * from './core/stream';
export * from './core/error';
export * from './core/embedding';
/* 上下文引擎：纯逻辑 + 端口注入，不触碰 Node IO / SQLite，渲染层可安全引用 */
export * from './context';
/* 生成与写入：提示词模板、解析、差异模型、只读守卫、外部改动检测均为纯逻辑 */
export * from './generate';
export * from './write';
export * from './anchors';
export * from './nav';
export type * from './core/adapter';
export type * from './core/http';
export type * from './repo/usage-repo';
export type * from './repo/remote-config-repo';
export type * from './remote-config/fetcher';
export type * from './remote-config/applier';
/* 用量报表与预算面板：纯函数，渲染层安全引用 */
export * from './gateway/usage-report';
export * from './gateway/budget-alert';
