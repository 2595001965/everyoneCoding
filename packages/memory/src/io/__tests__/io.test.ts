import { describe, it, expect } from 'vitest';
import { createMemoryItem, type MemoryItem } from '../../domain/memory-item';
import { MemoryRepo } from '../../repo/memory-repo';
import { createEmptyDb, seedGraph, TEST_GRAPH } from '../../__tests__/helpers';
import {
  exportJson,
  exportJsonl,
  parseExportJson,
  MEMORY_EXPORT_FORMAT,
  MEMORY_EXPORT_VERSION,
} from '../export-json';
import { exportMarkdown } from '../export-markdown';
import {
  classifyImport,
  parseMarkdownFiles,
  readImport,
  MemoryImportError,
  type ImportClassification,
} from '../import';
import {
  planMerge,
  batchDecision,
  applyMergePlan,
  commitMergePlan,
} from '../merge-preview';

const G = TEST_GRAPH;

/** 构造 5 个不同 scope 的条目（含 structured / 多标签 / issueStatus / sourceRef / confidence / importance）。 */
function makeFiveItems(): MemoryItem[] {
  return [
    createMemoryItem({
      userId: G.userId,
      scope: 'longterm',
      title: '全局命名规范',
      content: '# 命名规范\n\n使用 camelCase。',
      structured: { rule: 'camelCase', applies: ['ts', 'js'] },
      tags: ['style', 'typescript'],
      sourceType: 'manual',
      sourceRef: 'doc-1',
      confidence: 0.95,
      importance: 5,
    }),
    createMemoryItem({
      userId: G.userId,
      scope: 'project',
      projectId: G.projectId,
      title: '技术栈选型',
      content: 'React + TypeScript。',
      structured: { framework: 'react', language: 'ts' },
      tags: ['stack'],
      sourceType: 'auto_chat',
      sourceRef: 'conv-2',
      confidence: 0.8,
      importance: 4,
    }),
    createMemoryItem({
      userId: G.userId,
      scope: 'feature',
      projectId: G.projectId,
      featureId: G.featureId,
      title: '登录流程',
      content: '1. 输入账号\n2. 提交',
      structured: { steps: ['input', 'submit'] },
      tags: ['flow'],
      sourceType: 'manual',
      sourceRef: null,
      confidence: 1,
      importance: 3,
    }),
    createMemoryItem({
      userId: G.userId,
      scope: 'page',
      projectId: G.projectId,
      featureId: G.featureId,
      pageId: G.pageId,
      title: '登录页布局',
      content: '居中卡片。',
      structured: null,
      tags: [],
      sourceType: 'ai_summary',
      sourceRef: 'sum-3',
      confidence: 0.6,
      importance: 2,
    }),
    createMemoryItem({
      userId: G.userId,
      scope: 'issue',
      projectId: G.projectId,
      issueId: 'ISSUE1',
      title: '登录返回 500',
      content: '提交后服务端报错。',
      structured: { symptom: '500', repro: ['点击提交'] },
      tags: ['bug'],
      sourceType: 'manual',
      sourceRef: 'conv-4',
      confidence: 0.7,
      importance: 3,
      issueStatus: 'unsolved',
    }),
  ];
}

const ROUND_TRIP_FIELDS: ReadonlyArray<keyof MemoryItem> = [
  'id', 'userId', 'scope', 'projectId', 'featureId', 'pageId', 'elementId', 'issueId',
  'title', 'content', 'structured', 'tags', 'sourceType', 'sourceRef',
  'confidence', 'importance', 'status', 'issueStatus', 'pinned', 'version', 'createdAt', 'updatedAt',
];

