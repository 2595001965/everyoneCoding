/**
 * Git 渲染层本地辅助函数。
 *
 * 这三条规则定义在领域层 `@ec/git` 的浏览器安全模块（`models.ts` / `remote-service.ts`）里，
 * 渲染层直接复用同一份实现，**不要**再本地复制一份（复制过会引起规则漂移）。
 */
export { changeSourceLabel, isValidBranchName, suggestedCredentialKind } from '@ec/git';
