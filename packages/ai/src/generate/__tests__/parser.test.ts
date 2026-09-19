import { describe, expect, it } from 'vitest';

import {
  computeParseStats,
  extractCodeBlocks,
  extractFences,
  extractJsonValue,
  parseModelOutput,
  sliceBalancedObject,
} from '../parser';

/* ------------------------------ 样本构造 ------------------------------ */

const VALID_JSON = JSON.stringify({
  files: [
    {
      path: 'src/auth/auth.controller.ts',
      content: 'export class AuthController {}',
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
  summary: '新增登录接口',
  notes: '',
  decision: {
    referencedMemory: [{ id: 'm1', title: '技术栈', layer: 'project' }],
    rationale: '复用既有分层',
    risks: ['验证码服务未就绪'],
    uncovered: ['短信验证码登录'],
  },
});

const CODE_FENCE_TS =
  '```ts\n// src/auth/auth.controller.ts\nexport class AuthController {\n  login() {}\n}\n```';

/**
 * 20 组样本：合法、围栏、夹带解释、截断、混排、契约违规、纯文本……
 * 成功率目标 ≥95%（验收标准：构造 20 组含异常格式的响应做统计）。
 */
const SAMPLES: { name: string; raw: string; expectSuccess: boolean }[] = [
  { name: '1 标准 JSON', raw: VALID_JSON, expectSuccess: true },
  { name: '2 ```json 围栏', raw: `\`\`\`json\n${VALID_JSON}\n\`\`\``, expectSuccess: true },
  {
    name: '3 前言 + JSON',
    raw: `好的，我来实现登录接口。\n\n${VALID_JSON}\n\n以上就是全部改动。`,
    expectSuccess: true,
  },
  {
    name: '4 JSON + 后记',
    raw: `${VALID_JSON}\n\n需要我继续生成单元测试吗？`,
    expectSuccess: true,
  },
  {
    name: '5 围栏 + 前言后记',
    raw: `分析完成：\n\`\`\`json\n${VALID_JSON}\n\`\`\`\n如需调整请告诉我。`,
    expectSuccess: true,
  },
  {
    name: '6 字符串内含大括号',
    raw: JSON.stringify({
      files: [
        { path: 'a.ts', content: 'const x = { a: { b: 1 } };', action: 'create', language: 'ts' },
      ],
      anchors: [],
      summary: '含嵌套大括号的代码',
      notes: '',
      decision: { referencedMemory: [], rationale: 'r', risks: ['x'], uncovered: ['y'] },
    }),
    expectSuccess: true,
  },
  {
    name: '7 字符串内含转义引号',
    raw: JSON.stringify({
      files: [
        {
          path: 'a.ts',
          content: 'const s = "he said \\"hi\\"";',
          action: 'create',
          language: 'ts',
        },
      ],
      anchors: [],
      summary: '含转义引号',
      notes: '',
      decision: { referencedMemory: [], rationale: 'r', risks: ['x'], uncovered: ['y'] },
    }),
    expectSuccess: true,
  },
  {
    name: '8 缺 decision 字段（补默认值）',
    raw: JSON.stringify({
      files: [{ path: 'a.ts', content: 'x', action: 'create', language: 'ts' }],
      anchors: [],
      summary: 's',
    }),
    expectSuccess: true,
  },
  {
    name: '9 缺 language（默认 ts）',
    raw: JSON.stringify({
      files: [{ path: 'a.ts', content: 'x', action: 'create' }],
      summary: 's',
    }),
    expectSuccess: true,
  },
  {
    name: '10 多余未知字段（忽略）',
    raw: JSON.stringify({ ...JSON.parse(VALID_JSON), extra: 'ignored', tokens: 123 }),
    expectSuccess: true,
  },
  {
    name: '11 合法 JSON 但路径为绝对路径（契约违规）→ 降级代码块',
    raw: `\`\`\`json\n${JSON.stringify({
      files: [{ path: 'C:/abs/a.ts', content: 'x', action: 'create', language: 'ts' }],
      summary: 's',
    })}\n\`\`\`\n\n${CODE_FENCE_TS}`,
    expectSuccess: true,
  },
  {
    name: '12 路径含 ..（越界）→ 降级代码块',
    raw: `\`\`\`json\n${JSON.stringify({ files: [{ path: '../out/a.ts', content: 'x', action: 'create' }] })}\n\`\`\`\n${CODE_FENCE_TS}`,
    expectSuccess: true,
  },
  {
    name: '13 截断的 JSON（未闭合）→ 降级代码块',
    raw: `{"files":[{"path":"a.ts","content":"x","action":"create"}],"anchors":[{"elementId":"el-1"\n\n${CODE_FENCE_TS}`,
    expectSuccess: true,
  },
  {
    name: '14 纯 Markdown 代码块（无 JSON）',
    raw: `这是实现：\n\n${CODE_FENCE_TS}\n\n请查阅。`,
    expectSuccess: true,
  },
  {
    name: '15 多语言代码块混排',
    raw: `后端：\n\n${CODE_FENCE_TS}\n\n数据库：\n\n\`\`\`sql\n-- src/db/migration.sql\nCREATE TABLE IF NOT EXISTS t (id TEXT);\n\`\`\`\n\nArkTS：\n\n\`\`\`arkts\nexport class Page {}\n\`\`\``,
    expectSuccess: true,
  },
  {
    name: '16 代码块带 anchor 注释',
    raw: '```ts\n// src/auth/auth.controller.ts\n// @everyonecoding:anchor el-btn AuthController.login controller\nexport class AuthController {}\n```',
    expectSuccess: true,
  },
  {
    name: '17 BOM + JSON',
    raw: `\uFEFF${VALID_JSON}`,
    expectSuccess: true,
  },
  {
    name: '18 JSON 中 anchors 的 kind 非法（整体解析失败）→ 降级代码块',
    raw: `\`\`\`json\n${JSON.stringify({
      files: [{ path: 'a.ts', content: 'x', action: 'create' }],
      anchors: [{ elementId: 'e', filePath: 'a.ts', symbol: 's', kind: 'unknown-kind' }],
      summary: 's',
    })}\n\`\`\`\n${CODE_FENCE_TS}`,
    expectSuccess: true,
  },
  {
    name: '19 单引号伪 JSON → 降级代码块',
    raw: `{ 'files': [ { 'path': 'a.ts' } ] }\n\n${CODE_FENCE_TS}`,
    expectSuccess: true,
  },
  {
    name: '20 纯散文，既无 JSON 也无代码块（应失败）',
    raw: '我已经理解了需求，稍后会给出实现。',
    expectSuccess: false,
  },
];

describe('结构化输出解析（T4-04 要点 2）', () => {
  it('20 组异常样本的解析成功率 ≥95%', () => {
    const results = SAMPLES.map((sample) => parseModelOutput(sample.raw));
    const stats = computeParseStats(results);

    // 把统计结果打出来，验收报告直接引用
    console.info(
      `[T4-04 解析统计] 样本 ${stats.total} 组；成功 ${stats.success}（${(stats.rate * 100).toFixed(1)}%）；` +
        `一次即合法 JSON ${stats.strictSuccess}（${(stats.strictRate * 100).toFixed(1)}%）；降级 ${stats.degraded} 组`,
    );

    expect(stats.total).toBe(20);
    expect(stats.rate).toBeGreaterThanOrEqual(0.95);

    // 逐组核对预期，防止"成功率达标但个别路径走错"
    SAMPLES.forEach((sample, index) => {
      expect(results[index]?.success, `样本 ${sample.name}`).toBe(sample.expectSuccess);
    });
  });

  it('各解析模式被正确标注', () => {
    const modes = SAMPLES.map((sample) => parseModelOutput(sample.raw).mode);
    expect(modes[0]).toBe('json');
    expect(modes[1]).toBe('fenced-json');
    expect(modes[2]).toBe('fenced-json');
    expect(modes[13]).toBe('code-blocks');
    expect(modes[19]).toBe('raw');
  });

  it('降级到代码块时文件按语言推断扩展名，并保留 anchor 注释', () => {
    const result = parseModelOutput(SAMPLES[14]?.raw ?? '');
    expect(result.degraded).toBe(true);
    expect(result.output?.files.map((file) => file.path)).toEqual([
      'src/auth/auth.controller.ts',
      'src/db/migration.sql',
      'generated/block-3.ets',
    ]);
    expect(result.output?.files.every((file) => file.action === 'create')).toBe(true);
    expect(result.output?.decision.risks.length).toBeGreaterThan(0);
  });

  it('只有 anchor 注释的代码块也能把锚点声明救回来', () => {
    const result = parseModelOutput(SAMPLES[15]?.raw ?? '');
    expect(result.output?.anchors).toEqual([
      {
        elementId: 'el-btn',
        filePath: 'src/auth/auth.controller.ts',
        symbol: 'AuthController.login',
        kind: 'controller',
      },
    ]);
  });

  it('按路径推断 kind（test / sql / controller / dto / repo / route）', () => {
    const raw = [
      '```ts\n// src/a/user.controller.ts\nexport class A {}\n```',
      '```sql\n-- src/db/init.sql\nSELECT 1;\n```',
      '```ts\n// src/a/user.repo.ts\nexport class B {}\n```',
      '```ts\n// src/a/user.service.test.ts\ntest("a", () => {});\n```',
    ].join('\n');
    const result = parseModelOutput(raw);
    expect(result.output?.files.map((file) => file.path)).toEqual([
      'src/a/user.controller.ts',
      'src/db/init.sql',
      'src/a/user.repo.ts',
      'src/a/user.service.test.ts',
    ]);
  });
});

describe('解析工具（T4-04）', () => {
  it('sliceBalancedObject 忽略字符串内的括号与转义', () => {
    const text = '前言 {"a":"}{","b":{"c":1}} 后记';
    expect(sliceBalancedObject(text)).toBe('{"a":"}{","b":{"c":1}}');
    expect(sliceBalancedObject('没有对象')).toBeNull();
    expect(sliceBalancedObject('{"unclosed": 1')).toBeNull();
  });

  it('extractJsonValue 命中围栏 / 夹带文本，都失败时返回 null', () => {
    expect(extractJsonValue('{"a":1}')?.mode).toBe('json');
    expect(extractJsonValue('```json\n{"a":1}\n```')?.mode).toBe('fenced-json');
    expect(extractJsonValue('说明 {"a":1} 结尾')?.mode).toBe('fenced-json');
    expect(extractJsonValue('完全没有')).toBeNull();
  });

  it('extractFences 抓取所有围栏内容', () => {
    expect(extractFences('```json\n1\n```\n```ts\n2\n```')).toEqual(['1\n', '2\n']);
  });

  it('extractCodeBlocks 给出语言与路径提示', () => {
    const blocks = extractCodeBlocks('```ts\n// src/a/b.ts\nconst a = 1;\n```');
    expect(blocks[0]?.language).toBe('ts');
    expect(blocks[0]?.pathHint).toBe('src/a/b.ts');
  });

  it('空返回给出去重后的失败原因，不抛错', () => {
    const result = parseModelOutput('   ');
    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(result.issues[0]).toContain('为空');
  });

  it('computeParseStats 对空数组返回 0 而不是 NaN', () => {
    expect(computeParseStats([])).toEqual({
      total: 0,
      success: 0,
      strictSuccess: 0,
      degraded: 0,
      rate: 0,
      strictRate: 0,
    });
  });
});
