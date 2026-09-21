-- migration: 0006_designer_notes
-- up

-- Wave 4 / T4-01：备注（FR-ANN）落库字段扩展。
--
-- 背景（真实缺陷）：`0001_init.sql` 的 `note` 表只有 title/content/kind + page_id，
-- 而设计器的领域模型 `Note`（packages/designer/src/notes/note-model.ts）带
-- targetType/targetId/type/status/priority/version/history 与富文本正文。
-- 主进程此前按领域模型的字段名写 SQL（INSERT ... element_id, body），
-- 列不存在 ⇒ 元素级备注写入必然抛 SQL 错；上下文引擎读 `row.body` 也永远是空。
--
-- 设计取舍：
-- - 可查询的字段（target/ type / status / priority / version）独立成列，
--   备注面板的按类型、按状态筛选与「未解决计数」都走索引而不是全表 JSON 解析；
-- - 嵌套结构（富文本正文、checklist、代码片段、历史版本）统一放 `payload_json`，
--   与 `memory_item.structured` 的存法一致；
-- - `title` / `content` / `kind` 保留并同步维护（content 存正文纯文本，
--   kind 存 NoteType 的旧枚举投影），使既有 `note` 消费方与全文检索不失效。

ALTER TABLE note ADD COLUMN element_id TEXT NULL;
ALTER TABLE note ADD COLUMN target_type TEXT NOT NULL DEFAULT 'page';
ALTER TABLE note ADD COLUMN target_id TEXT NULL;
ALTER TABLE note ADD COLUMN note_type TEXT NOT NULL DEFAULT 'todo';
ALTER TABLE note ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE note ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE note ADD COLUMN manual_priority INTEGER NULL;
ALTER TABLE note ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE note ADD COLUMN resolved_at INTEGER NULL;
ALTER TABLE note ADD COLUMN created_by TEXT NULL;
ALTER TABLE note ADD COLUMN payload_json TEXT NULL;

-- 已有行：target 归属回填成页面级（旧模型只能表达页面归属）
UPDATE note SET target_type = 'page', target_id = page_id WHERE target_id IS NULL AND page_id IS NOT NULL;
UPDATE note SET version = 1 WHERE version IS NULL;

CREATE INDEX idx_note_target ON note (project_id, target_type, target_id);
CREATE INDEX idx_note_status ON note (project_id, status);
CREATE INDEX idx_note_element ON note (element_id);

-- down

DROP INDEX IF EXISTS idx_note_element;
DROP INDEX IF EXISTS idx_note_status;
DROP INDEX IF EXISTS idx_note_target;
ALTER TABLE note DROP COLUMN payload_json;
ALTER TABLE note DROP COLUMN created_by;
ALTER TABLE note DROP COLUMN resolved_at;
ALTER TABLE note DROP COLUMN version;
ALTER TABLE note DROP COLUMN manual_priority;
ALTER TABLE note DROP COLUMN priority;
ALTER TABLE note DROP COLUMN status;
ALTER TABLE note DROP COLUMN note_type;
ALTER TABLE note DROP COLUMN target_id;
ALTER TABLE note DROP COLUMN target_type;
ALTER TABLE note DROP COLUMN element_id;
