/**
 * @ec/core —— 浏览器条件入口（exports.browser）。
 *
 * 渲染层（Vite browser 条件）经此入口引用 core，规避 Node 侧模块：
 * - `docs/parsers/docx.ts` / `docs/parsers/pdf.ts` / `docs/parsers/image-ocr.ts`
 *   依赖 `node:zlib` / `node:fs`，**不得**在此导出
 * - 其余模块（事件总线 / 命令 / 设置 / 项目域 / 文档域纯解析器）均为纯逻辑，可进浏览器
 *
 * 维护规则：新增模块时同步维护 `index.ts`（Node 全集）与本文件（浏览器子集）。
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
export * from './docs/browser';
export * from './update';
