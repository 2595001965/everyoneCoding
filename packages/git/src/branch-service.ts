import type { BranchGraph, BranchNode, GitBranchInfo, GitCommit, GitResult, GitTagInfo } from './models';
import type { GitClient } from './git-client';

/**
 * 分支服务（T6-03 要点 1）。
 *
 * 两件事：
 * 1. **分支树**：把 `feat/user/login` 这类带 `/` 的分支名按层级铺成树，UI 直接渲染；
 * 2. **提交图（BranchGraph）**：把线性提交列表排成"泳道"，正确标出分叉点与合并点。
 *
 * 泳道算法（自顶向下扫一遍，最新的提交在最上面）：
 * - 维护 `lanes[]`：每条泳道"下一个应该出现的提交 sha"；
 * - 若当前提交等于某条泳道的预期 → 它就落在该泳道；否则占用第一条空闲泳道；
 * - 提交的第一个父提交继承当前泳道，其余父提交各占一条（合并点由此产生两条边）；
 * - 一个提交被两条泳道同时期待 → 该提交是**分叉点**。
 *
 * 这是**启发式布局**：目的是让"分叉/合并关系"在图上可读，
 * 不追求与 `git log --graph` 完全一致（后者还有八向连线等细节）。
 */

export interface BranchTreeNode {
  /** 完整分支名（叶子节点才对应真实分支） */
  name: string;
  /** 展示用的最后一段 */
  label: string;
  children: BranchTreeNode[];
  /** 叶子节点上的分支信息 */
  branch: GitBranchInfo | null;
}

/** 按 `/` 分层构建分支树 */
export function buildBranchTree(branches: readonly GitBranchInfo[]): BranchTreeNode[] {
  const roots: BranchTreeNode[] = [];

  const findOrCreate = (nodes: BranchTreeNode[], name: string, label: string): BranchTreeNode => {
    const existing = nodes.find((node) => node.name === name);
    if (existing !== undefined) return existing;
    const created: BranchTreeNode = { name, label, children: [], branch: null };
    nodes.push(created);
    return created;
  };

  for (const branch of branches) {
    const segments = branch.name.split('/').filter((segment) => segment.length > 0);
    let nodes = roots;
    let prefix = '';
    let leaf: BranchTreeNode | null = null;
    for (const segment of segments) {
      prefix = prefix.length > 0 ? `${prefix}/${segment}` : segment;
      leaf = findOrCreate(nodes, prefix, segment);
      nodes = leaf.children;
    }
    if (leaf !== null) leaf.branch = branch;
  }
  return roots;
}

export interface BranchGraphInput {
  commits: readonly GitCommit[];
  branches?: readonly GitBranchInfo[];
  tags?: readonly GitTagInfo[];
  headSha?: string | null;
}

