import { describe, expect, it } from 'vitest';

import {
  HARD_CONSTRAINT_PREFIX,
  NOTE_TYPE_META,
  NOTE_TYPES,
  assertNoteValid,
  computeNotePriority,
  documentFromText,
  documentToText,
  emptyDocument,
  fromLegacyNoteKind,
  noteMatchesFilter,
  noteSchema,
  parseNote,
  sortNotesForContext,
  spansToText,
  textToSpans,
  toContextNote,
  toLegacyNoteKind,
  toggleMarkInSpans,
  type Note,
} from '../note-model';

/* ------------------------------ 夹具 ------------------------------ */

function makeNote(overrides: Partial<Note> = {}): Note {
  const base: Note = {
    id: 'n1',
    projectId: 'P1',
    targetType: 'element',
    targetId: 'e1',
    type: 'todo',
    title: '待办',
    content: documentFromText('正文'),
    checklists: [],
    codeBlocks: [],
    status: 'open',
    priority: 2,
    manualPriority: null,
    version: 1,
    createdAt: 1000,
    updatedAt: 1000,
    resolvedAt: null,
    createdBy: 'user',
    history: [],
  };
  return { ...base, ...overrides };
}

/* ------------------------------ 富文本 ------------------------------ */

describe('备注富文本（T4-01）', () => {
  it('纯文本按空行分段，并识别 - / 1. 清单前缀', () => {
    const doc = documentFromText('第一段\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n第二段');
    expect(doc.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'bullet-list',
      'ordered-list',
      'paragraph',
    ]);
    const bullet = doc.blocks[1];
    expect(bullet !== undefined && bullet.type === 'bullet-list' ? bullet.items.length : 0).toBe(2);
    expect(documentToText(doc)).toBe('第一段\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n第二段');
  });

  it('空文本回退为单个空段落，不会是空 blocks（避免编辑器"无处可写"）', () => {
    expect(documentFromText('')).toEqual(emptyDocument());
    expect(documentFromText('   ')).toEqual(emptyDocument());
  });

  it('标题块序列化为 # 前缀，供提示词注入时保留层级', () => {
    const doc = { type: 'doc' as const, blocks: [{ type: 'heading' as const, level: 2 as const, spans: textToSpans('需求') }] };
    expect(documentToText(doc)).toBe('## 需求');
  });

  it('行内标记：区间加粗后可再次切换移除', () => {
    const spans = textToSpans('需校验图形验证码');
    const bolded = toggleMarkInSpans(spans, 1, 5, 'bold');
    expect(bolded.map((span) => [span.text, span.marks.join(',')])).toEqual([
      ['需', ''],
      ['校验图形', 'bold'],
      ['验证码', ''],
    ]);
    const unbolded = toggleMarkInSpans(bolded, 1, 5, 'bold');
    expect(unbolded).toHaveLength(1);
    expect(unbolded[0]?.text).toBe('需校验图形验证码');
    expect(unbolded[0]?.marks).toEqual([]);
  });

  it('行内标记：部分命中时补齐标记而不是整体移除，相邻同标记片段会合并', () => {
    const spans = toggleMarkInSpans(textToSpans('abcd'), 0, 2, 'italic');
    expect(spans.map((span) => [span.text, span.marks.join(',')])).toEqual([
      ['ab', 'italic'],
      ['cd', ''],
    ]);

    const next = toggleMarkInSpans(spans, 1, 3, 'italic');
    expect(next.map((span) => [span.text, span.marks.join(',')])).toEqual([
      ['abc', 'italic'],
      ['d', ''],
    ]);
    expect(spansToText(next)).toBe('abcd');
  });

  it('行内标记：空区间是 no-op，但仍返回新数组（不可变语义）', () => {
    const spans = textToSpans('abc');
    const next = toggleMarkInSpans(spans, 2, 2, 'code');
    expect(next).toEqual(spans);
    expect(next).not.toBe(spans);
  });

  it('多个标记可叠加且稳定合并', () => {
    let spans = toggleMarkInSpans(textToSpans('abc'), 0, 3, 'bold');
    spans = toggleMarkInSpans(spans, 0, 3, 'italic');
    expect(spans).toHaveLength(1);
    expect([...spans[0]!.marks].sort()).toEqual(['bold', 'italic']);
  });
});

/* ------------------------------ 优先级 ------------------------------ */

