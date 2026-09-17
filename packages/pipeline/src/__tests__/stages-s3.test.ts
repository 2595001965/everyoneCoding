import { describe, expect, it } from 'vitest';

import { PipelineMachine } from '../pipeline-machine';
import { S3TechDocStage, type TechDocMemoryPort } from '../stages/s3-techdoc';
import {
  defaultChoice,
  questionsForTargets,
  techChoiceToStack,
  toStackObject,
  validateChoice,
  type TechChoice,
} from '../stages/tech-choice-questionnaire';
import { checkTechDocCompleteness, extractOpenApiDraft, findForbiddenTech, validateOpenApiDraft } from '../stages/templates/tech-doc';
import type { DocumentArchivePort, StageGenerationPort } from '../stages/s1-requirement';

/**
 * T5-04 测试：问卷阻断 / 选择写入记忆 / 八项齐全 / OpenAPI 校验 /
 * 禁止技术后置校验触发重生成 / 重填问卷 stale 提示。
 */

const TECH_DOC_EIGHT = [
  '# 商城 技术文档',
  '## 技术选型',
  '目标端：web / android',
  '前端：React 18（权衡：生态最大）',
  '后端：NestJS（权衡：TS 全栈一致）',
  '## 系统架构',
  '```mermaid',
  'flowchart TD',
  '    A[Web] --> B[API]',
  '```',
  '```mermaid',
  'flowchart LR',
  '    C[部署] --> D[服务器]',
  '```',
  '## 模块划分',
  '- 认证模块',
  '- 商品模块',
  '## 数据模型',
  '```mermaid',
  'erDiagram',
  '    USER ||--o{ ORDER : places',
  '```',
  '- user（id, name）',
  '- order（id, user_id）',
  '## 接口设计',
  '```yaml',
  'openapi: 3.0.0',
  'info:',
  '  title: 商城 API',
  '  version: 1.0.0',
  'paths:',
  '  /api/products:',
  '    get:',
  '      summary: 商品列表',
  '      responses:',
  '        "200":',
  '          description: OK',
  '```',
  '## 安全设计',
  '- Token 鉴权',
  '## 性能与容量估算',
  '- 预估 QPS 100，存储年增 2GB',
  '## 测试策略',
  '- 单元测试 + 接口测试',
].join('\n');

const STACK_OBJECT = toStackObject(
  defaultChoice(['web', 'android', 'harmonyos', 'windows']),
);

function createTechDocChoice(): TechChoice {
  return {
    targets: ['web', 'android', 'windows'],
    web: 'react',
    mobile: 'flutter',
    harmony: 'arkts',
    desktop: 'tauri2',
    frontend: 'react',
    backend: 'node-nest',
    database: 'sqlite',
    orm: 'prisma',
    deploy: 'desktop',
  };
}

describe('tech-choice-questionnaire（FR-AI-13 矩阵）', () => {
  it('七端矩阵每端有推荐项与权衡说明', () => {
    const questions = questionsForTargets(['web', 'android', 'ios', 'harmonyos', 'windows', 'linux', 'macos']);
    // 7 个端题 + 5 个公共题
    expect(questions).toHaveLength(12);
    const web = questions.find((question) => question.id === 'platform-web');
    expect(web?.options.find((option) => option.value === 'react')?.recommended).toBe(true);
    const harmony = questions.find((question) => question.id === 'platform-harmonyos');
    expect(harmony?.options).toHaveLength(1);
    expect(harmony?.options[0]?.label).toContain('ArkTS');
  });

  it('未选择目标端时校验失败（阻断进入 S3）', () => {
    const choice = defaultChoice([]);
    const { ok, issues } = validateChoice(choice);
    expect(ok).toBe(false);
    expect(issues.some((issue) => issue.includes('目标端'))).toBe(true);
  });

  it('目标端未选择方案时校验失败', () => {
    const choice = createTechDocChoice();
    const broken = {
      ...choice,
      targets: ['web', 'macos'] as TechChoice['targets'],
      desktop: '' as TechChoice['desktop'],
    };
    const { ok, issues } = validateChoice(broken);
    expect(ok).toBe(false);
    expect(issues.some((issue) => issue.includes('macOS'))).toBe(true);
  });

  it('完整选择校验通过', () => {
    const { ok, issues } = validateChoice(createTechDocChoice());
    expect(ok).toBe(true);
    expect(issues).toEqual([]);
  });

  it('选择结果可写入项目记忆（structured.stack / targetPlatforms）', () => {
    const { stack, targetPlatforms } = STACK_OBJECT;
    expect(targetPlatforms).toEqual(['web', 'android', 'harmonyos', 'windows']);
    expect(stack).toContain('目标端');
    expect(stack).toContain('移动方案：flutter');
    expect(stack).toContain('桌面方案：tauri2');
    expect(techChoiceToStack(createTechDocChoice())).toContain('后端');
  });
});

