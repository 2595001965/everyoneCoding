import { describe, expect, it, vi } from 'vitest';

import type { AssembledContext } from '../../context/context-types';
import { streamOf, type StreamChunk } from '../../core/stream';
import { toDecisionCard, auditDecisionMemory, describeDecisionCard } from '../decision-card';
import { Generator, createGenerator, type GenerationRunner } from '../generator';
import type { GenerationOutput } from '../output-schema';
import {
  buildPromptFor,
  PROMPT_TEMPLATES,
  GENERATION_TARGETS,
  COMMON_CONSTRAINTS,
  DEFAULT_STACKS,
} from '../prompt-templates';
import { RevisionStore, computeLineDelta, summarizeFileDiff } from '../revision';

/* ------------------------------ 夹具 ------------------------------ */

const VALID_OUTPUT: GenerationOutput = {
  files: [
    {
      path: 'src/auth/auth.controller.ts',
      content: 'export class AuthController {\n  login() { return true; }\n}',
      action: 'create',
      language: 'ts',
    },
  ],
  anchors: [
    {
      elementId: 'el-btn',
      filePath: 'src/auth/auth.controller.ts',
      symbol: 'AuthController.login',
      kind: 'controller',
    },
  ],
  summary: '新增登录接口并落地图形验证码校验',
  notes: '',
  decision: {
    referencedMemory: [{ id: 'pj-1', title: '技术栈：Tauri 2 + React 18', layer: 'project' }],
    rationale: '沿用既有 controller/service 分层',
    risks: ['验证码服务未就绪时登录会失败'],
    uncovered: ['短信验证码登录'],
  },
};

const VALID_JSON = JSON.stringify(VALID_OUTPUT);

function runnerOf(...responses: string[]): {
  run: GenerationRunner;
  calls: { messages: unknown }[];
} {
  const calls: { messages: unknown }[] = [];
  let index = 0;
  const run: GenerationRunner = (request) => {
    calls.push({ messages: request.messages });
    const text = responses[Math.min(index, responses.length - 1)] ?? '';
    index += 1;
    return streamOf([
      ...deltas(text),
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
      { type: 'done', finishReason: 'stop', partial: false },
    ]);
  };
  return { run, calls };
}

function deltas(text: string, size = 12): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (let i = 0; i < text.length; i += size)
    chunks.push({ type: 'delta', text: text.slice(i, i + size) });
  return chunks;
}

/* ------------------------------ 模板 ------------------------------ */

describe('九类提示词模板（T4-04 要点 2）', () => {
  it('九类模板齐全，每类都含公共三条硬约束', () => {
    expect(GENERATION_TARGETS).toHaveLength(9);
    for (const target of GENERATION_TARGETS) {
      const template = PROMPT_TEMPLATES[target];
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.systemRole.length).toBeGreaterThan(10);
      for (const rule of COMMON_CONSTRAINTS) {
        expect(template.constraints.join('\n'), `${target} 缺少公共约束`).toContain(
          rule.slice(0, 12),
        );
      }
      expect(template.outputContract).toContain('输出契约');
    }
  });

  it('端专用约束按端矩阵注入（ArkTS / Flutter / Tauri / React）', () => {
    expect(PROMPT_TEMPLATES['harmony-code'].constraints.join()).toContain('ArkTS 严格模式');
    expect(PROMPT_TEMPLATES['mobile-code'].constraints.join()).toContain('共用同一套页面代码');
    expect(PROMPT_TEMPLATES['desktop-code'].constraints.join()).toContain('统一抽象层');
    expect(PROMPT_TEMPLATES['frontend-code'].systemRole).toContain('React');
    expect(PROMPT_TEMPLATES['backend-code'].requiresBuildableProject).toBe(true);
  });

  it('文档类模板不要求锚点；提交信息模板覆写契约且不产出文件', () => {
    expect(PROMPT_TEMPLATES.requirement.requiresAnchors).toBe(false);
    expect(PROMPT_TEMPLATES.techdoc.requiresAnchors).toBe(false);
    expect(PROMPT_TEMPLATES['commit-msg'].requiresAnchors).toBe(false);
    expect(PROMPT_TEMPLATES['commit-msg'].outputContract).toContain(
      'files 与 anchors 必须为空数组',
    );
    expect(PROMPT_TEMPLATES['backend-code'].requiresAnchors).toBe(true);
  });

  it('buildPromptFor 注入默认技术选型、项目约束与用户指令', () => {
    const rendered = buildPromptFor('backend-code', {
      projectName: 'EveryoneCoding',
      stack: null,
      extraConstraints: ['组件名与标识符用英文或拼音'],
      instruction: '只生成登录接口，不要动注册',
    });
    expect(rendered.user).toContain(
      `技术选型（来自项目记忆，必须遵守）：${DEFAULT_STACKS['backend-code']}`,
    );
    expect(rendered.user).toContain('组件名与标识符用英文或拼音');
    expect(rendered.user).toContain('用户补充指令（优先级最高）：只生成登录接口，不要动注册');
    expect(rendered.system.indexOf('输出契约')).toBeLessThan(rendered.system.indexOf('硬约束'));
  });
});