describe('备注优先级与上下文排序（T4-01）', () => {
  it('六类备注元数据完整，禁止事项为硬约束', () => {
    expect(NOTE_TYPES).toHaveLength(6);
    for (const type of NOTE_TYPES) {
      const meta = NOTE_TYPE_META[type];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(meta.basePriority).toBeGreaterThanOrEqual(1);
      expect(meta.basePriority).toBeLessThanOrEqual(5);
    }
    expect(NOTE_TYPE_META.forbidden.mustFollow).toBe(true);
    expect(NOTE_TYPE_META.business_rule.mustFollow).toBe(false);
  });

  it('禁止事项优先级恒为 5，人工下调无效', () => {
    expect(computeNotePriority('forbidden', null)).toBe(5);
    expect(computeNotePriority('forbidden', 1)).toBe(5);
  });

  it('普通类型可人工调整且被夹在 1–5', () => {
    expect(computeNotePriority('validation', null)).toBe(4);
    expect(computeNotePriority('todo', null)).toBe(2);
    expect(computeNotePriority('todo', 5)).toBe(5);
    expect(computeNotePriority('todo', 9)).toBe(5);
    expect(computeNotePriority('todo', 0)).toBe(1);
  });

  it('上下文排序把禁止事项置顶，其余按优先级 / 更新时间 / id', () => {
    const sorted = sortNotesForContext([
      { id: 'a', type: 'business_rule', priority: 4, updatedAt: 100 },
      { id: 'b', type: 'forbidden', priority: 5, updatedAt: 10 },
      { id: 'c', type: 'validation', priority: 4, updatedAt: 200 },
      { id: 'd', type: 'todo', priority: 2, updatedAt: 300 },
    ]);
    expect(sorted.map((note) => note.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('toContextNote 展平正文 / 清单 / 代码，并对禁止事项加强约束前缀', () => {
    const note = makeNote({
      type: 'forbidden',
      priority: 5,
      title: '不得明文存 Key',
      content: documentFromText('必须走密钥环'),
      checklists: [{ id: 'c1', text: '检查落盘日志', checked: true }],
      codeBlocks: [{ id: 'k1', language: 'ts', code: 'const a = 1;' }],
    });
    const context = toContextNote(note);
    expect(context.mustFollow).toBe(true);
    expect(context.typeLabel).toBe('禁止事项');
    expect(context.text.startsWith(HARD_CONSTRAINT_PREFIX)).toBe(true);
    expect(context.text).toContain('必须走密钥环');
    expect(context.text).toContain('- [x] 检查落盘日志');
    expect(context.text).toContain('```ts');
  });

  it('普通备注不加前缀，纯文本不丢失', () => {
    const context = toContextNote(makeNote({ title: '需校验图形验证码', content: documentFromText('') }));
    expect(context.text.startsWith(HARD_CONSTRAINT_PREFIX)).toBe(false);
    expect(context.text).toContain('需校验图形验证码');
  });
});

/* ------------------------------ 校验 ------------------------------ */

describe('备注 zod 校验（T4-01）', () => {
  it('合法备注通过 schema 与 assertNoteValid', () => {
    const note = makeNote();
    expect(noteSchema.safeParse(note).success).toBe(true);
    expect(() => assertNoteValid(note)).not.toThrow();
  });

  it('非法类型 / 越界优先级被拒绝', () => {
    expect(noteSchema.safeParse({ ...makeNote(), type: 'unknown' }).success).toBe(false);
    expect(noteSchema.safeParse({ ...makeNote(), priority: 9 }).success).toBe(false);
    expect(noteSchema.safeParse({ ...makeNote(), targetType: 'page2' }).success).toBe(false);
  });

  it('parseNote 可解析并保留历史版本', () => {
    const note = makeNote({
      version: 2,
      history: [
        {
          version: 1,
          title: '旧标题',
          type: 'todo',
          status: 'open',
          content: emptyDocument(),
          checklists: [],
          codeBlocks: [],
          changedFields: ['title'],
          editor: 'user',
          createdAt: 900,
        },
      ],
    });
    expect(parseNote(note).history).toHaveLength(1);
  });
});

/* ------------------------------ 过滤与兼容 ------------------------------ */

describe('备注过滤与 DSL 兼容（T4-01）', () => {
  it('按类型 / 状态 / 层级 / 关键字过滤', () => {
    const note = makeNote({ title: '登录按钮', content: documentFromText('需校验图形验证码') });
    expect(noteMatchesFilter(note, { type: 'todo' })).toBe(true);
    expect(noteMatchesFilter(note, { type: ['todo', 'question'] })).toBe(true);
    expect(noteMatchesFilter(note, { type: 'forbidden' })).toBe(false);
    expect(noteMatchesFilter(note, { status: 'resolved' })).toBe(false);
    expect(noteMatchesFilter(note, { targetType: 'element' })).toBe(true);
    expect(noteMatchesFilter(note, { text: '验证码' })).toBe(true);
    expect(noteMatchesFilter(note, { text: '不存在的词' })).toBe(false);
  });

  it('与设计器 DSL 的旧四类可双向映射（无字段漂移）', () => {
    expect(toLegacyNoteKind('forbidden')).toBe('issue');
    expect(fromLegacyNoteKind('issue')).toBe('forbidden');
    expect(toLegacyNoteKind('validation')).toBe('idea');
    for (const legacy of ['todo', 'issue', 'idea', 'question'] as const) {
      expect(toLegacyNoteKind(fromLegacyNoteKind(legacy))).toBe(legacy);
    }
  });
});
