import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepo } from '../../repo/memory-repo';
import { createEmptyDb, seedGraph, TEST_GRAPH, type TestDb } from '../../__tests__/helpers';
import type { MemoryCategory, MemoryCandidate, ExtractionModelPort } from '../extractor';
import { MemoryExtractor, parseCandidates } from '../extractor';
import { IMPERATIVE_PATTERNS, assessSignal, detectImperatives, levelOf } from '../signal-strength';
import {
  LongTermMemoryWriter,
  SettingsWritePolicyPort,
  decideWrite,
  type WritePolicyPort,
} from '../write-policy';
import type { SignalAssessment } from '../signal-strength';
import { ConflictCardSource } from '../conflict-card-source';
import { MemoryChangeLog } from '../change-log';
import { SettingsStore } from '@ec/core';

const USER = TEST_GRAPH.userId;

let handle: TestDb;
let repo: MemoryRepo;

beforeEach(() => {
  handle = createEmptyDb();
  seedGraph(handle.db);
  repo = new MemoryRepo(handle.db);
});

afterEach(() => {
  handle.close();
});

/* --------------------------- 测试工具 --------------------------- */

function candidate(
  partial: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'title' | 'content'>,
): MemoryCandidate {
  const category: MemoryCategory = partial.category ?? 'naming';
  return {
    title: partial.title,
    content: partial.content,
    category,
    structured: null,
    tags: partial.tags ?? [],
    signalCount: partial.signalCount ?? 1,
    hasImperative: partial.hasImperative ?? false,
    baseConfidence: partial.baseConfidence ?? 0.6,
    sourceConversationId: partial.sourceConversationId ?? 'C1',
    snippet: partial.snippet ?? '片段',
    evidence: partial.evidence ?? partial.content,
  };
}

function assessment(
  level: 'low' | 'medium' | 'high',
  overrides: Partial<SignalAssessment> = {},
): SignalAssessment {
  const confidence = level === 'high' ? 0.9 : level === 'medium' ? 0.6 : 0.2;
  return {
    confidence,
    level,
    signalCount: overrides.signalCount ?? 1,
    hasImperative: overrides.hasImperative ?? level === 'high',
    matchedImperatives: overrides.matchedImperatives ?? (level === 'high' ? ['以后都'] : []),
    ...overrides,
  };
}

function fixedPolicy(policy: 'auto' | 'confirm' | 'manual'): WritePolicyPort {
  return { policyFor: () => policy };
}

function seedLongterm(title: string, content: string, sourceRef = 'conversation:old'): string {
  const item = repo.create({
    userId: USER,
    scope: 'longterm',
    projectId: null,
    title,
    content,
    sourceType: 'auto_chat',
    sourceRef,
  });
  return item.id;
}

/* =========================== signal-strength =========================== */

describe('signal-strength', () => {
  it('IMPERATIVE_PATTERNS 覆盖中英文指令词', () => {
    for (const w of [
      '以后都',
      '以后',
      '不要',
      '别',
      '统一用',
      '统一',
      '禁止',
      '必须',
      '一律',
      'always',
      'never',
      'must',
      'do not',
      'prefer',
    ]) {
      expect(IMPERATIVE_PATTERNS).toContain(w);
    }
  });

  it('含「以后都」的语句被识别且置信度 ≥0.8（验收项）', () => {
    const r = assessSignal({ text: '以后都使用 TypeScript', occurrences: 1 });
    expect(r.hasImperative).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.8);
    expect(r.level).toBe('high');
  });

  it('detectImperatives 匹配中英文且不区分大小写', () => {
    expect(detectImperatives('Do Not use var').sort()).toEqual(['do not']);
    expect(detectImperatives('必须统一用 pnpm').sort()).toEqual(['必须', '统一', '统一用']);
  });

  it('同一偏好出现 ≥2 次可达高置信', () => {
    const r = assessSignal({ text: '用 pnpm', occurrences: 2 });
    expect(r.confidence).toBeGreaterThan(0.8);
    expect(r.level).toBe('high');
  });

  it('单次且无指令词落在中/低档', () => {
    expect(levelOf(0.3)).toBe('low');
    expect(levelOf(0.5)).toBe('medium');
    expect(levelOf(0.8)).toBe('medium');
    expect(levelOf(0.81)).toBe('high');
    const r = assessSignal({ text: 'maybe use tabs', occurrences: 1, baseConfidence: 0.2 });
    expect(r.level).toBe('low');
  });
});

