-- migration: 0004_memory
-- up

-- 问题记忆状态（FR-MEM-05：未解决 / 已解决 / 已规避）。
-- `status` 表达条目生命周期（active / archived / superseded），issue_status 表达缺陷处置状态，
-- 两者正交：solved 的问题记忆仍可能是 active（还在参考）或 archived（已沉淀归档）。
ALTER TABLE memory_item ADD COLUMN issue_status TEXT NULL;

-- 记忆变更日志（FR-MEM-12 / FR-MEM-08~12）
-- 每次自动写入、手动修改、撤销、冲突解决、层级移动、导入都留一条审计记录。
-- 刻意不加 memory_id 外键：条目被删除后日志仍需可查（审计与"可撤销"要求）。
-- source_conversation_id / source_snippet 支撑"点击日志跳转原始对话"。
CREATE TABLE memory_change_log (
  id                     TEXT PRIMARY KEY NOT NULL,
  user_id                TEXT NOT NULL REFERENCES user (id),
  memory_id              TEXT NOT NULL,
  action                 TEXT NOT NULL,
  policy                 TEXT NULL,
  source_type            TEXT NULL,
  source_conversation_id TEXT NULL,
  source_snippet         TEXT NULL,
  before_json            TEXT NULL,
  after_json             TEXT NULL,
  detail_json            TEXT NULL,
  created_at             INTEGER NOT NULL
);
CREATE INDEX idx_mcl_memory ON memory_change_log (memory_id, created_at);
CREATE INDEX idx_mcl_user ON memory_change_log (user_id, created_at);
CREATE INDEX idx_mcl_action ON memory_change_log (action);

-- 页面逻辑结构变更历史（FR-MEM-18：页面记忆可查看"最近 5 次结构变更"）
-- summary_json 为当次精简后的逻辑结构摘要；diff_json 为相对上一版的结构化 diff；
-- token_estimate / truncated 供 UI 展示 token 占用与裁剪标记。
CREATE TABLE memory_struct_revision (
  id             TEXT PRIMARY KEY NOT NULL,
  memory_id      TEXT NOT NULL REFERENCES memory_item (id),
  page_id        TEXT NOT NULL REFERENCES page (id),
  revision       INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  truncated      INTEGER NOT NULL DEFAULT 0,
  summary_json   TEXT NOT NULL,
  diff_json      TEXT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_msr_memory ON memory_struct_revision (memory_id, revision);
CREATE INDEX idx_msr_page ON memory_struct_revision (page_id, revision);

-- 注意：向量虚表 memory_item_vec（sqlite-vec）**不在此创建**。
-- vec0 扩展缺失时 CREATE VIRTUAL TABLE 会失败，导致整条迁移回滚、应用无法启动。
-- 因此改由 packages/memory/src/search/vector-search.ts 在检测到扩展可用后
-- 运行时幂等创建（见 ensureVecTable），维度与 embedding 一致（默认 1536）。

-- down

DROP INDEX idx_msr_page;
DROP INDEX idx_msr_memory;
DROP TABLE memory_struct_revision;
DROP INDEX idx_mcl_action;
DROP INDEX idx_mcl_user;
DROP INDEX idx_mcl_memory;
DROP TABLE memory_change_log;
ALTER TABLE memory_item DROP COLUMN issue_status;
