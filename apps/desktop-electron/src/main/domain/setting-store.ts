import type Database from 'better-sqlite3';

/**
 * `setting` 表的键值读写（T12-04 顺带修掉的缺陷）。
 *
 * ## 为什么必须有这一个模块
 *
 * 迁移 0001 定义的 `setting` 表列是
 * `id / user_id / key / value_json / value_text / created_at / updated_at`，
 * **没有 `value` 列**；但 git / package / usage 三个域此前都写着
 * `SELECT value FROM setting WHERE key = ?`，一旦真的执行就会
 * `SqliteError: no such column: value`。这类缺陷在"装配期没有真实调用"的
 * 阶段不会暴露，等到用户点下「自动提交策略」「预算」才炸。
 *
 * 因此这里给出唯一入口，统一处理三件事：
 * 1. 列名正确（写 `value_json`，读时兼容落到 `value_text` 的旧值）；
 * 2. 主键与 NOT NULL 列补齐（`id` / `user_id` / `created_at` / `updated_at`）；
 * 3. `UNIQUE (user_id, key)` 语义下的 upsert（不能用 key 单独做冲突目标）。
 */

export interface SettingStoreOptions {
  db: Database.Database;
  userId: string;
}

export interface SettingStore {
  /** 读取 JSON 值；不存在或解析失败返回 null */
  read<T>(key: string): T | null;
  /** 写入 JSON 值（upsert） */
  write(key: string, value: unknown): void;
  /** 删除（不存在时静默） */
  remove(key: string): void;
}

interface SettingRow {
  value_json: string | null;
  value_text: string | null;
}

export function createSettingStore(options: SettingStoreOptions): SettingStore {
  const { db, userId } = options;

  const select = (key: string): SettingRow | undefined =>
    db
      .prepare(`SELECT value_json, value_text FROM setting WHERE user_id = ? AND key = ?`)
      .get(userId, key) as SettingRow | undefined;

  return {
    read<T>(key: string): T | null {
      const row = select(key);
      if (row === undefined) return null;
      const raw = row.value_json ?? row.value_text;
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        // 历史值可能是不带引号的裸字符串（早期版本直接写 value_text），按字符串兜底
        return raw as unknown as T;
      }
    },

    write(key: string, value: unknown): void {
      const now = Date.now();
      const json = JSON.stringify(value ?? null);
      db.prepare(
        `INSERT INTO setting (id, user_id, key, value_json, value_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(user_id, key)
         DO UPDATE SET value_json = excluded.value_json, value_text = NULL, updated_at = excluded.updated_at`,
      ).run(`set-${userId}-${key}`, userId, key, json, now, now);
    },

    remove(key: string): void {
      db.prepare(`DELETE FROM setting WHERE user_id = ? AND key = ?`).run(userId, key);
    },
  };
}