function expectJsonRoundTrip(original: readonly MemoryItem[]): void {
  const json = exportJson(original, { userId: G.userId });
  const parsed = parseExportJson(json);
  expect(parsed.items).toHaveLength(original.length);
  expect(parsed.count).toBe(original.length);
  expect(parsed.format).toBe(MEMORY_EXPORT_FORMAT);
  expect(parsed.version).toBe(MEMORY_EXPORT_VERSION);
  for (const o of original) {
    const r = parsed.items.find((x) => x.id === o.id);
    expect(r, `找不到 id=${o.id}`).toBeDefined();
    for (const field of ROUND_TRIP_FIELDS) {
      expect((r as MemoryItem)[field], `字段 ${String(field)} 不一致`).toEqual(o[field]);
    }
    // embedding 默认不导出，结构位保留为 null
    expect((r as MemoryItem).embedding).toBeNull();
  }
}

function expectMarkdownRoundTrip(original: readonly MemoryItem[]): void {
  const files = exportMarkdown(original);
  const itemFiles = files.filter((f) => f.path !== 'README.md');
  expect(itemFiles).toHaveLength(original.length);
  const { items, skipped } = parseMarkdownFiles(itemFiles);
  expect(skipped, `不应跳过：${JSON.stringify(skipped)}`).toHaveLength(0);
  expect(items).toHaveLength(original.length);
  for (const o of original) {
    const r = items.find((x) => x.id === o.id);
    expect(r, `找不到 id=${o.id}`).toBeDefined();
    expect(r!.title).toBe(o.title);
    expect(r!.content).toBe(o.content);
    expect(r!.structured).toEqual(o.structured);
    expect(r!.tags).toEqual(o.tags);
    expect(r!.importance).toBe(o.importance);
    expect(r!.confidence).toBe(o.confidence);
    expect(r!.sourceRef).toBe(o.sourceRef);
  }
}

describe('export-json：全字段往返无损', () => {
  it('5 个不同 scope 的条目导出再解析字段逐一相等（embedding 除外）', () => {
    expectJsonRoundTrip(makeFiveItems());
  });

  it('JSONL：每行一条、行数与条目数一致', () => {
    const items = makeFiveItems();
    const lines = exportJsonl(items);
    const arr = lines.split('\n').filter((l) => l.length > 0);
    expect(arr).toHaveLength(items.length);
    const back = arr.map((l) => JSON.parse(l) as MemoryItem);
    expect(back).toHaveLength(items.length);
    for (const o of items) {
      const r = back.find((x) => x.id === o.id);
      expect(r).toBeDefined();
      expect(r!.title).toBe(o.title);
      expect(r!.structured).toEqual(o.structured);
    }
  });
});

describe('export-markdown：分文件 + 往返无损', () => {
  it('5 个条目按层级分文件，解析回等价条目', () => {
    expectMarkdownRoundTrip(makeFiveItems());
  });

  it('README.md 索引文件被产出', () => {
    const files = exportMarkdown(makeFiveItems());
    expect(files.some((f) => f.path === 'README.md')).toBe(true);
  });

  it('front-matter 含特殊字符（冒号、引号、换行、中文）仍可正确解析', () => {
    const original = createMemoryItem({
      userId: G.userId,
      scope: 'longterm',
      title: '规范：命名 "约定"\n第二行',
      content: '示例：key: value\n引用 "abc" 结尾',
      structured: { note: 'a: b' },
      tags: ['x:y', '中文标签'],
      sourceType: 'manual',
      sourceRef: 'conv:"x"',
      confidence: 0.5,
      importance: 1,
    });
    const files = exportMarkdown([original]).filter((f) => f.path !== 'README.md');
    const { items, skipped } = parseMarkdownFiles(files);
    expect(skipped).toHaveLength(0);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('规范：命名 "约定"\n第二行');
    expect(items[0]!.content).toBe('示例：key: value\n引用 "abc" 结尾');
    expect(items[0]!.sourceRef).toBe('conv:"x"');
    expect(items[0]!.tags).toEqual(['x:y', '中文标签']);
  });

  it('文件名重名时追加 -2 / -3', () => {
    const base = {
      userId: G.userId,
      title: '同名记忆',
      content: 'x',
    };
    const a = createMemoryItem({ ...base, scope: 'longterm' });
    const b = createMemoryItem({ ...base, scope: 'longterm' });
    const files = exportMarkdown([a, b]);
    const md = files.filter((f) => f.path !== 'README.md').map((f) => f.path).sort();
    expect(md).toContain('longterm/同名记忆.md');
    expect(md).toContain('longterm/同名记忆-2.md');
  });
});

