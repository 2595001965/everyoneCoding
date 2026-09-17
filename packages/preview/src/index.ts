/**
 * @ec/preview —— Mock Server + 后端进程托管（领域层）。
 *
 * 跨包引用只允许通过本单一入口，禁止深路径导入。
 * 浏览器环境请引用本包的 browser 条件入口（见 package.json exports.browser）。
 */
export * from './browser';