/* ------------------------------ 生成器 ------------------------------ */

describe('Generator（T4-04 要点 3）', () => {
  it('一次成功：结构化解析通过，attempts = 1', async () => {
    const stub = runnerOf(VALID_JSON);
    const generator = createGenerator({ run: stub.run });
    const result = await generator.generate({ target: 'backend-code' });

    expect(result.parse.success).toBe(true);
    expect(result.parse.mode).toBe('json');
    expect(result.degraded).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.output?.files[0]?.path).toBe('src/auth/auth.controller.ts');
    expect(result.usage?.totalTokens).toBe(30);
  });

  it('流式增量通过 onDelta 回调（UI 逐字展示）', async () => {
    const stub = runnerOf(VALID_JSON);
    const generator = createGenerator({ run: stub.run });
    const received: string[] = [];

    const result = await generator.generate({
      target: 'backend-code',
      onDelta: (text) => received.push(text),
    });

    expect(received.join('')).toBe(result.raw);
    expect(received.length).toBeGreaterThan(1);
  });

  it('首次输出不合契约时把违规明细反馈给模型并重试一次', async () => {
    const stub = runnerOf('这是一段没有 JSON 也没有代码块的解释文字。', VALID_JSON);
    const generator = createGenerator({ run: stub.run });
    const result = await generator.generate({ target: 'backend-code' });

    expect(result.attempts).toBe(2);
    expect(result.parse.success).toBe(true);

    const secondCall = stub.calls[1]?.messages as Array<{ role: string; content: unknown }>;
    // system + user + 上次的助手输出 + 反馈
    expect(secondCall).toHaveLength(4);
    expect(secondCall[2]?.role).toBe('assistant');
    expect(String(secondCall[3]?.content)).toContain('上一次的输出不符合输出契约');
    expect(String(secondCall[3]?.content)).toContain('既不是合法 JSON');
  });

  it('两次都失败则降级为原样文本，不抛错、不丢内容', async () => {
    const stub = runnerOf('无法解析的输出 A', '无法解析的输出 B');
    const generator = createGenerator({ run: stub.run });
    const result = await generator.generate({ target: 'backend-code' });

    expect(result.attempts).toBe(2);
    expect(result.parse.success).toBe(false);
    expect(result.parse.mode).toBe('raw');
    expect(result.degraded).toBe(true);
    expect(result.output).toBeNull();
    expect(result.raw).toBe('无法解析的输出 B');
    expect(result.parse.issues.length).toBeGreaterThan(0);
  });

  it('JSON 不合契约但含代码块时直接降级为代码块，不再重试', async () => {
    const brokenJson = `\`\`\`json\n{"files":[{"path":"C:/abs/a.ts","content":"x","action":"create"}]}\n\`\`\`\n\`\`\`ts\n// src/a/a.ts\nexport const a = 1;\n\`\`\``;
    const stub = runnerOf(brokenJson);
    const generator = createGenerator({ run: stub.run });
    const result = await generator.generate({ target: 'backend-code' });

    expect(result.attempts).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.parse.mode).toBe('code-blocks');
    expect(result.output?.files[0]?.path).toBe('src/a/a.ts');
  });

  it('中断后保留已生成内容（partial = true，不重试）', async () => {
    const run: GenerationRunner = () =>
      streamOf([
        { type: 'delta', text: '{"files":[' },
        { type: 'delta', text: '{"path":"a.ts"' },
        { type: 'done', finishReason: 'aborted', partial: true },
      ]);
    const generator = new Generator({ run });
    const result = await generator.generate({ target: 'backend-code' });

    expect(result.partial).toBe(true);
    expect(result.raw).toBe('{"files":[{"path":"a.ts"');
    expect(result.attempts).toBe(1);
  });

  it('继续生成把已生成内容作为助手前缀，并标注 continuedFrom', async () => {
    const first = runnerOf('{"files":[{"path":"a.ts","content":"x","action":"create"}');
    const generator = createGenerator({ run: first.run });
    const partial = await generator.generate({ target: 'backend-code' });
    expect(partial.partial).toBe(false);

    const messagesSeen: Array<{ role: string; content: unknown }>[] = [];
    const second: GenerationRunner = (request) => {
      messagesSeen.push(request.messages as Array<{ role: string; content: unknown }>);
      return streamOf([
        ...deltas(VALID_JSON),
        { type: 'done', finishReason: 'stop', partial: false },
      ]);
    };
    const continued = await new Generator({ run: second }).continueGeneration(partial, {
      instruction: '只补文件清单',
    });

    expect(messagesSeen[0]?.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(String(messagesSeen[0]?.[2]?.content)).toBe(partial.raw);
    expect(String(messagesSeen[0]?.[3]?.content)).toContain('从中断处继续');
    expect(messagesSeen[0]?.[3]?.content).toContain('只补文件清单');
    expect(continued.continuedFrom?.length).toBeGreaterThan(0);
    expect(continued.parse.success).toBe(true);
  });

  it('有上下文时复用引擎的 system 并追加端专用约束（不重复输出契约）', async () => {
    const context = {
      system: '# 角色与输出契约\n引擎渲染的系统提示词',
      user: '请生成后端代码',
      blocks: [],
      messages: [],
      totalTokens: 10,
      budget: 128_000,
      tookMs: 1,
      truncation: null,
      noteIds: ['note-1'],
      memoryIds: [],
      skipped: [],
      aggressive: false,
    } satisfies AssembledContext;

    const stub = runnerOf(VALID_JSON);
    const generator = createGenerator({ run: stub.run });
    await generator.generate({ target: 'backend-code', context });

    const messages = stub.calls[0]?.messages as Array<{ role: string; content: unknown }>;
    const system = String(messages[0]?.content);
    expect(system).toContain('引擎渲染的系统提示词');
    expect(system).toContain('## 端专用约束（后端代码）');
    expect(system.match(/输出契约/g)?.length).toBe(1);
    expect(String(messages[1]?.content)).toBe('请生成后端代码');
  });

  it('rawText 模式只取文本、不做结构化解析', async () => {
    const stub = runnerOf('一篇很长的 markdown 文档');
    const generator = createGenerator({ run: stub.run });
    const result = await generator.generate({ target: 'techdoc', rawText: true });
    expect(result.output).toBeNull();
    expect(result.raw).toBe('一篇很长的 markdown 文档');
    expect(result.parse.issues[0]).toContain('不做结构化解析');
  });

  it('自定义 maxRetries=0 时不重试', async () => {
    const stub = runnerOf('纯文本');
    const generator = createGenerator({ run: stub.run });
    const result = await generator.generate({ target: 'backend-code', maxRetries: 0 });
    expect(result.attempts).toBe(1);
    expect(result.parse.success).toBe(false);
  });
});