describe('import：四类差异分类齐全 + 默认不覆盖', () => {
  function buildLocalAndIncoming() {
    const local = [
      createMemoryItem({ userId: G.userId, scope: 'longterm', title: 'A', content: 'local-A' }),
      createMemoryItem({ userId: G.userId, scope: 'project', projectId: G.projectId, title: 'B', content: 'local-B' }),
      createMemoryItem({ userId: G.userId, scope: 'page', projectId: G.projectId, pageId: G.pageId, title: 'D', content: 'local-D' }),
    ];
    const added = createMemoryItem({ userId: G.userId, scope: 'feature', projectId: G.projectId, featureId: G.featureId, title: 'E', content: 'new-E' });
    const conflicted = { ...local[0]!, updatedAt: local[0]!.updatedAt + 1, content: 'incoming-A' };
    const unchanged = { ...local[1]! };
    const incoming = [added, conflicted, unchanged];
    return { local, incoming, addedId: added.id, conflictedId: local[0]!.id, unchangedId: local[1]!.id, missingId: local[2]!.id };
  }

  it('覆盖 added / conflicted / unchanged / missing 四类并断言 counts', () => {
    const { local, incoming } = buildLocalAndIncoming();
    const preview = classifyImport(incoming, local);
    expect(preview.counts).toEqual({ added: 1, conflicted: 1, unchanged: 1, missing: 1 });
    const classes: ImportClassification[] = preview.items.map((i) => i.classification);
    expect(classes).toContain('added');
    expect(classes).toContain('conflicted');
    expect(classes).toContain('unchanged');
    expect(preview.missing).toHaveLength(1);
  });

  it('classifyImport 默认不覆盖：不写库，库条目数不变', () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const repo = new MemoryRepo(db);
    const { local, incoming } = buildLocalAndIncoming();
    for (const item of local) repo.insert(item);
    const before = repo.count({ userId: G.userId });
    expect(before).toBe(3);
    classifyImport(incoming, local);
    expect(repo.count({ userId: G.userId })).toBe(before);
    db.close();
  });
});

describe('merge-preview：keepBoth / 批量决策 / 落库', () => {
  it('keepBoth 生成新 id，落库后双方都保留、库条目 +1', () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const repo = new MemoryRepo(db);
    const localItem = repo.create({
      userId: G.userId, scope: 'page', projectId: G.projectId, featureId: G.featureId, pageId: G.pageId,
      title: 'L', content: 'local', structured: { v: 1 }, importance: 2, confidence: 0.5,
    });
    const incoming: MemoryItem = { ...localItem, updatedAt: localItem.updatedAt + 1, content: 'imported', structured: { v: 2 } };
    const preview = classifyImport([incoming], [localItem]);
    expect(preview.counts.conflicted).toBe(1);

    const plan = planMerge(preview, [{ id: incoming.id, strategy: 'keepBoth' }]);
    const apply = applyMergePlan(plan);
    expect(apply.toCreate).toHaveLength(1);
    expect(apply.toUpdate).toHaveLength(0);
    expect(apply.toSupersede).toHaveLength(0);
    const created = apply.toCreate[0]!;
    expect(created.id).not.toBe(localItem.id);
    expect(created.id).not.toBe(incoming.id);

    const result = commitMergePlan(repo, plan);
    expect(result).toEqual({ created: 1, updated: 0, superseded: 0 });
    expect(repo.count({ userId: G.userId })).toBe(2);
    expect(repo.findById(localItem.id)).not.toBeNull();
    expect(repo.findById(created.id)).not.toBeNull();
    db.close();
  });

  it('batchDecision 对 conflicted 取 keepBoth、对 added 取 takeNew，summary 计数正确', () => {
    const local = [
      createMemoryItem({ userId: G.userId, scope: 'longterm', title: 'X', content: 'local-X' }),
    ];
    const added = createMemoryItem({ userId: G.userId, scope: 'longterm', title: 'Y', content: 'new-Y' });
    const conflicted = { ...local[0]!, updatedAt: local[0]!.updatedAt + 1, content: 'incoming-X' };
    const unchanged = createMemoryItem({ userId: G.userId, scope: 'longterm', title: 'Z', content: 'z' });
    const preview = classifyImport([added, conflicted, unchanged], [...local, unchanged]);
    const decisions = batchDecision(preview, { conflicted: 'keepBoth', added: 'takeNew' });
    const plan = planMerge(preview, decisions);
    expect(plan.summary).toEqual({ keptLocal: 1, tookNew: 1, merged: 0, created: 1 });
  });

  it('默认策略：conflicted 默认 keepLocal（不覆盖），unchanged 默认 keepLocal', () => {
    const local = createMemoryItem({ userId: G.userId, scope: 'longterm', title: 'X', content: 'local' });
    const conflicted = { ...local, updatedAt: local.updatedAt + 1, content: 'incoming' };
    const preview = classifyImport([conflicted], [local]);
    const plan = planMerge(preview, []);
    expect(plan.summary).toEqual({ keptLocal: 1, tookNew: 0, merged: 0, created: 0 });
    const apply = applyMergePlan(plan);
    expect(apply.toCreate).toHaveLength(0);
    expect(apply.toUpdate).toHaveLength(0);
    expect(apply.toSupersede).toHaveLength(0);
  });
});

