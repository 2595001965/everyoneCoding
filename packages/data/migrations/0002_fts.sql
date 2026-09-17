-- migration: 0002_fts
-- up

-- 记忆条目全文检索（FTS5）：独立虚表 + 触发器同步
-- 使用 trigram 分词器以支持中文（CJK）子串检索；查询需 >=3 字符。
CREATE VIRTUAL TABLE memory_item_fts USING fts5 (
  title,
  content,
  id UNINDEXED,
  tokenize = 'trigram'
);

CREATE TRIGGER memory_item_ai AFTER INSERT ON memory_item BEGIN
  INSERT INTO memory_item_fts (title, content, id)
  VALUES (new.title, new.content, new.id);
END;

CREATE TRIGGER memory_item_ad AFTER DELETE ON memory_item BEGIN
  DELETE FROM memory_item_fts WHERE id = old.id;
END;

CREATE TRIGGER memory_item_au AFTER UPDATE ON memory_item BEGIN
  DELETE FROM memory_item_fts WHERE id = old.id;
  INSERT INTO memory_item_fts (title, content, id)
  VALUES (new.title, new.content, new.id);
END;

/*
 * 向量检索预留：sqlite-vec 不可用时由 T0-07 跳过本段。
 * 待 sqlite-vec 可用后，取消下方注释以创建 vec0 虚表（维度须与 embedding 一致）：
 *
CREATE VIRTUAL TABLE memory_item_vec USING vec0 (
  embedding float[1536]
);
 */

-- down

DROP TRIGGER memory_item_au;
DROP TRIGGER memory_item_ad;
DROP TRIGGER memory_item_ai;
DROP TABLE memory_item_fts;
