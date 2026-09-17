import Database from 'better-sqlite3';
import { Migrator, loadMigrations, seedDatabase } from '@ec/data';

/**
 * 测试库：内存 SQLite + 全量迁移 + 种子数据。
 *
 * 迁移目录用仓库内的绝对路径（`packages/data/migrations`），
 * 避免依赖构建产物，测试与开发共用同一套 DDL。
 */

export interface TestDb {
  db: Database.Database;
  close(): void;
}

/** 只建表、不塞种子数据（多数单测需要干净环境） */
export function createEmptyDb(): TestDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  Migrator.fromDirectory(db, migrationsDir()).up();
  return { db, close: () => db.close() };
}

/** 带种子数据（用户 / 项目 / 页面 / 9 条五层记忆） */
export function createSeededDb(): TestDb {
  const handle = createEmptyDb();
  seedDatabase(handle.db);
  return handle;
}

/**
 * 测试用的项目图谱。
 *
 * memory_item 的 project_id / feature_id / page_id / element_id 都有外键约束，
 * 单测必须先把这些实体落库，否则写入会以 FOREIGN KEY constraint failed 失败。
 * 这里一次性铺好两组项目（P1 为主、P2/PG9/E9 用于"范围外"用例）。
 */
export const TEST_GRAPH = {
  userId: 'U-TEST',
  projectId: 'P1',
  featureId: 'F1',
  pageId: 'PG1',
  elementId: 'E1',
  otherProjectId: 'P2',
  otherFeatureId: 'F2',
  otherPageId: 'PG9',
  otherElementId: 'E9',
} as const;

export function seedUser(db: Database.Database, userId: string = TEST_GRAPH.userId): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO user (id, login, display_name, avatar_ref, role, settings_json, created_at, updated_at)
     VALUES (?, ?, '测试用户', NULL, 'owner', NULL, ?, ?)`,
  ).run(userId, `login-${userId}`, now, now);
}

/** 落库用户 + 两组项目/功能/页面/元素，满足全部外键 */
export function seedGraph(db: Database.Database, userId: string = TEST_GRAPH.userId): void {
  const now = Date.now();
  seedUser(db, userId);
  const project = db.prepare(
    `INSERT OR IGNORE INTO project (id, user_id, workspace_id, name, description, tech_stack_json, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, NULL, NULL, 'active', ?, ?)`,
  );
  const feature = db.prepare(
    `INSERT OR IGNORE INTO feature (id, project_id, name, description, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'planned', ?, ?)`,
  );
  const page = db.prepare(
    `INSERT OR IGNORE INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const element = db.prepare(
    `INSERT OR IGNORE INTO element (id, page_id, parent_id, type, name, props_json, style_json, feature_ref, note_id, order_index, anchor_json, created_at, updated_at)
     VALUES (?, ?, NULL, 'Button', ?, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
  );

  const g = TEST_GRAPH;
  project.run(g.projectId, userId, '商城', now, now);
  project.run(g.otherProjectId, userId, '看板', now, now);
  feature.run(g.featureId, g.projectId, '用户登录', now, now);
  feature.run(g.otherFeatureId, g.otherProjectId, '任务列表', now, now);
  page.run(g.pageId, g.projectId, g.featureId, '登录页', '/login', now, now);
  page.run(g.otherPageId, g.otherProjectId, g.otherFeatureId, '看板页', '/board', now, now);
  element.run(g.elementId, g.pageId, '提交按钮', now, now);
  element.run(g.otherElementId, g.otherPageId, '拖拽卡片', now, now);
}

function migrationsDir(): string {
  return new URL('../../../data/migrations', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

export function migrationsCount(): number {
  return loadMigrations(migrationsDir()).length;
}
