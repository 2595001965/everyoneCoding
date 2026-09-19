import { describe, expect, it, vi } from 'vitest';

import type { GenerationOutput } from '../../generate/output-schema';
import { applyUnifiedPatch, parseUnifiedPatch } from '../apply-strategy/patch';
import { createWritePipeline } from '../write-pipeline';
import type { WritePipeline } from '../write-pipeline';
import type { WriteEvent, WritePlan } from '../write-types';
import { memoryFs, unifiedDiff, type MemoryFs } from './helpers';

/* ------------------------------ 夹具 ------------------------------ */

const EXISTING_SERVICE = [
  'export class UserService {',
  '  find(id: string) {',
  '    return id;',
  '  }',
  '}',
  '',
].join('\n');

function output(
  files: GenerationOutput['files'],
  extra: Partial<GenerationOutput> = {},
): GenerationOutput {
  return {
    files,
    anchors: [],
    summary: '本次变更说明',
    notes: '',
    decision: { referencedMemory: [], rationale: 'r', risks: ['x'], uncovered: ['y'] },
    ...extra,
  };
}

function pipeline(
  local: MemoryFs,
  clock = 1_000,
): { pipeline: WritePipeline; events: WriteEvent[] } {
  const events: WriteEvent[] = [];
  let tick = clock;
  const instance = createWritePipeline({
    fs: local.fs,
    clock: () => (tick += 1),
    idFactory: (sequence) => `plan-${sequence}`,
  });
  instance.onEvent((event) => events.push(event));
  return { pipeline: instance, events };
}

const CREATE_FILE = 'src/modules/user/user.repo.ts';
const CREATE_CONTENT = 'export class UserRepo {\n  find(id: string) {\n    return id;\n  }\n}\n';

/* ------------------------------ 补丁解析 ------------------------------ */

describe('unified diff 应用（T4-05 要点 1）', () => {
  it('按上下文定位应用补丁，行号有偏移也能命中', () => {
    const before = ['line1', 'line2', 'line3', 'line4', 'line5', ''].join('\n');
    const patch = [
      '@@ -99,3 +99,4 @@',
      ' line2',
      '-line3',
      '+line3-changed',
      '+line3-new',
      ' line4',
    ].join('\n');

    const applied = applyUnifiedPatch(before, patch);
    expect(applied.ok).toBe(true);
    expect(applied.hunks).toBe(1);
    expect(applied.after).toContain('line3-changed');
    expect(applied.after).toContain('line3-new');
    expect(applied.after).not.toContain('line3\n');
  });

  it('找不到上下文时明确拒绝，绝不做部分应用', () => {
    const applied = applyUnifiedPatch('a\nb\n', '@@ -1,1 +1,1 @@\n-不存在的内容\n+新内容');
    expect(applied.ok).toBe(false);
    expect(applied.after).toBeNull();
    expect(applied.error).toContain('找不到对应内容');
  });

  it('缺少 @@ 头时判定为非法补丁并给出可操作提示', () => {
    const applied = applyUnifiedPatch('a\n', '就是把 a 改成 b');
    expect(applied.ok).toBe(false);
    expect(applied.error).toContain('unified diff');
    expect(parseUnifiedPatch('not a patch').malformed).toBe(true);
  });

  it('忽略 \\ No newline at end of file 标记', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-a', '+b', '\\ No newline at end of file'].join('\n');
    expect(applyUnifiedPatch('a\n', patch).after).toBe('b\n');
  });
});

/* ------------------------------ 计划 ------------------------------ */

