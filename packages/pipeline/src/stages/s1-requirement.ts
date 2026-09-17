import {
  buildRequirementPrompt,
  checkRequirementDocCompleteness,
  type RequirementDocSection,
  type SimilarProjectSummary,
} from './templates/requirement-doc';

/**
 * S1 需求文档生成（T5-03 / FR-PIPE-05 / FR-DOC-06）。
 *
 * 流程：记忆偏好 + 相似项目检索 → 提示词组装（purpose='requirement' 同款句式）→
 * 生成 → 八项要素完整性校验 → 入档 document 表 + 关联 memory_doc_link →
 * 产物命名 `<项目>-需求文档-v<版本>.md`。
 *
 * 端口注入（对齐 Wave 1–4 的既定做法，不直接 import @ec/memory / @ec/ai 根入口）：
 * - `memory`：长期记忆偏好 / 禁止事项 / 相似项目检索（外壳装配到 @ec/memory）；
 * - `archive`：document / memory_doc_link 读写（外壳装配到 @ec/data 或文档服务）；
 * - `generate`：一次模型调用（外壳适配 @ec/ai Generator 的 rawText 模式）。
 */

export interface StageGenerateRequest {
  userId: string;
  projectId: string;
  projectName: string;
  /** 用户自然语言描述（约 200 字） */
  description: string;
  /** 追加要求（T5-02 的「追加要求」：与原描述一起提交，输出完整新版） */
  instruction?: string | undefined;
}

export interface RequirementGenerationResult {
  /** 完整 Markdown 需求文档 */
  content: string;
  documentId: string;
  /** 阶段产物版本（v1/v2…） */
  version: number;
  /** 文档标题（<项目>-需求文档-v<版本>.md） */
  title: string;
  /** 被引用的长期 / 项目记忆 id（已写入 memory_doc_link） */
  referencedMemoryIds: string[];
  /** 八项要素完整性（缺失项由 UI 提示） */
  completeness: { missing: RequirementDocSection[]; present: RequirementDocSection[] };
  /** 生成是否降级（AI 不可用时的模板兜底） */
  degraded: boolean;
}

/** 记忆端口（外壳装配 @ec/memory；测试用假实现） */
export interface RequirementMemoryPort {
  /** 长期记忆偏好与禁止事项 */
  getPreferences(userId: string): Promise<{ preferences: string[]; forbidden: string[] }>;
  /** 相似项目检索（取 topN 项目记忆摘要） */
  findSimilarProjects(userId: string, description: string, limit: number): Promise<SimilarProjectSummary[]>;
}

/** 文档入档端口（外壳装配文档服务 / @ec/data document 表） */
export interface DocumentArchivePort {
  /** 保存新版本文档，返回 documentId 与版本号（调用方决定 version） */
  saveDocument(input: {
    projectId: string;
    title: string;
    kind: 'requirement' | 'techdoc' | 'other';
    content: string;
    version: number;
    note?: string | undefined;
  }): Promise<{ documentId: string; version: number }>;
  /** 关联记忆与文档 */
  linkMemory(input: { documentId: string; memoryId: string; linkType: 'derived_from' | 'related' }): Promise<void>;
  /** 查询某项目某类文档的最新版本（未有过返回 0） */
  latestVersion(projectId: string, kind: 'requirement' | 'techdoc'): Promise<number>;
}

/** 单次模型调用端口（外壳适配 @ec/ai Generator：rawText=true 返回完整文本） */
export interface StageGenerationPort {
  generate(prompt: { system: string; user: string }): Promise<{ content: string; degraded: boolean }>;
}

export interface S1RequirementDeps {
  memory: RequirementMemoryPort;
  archive: DocumentArchivePort;
  generate: StageGenerationPort;
  clock?: (() => number) | undefined;
}

export class S1RequirementStage {
  private readonly deps: S1RequirementDeps;

  constructor(deps: S1RequirementDeps) {
    this.deps = deps;
  }

  /**
   * 生成（或追加要求后重新生成）。
   * - 追加要求（instruction）与原描述一起提交，要求 AI 输出**完整新版**而非补丁（T5-02 要点 3）；
   * - 产物按版本号递增入档；记忆引用写 memory_doc_link。
   */
  async generate(input: StageGenerateRequest): Promise<RequirementGenerationResult> {
    const { preferences, forbidden } = await this.deps.memory.getPreferences(input.userId);
    const similarProjects = await this.deps.memory.findSimilarProjects(input.userId, input.description, 3);

    const prompt = buildRequirementPrompt({
      projectName: input.projectName,
      description: input.description,
      preferences,
      forbidden,
      similarProjects,
      ...(input.instruction !== undefined && input.instruction.trim().length > 0 ? { instruction: input.instruction } : {}),
    });

    const { content, degraded } = await this.deps.generate.generate(prompt);

    // 完整性校验：八项要素缺失时仍入档，但把缺失项返回给 UI 提示（不强造内容）
    const completeness = checkRequirementDocCompleteness(content);
    const version = (await this.deps.archive.latestVersion(input.projectId, 'requirement')) + 1;
    const title = `${input.projectName}-需求文档-v${version}.md`;

    const { documentId } = await this.deps.archive.saveDocument({
      projectId: input.projectId,
      title,
      kind: 'requirement',
      content,
      version,
      note: input.instruction !== undefined && input.instruction.trim().length > 0 ? `追加要求：${input.instruction.trim()}` : '初始生成',
    });

    // 关联记忆（偏好 / 禁止事项 / 相似项目所属记忆；无 id 可关联时跳过）
    const referencedMemoryIds: string[] = [];
    for (const memoryId of this.collectMemoryIds(preferences, forbidden, similarProjects)) {
      await this.deps.archive.linkMemory({ documentId, memoryId, linkType: 'derived_from' });
      referencedMemoryIds.push(memoryId);
    }

    return { content, documentId, version, title, referencedMemoryIds, completeness, degraded };
  }

  /** 记忆 id 收集：偏好 / 禁止事项条目中带 (id:xxx) 后缀的；相似项目按 projectId 组装 */
  private collectMemoryIds(preferences: string[], forbidden: string[], similar: SimilarProjectSummary[]): string[] {
    const ids: string[] = [];
    const push = (text: string): void => {
      const match = /\(id:\s*([A-Za-z0-9_-]+)\)/.exec(text);
      if (match !== null) ids.push(match[1] as string);
    };
    for (const preference of preferences) push(preference);
    for (const item of forbidden) push(item);
    for (const project of similar) {
      // 相似项目记忆：使用其项目记忆 id（若无明确 id，跳过）
      const match = /\(id:\s*([A-Za-z0-9_-]+)\)/.exec(project.summary);
      if (match !== null) ids.push(match[1] as string);
    }
    return [...new Set(ids)];
  }
}