/* =========================== extractor：同步无感 =========================== */

describe('MemoryExtractor 不阻塞主对话', () => {
  it('notify 同步返回且 drain 后才拿到结果', async () => {
    const delayMs = 8;
    const model: ExtractionModelPort = {
      name: 'fake',
      async complete() {
        await new Promise((r) => setTimeout(r, delayMs));
        return {
          ok: true,
          text: JSON.stringify([
            { title: '统一用 TypeScript', content: 'c', category: 'tech-stack', tags: ['ts'] },
          ]),
        };
      },
    };
    const ex = new MemoryExtractor({ model, repo });
    const received: MemoryCandidate[][] = [];
    ex.onCandidates((c) => {
      received.push(c);
    });

    const turn = {
      conversationId: 'C1',
      projectId: null,
      userId: USER,
      messages: [{ role: 'user' as const, content: '以后都用 TypeScript' }],
    };

    const start = performance.now();
    ex.notify(turn);
    const elapsed = performance.now() - start;
    // 同步耗时极小（远小于模型延迟）
    expect(elapsed).toBeLessThan(20);
    // 尚未抽取完成
    expect(received).toHaveLength(0);

    await ex.drain();
    expect(received).toHaveLength(1);
    expect(received[0]?.[0]?.title).toBe('统一用 TypeScript');
  });

  it('notify 不返回 Promise（同步语义）', () => {
    const model: ExtractionModelPort = {
      name: 'fake',
      async complete() {
        return { ok: true, text: '[]' };
      },
    };
    const ex = new MemoryExtractor({ model, repo });
    const ret = ex.notify({
      conversationId: 'C1',
      projectId: null,
      userId: USER,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(ret).toBeUndefined();
  });
});

/* =========================== extractor：容错解析 =========================== */

describe('parseCandidates 容错', () => {
  const turn = {
    conversationId: 'C1',
    projectId: null,
    userId: USER,
    messages: [{ role: 'user' as const, content: '以后都用 TypeScript' }],
  };

  it('解析 ```json 围栏', () => {
    const raw = '```json\n[{"title":"A","content":"c","category":"naming","tags":[]}]\n```';
    const r = parseCandidates(raw, turn);
    expect(r).toHaveLength(1);
    expect(r[0]?.title).toBe('A');
  });

  it('解析前后带解释文字', () => {
    const raw =
      '好的，这是结果：[{"title":"A","content":"c","category":"naming","tags":["x"]}] 完毕～';
    const r = parseCandidates(raw, turn);
    expect(r).toHaveLength(1);
  });

  it('单条非法跳过该条', () => {
    const raw =
      '[{"title":"","content":"c","category":"naming"},{"title":"B","content":"c","category":"tech-stack","tags":[]}]';
    const r = parseCandidates(raw, turn);
    expect(r).toHaveLength(1);
    expect(r[0]?.title).toBe('B');
  });

  it('完全非法文本返回空数组且不抛错', () => {
    expect(parseCandidates('没有偏好', turn)).toEqual([]);
    expect(parseCandidates('[坏', turn)).toEqual([]);
  });
});

/* =========================== extractor：失败静默重试 =========================== */

describe('extractOnce 失败静默重试', () => {
  it('连续两次失败：恰好调用 2 次、warn 1 次、路径无异常', async () => {
    const calls = vi.fn();
    const warns = vi.fn();
    const model: ExtractionModelPort = {
      name: 'fake',
      async complete() {
        calls();
        return { ok: false, reason: 'rate-limit' };
      },
    };
    const ex = new MemoryExtractor({
      model,
      repo,
      logger: { warn: (message: string) => void warns(message) },
    });
    const received: MemoryCandidate[][] = [];
    ex.onCandidates((c) => {
      received.push(c);
    });

    await ex.extractOnce({
      conversationId: 'C1',
      projectId: null,
      userId: USER,
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(calls).toHaveBeenCalledTimes(2);
    expect(warns).toHaveBeenCalledTimes(1);
  });

  it('notify 路径不抛错（失败静默丢弃）', async () => {
    const model: ExtractionModelPort = {
      name: 'fake',
      async complete() {
        return { ok: false, reason: 'boom' };
      },
    };
    const ex = new MemoryExtractor({ model, repo });
    expect(() =>
      ex.notify({
        conversationId: 'C1',
        projectId: null,
        userId: USER,
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).not.toThrow();
    await expect(ex.drain()).resolves.toBeUndefined();
  });

  it('第一次失败第二次成功：正常产出候选', async () => {
    const calls = vi.fn();
    const model: ExtractionModelPort = {
      name: 'fake',
      async complete() {
        calls();
        if (calls.mock.calls.length === 1) return { ok: false, reason: 'temp' };
        return {
          ok: true,
          text: JSON.stringify([{ title: 'A', content: 'c', category: 'naming', tags: [] }]),
        };
      },
    };
    const ex = new MemoryExtractor({ model, repo });
    const r = await ex.extractOnce({
      conversationId: 'C1',
      projectId: null,
      userId: USER,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(r).toHaveLength(1);
    expect(r[0]?.title).toBe('A');
  });
});

/* =========================== write-policy：三档策略 =========================== */

describe('decideWrite 三档', () => {
  it('auto：高置信静默写，低置信跳过', () => {
    expect(decideWrite({ confidence: 0.9, level: 'high' }, 'auto').action).toBe('silent-write');
    expect(decideWrite({ confidence: 0.2, level: 'low' }, 'auto').action).toBe('skip');
  });
  it('confirm：非低置信写入+通知，低置信跳过', () => {
    expect(decideWrite({ confidence: 0.9, level: 'high' }, 'confirm').action).toBe(
      'write-and-notify',
    );
    expect(decideWrite({ confidence: 0.6, level: 'medium' }, 'confirm').action).toBe(
      'write-and-notify',
    );
    expect(decideWrite({ confidence: 0.2, level: 'low' }, 'confirm').action).toBe('skip');
  });
  it('manual：仅建议', () => {
    expect(decideWrite({ confidence: 0.9, level: 'high' }, 'manual').action).toBe('suggest-only');
  });
  it('达到上限一律建议归档', () => {
    const d = decideWrite({ confidence: 0.9, level: 'high' }, 'confirm', {
      maxLongterm: 2,
      currentLongtermCount: 2,
    });
    expect(d.action).toBe('suggest-only');
    expect(d.reason).toContain('上限');
  });
});

describe('LongTermMemoryWriter 行为', () => {
  it('auto 高置信静默写入且不产生通知(decision=silent-write)', () => {
    const writer = new LongTermMemoryWriter({ repo, policy: fixedPolicy('auto') });
    const cand = candidate({
      title: '统一用 TypeScript',
      content: '长期约定',
      sourceConversationId: 'C1',
    });
    const res = writer.apply(cand, assessment('high'), { userId: USER });
    expect(res).not.toBeNull();
    if (res && 'record' in res) {
      expect(res.record.decision.action).toBe('silent-write');
      const stored = repo.findById(res.record.memoryId);
      expect(stored).not.toBeNull();
      expect(stored?.status).toBe('active');
    } else {
      throw new Error('应为写入结果');
    }
  });

  it('auto 低置信跳过（库里无新条目）', () => {
    const writer = new LongTermMemoryWriter({ repo, policy: fixedPolicy('auto') });
    const cand = candidate({ title: '也许用 tabs', content: 'x' });
    const res = writer.apply(cand, assessment('low'), { userId: USER });
    expect(res).toBeNull();
    expect(repo.list({ userId: USER, scopes: ['longterm'] })).toHaveLength(0);
  });

  it('confirm 自动写入并可撤销；undo 后条目消失', () => {
    const writer = new LongTermMemoryWriter({ repo, policy: fixedPolicy('confirm') });
    const cand = candidate({
      title: '统一命名规范',
      content: '长期约定',
      sourceConversationId: 'C1',
    });
    const res = writer.apply(cand, assessment('high'), { userId: USER });
    expect(res).not.toBeNull();
    if (!res || !('record' in res)) throw new Error('应为写入结果');
    expect(res.record.decision.action).toBe('write-and-notify');

    const ok = writer.undo(res.record.memoryId, { userId: USER });
    expect(ok).toBe(true);
    const stored = repo.findById(res.record.memoryId);
    expect(stored?.status).toBe('archived');
    const active = repo.list({ userId: USER, scopes: ['longterm'], status: 'active' });
    expect(active.find((m) => m.id === res.record.memoryId)).toBeUndefined();
  });

  it('manual 仅建议，库里无新条目', () => {
    const writer = new LongTermMemoryWriter({ repo, policy: fixedPolicy('manual') });
    const cand = candidate({ title: '建议用 ESLint', content: 'x' });
    const res = writer.apply(cand, assessment('high'), { userId: USER });
    expect(res).not.toBeNull();
    expect('suggestionOnly' in res!).toBe(true);
    expect(repo.list({ userId: USER, scopes: ['longterm'] })).toHaveLength(0);
  });

  it('项目级覆盖全局：WritePolicyPort 不同档位行为随之改变', () => {
    const cand = candidate({ title: 'T', content: 'x' });
    const autoWriter = new LongTermMemoryWriter({ repo, policy: fixedPolicy('auto') });
    const manualWriter = new LongTermMemoryWriter({ repo, policy: fixedPolicy('manual') });
    const autoRes = autoWriter.apply(cand, assessment('high'), { userId: USER });
    const manualRes = manualWriter.apply(cand, assessment('high'), { userId: USER });
    expect(autoRes && 'record' in autoRes).toBe(true);
    expect(manualRes && 'suggestionOnly' in manualRes).toBe(true);
  });

  it('SettingsWritePolicyPort 读取全局/项目策略', () => {
    const store = new SettingsStore();
    const port = new SettingsWritePolicyPort(store);
    expect(port.policyFor(null)).toBe('confirm'); // 默认 confirm
    store.updateGlobal({ ai: { ...store.getGlobal().ai, memoryWritePolicy: 'auto' } });
    expect(port.policyFor(null)).toBe('auto');
    store.updateProject(TEST_GRAPH.projectId, { memoryWritePolicy: 'manual' });
    expect(port.policyFor(TEST_GRAPH.projectId)).toBe('manual');
  });
});

/* =========================== conflict-card-source =========================== */

describe('ConflictCardSource 三选项', () => {
  it('inspect 返回冲突对比卡（conflicts 非空）', () => {
    const localId = seedLongterm('使用 TypeScript', '旧的规范');
    const source = new ConflictCardSource({ repo });
    const cand = candidate({
      title: '使用 TypeScript',
      content: '新的规范',
      category: 'tech-stack',
      sourceConversationId: 'new',
    });
    const model = source.inspect(cand, { userId: USER });
    expect(model).not.toBeNull();
    expect(model?.memoryId).toBe(localId);
    expect(model?.conflicts.length).toBeGreaterThan(0);
    expect(model?.options.map((o) => o.strategy)).toEqual(['keepLocal', 'takeNew', 'merge']);
  });

  it('无冲突时 inspect 返回 null', () => {
    seedLongterm('已有的', 'x');
    const source = new ConflictCardSource({ repo });
    const cand = candidate({
      title: '完全不同的新偏好',
      content: 'y',
      sourceConversationId: 'new',
    });
    expect(source.inspect(cand, { userId: USER })).toBeNull();
  });

  it('keepLocal：保留旧条目，写冲突日志', () => {
    seedLongterm('使用 TypeScript', '旧的规范');
    const source = new ConflictCardSource({ repo });
    const cand = candidate({
      title: '使用 TypeScript',
      content: '新的规范',
      category: 'tech-stack',
      sourceConversationId: 'new',
    });
    const model = source.inspect(cand, { userId: USER });
    expect(model).not.toBeNull();
    const r = source.resolve(model!, 'keepLocal', { userId: USER });
    expect(r.action).toBe('kept-local');
    const stored = repo.findById(model!.memoryId)!;
    expect(stored.content).toBe('旧的规范');
    expect(
      repo.changes
        .list({ userId: USER, memoryId: model!.memoryId })
        .some((e) => e.action === 'conflict_resolve'),
    ).toBe(true);
  });

  it('takeNew：采用新内容（保留既有 id），写冲突日志', () => {
    seedLongterm('使用 TypeScript', '旧的规范');
    const source = new ConflictCardSource({ repo });
    const cand = candidate({
      title: '使用 TypeScript',
      content: '新的规范',
      category: 'tech-stack',
      sourceConversationId: 'new',
    });
    const model = source.inspect(cand, { userId: USER })!;
    const r = source.resolve(model, 'takeNew', { userId: USER });
    expect(r.action).toBe('took-new');
    const stored = repo.findById(model.memoryId)!;
    expect(stored.id).toBe(model.memoryId); // 保留既有 id
    expect(stored.content).toBe('新的规范');
    expect(r.mergedFields).toEqual([]);
  });

  it('merge：结果保留双方来源引用（sources 长度 2，sourceRef 含两者）', () => {
    seedLongterm('使用 TypeScript', '旧的规范', 'conversation:old');
    const source = new ConflictCardSource({ repo });
    const cand = candidate({
      title: '使用 TypeScript',
      content: '新的规范',
      category: 'tech-stack',
      sourceConversationId: 'new',
    });
    const model = source.inspect(cand, { userId: USER })!;
    const r = source.resolve(model, 'merge', { userId: USER });
    expect(r.action).toBe('merged');
    expect(r.sources).toHaveLength(2);
    expect(r.sources).toContain('conversation:old');
    expect(r.sources).toContain('conversation:new');
    const stored = repo.findById(model.memoryId)!;
    expect(stored.sourceRef).toContain('conversation:old');
    expect(stored.sourceRef).toContain('conversation:new');
  });

  it('longtermStatus 上限提示', () => {
    const source = new ConflictCardSource({ repo, maxLongterm: 2 });
    expect(source.longtermStatus({ userId: USER }).shouldArchive).toBe(false);
    seedLongterm('A', 'x');
    seedLongterm('B', 'y');
    const status = source.longtermStatus({ userId: USER });
    expect(status.count).toBe(2);
    expect(status.limit).toBe(2);
    expect(status.shouldArchive).toBe(true);
  });
});

/* =========================== change-log =========================== */

describe('MemoryChangeLog', () => {
  it('每次自动写入记录对话片段、来源与策略，且 jumpTarget 可取回 conversationId', () => {
    const writer = new LongTermMemoryWriter({ repo, policy: fixedPolicy('confirm') });
    const cand = candidate({
      title: '统一用 Prettier',
      content: '长期约定',
      sourceConversationId: 'CX',
      snippet: '来自对话的片段',
    });
    const res = writer.apply(cand, assessment('high'), { userId: USER });
    expect(res && 'record' in res).toBe(true);
    if (!res || !('record' in res)) throw new Error('预期自动写入并返回 record');

    const log = new MemoryChangeLog(repo);
    const entries = log.list({ userId: USER, memoryId: res.record.memoryId });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[0]!;
    expect(entry.action).toBe('auto_write');
    expect(entry.conversationId).toBe('CX');
    expect(entry.snippet).toBe('来自对话的片段');
    expect(entry.at).toBeGreaterThan(0);

    const target = log.jumpTarget(entry.id);
    expect(target.conversationId).toBe('CX');
    expect(target.memoryId).toBe(res.record.memoryId);
  });

  it('undo 写入 undo 变更日志', () => {
    const writer = new LongTermMemoryWriter({ repo, policy: fixedPolicy('confirm') });
    const cand = candidate({ title: '统一用 ESLint', content: 'x', sourceConversationId: 'CY' });
    const res = writer.apply(cand, assessment('high'), { userId: USER });
    if (!res || !('record' in res)) throw new Error('应为写入结果');
    writer.undo(res.record.memoryId, { userId: USER });
    const log = new MemoryChangeLog(repo);
    expect(
      log.list({ userId: USER, memoryId: res.record.memoryId }).some((e) => e.action === 'undo'),
    ).toBe(true);
  });
});
