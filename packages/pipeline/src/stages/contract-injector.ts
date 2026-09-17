import type { DependencyContract } from '@ec/ai';

/**
 * S5 契约注入（T5-06 要点 2 / FR-PIPE-10）。
 *
 * 核心约束：每个生成节点的上下文 = 自身记忆 + 上层记忆 + **已生成依赖的接口契约摘要**，
 * 禁止注入全部历史代码。本模块负责把"依赖节点的对外可调用面"压缩为摘要块：
 * - 只保留接口签名、参数与返回类型（types）；
 * - 不注入函数体 / 实现细节 / 无关文件；
 * - 技术文档中的 OpenAPI 草案也会被转化为契约条目（后端节点生成时消费）。
 *
 * 提取端口由外壳装配（Wave 9/10）：真实实现从 code_anchor + 已生成文件提取；
 * 测试用假实现构造确定性契约。
 */

/** 契约提取端口（外壳装配；测试注入假实现） */
export interface ContractExtractionPort {
  /** 已生成依赖节点的接口契约（按节点 id 过滤） */
  listContracts(projectId: string, nodeIds: readonly string[]): Promise<DependencyContract[]>;
  /** 从技术文档 OpenAPI 草案提取的契约（缺省空数组） */
  listFromTechDoc?(projectId: string): Promise<DependencyContract[]>;
}

export interface ContractInjectorDeps {
  port?: ContractExtractionPort | undefined;
}

export class ContractInjector {
  private readonly port: ContractExtractionPort | undefined;

  constructor(deps: ContractInjectorDeps = {}) {
    this.port = deps.port;
  }

  /**
   * 为节点组装契约块。
   * - 节点自身的依赖（dependsOn）优先；
   * - 未装配提取端口时返回空契约（块内说明"契约端口未接入"），不阻断生成。
   */
  async injectForNode(
    projectId: string,
    node: { id: string; name: string; dependsOn: readonly string[] },
  ): Promise<{ contracts: DependencyContract[]; block: string }> {
    const contracts = await this.collect(projectId, node.dependsOn);
    return { contracts, block: buildContractBlock(contracts) };
  }

  private async collect(projectId: string, nodeIds: readonly string[]): Promise<DependencyContract[]> {
    if (this.port === undefined) return [];
    const [fromNodes, fromTechDoc] = await Promise.all([
      this.port.listContracts(projectId, nodeIds),
      this.port.listFromTechDoc !== undefined ? this.port.listFromTechDoc(projectId) : Promise.resolve([]),
    ]);
    const seen = new Set<string>();
    const result: DependencyContract[] = [];
    for (const contract of [...fromNodes, ...fromTechDoc]) {
      const key = `${contract.kind}:${contract.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(contract);
    }
    return result;
  }
}

/** 单条契约渲染为摘要文本（只含对外可调用面） */
export function summarizeContract(contract: DependencyContract): string {
  const lines = [`${contract.kind} ${contract.name}`, contract.summary];
  if (contract.types !== undefined && contract.types.length > 0) {
    lines.push('关键类型：');
    for (const type of contract.types) lines.push(`- ${type}`);
  }
  return lines.join('\n');
}

/** 契约块：注入接口摘要而非全部代码（FR-PIPE-10 的机器可断言点） */
export function buildContractBlock(contracts: readonly DependencyContract[]): string {
  if (contracts.length === 0) {
    return [
      '## 依赖接口契约',
      '（无已生成依赖的接口契约 —— 本项目首次生成或依赖尚未生成）',
    ].join('\n');
  }
  const body = contracts.map((contract) => summarizeContract(contract)).join('\n\n');
  return `## 依赖接口契约（只允许调用以下接口签名，禁止臆造未列出的接口）\n\n${body}`;
}

/**
 * 断言契约块不含实现细节（测试用）：
 * 块中不得出现函数体特征（如 `{ return`、`=> {`、`function x(` 的完整实现）。
 * 真实校验在测试里对 buildContractBlock 的产物做正则断言。
 */
export function containsImplementationDetail(block: string): boolean {
  // 出现函数体 / 赋值实现 / 依赖导入即视为泄漏了实现细节
  return /=>\s*{[\s\S]*}/.test(block) || /\{\s*return\b[\s\S]*\}/.test(block) || /^\s*(import|require)\s*\(/m.test(block);
}
