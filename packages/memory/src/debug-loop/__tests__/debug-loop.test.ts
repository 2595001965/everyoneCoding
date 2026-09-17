import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryRepo } from '../../repo/memory-repo';
import { IssueMemoryService } from '../../service/issue-memory';
import { DebugLoopDetector } from '../detector';
import {
  InMemoryIgnoreStore,
  PromptCardSource,
} from '../prompt-card-source';
import {
  IssueDraftBuilder,
  draftToCreateIssueInput,
  materializeIssueDraft,
  type ConversationSnippetPort,
  type GitCommitPort,
} from '../draft-builder';
import {
  WindowQueue,
  normalizeErrorSignature,
  readableTarget,
  targetKeyOf,
  type DebugEvent,
} from '../window-queue';
import { createEmptyDb, seedGraph, TEST_GRAPH, type TestDb } from '../../__tests__/helpers';

/**
 * T2-05：Debug 循环检测与问题记忆（领域层）。
 *
 * 所有时间都由 `clock` / 显式参数注入，断言不依赖真实时钟。
 */

const T0 = 1_700_000_000_000;
const TARGET = { pageId: 'PG1', elementId: 'E1', featureId: 'F1' };
const KEY = targetKeyOf(TARGET);
const WINDOW = 10 * 60 * 1000;

let clockNow = T0;
const clock = (): number => clockNow;

function targetOf(patch: Partial<typeof TARGET> = {}): typeof TARGET {
  return { ...TARGET, ...patch };
}

function event(
  type: DebugEvent['type'],
  at: number,
  patch: Partial<DebugEvent> = {},
): DebugEvent {
  return {
    type,
    at,
    targetKey: KEY,
    ...TARGET,
    ...patch,
  };
}

/** 造一次「生成 → 运行 → 报错」完整循环 */
function cycle(at: number, signature: string, extra: Partial<DebugEvent> = {}): DebugEvent[] {
  return [
    event('generate', at, { attemptSummary: '生成提交按钮', ...extra }),
    event('run', at + 1, extra),
    event('error', at + 2, { errorSignature: signature, rawError: `TypeError: ${signature} at /a/b.ts:1:2`, ...extra }),
  ];
}

beforeEach(() => {
  clockNow = T0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WindowQueue 滚动窗口', () => {
  it('窗口内事件按时间升序返回，过期事件被清理', () => {
    const queue = new WindowQueue({ windowMs: WINDOW });
    queue.push(event('generate', T0));
    queue.push(event('run', T0 + 1000));
    queue.push(event('error', T0 + 2000, { errorSignature: 'sig-a' }));

    // 注意：within 会顺带清理过期项，因此这里只按 now 递增的顺序断言
    expect(queue.size(T0 + 2000)).toBe(3);
    expect(queue.within(T0 + 2000).map((e) => e.type)).toEqual(['generate', 'run', 'error']);

    // 窗口为半开区间：now=T0+WINDOW+1 时 cutoff=T0+1，最早的 generate 过期
    expect(queue.within(T0 + WINDOW + 1).map((e) => e.type)).toEqual(['run', 'error']);

    // 继续推进：只剩最后一个事件
    expect(queue.within(T0 + 2000 + WINDOW).map((e) => e.type)).toEqual(['error']);

    // 全部过期
    expect(queue.within(T0 + 2002 + WINDOW + 1)).toEqual([]);
    expect(queue.size(T0 + 2002 + WINDOW + 1)).toBe(0);
  });

  it('超过 maxEvents 时丢弃最旧事件（防止长时间调试吃满内存）', () => {
    const queue = new WindowQueue({ windowMs: WINDOW, maxEvents: 3 });
    for (let index = 0; index < 5; index += 1) queue.push(event('run', T0 + index));
    const kept = queue.within(T0 + 100);
    expect(kept).toHaveLength(3);
    expect(kept.map((e) => e.at)).toEqual([T0 + 2, T0 + 3, T0 + 4]);
  });

  it('clear 清空全部事件', () => {
    const queue = new WindowQueue({ windowMs: WINDOW });
    queue.push(event('generate', T0));
    queue.clear();
    expect(queue.size(T0)).toBe(0);
  });
});