describe('WritePipeline.plan（T4-05 要点 1）', () => {
  it('create：新文件生成 after；已存在文件被拒绝并提示改用 patch', async () => {
    const local = memoryFs({ 'src/modules/user/user.service.ts': EXISTING_SERVICE });
    const { pipeline: instance } = pipeline(local);

    const plan = await instance.plan({
      output: output([
        { path: CREATE_FILE, content: CREATE_CONTENT, action: 'create', language: 'ts' },
        {
          path: 'src/modules/user/user.service.ts',
          content: 'x',
          action: 'create',
          language: 'ts',
        },
      ]),
      mode: 'create',
    });

    expect(plan.entries[0]?.blocked).toBe(false);
    expect(plan.entries[0]?.after).toBe(CREATE_CONTENT);
    expect(plan.entries[0]?.changed).toBe(true);
    expect(plan.entries[1]?.blocked).toBe(true);
    expect(plan.entries[1]?.blockReason).toContain('目标文件已存在');
    expect(plan.blockedCount).toBe(1);
    // plan 不落盘
    expect(local.files.has(CREATE_FILE)).toBe(false);
  });

  it('patch：补丁可应用时给出 after 与增删行数；不可应用时阻塞', async () => {
    const local = memoryFs({ 'src/modules/user/user.service.ts': EXISTING_SERVICE });
    const { pipeline: instance } = pipeline(local);

    const goodPatch = unifiedDiff({
      oldStart: 2,
      oldLines: ['  find(id: string) {', '    return id;'],
      newLines: ['  find(id: string) {', '    return this.repo.find(id);'],
    });
    const plan = await instance.plan({
      output: output([
        {
          path: 'src/modules/user/user.service.ts',
          content: goodPatch,
          action: 'patch',
          language: 'ts',
        },
      ]),
      mode: 'patch',
    });

    expect(plan.entries[0]?.blocked).toBe(false);
    expect(plan.entries[0]?.after).toContain('this.repo.find(id)');
    expect(plan.addedLines).toBeGreaterThan(0);

    const bad = await instance.plan({
      output: output([
        {
          path: 'src/modules/user/user.service.ts',
          content: '@@ -1,1 +1,1 @@\n-没有的\n+有',
          action: 'patch',
          language: 'ts',
        },
      ]),
      mode: 'patch',
    });
    expect(bad.entries[0]?.blocked).toBe(true);
    expect(bad.entries[0]?.blockReason).toContain('找不到对应内容');
  });

  it('patch 目标不存在时阻塞并建议改用 create', async () => {
    const local = memoryFs();
    const { pipeline: instance } = pipeline(local);
    const plan = await instance.plan({
      output: output([
        { path: 'src/x.ts', content: '@@ -1,1 +1,1 @@\n-a\n+b', action: 'patch', language: 'ts' },
      ]),
      mode: 'patch',
    });
    expect(plan.entries[0]?.blocked).toBe(true);
    expect(plan.entries[0]?.blockReason).toContain('补丁目标文件不存在');
  });

  it('delete：幂等（文件不存在时 changed=false）', async () => {
    const local = memoryFs({ 'a.ts': 'x\n' });
    const { pipeline: instance } = pipeline(local);
    const plan = await instance.plan({
      output: output([
        { path: 'a.ts', content: '', action: 'delete', language: 'ts' },
        { path: 'missing.ts', content: '', action: 'delete', language: 'ts' },
      ]),
      mode: 'patch',
    });
    expect(plan.entries[0]?.changed).toBe(true);
    expect(plan.entries[1]?.changed).toBe(false);
    expect(plan.entries[1]?.blocked).toBe(false);
  });

  it('selectedPaths 只勾选部分文件时其余标记为未选中', async () => {
    const local = memoryFs();
    const { pipeline: instance } = pipeline(local);
    const plan = await instance.plan({
      output: output([
        { path: 'a.ts', content: 'a\n', action: 'create', language: 'ts' },
        { path: 'b.ts', content: 'b\n', action: 'create', language: 'ts' },
      ]),
      mode: 'preview',
      selectedPaths: ['b.ts'],
    });
    expect(plan.entries[0]?.selected).toBe(false);
    expect(plan.entries[1]?.selected).toBe(true);
  });
});

/* ------------------------------ 应用与事务 ------------------------------ */

