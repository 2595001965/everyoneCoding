import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { apiRouteKeyOf } from '@ec/core';
import {
  scanApiSources,
  type ApiContractParser,
  type ApiEndpointDraft,
  type ApiSourceFile,
} from '@ec/registry';

const runFile = promisify(execFile);
export interface ApiCreationTime {
  createdAt: number | null;
  createdAtSource: 'git_inferred' | 'unknown';
  timeReason: string;
}
const unknown = (timeReason: string): ApiCreationTime => ({
  createdAt: null,
  createdAtSource: 'unknown',
  timeReason,
});

/** Read only local reachable history. No fetch, hooks, project scripts or network. */
export function createApiHistoryReader(
  root: string,
  files: readonly ApiSourceFile[],
  parseContract: ApiContractParser,
): (endpoint: ApiEndpointDraft) => Promise<ApiCreationTime> {
  const git = async (args: string[]): Promise<string> =>
    (
      await runFile('git', ['-c', 'core.fsmonitor=false', '--no-pager', ...args], {
        cwd: root,
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        windowsHide: true,
      })
    ).stdout;
  let state: Promise<string | null> | null = null;
  const readiness = (): Promise<string | null> =>
    (state ??= (async () => {
      try {
        const top = (await git(['rev-parse', '--show-toplevel'])).trim();
        if (resolve(top).toLowerCase() !== resolve(root).toLowerCase())
          return '代码根不是独立 Git 仓库；不采用父目录的历史，创建时间未知';
        if ((await git(['rev-parse', '--is-shallow-repository'])).trim() === 'true')
          return '浅克隆历史不完整，创建时间未知；未自动补全历史';
        return null;
      } catch {
        return '无可读取的 Git 历史，创建时间未知';
      }
    })());
  const cache = new Map<
    string,
    Promise<Array<{ hash: string; at: number; content: string }> | string>
  >();
  const deadline = Date.now() + 15_000;
  const historyOf = (
    path: string,
  ): Promise<Array<{ hash: string; at: number; content: string }> | string> => {
    let value = cache.get(path);
    if (!value) {
      value = (async () => {
        try {
          const log = await git([
            'log',
            '--follow',
            '--max-count=101',
            '--format=%H %ct',
            '--name-status',
            'HEAD',
            '--',
            path,
          ]);
          if (/^[RC]\d*\t/m.test(log)) return '文件重命名/复制历史需人工核对，创建时间降级为未知';
          const commits = [...log.matchAll(/^([a-f0-9]{40,64}) (\d+)$/gm)].map((m) => ({
            hash: m[1]!,
            at: Number(m[2]) * 1_000,
          }));
          if (!commits.length) return '文件未被当前 Git 历史追踪，创建时间未知';
          if (commits.length > 100) return '文件历史超出本次只读扫描上限，创建时间未知';
          const out: Array<{ hash: string; at: number; content: string }> = [];
          for (const commit of commits.reverse()) {
            if (Date.now() > deadline) return '本次 Git 历史扫描达到时间上限，创建时间未知';
            try {
              out.push({ ...commit, content: await git(['show', `${commit.hash}:${path}`]) });
            } catch {
              return '历史文件内容无法完整读取，创建时间未知';
            }
          }
          return out;
        } catch {
          return 'Git 历史读取失败或超时，创建时间未知';
        }
      })();
      cache.set(path, value);
    }
    return value;
  };
  return async (endpoint) => {
    if (Date.now() > deadline) return unknown('本次 Git 历史扫描达到时间上限，创建时间未知');
    const blocked = await readiness();
    if (blocked) return unknown(blocked);
    if (endpoint.status !== 'active') return unknown('路由未解析，不能推断创建时间');
    const declaration =
      endpoint.evidence.find((e) => e.kind === 'router_decl') ??
      endpoint.evidence.find((e) => e.kind === 'openapi');
    if (!declaration) return unknown('没有可靠的声明/契约证据');
    if (
      endpoint.evidence.some(
        (e) =>
          e.kind === 'configuration' && e.sourceRef.filePath !== declaration.sourceRef.filePath,
      )
    )
      return unknown('挂载前缀依赖其他文件，单文件历史不足以推断接口首次出现');
    const history = await historyOf(declaration.sourceRef.filePath);
    if (typeof history === 'string') return unknown(history);
    const manifests = files.filter((f) =>
      /(^|\/)(package\.json|pyproject\.toml|requirements\.txt)$/.test(f.path),
    );
    const match = (content: string, currentRoute = false): boolean => {
      const scanned = scanApiSources(
        [...manifests, { path: declaration.sourceRef.filePath, content, modifiedAt: null }],
        parseContract,
      );
      return (
        scanned.complete &&
        scanned.endpoints.some(
          (e) =>
            e.status === 'active' &&
            (currentRoute
              ? apiRouteKeyOf(e) === apiRouteKeyOf(endpoint)
              : e.evidence.some((ev) => ev.key === declaration.key)),
        )
      );
    };
    // A current uncommitted declaration must not inherit some unrelated old route time.
    if (!history.at(-1) || !match(history.at(-1)!.content, true))
      return unknown('当前路由未出现在可追溯的最新文件版本中，创建时间未知');
    const first = history.find((h) => match(h.content));
    if (!first || first.at > Date.now()) return unknown('没有可靠的首次出现匹配，创建时间未知');
    return {
      createdAt: first.at,
      createdAtSource: 'git_inferred',
      timeReason: `当前可追溯文件历史的首次路由出现推断（${first.hash.slice(0, 12)}）；不是客观业务创建时间`,
    };
  };
}
