/**
 * @ec/data —— 浏览器安全入口（`exports.browser` 条件解析）。
 *
 * 只暴露纯函数模块（ULID / 时间戳）。SQLite 客户端、迁移框架、seed 等
 * Node 侧模块（better-sqlite3 / node:fs / node:crypto）**绝不进浏览器构建**——
 * 它们曾把渲染层 vite build 打挂（Wave 2 遗留：`"join" is not exported by
 * __vite-browser-external`）。
 *
 * 消费方：`@ec/memory` 的 domain 层（newUlid）；渲染层不直接引用本包，
 * 存储访问一律经 MemoryApi / PipelineApi 等端口由外壳注入。
 */

export * from './ids';
