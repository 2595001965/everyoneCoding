/**
 * 浏览器条件入口：只导出纯模块（领域逻辑 + 端口注入），禁止引入 node:*。
 *
 * 本包所有外部能力都通过端口注入，因此所有模块在浏览器/渲染层都安全。
 * 生产 HTTP 服务与子进程由外壳 Shell API 以端口形式注入，不在本包内实现。
 */
export * from './models';
export * from './mock/rules';
export * from './mock/openapi-loader';
export * from './mock/response-generator';
export * from './mock/fault-injection';
export * from './port-manager';
export * from './static-server';
export * from './binding-resolver';
export * from './backend/project-detector';
export * from './backend/log-stream';
export * from './preview-server';