describe('错误指纹归一化与归属键', () => {
  it('仅路径 / 行号 / 时间戳不同的同类错误得到同一指纹', () => {
    const a = normalizeErrorSignature("TypeError: Cannot read properties of undefined (reading 'x') at /a/b.ts:12:5");
    const b = normalizeErrorSignature("TypeError: Cannot read properties of undefined (reading 'x') at C:\\x\\y.ts:99:1");
    const c = normalizeErrorSignature(
      "TypeError: Cannot read properties of undefined (reading 'x') at /a/b.ts:12:5 2024-01-02T03:04:05.678Z",
    );
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toContain('cannot read properties of undefined');
  });

  it('不同类型的错误得到不同指纹', () => {
    const a = normalizeErrorSignature('TypeError: x is not a function');
    const b = normalizeErrorSignature('SyntaxError: Unexpected token }');
    expect(a).not.toBe(b);
  });

  it('归属键稳定且与字段顺序无关，可读描述不含 targetKey', () => {
    expect(targetKeyOf(TARGET)).toBe('page:PG1|element:E1|feature:F1');
    expect(targetKeyOf({ elementId: 'E1', featureId: 'F1', pageId: 'PG1' })).toBe('page:PG1|element:E1|feature:F1');
    expect(targetKeyOf({})).toBe('page:-|element:-|feature:-');
    expect(readableTarget(TARGET)).toBe('功能F1 / 页面PG1 / 元素E1');
    expect(readableTarget(TARGET)).not.toContain('page:');
    expect(readableTarget({})).toBe('未知目标');
  });
});