/* ------------------------------ 多轮修正 ------------------------------ */

describe('多轮修正与回退（T4-04 要点 4）', () => {
  const round1: GenerationOutput = {
    ...VALID_OUTPUT,
    files: [{ path: 'a.ts', content: 'const a = 1;\n', action: 'create', language: 'ts' }],
    summary: '首轮',
  };
  const round2: GenerationOutput = {
    ...VALID_OUTPUT,
    files: [
      { path: 'a.ts', content: 'const a = 1;\nconst b = 2;\n', action: 'patch', language: 'ts' },
      { path: 'b.ts', content: 'export const b = 2;\n', action: 'create', language: 'ts' },
    ],
    summary: '第二轮',
  };
  const round3: GenerationOutput = {
    ...VALID_OUTPUT,
    files: [{ path: 'a.ts', content: 'const a = 3;\n', action: 'patch', language: 'ts' }],
    summary: '第三轮',
  };

  function store(): RevisionStore {
    let clock = 1_000;
    let counter = 0;
    return new RevisionStore({
      clock: () => (clock += 10),
      idFactory: (index) => `rev-${index}-${(counter += 1)}`,
    });
  }

  it('每轮都记录 diff / 指令 / 模型，且可单独回退', () => {
    const revisions = store();
    const first = revisions.add({
      instruction: '实现登录',
      target: 'backend-code',
      output: round1,
      model: 'gpt-x',
    });
    const second = revisions.add({
      instruction: '加一个 b.ts',
      target: 'backend-code',
      output: round2,
    });
    const third = revisions.add({
      instruction: '把常量改成 3',
      target: 'backend-code',
      output: round3,
    });

    expect(revisions.list().map((record) => record.index)).toEqual([1, 2, 3]);
    expect(second.parentId).toBe(first.id);
    expect(third.model).toBeNull();
    expect(first.diff[0]?.addedLines).toBe(1);

    // 第二轮：a.ts 改了 1 行 + b.ts 新增
    expect(second.diff).toEqual([
      { path: 'a.ts', action: 'patch', addedLines: 1, removedLines: 0, unchanged: false },
      { path: 'b.ts', action: 'create', addedLines: 1, removedLines: 0, unchanged: false },
    ]);

    // 回退到第一轮：只切换指针，后续轮次仍在（可以再切回来）
    expect(revisions.current()?.id).toBe(third.id);
    const reverted = revisions.revertTo(first.id);
    expect(reverted?.summary).toBe('首轮');
    expect(revisions.current()?.id).toBe(first.id);
    expect(revisions.list()).toHaveLength(3);
    expect(revisions.revertTo(third.id)?.summary).toBe('第三轮');
    expect(revisions.revertTo('不存在')).toBeNull();
  });

  it('第二轮删除的文件记为 delete，未变更记为 unchanged', () => {
    const revisions = store();
    revisions.add({ instruction: '首轮', target: 'backend-code', output: round1 });
    const unchanged = revisions.add({
      instruction: '原样再输出一次',
      target: 'backend-code',
      output: { ...round1, summary: '无变化' },
    });
    expect(unchanged.diff[0]?.unchanged).toBe(true);

    const deleted = revisions.add({
      instruction: '删掉 a.ts',
      target: 'backend-code',
      output: { ...round1, files: [] },
    });
    expect(deleted.diff[0]?.action).toBe('delete');
    expect(deleted.diff[0]?.removedLines).toBeGreaterThan(0);
  });

  it('totalDelta 汇总新增 / 删除行；limit 淘汰最旧但保留当前轮', () => {
    const revisions = new RevisionStore({
      limit: 2,
      clock: () => 1,
      idFactory: (index) => `r${index}`,
    });
    revisions.add({ instruction: '1', target: 'backend-code', output: round1 });
    revisions.add({ instruction: '2', target: 'backend-code', output: round2 });
    revisions.add({ instruction: '3', target: 'backend-code', output: round3 });

    const totals = revisions.totalDelta();
    expect(totals.added).toBeGreaterThan(0);
    expect(revisions.list().length).toBeLessThanOrEqual(3);
    expect(revisions.current()?.summary).toBe('第三轮');
  });

  it('computeLineDelta / summarizeFileDiff 为纯函数', () => {
    expect(computeLineDelta('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
    expect(computeLineDelta('', 'a\nb')).toEqual({ added: 2, removed: 0 });
    expect(computeLineDelta('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
    expect(summarizeFileDiff([], [])).toEqual([]);
  });
});

/* ------------------------------ 决策卡片 ------------------------------ */

describe('决策说明卡片（T4-04 要点 5 / NFR-U-02）', () => {
  it('四要素齐备时 complete = true，并翻译记忆层级', () => {
    const card = toDecisionCard(VALID_OUTPUT, { noteIds: ['note-1'] });
    expect(card.complete).toBe(true);
    expect(card.missing).toEqual([]);
    expect(card.referencedMemory[0]?.layerLabel).toBe('项目记忆');
    expect(card.followedNoteIds).toEqual(['note-1']);
    expect(describeDecisionCard(card)).toContain('已引用 1 条记忆');
  });

  it('四要素缺失时逐项列出（空字符串 / 空数组都算缺失）', () => {
    const card = toDecisionCard({
      ...VALID_OUTPUT,
      decision: { referencedMemory: [], rationale: '   ', risks: [], uncovered: [''] },
    });
    expect(card.complete).toBe(false);
    expect(card.missing).toEqual(['引用记忆', '选型理由', '潜在风险', '未覆盖点']);
    expect(describeDecisionCard(card)).toContain('决策说明不完整');
  });

  it('降级结果显式标记 degraded', () => {
    expect(toDecisionCard(VALID_OUTPUT, { degraded: true }).degraded).toBe(true);
  });

  it('auditDecisionMemory 找出幻觉引用与漏引', () => {
    const audit = auditDecisionMemory(VALID_OUTPUT, ['pj-1', 'ft-2']);
    expect(audit.hallucinated).toEqual([]);
    expect(audit.underCited).toEqual(['ft-2']);

    const hallucinated = auditDecisionMemory(
      {
        ...VALID_OUTPUT,
        decision: {
          ...VALID_OUTPUT.decision,
          referencedMemory: [{ id: 'ghost', title: 'x', layer: 'project' }],
        },
      },
      [],
    );
    expect(hallucinated.hallucinated).toEqual(['ghost']);
  });
});

/* ------------------------------ 端到端串联 ------------------------------ */

describe('生成主链路串联（T4-04 验收）', () => {
  it('生成 → 解析 → 决策卡片 → 轮次记录 全部可用', async () => {
    const stub = runnerOf(VALID_JSON);
    const generator = createGenerator({ run: stub.run });
    const result = await generator.generate({
      target: 'backend-code',
      templateInput: { instruction: '给登录按钮加图形验证码校验' },
    });

    expect(result.output).not.toBeNull();
    const card = toDecisionCard(result.output as GenerationOutput, { noteIds: ['note-1'] });
    expect(card.complete).toBe(true);

    const revisions = new RevisionStore();
    const record = revisions.add({
      instruction: '给登录按钮加图形验证码校验',
      target: 'backend-code',
      output: result.output as GenerationOutput,
    });
    expect(record.diff[0]?.path).toBe('src/auth/auth.controller.ts');
    expect(vi.isMockFunction(stub.run)).toBe(false);
  });
});
