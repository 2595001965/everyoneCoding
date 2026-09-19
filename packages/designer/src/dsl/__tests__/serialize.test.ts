import { describe, expect, it } from 'vitest';

import { createElement, createLoginPageDsl, createPageDsl } from '../factory';
import {
  DslParseError,
  deserializePageDsl,
  dslFileName,
  isDslFileName,
  listPageDslFiles,
  loadPageDsl,
  pageDslPath,
  pageIdFromFileName,
  savePageDsl,
  serializePageDsl,
  type DslStorePort,
} from '../serialize';
import { DSL_VERSION, DslVersionError, migrateDsl } from '../version';
import type { ElementNode, PageDsl } from '../types';

/** 模拟原子写：先写临时文件，再 rename 提交（与 @ec/core FileService 语义一致） */
class AtomicMemoryStore implements DslStorePort {
  readonly files = new Map<string, string>();
  readonly temps = new Map<string, string>();
  writeCalls = 0;
  /** 在 rename 提交前注入崩溃 */
  crashBeforeCommit = false;

  async readText(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
    this.writeCalls += 1;
    const temp = `${path}.ec-tmp`;
    this.temps.set(temp, String(data));
    if (this.crashBeforeCommit) {
      const error = new Error('模拟写入中断（进程被杀 / 磁盘满）');
      this.crashBeforeCommit = false;
      throw error;
    }
    this.files.set(path, String(data));
    this.temps.delete(temp);
  }

  async list(path: string): Promise<string[]> {
    const prefix = `${path.replace(/\/+$/, '')}/`;
    return [...this.files.keys()].filter((key) => key.startsWith(prefix));
  }
}

function deepTree(depth: number): ElementNode {
  let node: ElementNode = createElement({
    id: `n-${depth - 1}`,
    type: 'Text',
    name: `第 ${depth} 层`,
    props: { text: '深层文本', nested: { list: [1, 2, { deep: true }] } },
    style: { color: '#333', padding: 8 },
    bindings: { text: 'deepText' },
  });
  for (let level = depth - 2; level >= 0; level -= 1) {
    node = createElement({
      id: `n-${level}`,
      type: 'Container',
      name: `第 ${level + 1} 层`,
      children: [node],
    });
  }
  return node;
}

describe('T3-01 文件命名', () => {
  it('文件名与路径拼接', () => {
    expect(dslFileName('login')).toBe('login.dsl.json');
    expect(pageDslPath('pages/', 'login')).toBe('pages/login.dsl.json');
    expect(isDslFileName('login.dsl.json')).toBe(true);
    expect(isDslFileName('login.json')).toBe(false);
    expect(pageIdFromFileName('login.dsl.json')).toBe('login');
    expect(pageIdFromFileName('.dsl.json')).toBeNull();
  });
});

describe('T3-01 序列化往返', () => {
  it('登录页样例往返无损', () => {
    const dsl = createLoginPageDsl();
    const roundTrip = deserializePageDsl(serializePageDsl(dsl)).dsl;
    expect(roundTrip).toEqual(dsl);
  });

  it('含 8 层嵌套与复杂 props 的页面往返无损', () => {
    const dsl = createPageDsl({
      id: 'deep',
      projectId: 'P1',
      name: '深层页',
      platform: 'ios',
      route: '/deep',
      tree: deepTree(8),
    });
    const text = serializePageDsl(dsl);
    const roundTrip = deserializePageDsl(text).dsl;
    expect(roundTrip).toEqual(dsl);
    expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(dsl));
  });

  it('信封带 dslVersion', () => {
    const text = serializePageDsl(createLoginPageDsl());
    const parsed = JSON.parse(text) as { dslVersion: number; page: PageDsl };
    expect(parsed.dslVersion).toBe(DSL_VERSION);
    expect(parsed.page.id).toBe('login');
  });

  it('非法 JSON 与非法结构给出可读错误', () => {
    expect(() => deserializePageDsl('{ not json')).toThrow(DslParseError);
    expect(() => deserializePageDsl('[]')).toThrow(DslParseError);
    expect(() =>
      deserializePageDsl(JSON.stringify({ dslVersion: DSL_VERSION, page: { id: 'x' } })),
    ).toThrow(/PageDSL 校验失败/);
  });

  it('写出前先校验，非法 DSL 不落盘', async () => {
    const store = new AtomicMemoryStore();
    const bad = { ...createLoginPageDsl(), route: 'login' } as PageDsl;
    await expect(savePageDsl(store, 'p/bad.dsl.json', bad)).rejects.toThrow();
    expect(store.writeCalls).toBe(0);
  });
});

