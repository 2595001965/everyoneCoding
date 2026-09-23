/**
 * 文档域导出入口（T9-04 / Node 全集）。
 *
 * 含 docx / pdf / image-ocr 解析器（依赖 node:zlib）。
 * 浏览器入口见 `./browser.ts`（只导出纯逻辑，避免把 node:zlib 打进 vite 构建）。
 */

export * from './doc-types';
export * from './versioning';
export * from './doc-service';
export * from './parsers/markdown';
export * from './parsers/txt';
export * from './parsers/docx';
export * from './parsers/pdf';
export * from './parsers/image-ocr';
export * from './parsers/windows-ocr';
export * from './parsers/node-registry';
export * from './parsers/browser-registry';
