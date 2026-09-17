/**
 * 文档域浏览器入口（T9-04）：只导出纯逻辑（markdown/txt 解析、服务、版本、端口与类型）。
 *
 * **绝不**在此导出 `parsers/docx.ts` / `parsers/pdf.ts` / `parsers/image-ocr.ts`
 * （它们 import `node:zlib`，静态进浏览器包会打挂 vite build）。
 * 渲染层经 `@ec/core` 的 browser 条件引用本入口。
 */

export * from './doc-types';
export * from './versioning';
export * from './doc-service';
export * from './parsers/markdown';
export * from './parsers/txt';
export * from './parsers/browser-registry';
