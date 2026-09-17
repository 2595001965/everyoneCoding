/**
 * @ec/core —— 应用内核。
 *
 * 组成：
 * - `event-bus`：类型化事件总线（once / 通配符 / 异步串行）
 * - `command-registry`：命令系统（快捷键、启用条件、命令面板检索、冲突检测）
 * - `command-catalog`：应用命令目录（真实动作的 id / 标题 / 默认键位，设置页快捷键类目的数据源）
 * - `undo-manager`：基于 Immer patch 的撤销重做，按域隔离
 * - `persist-middleware`：Zustand 持久化中间件（版本化 + 迁移 + 可插拔存储）
 * - `crash-recovery`：20s 快照 + 脏标记，丢失窗口 ≤30s
 * - `logger`：分级结构化日志，输出前统一脱敏
 * - `settings` / `settings-schema`：全局与项目两级设置（zod 校验 + 版本迁移）
 * - `secure-store`：DPAPI 密钥环封装
 * - `redaction`：统一脱敏规则（日志与导出共用）
 * - `telemetry`：默认关闭、未授权零上报
 * - `file-service` / `path-guard`：原子写与路径越界防护
 * - `workspace-layout` / `gitignore-templates`：工程目录约定与模板
 */

export * from './event-bus';
export * from './command-registry';
export * from './command-catalog';
export * from './undo-manager';
export * from './persist-middleware';
export * from './crash-recovery';
export * from './logger';
export * from './settings';
export * from './settings-schema';
export * from './secure-store';
export * from './redaction';
export * from './telemetry';
export * from './telemetry-events';
export * from './telemetry-client';
export * from './file-service';
export * from './path-guard';
export * from './workspace-layout';
export * from './gitignore-templates';
export * from './project';
export * from './docs';
export * from './update';
