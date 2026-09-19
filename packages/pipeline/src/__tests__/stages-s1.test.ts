import { describe, expect, it } from 'vitest';

import {
  S1RequirementStage,
  type DocumentArchivePort,
  type RequirementMemoryPort,
  type StageGenerationPort,
} from '../stages/s1-requirement';
import {
  buildRequirementPrompt,
  checkRequirementDocCompleteness,
  extractFeaturePriorities,
  extractMermaidFlowchart,
  type SimilarProjectSummary,
} from '../stages/templates/requirement-doc';

/**
 * T5-03 测试：八项要素齐全 / 长期记忆偏好体现 / 入档与关联 / 命名规范。
 */

const EIGHT_SECTIONS_DOC = [
  '# 商城 需求文档',
  '## 项目背景',
  '做一个电商平台。',
  '## 目标用户',
  'C 端消费者。',
  '## 功能清单',
  '- P0：商品浏览',
  '- P1：购物车',
  '- P2：个性化推荐',
  '## 用户故事',
  '- 作为消费者，我希望浏览商品，以便购买。',
  '## 业务流程图',
  '```mermaid',
  'flowchart TD',
  '    A[浏览] --> B[下单]',
  '```',
  '## 验收标准',
  '- [ ] 商品列表可加载',
  '## 非功能要求',
  '- 必须有单元测试',
  '## 风险与假设',
  '- 假设：需求以描述为准。',
].join('\n');

/** 200 字级别描述 */
const DESCRIPTION_200 = [
  '做一个面向小团队的轻量项目管理系统，核心诉求是：',
  '1. 需求从想法到代码全流程可视化，每个阶段产物可查看可回退；',
  '2. 界面用可视化设计器拖拽完成，导出标准 DSL；',
  '3. 所有代码由 AI 生成，客户端代码视图只读，禁止手动编辑；',
  '4. 数据全部本地存储，不依赖云端同步；',
  '5. 支持七端产物（Web/Android/iOS/鸿蒙/Windows/Linux/macOS）生成；',
  '6. 项目之间不自动联动，重命名只在项目内生效。',
  '目标用户是有多端交付需求的独立开发者与小团队。',
  '期望单机即可运行，安装包小于 100MB，首次启动 2 秒内完成。',
].join('\n');

function createFakeMemory(): RequirementMemoryPort {
  return {
    async getPreferences() {
      return {
        preferences: ['必须有单元测试 (id:mem-tests)', '界面文案保留中文 (id:mem-zh)'],
        forbidden: ['禁止使用 PHP (id:mem-no-php)', '禁止依赖云端服务 (id:mem-no-cloud)'],
      };
    },
    async findSimilarProjects(_userId, _description, limit): Promise<SimilarProjectSummary[]> {
      return [
        {
          projectId: 'P-SIM-1',
          name: '轻量看板',
          summary: '使用 SQLite 本地存储，未做多端 (id:mem-sim1)',
          score: 0.9,
        },
        {
          projectId: 'P-SIM-2',
          name: '内部工具台',
          summary: 'AI 生成代码，界面只读 (id:mem-sim2)',
          score: 0.8,
        },
      ].slice(0, limit);
    },
  };
}

function createFakeArchive(): DocumentArchivePort & {
  saved: unknown[];
  links: unknown[];
  versions: Record<string, number>;
} {
  const saved: unknown[] = [];
  const links: unknown[] = [];
  const versions: Record<string, number> = { requirement: 0, techdoc: 0 };
  return {
    saved,
    links,
    versions,
    async saveDocument(input) {
      saved.push({ ...input });
      versions[input.kind] = input.version;
      return { documentId: `doc-${input.kind}-${input.version}`, version: input.version };
    },
    async linkMemory(input) {
      links.push({ ...input });
    },
    async latestVersion(projectId, kind) {
      void projectId;
      return versions[kind] ?? 0;
    },
  };
}

function createFakeGenerator(content: string): StageGenerationPort & { calls: number } {
  let calls = 0;
  const port: StageGenerationPort & { calls: number } = {
    async generate() {
      calls += 1;
      return { content, degraded: false };
    },
    get calls() {
      return calls;
    },
  };
  return port;
}

