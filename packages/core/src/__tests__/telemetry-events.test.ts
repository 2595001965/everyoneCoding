/**
 * 埋点事件目录与 payload 白名单测试（T10-01）。
 *
 * 验收对应：
 * - 埋点 payload 中不含任何内容字段（断言测试）→ 白名单违规必须抛错
 * - 关键路径事件清单完整性 → KEY_EVENT_NAMES 覆盖任务卡列举的全部类别
 */

import { describe, expect, it } from 'vitest';

import {
  assertEventPayloadSafe,
  buildEvent,
  isKeyEventName,
  KEY_EVENT_NAMES,
  PAYLOAD_FIELD_ALLOWLIST,
} from '../telemetry-events';

describe('telemetry-events：事件目录与白名单', () => {
  it('关键路径事件覆盖任务卡列举的全部类别', () => {
    const categories = [
      'project.',
      'pipeline.',
      'designer.',
      'memory.',
      'git.',
      'rename.',
      'package.',
      'auth.',
      'ai.',
      'app.',
    ];
    for (const prefix of categories) {
      expect(KEY_EVENT_NAMES.some((name) => name.startsWith(prefix))).toBe(true);
    }
  });

  it('任务卡点名的关键事件全部登记', () => {
    const required = [
      'project.create',
      'project.open',
      'project.delete',
      'pipeline.stage_advance',
      'pipeline.generate_start',
      'pipeline.generate_end',
      'git.commit',
      'git.push',
      'rename.transaction',
      'rename.undo',
      'package.export',
      'package.import',
      'auth.login',
      'auth.logout',
      'app.error',
    ];
    for (const name of required) {
      expect(isKeyEventName(name), `缺少关键事件 ${name}`).toBe(true);
    }
  });

  it('白名单拒绝内容类字段', () => {
    expect(() =>
      assertEventPayloadSafe({
        name: 'project.create',
        result: 'success',
        dims: { content: '用户想法正文' },
      }),
    ).toThrow();
    expect(() =>
      assertEventPayloadSafe({
        name: 'ai.request',
        result: 'success',
        dims: { prompt: '提示词正文' },
      }),
    ).toThrow();
    expect(() =>
      assertEventPayloadSafe({
        name: 'ai.request',
        result: 'success',
        dims: { code: 'const x = 1' },
      }),
    ).toThrow();
    expect(() =>
      assertEventPayloadSafe({
        name: 'memory.capture',
        result: 'success',
        dims: { memoryText: '记忆正文' },
      }),
    ).toThrow();
    expect(() =>
      assertEventPayloadSafe({ name: 'ai.request', result: 'success', dims: { apiKey: 'sk-xxx' } }),
    ).toThrow();
  });

  it('白名单接受维度 id / 耗时 / 结果状态', () => {
    expect(() =>
      assertEventPayloadSafe({
        name: 'pipeline.generate_end',
        result: 'success',
        durationMs: 1234,
        dims: { projectId: '01H...', stage: 'S5', modelId: 'gpt-x' },
      }),
    ).not.toThrow();
  });

  it('超长维度值被拒绝（疑似夹带内容）', () => {
    expect(() =>
      assertEventPayloadSafe({
        name: 'app.error',
        result: 'failure',
        errorKind: 'RenderError',
        dims: { projectId: 'x'.repeat(300) },
      }),
    ).toThrow(/维度值过长/);
  });

  it('buildEvent 构造合法事件并自动校验', () => {
    const event = buildEvent('git.commit', 'success', {
      durationMs: 820,
      dims: { projectId: 'p1' },
    });
    expect(event).toEqual({
      name: 'git.commit',
      result: 'success',
      durationMs: 820,
      dims: { projectId: 'p1' },
    });
    expect(() => buildEvent('ai.request', 'success', { dims: { messages: '对话内容' } })).toThrow();
  });

  it('白名单字段大小写不敏感（result/durationMs 等）', () => {
    expect(() =>
      assertEventPayloadSafe({
        name: 'ai.request',
        result: 'success',
        durationMs: 5,
        dims: { ModelId: 'm1' },
      }),
    ).not.toThrow();
  });

  it('PAYLOAD_FIELD_ALLOWLIST 不含任何内容语义字段', () => {
    const banned = [
      'content',
      'text',
      'body',
      'prompt',
      'messages',
      'code',
      'password',
      'apikey',
      'secret',
    ];
    for (const field of banned) {
      expect(PAYLOAD_FIELD_ALLOWLIST.has(field)).toBe(false);
    }
  });
});