/** 提交列表 → 泳道图 */
export function buildBranchGraph(input: BranchGraphInput): BranchGraph {
  const commits = input.commits;
  const indexBySha = new Map(commits.map((commit, index) => [commit.sha, index]));
  const laneOf = new Map<string, number>();
  const lanes: (string | null)[] = [];
  const nodes: BranchNode[] = [];
  const forks: string[] = [];
  const merges: string[] = [];

  const firstFreeLane = (): number => {
    const index = lanes.findIndex((tip) => tip === null || tip === undefined);
    if (index >= 0) return index;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha);
    const expectedBy = lanes.filter((tip) => tip === commit.sha).length;
    if (expectedBy > 1) forks.push(commit.sha);
    if (lane < 0) lane = firstFreeLane();
    laneOf.set(commit.sha, lane);

    // 第一个父提交继承本泳道，其余父提交各占一条（合并）
    const [firstParent, ...otherParents] = commit.parents;
    lanes[lane] = firstParent !== undefined && indexBySha.has(firstParent) ? firstParent : null;
    for (const parent of otherParents) {
      if (!indexBySha.has(parent)) continue;
      const already = lanes.indexOf(parent);
      if (already < 0) lanes[firstFreeLane()] = parent;
    }

    nodes.push({
      sha: commit.sha,
      subject: commit.subject,
      authorName: commit.authorName,
      authoredAt: commit.authoredAt,
      lane,
      parents: [],
      branches: [],
      tags: [],
      isHead: input.headSha !== undefined && input.headSha !== null && input.headSha === commit.sha,
      isMerge: commit.parents.length > 1,
    });
    if (commit.parents.length > 1) merges.push(commit.sha);
  }

  // 第二遍：父边（需要父提交的泳道，故在全部 lane 确定后再补）
  const nodeBySha = new Map(nodes.map((node) => [node.sha, node]));
  for (const node of nodes) {
    const commit = commits.find((item) => item.sha === node.sha);
    if (commit === undefined) continue;
    node.parents = commit.parents
      .filter((parent) => nodeBySha.has(parent))
      .map((parent) => ({ sha: parent, lane: laneOf.get(parent) ?? 0 }));
  }

  // ref 标记：分支与标签
  for (const branch of input.branches ?? []) {
    if (branch.lastCommitSha === null) continue;
    const node = nodeBySha.get(branch.lastCommitSha);
    if (node !== undefined && !node.branches.includes(branch.name)) node.branches.push(branch.name);
  }
  for (const tag of input.tags ?? []) {
    const node = nodeBySha.get(tag.sha);
    if (node !== undefined && !node.tags.includes(tag.name)) node.tags.push(tag.name);
  }
  // `%D` 里的 ref 也补进来（可能在 branches 清单之外，例如远端跟踪分支）
  for (const node of nodes) {
    const commit = commits.find((item) => item.sha === node.sha);
    if (commit === undefined) continue;
    for (const ref of commit.refs) {
      const cleaned = ref.replace(/^HEAD -> /, '');
      if (cleaned.length === 0) continue;
      if (cleaned.startsWith('tag: ')) {
        const name = cleaned.slice(5);
        if (!node.tags.includes(name)) node.tags.push(name);
      } else if (!node.branches.includes(cleaned)) {
        node.branches.push(cleaned);
      }
    }
  }

  return {
    nodes,
    lanes: lanes.length,
    head: input.headSha ?? nodes.find((node) => node.isHead)?.sha ?? null,
    forks: [...new Set(forks)],
    merges: [...new Set(merges)],
  };
}

export class BranchService {
  constructor(private readonly client: GitClient) {}

  async list(): Promise<GitResult<GitBranchInfo[]>> {
    return this.client.branches();
  }

  async tree(): Promise<GitResult<BranchTreeNode[]>> {
    const result = await this.client.branches();
    if (!result.ok || result.data === null) return { ...result, data: null };
    return { ...result, data: buildBranchTree(result.data) };
  }

  /** 提交图（默认取最近 200 条） */
  async graph(options: { limit?: number; branches?: readonly GitBranchInfo[] } = {}): Promise<GitResult<BranchGraph>> {
    const [commits, branches, tags, head] = await Promise.all([
      this.client.log({ limit: options.limit ?? 200 }),
      options.branches !== undefined ? Promise.resolve(null) : this.client.branches(),
      this.client.tags(),
      this.client.headSha(),
    ]);
    const logs = [...commits.logs, ...(branches?.logs ?? []), ...tags.logs, ...head.logs];
    if (!commits.ok || commits.data === null) {
      return { ok: false, data: null, logs, error: commits.error };
    }
    return {
      ok: true,
      error: null,
      logs,
      data: buildBranchGraph({
        commits: commits.data,
        branches: options.branches ?? branches?.data ?? [],
        tags: tags.data ?? [],
        headSha: head.data ?? null,
      }),
    };
  }

  async create(name: string, startPoint?: string): Promise<GitResult<string>> {
    return this.client.createBranch(name, startPoint);
  }

  async switch(name: string, options: { create?: boolean } = {}): Promise<GitResult<string>> {
    return this.client.switchBranch(name, options);
  }

  async rename(from: string, to: string): Promise<GitResult<string>> {
    return this.client.renameBranch(from, to);
  }

  /** 删除分支（破坏性：UI 必须二次确认；`force` 对应 -D） */
  async remove(name: string, options: { force?: boolean } = {}): Promise<GitResult<string>> {
    return this.client.deleteBranch(name, options);
  }
}
