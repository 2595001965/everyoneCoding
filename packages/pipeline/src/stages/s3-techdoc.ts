import type {
  DocumentArchivePort,
  StageGenerationPort,
  StageGenerateRequest,
} from './s1-requirement';
import type { TechChoice } from './tech-choice-questionnaire';
import { techChoiceToStack } from './tech-choice-questionnaire';
import {
  buildTechDocPrompt,
  checkTechDocCompleteness,
  extractOpenApiDraft,
  findForbiddenTech,
  validateOpenApiDraft,
  type TechDocSection,
} from './templates/tech-doc';

/**
 * S3 技术文档生成（T5-04 / FR-PIPE-06 / FR-PIPE-07）。
 *
 * 关键点：
 * - 尊重记忆：已声明技术栈必须遵循，冲突给对比说明而非覆盖（提示词句式已含）；
 * - 禁止技术后置校验：生成完成后扫描 forbidden，命中则带更强约束**重新生成一次**，
 *   仍命中则返回告警清单（UI 提示，绝不静默接受）；测试构造禁止技术断言触发重生成；
 * - OpenAPI 3.0 草案结构校验（供 T6-05 Mock Server 消费）；
 * - 产物入档 `<项目>-技术文档-v<版本>.md` 并关联项目记忆。
 */

export interface TechDocMemoryPort {
  /** 项目记忆已声明的技术栈与禁止技术 */
  getProjectConstraints(
    projectId: string,
  ): Promise<{ declaredStack: string | null; forbidden: string[] }>;
}

export interface S3TechDocRequest extends StageGenerateRequest {
  /** 技术选型问卷结果（未完成问卷时状态机已阻断，不会走到这里） */
  choice: TechChoice;
  /** 需求文档全文（S1 产物） */
  requirementDoc: string;
}

export interface TechDocGenerationResult {
  content: string;
  documentId: string;
  version: number;
  title: string;
  completeness: { missing: TechDocSection[]; present: TechDocSection[] };
  /** OpenAPI 草案与结构校验结果（null = 文档中没有合法草案） */
  openApi: { draft: string | null; valid: boolean; issues: string[] } | null;
  /** 后置校验命中的禁止技术（空 = 合规） */
  forbiddenHit: string[];
  /** 是否触发过一次重新生成 */
  regenerated: boolean;
  degraded: boolean;
}

export interface S3TechDocDeps {
  memory: TechDocMemoryPort;
  archive: DocumentArchivePort;
  generate: StageGenerationPort;
  clock?: (() => number) | undefined;
}

export class S3TechDocStage {
  private readonly deps: S3TechDocDeps;

  constructor(deps: S3TechDocDeps) {
    this.deps = deps;
  }

  async generate(input: S3TechDocRequest): Promise<TechDocGenerationResult> {
    const { declaredStack, forbidden } = await this.deps.memory.getProjectConstraints(
      input.projectId,
    );
    const stack = techChoiceToStack(input.choice);

    const prompt = buildTechDocPrompt({
      projectName: input.projectName,
      stack,
      targetPlatforms: input.choice.targets,
      requirementDoc: input.requirementDoc,
      declaredStack,
      forbidden,
      ...(input.instruction !== undefined && input.instruction.trim().length > 0
        ? { instruction: input.instruction }
        : {}),
    });

    let { content, degraded } = await this.deps.generate.generate(prompt);

    // 后置校验：禁止技术命中 → 重新生成一次（带更强约束）
    let forbiddenHit = findForbiddenTech(content, forbidden);
    let regenerated = false;
    if (forbiddenHit.length > 0) {
      regenerated = true;
      const rePrompt = buildTechDocPrompt({
        projectName: input.projectName,
        stack,
        targetPlatforms: input.choice.targets,
        requirementDoc: input.requirementDoc,
        declaredStack,
        forbidden,
        instruction: `上一次输出违反了以下禁止事项：${forbiddenHit.join('、')}。请删除所有相关技术、依赖与示例，重新输出**完整文档**。`,
      });
      const second = await this.deps.generate.generate(rePrompt);
      content = second.content;
      degraded = second.degraded;
      forbiddenHit = findForbiddenTech(content, forbidden);
    }

    const completeness = checkTechDocCompleteness(content);
    const draft = extractOpenApiDraft(content);
    let openApi: TechDocGenerationResult['openApi'] = null;
    if (draft !== null) {
      const validation = validateOpenApiDraft(draft);
      openApi = { draft, valid: validation.ok, issues: validation.issues };
    }

    const version = (await this.deps.archive.latestVersion(input.projectId, 'techdoc')) + 1;
    const title = `${input.projectName}-技术文档-v${version}.md`;
    const { documentId } = await this.deps.archive.saveDocument({
      projectId: input.projectId,
      title,
      kind: 'techdoc',
      content,
      version,
      note:
        input.instruction !== undefined && input.instruction.trim().length > 0
          ? `追加要求：${input.instruction.trim()}`
          : '初始生成',
    });

    return {
      content,
      documentId,
      version,
      title,
      completeness,
      openApi,
      forbiddenHit,
      regenerated,
      degraded,
    };
  }
}
