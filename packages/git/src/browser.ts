/**
 * @ec/git —— 浏览器安全入口（渲染层引用）。
 *
 * 与 `@ec/ai`、`@ec/pipeline` 的条件入口同一模式：`exports.browser` 指向本文件，
 * Vite 解析 `@ec/git` 时走这里，**不包含**会引入 `node:child_process` /
 * `node:fs` 的模块（`git-client.ts` 与 `backend/**`）。
 *
 * 内容：领域模型、结构化日志与脱敏、diff 解析、提交信息、.gitignore 模板、
 * 凭据封装，以及全部分支 / 历史 / 冲突 / 合并 / 回滚 / 远程服务
 * （这些服务只通过 `import type` 引用 `GitClient`，编译期擦除，零运行时依赖）。
 *
 * 渲染层拿到的真实能力由外壳经 `globalThis.__EC_GIT__` 注入（见 features/git/git-api.tsx）。
 */

export * from './models';
export * from './diff-service';
export * from './commit-message';
export * from './gitignore';
export * from './credentials';
export * from './branch-service';
export * from './history-service';
export * from './conflict-service';
export * from './merge-service';
export * from './recovery-service';
export * from './remote-service';