describe('requirement-doc 模板（纯函数）', () => {
  it('八项要素标题逐字齐全时完整性通过', () => {
    const { missing, present } = checkRequirementDocCompleteness(EIGHT_SECTIONS_DOC);
    expect(missing).toEqual([]);
    expect(present).toHaveLength(8);
  });

  it('缺少小节时列出缺失项', () => {
    const { missing } = checkRequirementDocCompleteness('# 只有背景\n## 项目背景\n内容');
    expect(missing).toContain('目标用户');
    expect(missing).toContain('风险与假设');
    expect(missing).toHaveLength(7);
  });

  it('抽取业务流程图 Mermaid 源码', () => {
    const mermaid = extractMermaidFlowchart(EIGHT_SECTIONS_DOC);
    expect(mermaid).toContain('flowchart TD');
    expect(extractMermaidFlowchart('# 无流程图')).toBeNull();
  });

  it('抽取功能清单优先级', () => {
    const features = extractFeaturePriorities(EIGHT_SECTIONS_DOC);
    expect(features).toContainEqual({ name: '商品浏览', priority: 'P0' });
    expect(features).toContainEqual({ name: '个性化推荐', priority: 'P2' });
  });

  it('提示词含禁止事项强约束句式与相似项目摘要', () => {
    const { system, user } = buildRequirementPrompt({
      projectName: '商城',
      description: '一个商城',
      preferences: ['必须有单元测试'],
      forbidden: ['禁止使用 PHP'],
      similarProjects: [{ projectId: 'P1', name: '看板', summary: '本地存储', score: 0.9 }],
    });
    expect(system).toContain('八个小节标题必须逐字出现');
    expect(user).toContain('必须有单元测试');
    expect(user).toContain('相似度 0.90');
  });
});

describe('S1RequirementStage（生成 + 入档 + 关联）', () => {
  it('输入 200 字描述产出八项要素齐全的需求文档', async () => {
    const memory = createFakeMemory();
    const archive = createFakeArchive();
    const generator = createFakeGenerator(EIGHT_SECTIONS_DOC);
    const stage = new S1RequirementStage({ memory, archive, generate: generator });

    const result = await stage.generate({
      userId: 'U-TEST',
      projectId: 'P1',
      projectName: '商城',
      description: DESCRIPTION_200,
    });

    expect(result.completeness.missing).toEqual([]);
    expect(result.content).toContain('## 非功能要求');
  });

  it('长期记忆偏好体现：必须有单元测试出现在非功能要求', async () => {
    const memory = createFakeMemory();
    const archive = createFakeArchive();
    const docWithPreference = EIGHT_SECTIONS_DOC.replace(
      '## 非功能要求\n- 必须有单元测试',
      '## 非功能要求\n- 必须有单元测试（来自长期记忆偏好）',
    );
    const stage = new S1RequirementStage({
      memory,
      archive,
      generate: createFakeGenerator(docWithPreference),
    });

    const result = await stage.generate({
      userId: 'U-TEST',
      projectId: 'P1',
      projectName: '商城',
      description: DESCRIPTION_200,
    });

    expect(result.content).toContain('必须有单元测试');
    expect(result.completeness.missing).toEqual([]);
  });

  it('产物入档文档库并关联项目记忆（document + memory_doc_link 记录）', async () => {
    const memory = createFakeMemory();
    const archive = createFakeArchive();
    const stage = new S1RequirementStage({
      memory,
      archive,
      generate: createFakeGenerator(EIGHT_SECTIONS_DOC),
    });

    const result = await stage.generate({
      userId: 'U-TEST',
      projectId: 'P1',
      projectName: '商城',
      description: DESCRIPTION_200,
    });

    // 入档：kind=requirement，版本 1
    expect(archive.saved).toHaveLength(1);
    const saved = archive.saved[0] as {
      title: string;
      kind: string;
      version: number;
      content: string;
    };
    expect(saved.kind).toBe('requirement');
    expect(saved.version).toBe(1);
    // 命名规范 <项目>-需求文档-v<版本>.md
    expect(saved.title).toBe('商城-需求文档-v1.md');
    // 关联记忆：偏好 / 禁止事项 / 相似项目中的 (id:xxx)
    expect(archive.links.length).toBeGreaterThanOrEqual(2);
    const linkedIds = (archive.links as Array<{ memoryId: string }>).map((link) => link.memoryId);
    expect(linkedIds).toContain('mem-tests');
    expect(linkedIds).toContain('mem-no-php');
    expect(linkedIds).toContain('mem-sim1');
    expect(result.referencedMemoryIds).toContain('mem-tests');
  });

  it('版本递增：第二次生成 v2 且不覆盖 v1', async () => {
    const memory = createFakeMemory();
    const archive = createFakeArchive();
    const stage = new S1RequirementStage({
      memory,
      archive,
      generate: createFakeGenerator(EIGHT_SECTIONS_DOC),
    });

    const first = await stage.generate({
      userId: 'U-TEST',
      projectId: 'P1',
      projectName: '商城',
      description: DESCRIPTION_200,
    });
    const second = await stage.generate({
      userId: 'U-TEST',
      projectId: 'P1',
      projectName: '商城',
      description: DESCRIPTION_200,
      instruction: '追加：增加权限管理',
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.title).toBe('商城-需求文档-v2.md');
    expect(archive.saved).toHaveLength(2);
    // 追加要求被记录在 note
    const secondSaved = archive.saved[1] as { note: string };
    expect(secondSaved.note).toContain('追加要求');
  });
});