describe('DebugLoopDetector 阈值与抑制', () => {
  function makeDetector(queue?: WindowQueue): { queue: WindowQueue; detector: DebugLoopDetector } {
    const q = queue ?? new WindowQueue({ windowMs: WINDOW });
    return { queue: q, detector: new DebugLoopDetector({ queue: q, clock }) };
  }

  it('2 次循环未达阈值（且错误指纹各不相同）→ 不命中', () => {
    const { queue, detector } = makeDetector();
    for (const item of [...cycle(T0, 'sig-a'), ...cycle(T0 + 100, 'sig-b')]) queue.push(item);
    expect(detector.inspect(T0 + 1000)).toEqual([]);
  });

  it('3 次循环达阈值 → 命中，原因为 cycles，并给出可读标题', () => {
    const { queue, detector } = makeDetector();
    for (const [index, signature] of ['sig-a', 'sig-b', 'sig-c'].entries()) {
      for (const item of cycle(T0 + index * 100, signature)) queue.push(item);
    }

    const results = detector.inspect(T0 + 1000);
    expect(results).toHaveLength(1);
    const hit = results[0]!;
    expect(hit.reason).toBe('cycles');
    expect(hit.cycles).toBe(3);
    expect(hit.errorSignatures).toEqual(['sig-a', 'sig-b', 'sig-c']);
    expect(hit.suggestedTitle).toBe('反复调试「功能F1 / 页面PG1 / 元素E1」');
    expect(hit.pageId).toBe('PG1');
    expect(hit.elementId).toBe('E1');
    expect(hit.firstAt).toBe(T0);
    expect(hit.lastAt).toBe(T0 + 202);
  });

  it('同一错误指纹连续出现 2 次 → 命中，原因为 repeated-error', () => {
    const { queue, detector } = makeDetector();
    queue.push(event('error', T0, { errorSignature: 'same', rawError: 'boom' }));
    queue.push(event('error', T0 + 10, { errorSignature: 'same', rawError: 'boom again' }));

    const results = detector.inspect(T0 + 100);
    expect(results).toHaveLength(1);
    expect(results[0]?.reason).toBe('repeated-error');
    expect(results[0]?.cycles).toBe(0);
    expect(results[0]?.errorSignatures).toEqual(['same']);
  });

  it('「连续」的定义：中间的 generate/run 不打断两个同类错误的相邻关系', () => {
    const { queue, detector } = makeDetector();
    queue.push(event('error', T0, { errorSignature: 'same' }));
    queue.push(event('generate', T0 + 1));
    queue.push(event('run', T0 + 2));
    queue.push(event('error', T0 + 3, { errorSignature: 'same' }));
    expect(detector.inspect(T0 + 100)[0]?.reason).toBe('repeated-error');
  });

  it('不同 target 的报错不会互相累计成命中', () => {
    const { queue, detector } = makeDetector();
    const otherKey = targetKeyOf(targetOf({ elementId: 'E9' }));

    // A：2 次循环但错误指纹不同；B 同理 —— 合并成 4 次错误也不该命中
    for (const [index, signature] of ['a1', 'a2'].entries()) {
      for (const item of cycle(T0 + index * 10, signature)) queue.push(item);
    }
    for (const [index, signature] of ['b1', 'b2'].entries()) {
      for (const item of cycle(T0 + 100 + index * 10, signature, { elementId: 'E9' })) {
        queue.push({ ...item, targetKey: otherKey });
      }
    }
    expect(detector.inspect(T0 + 1000)).toEqual([]);
  });

  it('record 命中后抑制重复触发，consume 后重新可触发', () => {
    const { detector } = makeDetector();
    let first = null as ReturnType<DebugLoopDetector['record']>;
    for (const [index, signature] of ['s1', 's2', 's3'].entries()) {
      for (const item of cycle(T0 + index * 100, signature)) first = detector.record(item) ?? first;
    }
    expect(first?.reason).toBe('cycles');

    // 未 consume：再记一条同类事件也不重复返回
    expect(detector.record(event('error', T0 + 500, { errorSignature: 's4' }))).toBeNull();

    detector.consume(KEY);
    expect(detector.record(event('error', T0 + 600, { errorSignature: 's5' }))).not.toBeNull();
  });

  it('reset 清空队列与抑制集合', () => {
    const { queue, detector } = makeDetector();
    for (const item of [...cycle(T0, 's1'), ...cycle(T0 + 10, 's2'), ...cycle(T0 + 20, 's3')]) queue.push(item);
    expect(detector.inspect(T0 + 100)).toHaveLength(1);
    detector.reset();
    expect(detector.inspect(T0 + 100)).toEqual([]);
  });
});

