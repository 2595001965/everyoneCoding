/**
 * @ec/data —— 种子数据
 *
 * `seedDatabase` 向空库写入演示数据，返回各表插入计数；
 * `clearSeed` 清空所有表（含同步的 FTS 索引）。
 * 主键均为 ULID 字符串，时间字段为 Unix 毫秒。
 */
import type { Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { MemoryItemRow } from './schema';

const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 生成 26 位 ULID 字符串（Crockford base32，前 10 位时间戳 + 后 16 位随机）。 */
function ulid(): string {
  const time = Date.now();
  let timePart = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ENCODING[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += ULID_ENCODING[rand[i]! & 31];
  }
  return timePart + randPart;
}

export interface SeedResult {
  users: number;
  projects: number;
  features: number;
  pages: number;
  notes: number;
  elements: number;
  documents: number;
  memoryItems: number;
  memoryDocLinks: number;
}

const now = Date.now;

/** 写入演示数据。调用前应已完成 0001/0002 的 up 段建表。 */
export function seedDatabase(db: Database): SeedResult {
  const ts = now();

  const userId = ulid();
  db.prepare(
    `INSERT INTO user (id, login, display_name, role, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', ?, ?)`,
  ).run(userId, 'demo@everyonecoding.local', 'Demo User', ts, ts);

  // 2 个项目
  const project1 = ulid();
  const project2 = ulid();
  const insertProject = db.prepare(
    `INSERT INTO project (id, user_id, name, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  );
  insertProject.run(project1, userId, '示例商城', '电商前端 + 后端示例', ts, ts);
  insertProject.run(project2, userId, '内部看板', '团队任务看板', ts, ts);

  // 每项目 1 个功能
  const feature1 = ulid();
  const feature2 = ulid();
  const insertFeature = db.prepare(
    `INSERT INTO feature (id, project_id, name, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`,
  );
  insertFeature.run(feature1, project1, '商品详情', '商品展示与购买', ts, ts);
  insertFeature.run(feature2, project2, '任务列表', '看板列表与筛选', ts, ts);

  // 每项目 1 个页面
  const page1 = ulid();
  const page2 = ulid();
  const insertPage = db.prepare(
    `INSERT INTO page (id, project_id, feature_id, name, route, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertPage.run(page1, project1, feature1, '商品页', '/product/:id', ts, ts);
  insertPage.run(page2, project2, feature2, '看板页', '/board', ts, ts);

  // 1 条笔记 + 1 个元素（供 memory_item.element_id 引用）
  const note1 = ulid();
  db.prepare(
    `INSERT INTO note (id, project_id, page_id, title, content, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'note', ?, ?)`,
  ).run(note1, project1, page1, '设计备注', '详情页需支持暗色模式', ts, ts);

  const element1 = ulid();
  db.prepare(
    `INSERT INTO element (id, page_id, parent_id, type, name, order_index, feature_ref, note_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'container', 'ProductCard', 0, ?, ?, ?, ?)`,
  ).run(element1, page1, feature1, note1, ts, ts);

  // 1 条需求文档（project1，requirement）
  const doc1 = ulid();
  db.prepare(
    `INSERT INTO document (id, project_id, kind, title, content_ref, version, created_at, updated_at)
     VALUES (?, ?, 'requirement', '商城需求文档', 'docs/req.md', 1, ?, ?)`,
  ).run(doc1, project1, ts, ts);

  // 五层记忆：longterm(1) / project(2) / feature(2) / page(2) / issue(2) = 9 条
  const memories: MemoryItemRow[] = [
    {
      id: ulid(),
      user_id: userId,
      scope: 'longterm',
      project_id: null,
      feature_id: null,
      page_id: null,
      element_id: null,
      issue_id: null,
      title: '全局约定',
      content: '统一使用 ULID 主键与 Unix 毫秒时间戳。',
      structured: null,
      tags: '["convention"]',
      source_type: 'manual',
      source_ref: null,
      confidence: 1,
      importance: 5,
      status: 'active',
      pinned: 1,
      version: 1,
      created_at: ts,
      updated_at: ts,
      embedding: null,
      issue_status: null,
    },
    {
      id: ulid(),
      user_id: userId,
      scope: 'project',
      project_id: project1,
      feature_id: null,
      page_id: null,
      element_id: null,
      issue_id: null,
      title: '商城技术栈',
      content: '前端 React + 后端 Node，SQLite 存储。',
      structured: null,
      tags: '["stack"]',
      source_type: 'auto_design',
      source_ref: 'design:1',
      confidence: 0.9,
      importance: 4,
      status: 'active',
      pinned: 0,
      version: 1,
      created_at: ts,
      updated_at: ts,
      embedding: null,
      issue_status: null,
    },
    {
      id: ulid(),
      user_id: userId,
      scope: 'project',
      project_id: project2,
      feature_id: null,
      page_id: null,
      element_id: null,
      issue_id: null,
      title: '看板范围',
      content: '看板聚焦任务流转与筛选。',
      structured: null,
      tags: '["scope"]',
      source_type: 'manual',
      source_ref: null,
      confidence: 1,
      importance: 3,
      status: 'active',
      pinned: 0,
      version: 1,
      created_at: ts,
      updated_at: ts,
      embedding: null,
      issue_status: null,
    },
    {
      id: ulid(),
      user_id: userId,
      scope: 'feature',
      project_id: project1,
      feature_id: feature1,
      page_id: null,
      element_id: null,
      issue_id: null,
      title: '商品详情要点',
      content: '展示价格、库存与加入购物车。',
      structured: null,
      tags: '["feature"]',
      source_type: 'ai_summary',
      source_ref: 'doc:1',
      confidence: 0.85,
      importance: 4,
      status: 'active',
      pinned: 0,
      version: 1,
      created_at: ts,
      updated_at: ts,
      embedding: null,
      issue_status: null,
    },
    {
      id: ulid(),
      user_id: userId,
      scope: 'feature',
      project_id: project2,
      feature_id: feature2,
      page_id: null,
      element_id: null,
      issue_id: null,
      title: '任务列表要点',
      content: '支持按状态分组与拖拽排序。',
      structured: null,
      tags: '["feature"]',
      source_type: 'ai_summary',
      source_ref: 'doc:2',
      confidence: 0.82,
      importance: 3,
      status: 'active',
      pinned: 0,
      version: 1,
      created_at: ts,
      updated_at: ts,
      embedding: null,
      issue_status: null,
    },
    {
      id: ulid(),
      user_id: userId,
      scope: 'page',
      project_id: project1,
      feature_id: feature1,
      page_id: page1,
      element_id: null,
      issue_id: null,
      title: '商品页结构',
      content: '顶部标题区 + 商品卡片 + 操作栏。',
      structured: null,
      tags: '["page"]',
      source_type: 'auto_design',
      source_ref: 'design:2',
      confidence: 0.88,
      importance: 3,
      status: 'active',
      pinned: 0,
      version: 1,
      created_at: ts,
      updated_at: ts,
      embedding: null,
      issue_status: null,
    },
    {
      id: ulid(),
      user_id: userId,
      scope: 'page',
      project_id: project2,
      feature_id: feature2,
      page_id: page2,
      element_id: null,
      issue_id: null,
      title: '看板页结构',
      content: '列布局：待办 / 进行中 / 完成。',
      structured: null,
      tags: '["page"]',
      source_type: 'auto_design',
      source_ref: 'design:3',
      confidence: 0.8,
      importance: 3,
      status: 'active',
      pinned: 0,
      version: 1,
      created_at: ts,
      updated_at: ts,
      embedding: null,
      issue_status: null,
    },
    {
      id: ulid(),
      user_id: userId,
      scope: 'issue',
      project_id: project1,
      feature_id: null,
      page_id: null,
      element_id: null,
      issue_id: 'ISSUE-101',
      title: '价格精度问题',
      content: '浮点价格需改用整数分存储。',
      structured: null,
      tags: '["bug"]',
      source_type: 'manual',
      source_ref: 'issue:101',
      confidence: 1,
      importance: 4,
      status: 'active',
      pinned: 0,
      version: 1,
      created_at: ts,
      updated_at: ts,
      embedding: null,
      issue_status: 'unsolved',
    },
    {
      id: ulid(),
      user_id: userId,
      scope: 'issue',
      project_id: project2,
      feature_id: null,
      page_id: null,
      element_id: null,
      issue_id: 'ISSUE-202',
      title: '拖拽卡顿',
      content: '大量卡片时拖拽掉帧。',
      structured: null,
      tags: '["perf"]',
      source_type: 'manual',
      source_ref: 'issue:202',
      confidence: 1,
      importance: 3,
      status: 'active',
      pinned: 0,
      version: 1,
      created_at: ts,
      updated_at: ts,
      embedding: null,
      issue_status: 'unsolved',
    },
  ];

  const insertMemory = db.prepare(
    `INSERT INTO memory_item
       (id, user_id, scope, project_id, feature_id, page_id, element_id, issue_id,
        title, content, structured, tags, source_type, source_ref,
        confidence, importance, status, pinned, version, created_at, updated_at, embedding, issue_status)
     VALUES
       (@id, @user_id, @scope, @project_id, @feature_id, @page_id, @element_id, @issue_id,
        @title, @content, @structured, @tags, @source_type, @source_ref,
        @confidence, @importance, @status, @pinned, @version, @created_at, @updated_at, @embedding, @issue_status)`,
  );
  const memoryInfo = db.transaction(() => {
    for (const m of memories) insertMemory.run(m);
  })();
  void memoryInfo;

  // 1 条文档-记忆关联（需求文档 → 商品详情要点记忆）
  const linkId = ulid();
  db.prepare(
    `INSERT INTO memory_doc_link (id, memory_id, document_id, link_type, created_at)
     VALUES (?, ?, ?, 'supports', ?)`,
  ).run(linkId, memories[3]!.id, doc1, ts);

  return {
    users: 1,
    projects: 2,
    features: 2,
    pages: 2,
    notes: 1,
    elements: 1,
    documents: 1,
    memoryItems: memories.length,
    memoryDocLinks: 1,
  };
}

/** 清空所有表（含 memory_item_fts 同步索引）。 */
export function clearSeed(db: Database): void {
  const order = [
    'memory_doc_link',
    'document',
    'element',
    'note',
    'page',
    'feature',
    'project',
    'workspace',
    'user',
    'code_anchor',
    'pipeline_run',
    'stage_artifact',
    'provider',
    'model',
    'usage_record',
    'ai_model_config',
    'remote_config_source',
    'registry_entry',
    'occurrence',
    'rename_event',
    'package_job',
    'setting',
    'secure_ref',
    'memory_item',
  ];
  db.exec('PRAGMA foreign_keys = OFF;');
  const existing = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  for (const table of order) {
    // 迁移版本不同的库可能没有最新表，跳过而不是中断清空流程
    if (!existing.has(table)) continue;
    db.exec(`DELETE FROM ${table};`);
  }
  db.exec('PRAGMA foreign_keys = ON;');
}