describe('T3-01 原子写与中断', () => {
  it('每次保存只发起一次原子写（无半截文件残留）', async () => {
    const store = new AtomicMemoryStore();
    const path = 'pages/login.dsl.json';
    await savePageDsl(store, path, createLoginPageDsl());
    expect(store.writeCalls).toBe(1);
    expect(store.temps.size).toBe(0);
    expect(await store.exists(path)).toBe(true);
  });

  it('写入中断时目标文件保持原内容，不产生半截文件', async () => {
    const store = new AtomicMemoryStore();
    const path = 'pages/login.dsl.json';
    await savePageDsl(store, path, createLoginPageDsl());
    const before = await store.readText(path);

    const modified: PageDsl = { ...createLoginPageDsl(), name: '改过名字的登录页' };
    store.crashBeforeCommit = true;
    await expect(savePageDsl(store, path, modified)).rejects.toThrow('模拟写入中断');

    // 目标文件仍是旧内容；未提交的临时文件不会污染目标路径
    expect(await store.readText(path)).toBe(before);
    expect(deserializePageDsl(await store.readText(path)).dsl.name).toBe('登录页');
  });

  it('loadPageDsl 返回带文件路径与版本的记录', async () => {
    const store = new AtomicMemoryStore();
    const path = pageDslPath('project/pages', 'login');
    await savePageDsl(store, path, createLoginPageDsl());
    const record = await loadPageDsl(store, path);
    expect(record.filePath).toBe('project/pages/login.dsl.json');
    expect(record.dslVersion).toBe(DSL_VERSION);
    expect(record.dsl.id).toBe('login');
  });

  it('目录扫描只挑出 *.dsl.json', async () => {
    const store = new AtomicMemoryStore();
    await savePageDsl(store, 'pages/a.dsl.json', createLoginPageDsl());
    await savePageDsl(store, 'pages/b.dsl.json', createLoginPageDsl());
    store.files.set('pages/readme.md', '# 说明');
    expect((await listPageDslFiles(store, 'pages')).sort()).toEqual(['a.dsl.json', 'b.dsl.json']);
  });
});

describe('T3-01 版本迁移', () => {
  /** 构造一份 v1 遗留文件：裸 PageDsl（无信封），带别名字面量与 breakpointStyles */
  function legacyV1(): Record<string, unknown> {
    return {
      id: 'legacy',
      projectId: 'P1',
      name: '老页面',
      platform: 'web',
      route: '/legacy',
      viewport: { width: 1440, height: 900 },
      state: [{ name: 'count', type: 'number', initial: 0 }],
      tree: {
        id: 'root',
        type: 'Container',
        name: '页面',
        breakpointStyles: { 768: { padding: 8 }, 375: { padding: 4 } },
        children: [{ id: 'btn', type: 'Button', props: { text: '提交' } }],
      },
      events: [
        {
          id: 'ev',
          trigger: 'click',
          actions: [
            { id: 'a1', kind: 'setState', value: 'count=1' },
            { id: 'a2', kind: 'toast', value: '成功' },
            { id: 'a3', kind: 'navigateTo', target: '/next' },
            { id: 'a4', kind: 'call', target: '/api/x' },
          ],
        },
      ],
    };
  }

  it('migrateDsl 记录迁移链', () => {
    const result = migrateDsl(legacyV1());
    expect(result.from).toBe(1);
    expect(result.to).toBe(DSL_VERSION);
    expect(result.applied).toEqual([1, 2]);
  });

  it('v1 文件加载后补齐 notes/anchors/apiDeps 并归一化动作别名', () => {
    const result = deserializePageDsl(JSON.stringify(legacyV1()));
    expect(result.fromVersion).toBe(1);
    expect(result.version).toBe(DSL_VERSION);
    expect(result.dsl.notes).toEqual([]);
    expect(result.dsl.anchors).toEqual({});
    expect(result.dsl.apiDeps).toEqual([]);
    expect(result.dsl.events[0]?.actions.map((action) => action.kind)).toEqual([
      'assign',
      'notify',
      'navigate',
      'request',
    ]);
  });

  it('v2 的 breakpointStyles 迁移为 v3 的 responsive（差异属性），不产生元素副本', () => {
    const result = deserializePageDsl(JSON.stringify(legacyV1()));
    expect(result.dsl.tree.responsive).toEqual({ '768': { padding: 8 }, '375': { padding: 4 } });
    // 原字段已被移除，且树中元素数量不变（仍是 2 个）
    expect(JSON.stringify(result.dsl.tree)).not.toContain('breakpointStyles');
    expect(result.dsl.tree.children).toHaveLength(1);
  });

  it('文件版本高于当前客户端时拒绝加载', () => {
    const future = serializePageDsl(createLoginPageDsl(), DSL_VERSION + 1);
    expect(() => deserializePageDsl(future)).toThrow(DslVersionError);
  });

  it('当前版本文件不触发迁移', () => {
    const result = deserializePageDsl(serializePageDsl(createLoginPageDsl()));
    expect(result.applied).toEqual([]);
    expect(result.fromVersion).toBe(DSL_VERSION);
  });
});