describe('PromptCardSource 提示卡策略', () => {
  function setup(options: { snoozeMs?: number } = {}): {
    detector: DebugLoopDetector;
    ignoreStore: InMemoryIgnoreStore;
    source: PromptCardSource;
    feed: (times: number, signature?: string) => void;
    /** 直接往队列里塞事件（用于静默期满后的新窗口） */
    feed2: (event: DebugEvent) => void;
  } {
    const queue = new WindowQueue({ windowMs: WINDOW });
    const detector = new DebugLoopDetector({ queue, clock });
    const ignoreStore = new InMemoryIgnoreStore();
    const source = new PromptCardSource({
      detector,
      ignoreStore,
      clock,
      ...(options.snoozeMs !== undefined ? { snoozeMs: options.snoozeMs } : {}),
    });
    const feed = (times: number, signature = 'sig'): void => {
      for (let index = 0; index < times; index += 1) {
        for (const item of cycle(T0 + index * 10, `${signature}-${index}`)) queue.push(item);
      }
    };
    return { detector, ignoreStore, source, feed, feed2: (item) => queue.push(item) };
  }

  it('命中时派发决策，文案固定且不含 targetKey', () => {
    const { source, feed } = setup();
    feed(3);
    const decisions = source.evaluate();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.targetKey).toBe(KEY);
    expect(decisions[0]?.title).toBe('功能F1 / 页面PG1 / 元素E1');
    expect(decisions[0]?.message).toBe('检测到正在反复调试「功能F1 / 页面PG1 / 元素E1」，是否建立专门的问题记忆？');
    expect(decisions[0]?.message).not.toContain('page:');
  });

  it('同一命中不重复派发（evaluate 幂等）', () => {
    const { source, feed } = setup();
    feed(3);
    expect(source.evaluate()).toHaveLength(1);
    expect(source.evaluate()).toHaveLength(0);
  });

  it('「稍后」：30 分钟内不再派发，超时后恢复', () => {
    const { source, feed, feed2 } = setup();
    feed(3);
    expect(source.evaluate()).toHaveLength(1);
    source.snooze(KEY);
    expect(source.isSnoozed(KEY, T0 + 1000)).toBe(true);

    // 静默期内不派发
    clockNow = T0 + 1000;
    expect(source.evaluate()).toHaveLength(0);

    // 窗口自然滚动清空（远早于 30 分钟静默期满）：内部"已派发"标记随之释放
    clockNow = T0 + WINDOW + 60_000;
    expect(source.evaluate()).toHaveLength(0);

    // 静默期满 + 新的调试循环 → 再次提示
    clockNow = T0 + 30 * 60 * 1000 + 1;
    expect(source.isSnoozed(KEY, clockNow)).toBe(false);
    for (const [index, signature] of ['n1', 'n2', 'n3'].entries()) {
      for (const item of cycle(clockNow + index * 10, signature)) feed2(item);
    }
    expect(source.evaluate()).toHaveLength(1);
  });

  it('「不再提示此项」：对该 target 持久生效', () => {
    const { source, ignoreStore, feed } = setup();
    feed(3);
    source.neverShow(KEY);
    expect(ignoreStore.isIgnored(KEY)).toBe(true);

    clockNow = T0 + 1;
    expect(source.evaluate()).toHaveLength(0);

    // 时间大幅前进依然不再提示
    clockNow = T0 + 5 * 60 * 60 * 1000;
    expect(source.evaluate()).toHaveLength(0);
  });

  it('监听回调抛错不影响派发结果（不阻塞、不抛出）', () => {
    const { detector, source, feed } = setup();
    feed(3);
    const received: string[] = [];
    source.on(() => {
      throw new Error('渲染层炸了');
    });
    source.on((decision) => {
      received.push(decision.targetKey);
    });
    expect(() => source.evaluate()).not.toThrow();
    expect(received).toEqual([KEY]);

    // 取消订阅后不再收到：换一个 target 触发派发，验证已取消的监听不被调用
    const off = source.on(() => received.push('x'));
    off();
    detector.consume(KEY);
    const otherKey = targetKeyOf(targetOf({ elementId: 'E9' }));
    for (const [index, signature] of ['o1', 'o2', 'o3'].entries()) {
      for (const item of cycle(T0 + 500 + index * 10, signature, { elementId: 'E9' })) {
        detector.record({ ...item, targetKey: otherKey });
      }
    }
    source.evaluate();
    expect(received).toEqual([KEY, otherKey]);
  });
});

