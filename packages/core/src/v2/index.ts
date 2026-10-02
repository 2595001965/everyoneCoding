/**
 * V2 公共契约（V2-T01 建立；PRD §11「数据模型与接口边界」）。
 *
 * 面向后续任务的引用入口：
 * - 源码/识别/运行：T04/T05/T06 → project-source.ts / runtime.ts
 * - 元素映射：T08 → element-anchor.ts
 * - 接口索引：T09/T10 → api-endpoint.ts
 * - Provider 复合身份：T02/T03 → provider-model.ts
 * - 计量：T11 → usage.ts / events.ts
 * - 会话/并发写入：T12/T13 → agent.ts
 * - 目录/价格/账务：T17/T18/T19 → billing.ts / money.ts（服务端载荷为拟新增边界）
 *
 * 维护规则：本目录只依赖 zod；禁止 node 内置模块、仓库内宿主/存储/外壳包
 * 及任何宿主能力（renderer 经 browser 条件直接导入）。新文件必须同步登记
 * 于本文件，并在 `__tests__/v2-contracts.test.ts` 中覆盖序列化往返与关键不变量。
 */

export * from './primitives';
export * from './money';
export * from './errors';
export * from './events';
export * from './provider-model';
export * from './usage';
export * from './api-endpoint';
export * from './element-anchor';
export * from './runtime';
export * from './project-source';
export * from './agent';
export * from './billing';
