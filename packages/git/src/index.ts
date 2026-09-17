/**
 * @ec/git —— Git 封装（git2 优先，回退系统 CLI）
 *
 * 组成：
 * - `models`：统一返回契约 `GitResult<T>`、结构化日志与脱敏、领域模型
 * - `backend/cli-backend`：系统 Git CLI（Windows 中文路径 / 编码已处理）
 * - `backend/git2-backend`：libgit2 绑定（可选，缺失时透明回退 CLI）
 * - `backend/index`：运行时探测与后端选择
 * - `git-client`：门面（结构化结果 + 凭据注入 + 大文件 diff 治理）
 * - `diff-service` / `commit-message`：T6-02 的解析与提交信息
 * - `branch-service` / `remote-service` / `history-service`：T6-03
 * - `merge-service` / `conflict-service` / `recovery-service`：T6-04
 * - `gitignore` / `credentials`：初始化模板与密钥环
 *
 * 约束：跨包引用只允许通过本单一入口（渲染层走 `exports.browser`）。
 */

export * from './browser';
export * from './git-client';
export * from './backend';
