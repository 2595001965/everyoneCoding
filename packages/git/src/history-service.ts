import type { GitCommit, GitDiffFile, GitResult } from './models';
import { parseUnifiedDiff } from './diff-service';
import type { GitClient } from './git-client';

/**
 * 历史服务（T6-03 要点 3）。
 *
 * - `query`：游标分页拉取（UI 用虚拟列表，只取窗口内的数据）；
 * - 过滤条件**下推到 git**（`--grep` / `--author` / `--since` / `--until` / `-- path`），
 *   避免把 1000 条提交先取回内存再筛；
 * - `filterCommits` 是同一套语义的**纯函数版本**，用于已加载数据上的即时二次筛选
 *   （UI 输入关键词时不重复调用 git）。
 */

export interface HistoryQuery {
  /** 按文件路径过滤 */
  path?: string | undefined;
  /** 按作者（name / email 子串）过滤 */
  author?: string | undefined;
  /** 关键词（subject / body） */
  keyword?: string | undefined;
  /** Unix 毫秒下界（含） */
  since?: number | undefined;
  /** Unix 毫秒上界（含） */
  until?: number | undefined;
  ref?: string | undefined;
}

export interface HistoryPage {
  commits: GitCommit[];
  /** 下一页游标（= 已取条数） */
  cursor: number;
  hasMore: boolean;
  /** 本页是否命中过滤条件；false 表示是"过滤后为空" */
  filtered: boolean;
}

export interface HistoryDetail {
  commit: GitCommit;
  files: GitDiffFile[];
  additions: number;
  deletions: number;
}

/** git 的空树对象 sha（与根提交比较时使用） */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 单条提交是否命中查询条件（与下推到 git 的条件保持一致） */
export function matchesQuery(commit: GitCommit, query: HistoryQuery): boolean {
  if (query.path !== undefined && query.path.length > 0) {
    // 单条提交里没有文件清单，文件过滤只能在 git 侧完成；
    // 这里不因 path 条件过滤掉提交，避免"本地过滤把结果筛没了"
  }
  if (query.author !== undefined && query.author.length > 0) {
    const needle = query.author.toLowerCase();
    if (
      !commit.authorName.toLowerCase().includes(needle) &&
      !commit.authorEmail.toLowerCase().includes(needle)
    )
      return false;
  }
  if (query.keyword !== undefined && query.keyword.length > 0) {
    const needle = query.keyword.toLowerCase();
    if (
      !commit.subject.toLowerCase().includes(needle) &&
      !commit.body.toLowerCase().includes(needle)
    )
      return false;
  }
  if (query.since !== undefined && commit.authoredAt < query.since) return false;
  if (query.until !== undefined && commit.authoredAt > query.until) return false;
  return true;
}

export function filterCommits(commits: readonly GitCommit[], query: HistoryQuery): GitCommit[] {
  return commits.filter((commit) => matchesQuery(commit, query));
}

export class HistoryService {
  constructor(private readonly client: GitClient) {}

  /** 分页拉取（游标 = 已跳过条数） */
  async query(
    query: HistoryQuery = {},
    page: { cursor?: number; pageSize?: number } = {},
  ): Promise<GitResult<HistoryPage>> {
    const pageSize = Math.max(1, page.pageSize ?? 100);
    const cursor = Math.max(0, page.cursor ?? 0);
    const result = await this.client.log({
      ...query,
      limit: pageSize + 1,
      skip: cursor,
    });
    if (!result.ok || result.data === null) return { ...result, data: null };

    const hasMore = result.data.length > pageSize;
    const commits = hasMore ? result.data.slice(0, pageSize) : result.data;
    const filtered =
      (query.keyword !== undefined && query.keyword.length > 0) ||
      (query.author !== undefined && query.author.length > 0) ||
      (query.path !== undefined && query.path.length > 0) ||
      query.since !== undefined ||
      query.until !== undefined;

    return {
      ok: true,
      error: null,
      logs: result.logs,
      data: { commits, cursor: cursor + commits.length, hasMore, filtered },
    };
  }

  /** 提交详情：文件变更清单 + diff 摘要（不懒加载 diff 正文，避免大提交卡顿） */
  async detail(sha: string): Promise<GitResult<HistoryDetail>> {
    const commitResult = await this.client.log({ ref: sha, limit: 1 });
    const commit = commitResult.data?.[0];
    if (!commitResult.ok || commit === undefined) {
      return {
        ok: false,
        data: null,
        logs: commitResult.logs,
        error: commitResult.error ?? { code: 'UNKNOWN', message: '未找到该提交' },
      };
    }

    // 根提交没有父提交：`<sha>^` 不存在，diff 会失败。
    // 这里退化为与「空树」比较（git 的空树对象是固定 sha），保证首个提交的详情也能展示文件清单。
    const hasParent = commit.parents.length > 0;
    const diff = hasParent
      ? await this.client.diff({ scope: 'range', from: `${sha}^`, to: sha })
      : await this.client.diff({ scope: 'range', from: EMPTY_TREE_SHA, to: sha });

    const logs = [...commitResult.logs, ...diff.logs];
    return {
      ok: true,
      error: null,
      logs,
      data: {
        commit,
        files: diff.data?.files ?? [],
        additions: diff.data?.additions ?? 0,
        deletions: diff.data?.deletions ?? 0,
      },
    };
  }

  /** 已加载数据上的即时筛选（不访问 git） */
  filter(commits: readonly GitCommit[], query: HistoryQuery): GitCommit[] {
    return filterCommits(commits, query);
  }

  /** 从 diff 文本解析文件清单（提交详情里"文件变更清单"用，纯函数便于测试） */
  filesOfPatch(patch: string): GitDiffFile[] {
    return parseUnifiedDiff(patch).files;
  }
}
