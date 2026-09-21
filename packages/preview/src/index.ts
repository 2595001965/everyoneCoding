/**
 * @ec/preview —— Mock Server + 后端进程托管（领域层）。
 *
 * 跨包引用只允许通过本单一入口，禁止深路径导入。
 * 浏览器环境请引用本包的 browser 条件入口（见 package.json exports.browser）。
 */
export * from './browser';

/**
 * Node 侧入口独有的导出（**不进 browser 入口**）：
 * 后端子进程托管与依赖安装。两者都是"纯逻辑 + 端口注入"，本身不 import `node:*`，
 * 但它们的消费者（Electron 主进程的 preview 域）是外壳形态特有的能力，
 * 渲染层没有理由拿到"启停进程"的函数引用，所以只挂在 Node 入口上。
 *
 * 注意：`browser.ts` 里的 `preview-server.ts` 已经 import 了 `BackendRunner`，
 * 因此这里补导出不会额外增加渲染层构建体积。
 */
export * from './backend/runner';
export * from './backend/dependency-installer';