describe('WritePipeline.apply（T4-05 要点 5）', () => {
  it('三种模式都能应用，并广播 file-written / applied / anchors-written 事件', async () => {
    const local = memoryFs({ 'src/modules/user/user.service.ts': EXISTING_SERVICE });
    const { pipeline: instance, events } = pipeline(local);

    const plan = await instance.plan({
      output: output(
        [
          { path: CREATE_FILE, content: CREATE_CONTENT, action: 'create', language: 'ts' },
          {
            path: 'src/modules/user/user.service.ts',
            content: unifiedDiff({
              oldStart: 2,
              oldLines: ['  find(id: string) {', '    return id;'],
              newLines: ['  find(id: string) {', '    return this.repo.find(id);'],
            }),
            action: 'patch',
            language: 'ts',
          },
        ],
        {
          anchors: [
            { elementId: 'el-btn', filePath: CREATE_FILE, symbol: 'UserRepo.find', kind: 'repo' },
          ],
        },
      ),
      mode: 'preview',
      noteIds: ['note-1'],
    });

    const result = await instance.apply(plan);
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([CREATE_FILE, 'src/modules/user/user.service.ts']);
    expect(local.files.get(CREATE_FILE)).toBe(CREATE_CONTENT);
    expect(local.files.get('src/modules/user/user.service.ts')).toContain('this.repo.find(id)');
    expect(plan.noteIds).toEqual(['note-1']);

    expect(events.map((event) => event.type)).toEqual([
      'file-written',
      'file-written',
      'applied',
      'anchors-written',
    ]);
  });

  it('冲突检测：文件在 plan 之后被外部修改则拒绝写入', async () => {
    const local = memoryFs({ 'a.ts': 'before\n' });
    const { pipeline: instance } = pipeline(local);
    const plan = await instance.plan({
      output: output([{ path: 'a.ts', content: 'after\n', action: 'create', language: 'ts' }]),
      // create 会因为文件已存在被阻塞，这里用 delete 构造"计划后文件被改"的场景
      mode: 'preview',
    });
    // 手工放开阻塞，模拟"计划基于某个版本、之后磁盘变了"
    const tampered: WritePlan = {
      ...plan,
      entries: plan.entries.map((entry) => ({
        ...entry,
        blocked: false,
        action: 'patch',
        after: 'after\n',
        changed: true,
      })),
    };
    local.files.set('a.ts', '被外部改过了\n');

    const result = await instance.apply(tampered);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('已被外部修改');
    expect(local.files.get('a.ts')).toBe('被外部改过了\n');
  });

  it('任一步失败则整体回滚，不留中间态', async () => {
    const local = memoryFs({ 'b.ts': 'original\n' });
    const { pipeline: instance, events } = pipeline(local);
    local.failOn('b.ts');

    const plan = await instance.plan({
      output: output([
        { path: 'c.ts', content: 'new file\n', action: 'create', language: 'ts' },
        { path: 'b.ts', content: 'replaced\n', action: 'patch', language: 'ts' },
      ]),
      mode: 'preview',
    });
    // patch 需要合法 diff，这里直接把 after 塞好以聚焦事务行为
    const patched: WritePlan = {
      ...plan,
      entries: plan.entries.map((entry) =>
        entry.path === 'b.ts'
          ? { ...entry, blocked: false, after: 'replaced\n', changed: true }
          : entry,
      ),
    };

    const result = await instance.apply(patched);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('模拟磁盘写入失败');
    // 已成功写入的 c.ts 被回滚删除；b.ts 写入本身就失败了，内容保持原样
    expect(result.rolledBack).toContain('c.ts');
    expect(local.files.has('c.ts')).toBe(false);
    expect(local.files.get('b.ts')).toBe('original\n');
    expect(events.some((event) => event.type === 'rolled-back')).toBe(true);
  });

  it('全部文件未选中时视为成功且不写盘', async () => {
    const local = memoryFs();
    const { pipeline: instance } = pipeline(local);
    const plan = await instance.plan({
      output: output([{ path: 'a.ts', content: 'a\n', action: 'create', language: 'ts' }]),
      mode: 'preview',
      selectedPaths: [],
    });
    const result = await instance.apply(plan);
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['a.ts']);
    expect(local.files.size).toBe(0);
  });

  it('不得存在"用户手动编辑"模式：只接受计划里已算好的 after', async () => {
    const local = memoryFs();
    const { pipeline: instance } = pipeline(local);
    const plan = await instance.plan({
      output: output([
        { path: 'a.ts', content: '来自 AI 的内容\n', action: 'create', language: 'ts' },
      ]),
      mode: 'create',
    });
    await instance.apply(plan);
    // 写入的必然是计划中的内容（调用方无法注入任意文本）
    expect(local.files.get('a.ts')).toBe('来自 AI 的内容\n');
  });
});

/* ------------------------------ 重改指令 ------------------------------ */

describe('「要求 AI 重改」指令构造（T4-05 要点 4）', () => {
  it('带上选择范围与差异，交给下一轮生成', async () => {
    const local = memoryFs();
    const { pipeline: instance } = pipeline(local);
    const plan = await instance.plan({
      output: output([
        { path: 'a.ts', content: 'const a = 1;\nconst b = 2;\n', action: 'create', language: 'ts' },
      ]),
      mode: 'preview',
    });

    const previews = instance.previews(plan);
    const rework = instance.buildReworkInstruction({
      previews,
      selectedPaths: ['a.ts'],
      comment: '不要 b 这一行',
    });

    expect(rework.instruction).toContain('不要 b 这一行');
    expect(rework.instruction).toContain('涉及文件：a.ts');
    expect(rework.instruction).toContain('+const b = 2;');
    expect(rework.context).toContain('### a.ts');
  });

  it('未填写意见时给出兜底措辞而不是空指令', async () => {
    const local = memoryFs();
    const { pipeline: instance } = pipeline(local);
    const plan = await instance.plan({
      output: output([{ path: 'a.ts', content: 'x\n', action: 'create', language: 'ts' }]),
      mode: 'preview',
    });
    const rework = instance.buildReworkInstruction({
      previews: instance.previews(plan),
      selectedPaths: ['a.ts'],
      comment: '   ',
    });
    expect(rework.instruction).toContain('未填写');
  });
});

/* ------------------------------ 事件 ------------------------------ */

describe('写入后事件（T4-05 要点 6）', () => {
  it('订阅可取消，事件总数为 0 时不广播 applied', async () => {
    const local = memoryFs();
    const { pipeline: instance } = pipeline(local);
    const listener = vi.fn();
    const off = instance.onEvent(listener);
    off();

    const plan = await instance.plan({
      output: output([]),
      mode: 'preview',
    });
    await instance.apply(plan);
    expect(listener).not.toHaveBeenCalled();
  });
});
