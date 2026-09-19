/**
 * `@ec/designer` 的**纯 DSL 子入口**（`exports['./dsl']`）。
 *
 * 为什么需要它：页面 DSL 的构造与序列化（`createPageDsl` / `serializePageDsl` / `dslFileName` …）
 * 不只是渲染层的能力——外壳在「按模板新建项目」时也要产出初始 DSL 并落盘。
 * 而包根入口会把 React / dnd-kit / zustand 等浏览器 UI 依赖一并拉进来，**主进程不能引入**。
 *
 * 本入口只导出 `dsl/*` 与 `shared/{expression,condition}`——经核对，这些模块的运行时依赖
 * **只有 zod**，无 React / DOM / Node 内置模块，因此渲染层与主进程都可安全引用。
 *
 * 维护约束：往本文件里加模块前，先确认该模块的 `import` 里没有 `react` / `@dnd-kit/*` /
 * `zustand` / `@ec/ui`，否则主进程构建会被污染（与 `@ec/core` 的 browser 入口同一类纪律）。
 * 新增模块时应同步更新 `packages/designer/__tests__` 下的纯度守卫测试。
 */

export * from './dsl/types';
export * from './dsl/identifier';
export * from './dsl/factory';
export * from './dsl/traverse';
export * from './dsl/schema';
export * from './dsl/serialize';
export * from './dsl/version';
export * from './shared/expression';
export * from './shared/condition';