describe('IssueDraftBuilder 草稿构建', () => {
  let handle: TestDb;

  beforeEach(() => {
    handle = createEmptyDb();
    seedGraph(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  function feed(): WindowQueue {
    const queue = new WindowQueue({ windowMs: WINDOW });
    for (const [index, signature] of ['sig-a', 'sig-b', 'sig-c'].entries()) {
      for (const item of cycle(T0 + index * 100, signature, { conversationId: `CONV-${index}` })) {
        queue.push(item);
      }
    }
    return queue;
  }

  it('汇总现象 / 复现步骤 / 关联归属 / commit / 对话', () => {
    const queue = feed();
    const commits: GitCommitPort = { latestSha: () => 'abc1234' };
    const conversations: ConversationSnippetPort = {
      attemptsFor: () => ['调整 token 过期时间', '检查 Cookie SameSite'],
    };
    const builder = new IssueDraftBuilder({ queue, commits, conversations, clock });

    const detector = new DebugLoopDetector({ queue, clock });
    const hit = detector.inspect(T0 + 1000)[0]!;
    const draft = builder.build(hit, { relatedCode: [{ filePath: 'src/auth/session.ts', symbol: 'writeSession' }] });

    expect(draft.title).toBe('反复调试「功能F1 / 页面PG1 / 元素E1」');
    expect(draft.phenomenon.split('\n\n')).toHaveLength(3);
    expect(draft.phenomenon).toContain('TypeError: sig-a');
    // 复现步骤来自真实事件序列（3 轮 × 3 步 = 9 步），不凭空编造
    expect(draft.reproduce).toHaveLength(9);
    expect(draft.reproduce[0]).toContain('生成「生成提交按钮」');
    expect(draft.reproduce[1]).toBe('运行');
    expect(draft.reproduce[2]).toContain('报错：signature' in {} ? '' : 'sig-a');
    expect(draft.attempts).toEqual([
      { action: '调整 token 过期时间', result: '待确认' },
      { action: '检查 Cookie SameSite', result: '待确认' },
    ]);
    expect(draft.codeLocations).toEqual([{ filePath: 'src/auth/session.ts', symbol: 'writeSession' }]);
    expect(draft.relatedPageId).toBe('PG1');
    expect(draft.relatedElementId).toBe('E1');
    expect(draft.relatedFeatureId).toBe('F1');
    expect(draft.commitSha).toBe('abc1234');
    // 取最近的对话 id
    expect(draft.conversationId).toBe('CONV-2');
  });

  it('未注入 commit / 对话端口时字段为空而不是抛错', () => {
    const queue = feed();
    const builder = new IssueDraftBuilder({ queue, clock });
    const hit = new DebugLoopDetector({ queue, clock }).inspect(T0 + 1000)[0]!;
    const draft = builder.build(hit);
    expect(draft.commitSha).toBeNull();
    expect(draft.attempts).toEqual([]);
    expect(draft.codeLocations).toEqual([]);
  });

  it('draftToCreateIssueInput 产出可落库入参，materializeIssueDraft 一键建立成功', async () => {
    const queue = feed();
    const builder = new IssueDraftBuilder({
      queue,
      commits: { latestSha: () => 'deadbee' },
      clock,
    });
    const hit = new DebugLoopDetector({ queue, clock }).inspect(T0 + 1000)[0]!;
    const draft = builder.build(hit);

    const input = draftToCreateIssueInput(draft, {
      userId: TEST_GRAPH.userId,
      projectId: TEST_GRAPH.projectId,
    });
    expect(input.sourceType).toBe('auto_chat');
    expect(input.tags).toEqual(['debug-loop']);
    expect(input.commitSha).toBe('deadbee');

    const repo = new MemoryRepo(handle.db);
    const service = new IssueMemoryService(repo, TEST_GRAPH.userId);
    const item = await materializeIssueDraft(service, draft, {
      userId: TEST_GRAPH.userId,
      projectId: TEST_GRAPH.projectId,
    });

    expect(item.scope).toBe('issue');
    expect(item.issueStatus).toBe('unsolved');
    expect(item.status).toBe('active');
    expect(item.pageId).toBe('PG1');
    expect(item.elementId).toBe('E1');
    expect(item.structured?.['commitSha']).toBe('deadbee');

    // 建立后进入"进行中问题"，即会自动进入该上下文的 AI 调用
    const active = service.listActive(TEST_GRAPH.projectId);
    expect(active.map((entry) => entry.id)).toContain(item.id);
  });
});