describe('tech-doc 模板（八项 + OpenAPI）', () => {
  it('八项内容齐全', () => {
    const { missing } = checkTechDocCompleteness(TECH_DOC_EIGHT);
    expect(missing).toEqual([]);
  });

  it('OpenAPI 草案可提取且结构合法（供 T6-05 消费）', () => {
    const draft = extractOpenApiDraft(TECH_DOC_EIGHT);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const { ok, issues } = validateOpenApiDraft(draft);
    expect(ok).toBe(true);
    expect(issues).toEqual([]);
    expect(draft).toContain('openapi: 3.0.0');
  });

  it('无 yaml 围栏时 OpenAPI 提取返回 null', () => {
    const doc = TECH_DOC_EIGHT.replace(/```yaml[\s\S]*?```/, '```json\n{"openapi":"3.0.0"}\n```');
    expect(extractOpenApiDraft(doc)).toBeNull();
  });

  it('禁止技术后置校验能命中', () => {
    const hit = findForbiddenTech(TECH_DOC_EIGHT + '\n- 采用 PHP 实现', ['PHP']);
    expect(hit).toEqual(['PHP']);
    expect(findForbiddenTech(TECH_DOC_EIGHT, ['PHP'])).toEqual([]);
  });
});

describe('S3TechDocStage（生成 + 记忆尊重 + 后置校验重生成）', () => {
  function createMemory(): TechDocMemoryPort {
    return {
      async getProjectConstraints() {
        return { declaredStack: '目标端：web\n前端：React', forbidden: ['PHP', 'MongoDB'] };
      },
    };
  }

  function createArchive(): DocumentArchivePort & { saved: unknown[] } {
    const saved: unknown[] = [];
    return {
      saved,
      async saveDocument(input) {
        saved.push({ ...input });
        return { documentId: `doc-techdoc-${input.version}`, version: input.version };
      },
      async linkMemory() {},
      async latestVersion(_projectId, kind) {
        return kind === 'techdoc' ? 0 : 0;
      },
    };
  }

  it('生成技术文档：八项齐全 + OpenAPI 校验通过 + 入档命名 v1', async () => {
    const memory = createMemory();
    const archive = createArchive();
    const generator: StageGenerationPort = {
      async generate() {
        return { content: TECH_DOC_EIGHT, degraded: false };
      },
    };
    const stage = new S3TechDocStage({ memory, archive, generate: generator });

    const result = await stage.generate({
      userId: 'U-TEST',
      projectId: 'P1',
      projectName: '商城',
      description: '商城',
      choice: createTechDocChoice(),
      requirementDoc: '# 需求文档\n## 项目背景\n商城',
    });

    expect(result.completeness.missing).toEqual([]);
    expect(result.openApi?.valid).toBe(true);
    expect(result.title).toBe('商城-技术文档-v1.md');
    expect(archive.saved).toHaveLength(1);
  });

  it('禁止技术命中触发重新生成一次，第二次仍命中则告警', async () => {
    const memory = createMemory();
    const archive = createArchive();
    let call = 0;
    const generator: StageGenerationPort = {
      async generate() {
        call += 1;
        if (call === 1) return { content: `${TECH_DOC_EIGHT}\n## 补充\n- 采用 PHP 实现`, degraded: false };
        // 第二次生成：完全不含禁止技术字样
        return { content: `${TECH_DOC_EIGHT}\n## 补充\n- 已移除该技术，改用受支持的方案`, degraded: false };
      },
    };
    const stage = new S3TechDocStage({ memory, archive, generate: generator });

    const result = await stage.generate({
      userId: 'U-TEST',
      projectId: 'P1',
      projectName: '商城',
      description: '商城',
      choice: createTechDocChoice(),
      requirementDoc: '# 需求文档',
    });

    expect(call).toBe(2); // 触发过一次重新生成
    expect(result.regenerated).toBe(true);
    expect(result.forbiddenHit).toEqual([]); // 第二次合规
  });

  it('重试后仍含禁止技术时返回告警清单（绝不静默接受）', async () => {
    const memory = createMemory();
    const archive = createArchive();
    const generator: StageGenerationPort = {
      async generate() {
        return { content: `${TECH_DOC_EIGHT}\n## 补充\n- 使用 MongoDB 存储`, degraded: false };
      },
    };
    const stage = new S3TechDocStage({ memory, archive, generate: generator });

    const result = await stage.generate({
      userId: 'U-TEST',
      projectId: 'P1',
      projectName: '商城',
      description: '商城',
      choice: createTechDocChoice(),
      requirementDoc: '# 需求文档',
    });

    expect(result.regenerated).toBe(true);
    expect(result.forbiddenHit).toEqual(['MongoDB']);
  });
});

describe('问卷重填 → 下游 stale（E2E-19 后半段）', () => {
  it('重填问卷后发事件提示下游需重新生成', () => {
    const machine = new PipelineMachine({ projectId: 'P1' });
    machine.startStage('S1');
    machine.submitForReview('S1');
    machine.confirm('S1');
    machine.advance('S1', 'S2');
    machine.startStage('S2');
    machine.submitForReview('S2');
    machine.confirm('S2');
    // 已推进到 S3 并确认过（问卷在设置中重填，S3 已生成）
    machine.advance('S2', 'S3');
    machine.startStage('S3');
    machine.submitForReview('S3');
    machine.confirm('S3');

    const events: string[] = [];
    machine.bus.onAny('pipeline:*', (event) => {
      events.push(event);
    });

    // 模拟重填问卷：S3 之前的产物变更 → 通知下游 + 确认后置 stale
    machine.notifyDownstream('S2', '技术选型问卷已重填，请确认是否重新生成下游');
    expect(events.some((event) => event.startsWith('pipeline:downstream-stale'))).toBe(true);

    const marked = machine.applyDownstreamStale('S2');
    expect(marked).toContain('S3');
    expect(machine.statusOf('S3')).toBe('stale');
    // 尚未开始的 S4 保持 pending（未受影响）
    expect(machine.statusOf('S4')).toBe('pending');
  });
});