describe('端到端：导出再导入条目数一致', () => {
  it('exportJson → classifyImport（自比）全 unchanged，commit 后库数不变', () => {
    const { db } = createEmptyDb();
    seedGraph(db);
    const repo = new MemoryRepo(db);
    const items = makeFiveItems();
    for (const item of items) repo.insert(item);
    const before = repo.count({ userId: G.userId });
    expect(before).toBe(5);

    const json = exportJson(items, { userId: G.userId });
    const env = parseExportJson(json);
    const preview = classifyImport(env.items, repo.list({ userId: G.userId }));
    expect(preview.counts.unchanged).toBe(5);
    expect(preview.counts.added + preview.counts.conflicted + preview.counts.missing).toBe(0);
    for (const diff of preview.items) expect(diff.classification).toBe('unchanged');

    const plan = planMerge(preview, []);
    const result = commitMergePlan(repo, plan);
    expect(result).toEqual({ created: 0, updated: 0, superseded: 0 });
    expect(repo.count({ userId: G.userId })).toBe(before);
    db.close();
  });

  it('readImport 统一入口：markdown 来源解析为条目', () => {
    const items = makeFiveItems();
    const files = exportMarkdown(items).filter((f) => f.path !== 'README.md');
    const { items: parsed, skipped } = readImport({ kind: 'markdown', files });
    expect(skipped).toHaveLength(0);
    expect(parsed).toHaveLength(5);
  });
});

describe('import：版本不兼容抛 MemoryImportError', () => {
  it('format 不匹配 → FORMAT', () => {
    expect(() => parseExportJson('{"format":"other","version":1}')).toThrow(MemoryImportError);
    try {
      parseExportJson('{"format":"other","version":1}');
    } catch (e) {
      expect((e as MemoryImportError).code).toBe('FORMAT');
    }
  });

  it('version 过高 → VERSION', () => {
    try {
      parseExportJson(`{"format":"${MEMORY_EXPORT_FORMAT}","version":99}`);
    } catch (e) {
      expect(e).toBeInstanceOf(MemoryImportError);
      expect((e as MemoryImportError).code).toBe('VERSION');
    }
  });

  it('非法 JSON → PARSE', () => {
    try {
      parseExportJson('not json at all');
    } catch (e) {
      expect(e).toBeInstanceOf(MemoryImportError);
      expect((e as MemoryImportError).code).toBe('PARSE');
    }
  });
});
