import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import {
  ConflictService,
  DEFAULT_AUTO_COMMIT_POLICY,
  GitClient,
  HistoryService,
  MergeService,
  RecoveryService,
  RemoteService,
  normalizeAiCommitMessage,
  resolveConflictFile,
  type AutoCommitPolicy,
  type ConflictFile,
  type ConflictResolution,
  type GitCredentialStore,
  type GitDiff,
  type GitResult,
  type RollbackMode,
  type RollbackPlan,
} from '@ec/git';
import { ShellError } from '@ec/shell-api';

import type { CodeWritePort } from './code-domain';
import { errorOfStreamChunk, textOfStreamChunk } from '../ai-stream-text';
import type { AiStackHandle } from '../domain-factories';
import { createProjectPaths, type ProjectPaths } from '../paths';
import type { DomainRouter } from '../runtime';
import { createSettingStore, type SettingStore } from '../setting-store';

/**
 * git 域生产路由（T12-04 Git 部分）。
 *
 * 装配口径：
 * - 每个项目的代码根 `<projectsDir>/<projectId>/code` 持有一组**懒建、按 projectId 缓存**
 *   的门面对象（GitClient + Merge/Conflict/Recovery/Remote/History 五个服务）。
 *   服务都只是 GitClient 的薄封装，不持有额外状态，共享一个实例最省。
 * - 路径一律经 `createProjectPaths` 解析（T12-04 要点 1），域内**不再**手写
 *   `startsWith(root + sep)`；越界统一抛 `PATH_ESCAPE`。
 * - `@ec/git` 的 `GitResult<T>` 本身就是给 UI 消费的结构化契约（含脱敏后的日志），
 *   **原样透传**，不要在这里拆成 `.data`——那会把失败原因和操作日志一起丢掉。
 * - 破坏性操作（回滚、删除分支、强制推送）由 UI 二次确认；主进程侧**额外**为
 *   可逆性兜底：删除分支与强制推送前自动建 `backup/<时间戳>` 快照分支
 *   （T12-04 要点 4「所有破坏性操作继续二次确认并建立安全快照」）。
 *
 * 凭据纪律（要点 4）：`GitCredentialStore` 只走 DPAPI（`domain/git-credentials.ts`），
 * 令牌经**环境变量**注入 git（`@ec/git` 的 `buildAuthEnv`），既不入 argv 也不落日志。
 * DPAPI 不可用时凭据类方法如实报 `NOT_SUPPORTED`，绝不降级为明文。
 */

export interface GitDomainOptions {
  projectsDir: string;
  db: Database.Database;
  /** 本地用户（setting 表按 user_id 分行） */
  userId: string;
  /** DPAPI 凭据存储；null = 系统加密不可用（凭据方法如实降级） */
  credentials: GitCredentialStore | null;
  /** AI 栈（生成提交信息用）；null 时如实报 NOT_SUPPORTED */
  aiStack: AiStackHandle | null;
  /**
   * 代码写入端口（D-04：代码只由 AI 写入）。
   * 冲突解决结果必须经它落盘；未装配时 `applyResolution` 报 NOT_SUPPORTED。
   */
  writeCode: CodeWritePort | null;
}

interface ProjectServices {
  readonly root: string;
  readonly client: GitClient;
  readonly merge: MergeService;
  readonly conflicts: ConflictService;
  readonly recovery: RecoveryService;
  readonly remote: RemoteService;
  readonly history: HistoryService;
}

/** 安全快照分支前缀（与 MergeService 的 `backup/<timestamp>` 口径一致） */
const BACKUP_PREFIX = 'backup/';

/** 自动提交策略在 setting 表中的键（FR-GIT-09，默认关闭） */
const AUTO_COMMIT_KEY = 'git_auto_commit_policy';

/** 冲突解决策略：'ai' 走模型合并，其余为「选一侧 / 两侧都要」 */
export type ResolutionStrategy = ConflictResolution;

export function createGitDomain(options: GitDomainOptions): DomainRouter {
  const cache = new Map<string, Promise<ProjectServices>>();
  const paths: ProjectPaths = createProjectPaths({ projectsDir: options.projectsDir });
  const settings: SettingStore = createSettingStore({ db: options.db, userId: options.userId });

  /* ------------------------------ 实例 ------------------------------ */

  const servicesOf = (projectId: string): Promise<ProjectServices> => {
    const cached = cache.get(projectId);
    if (cached !== undefined) return cached;
    const built = (async (): Promise<ProjectServices> => {
      const root = paths.codeRoot(projectId);
      if (!existsSync(root)) {
        throw new ShellError('NOT_FOUND', `项目代码目录不存在：${projectId}`);
      }
      const credentials = options.credentials;
      const client = await GitClient.create({
        repoPath: root,
        // 凭据解析：远程名 → 明文（仅在内存中短暂存在，随后由 buildAuthEnv 编码进环境变量）
        credentials: credentials === null ? null : (remote) => credentials.get(remote),
      });
      return {
        root,
        client,
        merge: new MergeService(client),
        // 冲突文件内容由本域直接从代码根读取：路径已限定在仓库内，且只读
        conflicts: new ConflictService(client, {
          readFile: async (path: string) => {
            try {
              return readFileSync(paths.inside(root, path), 'utf8');
            } catch {
              return null;
            }
          },
        }),
        recovery: new RecoveryService(client),
        remote: new RemoteService(client, credentials),
        history: new HistoryService(client),
      };
    })();
    cache.set(projectId, built);
    // 建实例失败不应永久污染缓存，否则后续调用会一直拿到同一个 rejected promise
    built.catch(() => cache.delete(projectId));
    return built;
  };

  const requireProject = (params: Record<string, unknown>): string => {
    const projectId = String(params['projectId'] ?? '');
    if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
    return projectId;
  };

  const requireCredentials = (): void => {
    if (options.credentials === null) {
      throw new ShellError(
        'NOT_SUPPORTED',
        '系统加密能力不可用（DPAPI），无法安全保存 Git 凭据；请改用 SSH agent 或先启用系统密钥环。',
      );
    }
  };

  /**
   * 建立安全快照分支并返回分支名。
   *
   * 命名用时间戳 + 序号：同一毫秒内连续两次破坏性操作若撞名，`createBranch` 会失败，
   * 而"快照没建成"绝不能让破坏性操作继续静默执行（那正是快照存在的意义），
   * 因此调用方会把失败写进结构化日志的 warn/error 级，UI 一定看得见。
   */
  let snapshotSeq = 0;
  const createSafetySnapshot = async (
    services: ProjectServices,
    label: string,
  ): Promise<{ branch: string; ok: boolean; message: string }> => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    snapshotSeq += 1;
    const suffix = label.length > 0 ? `-${label.replace(/[^A-Za-z0-9._-]/g, '-')}` : '';
    const branch = `${BACKUP_PREFIX}${stamp}-${snapshotSeq}${suffix}`;
    const created = await services.client.createBranch(branch);
    return {
      branch,
      ok: created.ok,
      message: created.ok
        ? `已建立安全快照分支 ${branch}`
        : `安全快照分支创建失败：${created.error?.message ?? '未知原因'}`,
    };
  };

  /* ------------------------------ 自动提交策略 ------------------------------ */

  const readAutoCommit = (): AutoCommitPolicy =>
    settings.read<AutoCommitPolicy>(AUTO_COMMIT_KEY) ?? { ...DEFAULT_AUTO_COMMIT_POLICY };

  /* ------------------------------ AI 生成提交信息 ------------------------------ */

  /**
   * 用模型生成 Conventional Commits 提交信息。
   *
   * 输入是**本次未提交变更的 diff**（不是整仓历史），并强制经
   * `normalizeAiCommitMessage` 归一化：模型偶尔会包围栏、加解释语、
   * 或用不在白名单里的 type；归一化保证"永远返回合法可用的提交信息"，
   * 而不是把一段没法用的文本交给 UI（FR-GIT-03）。
   */
  const generateCommitMessage = async (
    projectId: string,
    params: Record<string, unknown>,
  ): Promise<GitResult<{ subject: string; body: string; text: string; adjustments: string[] }>> => {
    if (options.aiStack === null) {
      throw new ShellError(
        'NOT_SUPPORTED',
        'AI 生成提交信息需要模型服务：请先在设置页配置 Provider 与 API Key。',
      );
    }
    const services = await servicesOf(projectId);
    const staged = await services.client.diff({ scope: 'staged' });
    const useStaged = staged.ok && (staged.data?.files.length ?? 0) > 0;
    const diff = useStaged ? staged : await services.client.diff({ scope: 'worktree' });
    const patch = renderDiffText(diff.data);
    if (patch.trim().length === 0) {
      throw new ShellError('INVALID_ARGUMENT', '当前没有可提交的变更，无法生成提交信息');
    }
    // 控制提示词体积：diff 过长时只给前若干行，避免把上下文塞爆
    const truncated = patch.split('\n').slice(0, 400).join('\n');
    const convention = String(params['convention'] ?? 'angular');

    let raw = '';
    for await (const chunk of options.aiStack.gateway.chat({
      userId: options.userId,
      purpose: 'commit-message',
      projectId,
      messages: [
        {
          role: 'system',
          content:
            '你是提交信息生成器。只输出一行符合 Conventional Commits 的提交信息' +
            '（`<type>(<scope>): <subject>`），如需补充再输出空行与正文。不要输出解释、不要用代码围栏。',
        },
        { role: 'user', content: `以下是本次变更的 diff：\n\n${truncated}` },
      ],
    })) {
      raw += textOfStreamChunk(chunk).text;
      const commitStreamError = errorOfStreamChunk(chunk);
      if (commitStreamError !== null) {
        throw new ShellError('UNKNOWN', `生成提交信息失败：${commitStreamError}`);
      }
    }

    const normalized = normalizeAiCommitMessage(raw, {
      convention: convention === 'custom' ? 'custom' : 'angular',
      fallbackSubject: '更新生成产物',
      sources: diff.data?.files.map((file) => file.path) ?? [],
    });
    return {
      ok: true,
      data: {
        subject: normalized.message.subject,
        body: normalized.message.body,
        text: normalized.text,
        adjustments: normalized.adjustments,
      },
      logs: diff.logs,
      error: null,
    };
  };

  /* ------------------------------ 冲突解决落盘 ------------------------------ */

  /**
   * 把冲突解决结果经**写入管线**落盘并 `git add` 标记已解决。
   *
   * D-04 的关键点：用户不改代码。因此这里的输入是「每个冲突块采用哪一侧」，
   * 而不是"一段用户手写的文本"。`ai` 策略会真的调用模型合并两侧内容；
   * 组装好的完整文件内容再交给 `WritePipeline`，由它做 before/after 比对与事务写。
   */
  const applyResolution = async (
    projectId: string,
    params: Record<string, unknown>,
  ): Promise<
    GitResult<{
      path: string;
      applied: boolean;
      resolvedBlocks: number;
      strategy: string;
      mergeCommitSha?: string;
    }>
  > => {
    if (options.writeCode === null) {
      throw new ShellError(
        'NOT_SUPPORTED',
        '冲突解决结果必须经 AI 写入管线落盘（D-04：代码视图只读），当前写入端口未装配。',
      );
    }
    const input = (params['input'] ?? {}) as { path?: unknown; choices?: unknown };
    const target = String(input.path ?? '');
    if (target.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少冲突文件路径');

    const services = await servicesOf(projectId);
    // 先确认该路径确实处于冲突中：不接受"随便一个文件"作为解决对象
    const scanned = await services.conflicts.scan();
    if (!scanned.ok || scanned.data === null) {
      return { ok: false, data: null, logs: scanned.logs, error: scanned.error };
    }
    const file = scanned.data.find((entry: ConflictFile) => entry.path === target);
    if (file === undefined) {
      throw new ShellError('NOT_FOUND', `该文件当前不在冲突清单中：${target}`);
    }

    const rawChoices = (input.choices ?? {}) as Record<string, unknown>;
    const choices: Record<number, ResolutionStrategy> = {};
    for (const [key, value] of Object.entries(rawChoices)) {
      const index = Number(key);
      const strategy = String(value) as ResolutionStrategy;
      if (!Number.isInteger(index) || index <= 0) continue;
      if (!['ours', 'theirs', 'both', 'ai'].includes(strategy)) {
        throw new ShellError('INVALID_ARGUMENT', `未知的冲突解决策略：${String(value)}`);
      }
      choices[index] = strategy;
    }
    // 未指定的块默认采用「传入」（合并来源）——与 git 的默认心智一致，且显式写出而非留空
    for (const block of file.blocks) choices[block.index] ??= 'theirs';

    let content: string;
    let strategy = 'choices';
    if (Object.values(choices).includes('ai')) {
      if (options.aiStack === null) {
        throw new ShellError(
          'NOT_SUPPORTED',
          '「交给 AI 合并」需要模型服务：请先在设置页配置 Provider 与 API Key。',
        );
      }
      const request = services.conflicts.buildAiMerge(file);
      let merged = '';
      for await (const chunk of options.aiStack.gateway.chat({
        userId: options.userId,
        purpose: 'merge-conflict',
        projectId,
        messages: [
          { role: 'system', content: request.instruction },
          { role: 'user', content: request.context },
        ],
      })) {
        merged += textOfStreamChunk(chunk).text;
        const mergeStreamError = errorOfStreamChunk(chunk);
        if (mergeStreamError !== null) {
          throw new ShellError('UNKNOWN', `AI 合并失败：${mergeStreamError}`);
        }
      }
      const trimmed = merged.trim();
      if (trimmed.length === 0) {
        // 空结果绝不写盘：那会把冲突标记整段抹掉而内容为空，比留着冲突危险得多
        throw new ShellError('UNKNOWN', 'AI 未返回合并结果，已保持冲突状态（未写入任何内容）。');
      }
      content = trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
      strategy = 'ai';
    } else {
      const resolved = resolveConflictFile(file, choices);
      if (resolved.unresolved > 0) {
        throw new ShellError(
          'INVALID_ARGUMENT',
          `仍有 ${resolved.unresolved} 处冲突未解决，请先为每一块选择处理方式`,
        );
      }
      content = resolved.content;
    }

    // 计划期必须与磁盘现状比对：`before` 就是当前带冲突标记的内容，
    // 应用前 WritePipeline 会再比对一次（两次不一致就会拒绝写入）
    let before: string;
    try {
      before = readFileSync(paths.inside(services.root, target), 'utf8');
    } catch {
      throw new ShellError('NOT_FOUND', `冲突文件无法读取：${target}`);
    }

    const plan = await options.writeCode.plan(
      projectId,
      {
        files: [
          {
            path: target,
            // 冲突文件必然已存在，只能走 patch（`create` 对已存在文件会直接 blocked，
            // 那是 WritePipeline 防"整体覆盖既有实现"的第一道闸门）。
            // 这里生成的是「整文件替换」形态的 unified diff：old 侧为磁盘现状、new 侧为合并结果。
            action: 'patch',
            content: buildFullFilePatch(before, content, target),
            language: languageFromPath(target),
          },
        ],
        anchors: [],
        summary: `解决冲突：${target}`,
        notes: '冲突解决结果由 Git 冲突面板产生，经写入管线事务落盘。',
        decision: {
          referencedMemory: [],
          rationale: '按用户在冲突面板中的选择组装结果文本',
          risks: [],
          uncovered: [],
        },
      },
      // 冲突文件已存在 → 只能是增量补丁模式（与 files[].action='patch' 一致）
      'patch',
    );
    const entry = plan.entries[0];
    if (entry !== undefined && entry.blocked) {
      throw new ShellError(
        'INVALID_ARGUMENT',
        `写入管线拒绝了该冲突解决结果：${entry.blockReason ?? '未给出原因'}`,
      );
    }
    const applied = await options.writeCode.apply(projectId, plan);
    if (!applied.ok) {
      throw new ShellError(
        'IO_ERROR',
        `冲突解决结果写入失败：${applied.error ?? '写入管线拒绝该计划'}`,
      );
    }
    // 落盘成功后才 git add：顺序反了会在写入失败时留下"已标记解决但文件仍是冲突标记"的假状态
    const staged = await services.client.stage([target]);
    // 全部冲突解决完且处于合并中 → 自动生成合并提交（T6-04：解决后自动生成合并提交）。
    // 不自动提交的话，git status 会一直停在"All conflicts fixed but you are still merging"，
    // 用户看到的"变更"永远清不掉，也没法继续回滚 / 切分支。
    let mergeCommitSha: string | null = null;
    const mergeHead = join(services.root, '.git', 'MERGE_HEAD');
    if (existsSync(mergeHead)) {
      const remaining = await services.client.conflictFiles();
      if (remaining.ok && (remaining.data?.length ?? 1) === 0) {
        const committed = await services.client.commit({
          subject: 'merge: 解决冲突后完成合并',
        });
        if (committed.ok) mergeCommitSha = committed.data ?? null;
      }
    }
    return {
      ok: staged.ok,
      data: {
        path: target,
        applied: true,
        resolvedBlocks: file.blocks.length,
        strategy,
        ...(mergeCommitSha !== null ? { mergeCommitSha } : {}),
      },
      logs: [...scanned.logs, ...staged.logs],
      error: staged.error,
    };
  };

  /* ------------------------------ 路由 ------------------------------ */

  const router: DomainRouter = async (method, params, ctx) => {
    // openProject 只校验目录存在，不要求已是 git 仓库（info / init 在其后调用）
    if (method === 'openProject') {
      const projectId = requireProject(params);
      const root = paths.codeRoot(projectId);
      return { projectId, root, exists: existsSync(root) };
    }

    const projectId = requireProject(params);
    const services = await servicesOf(projectId);
    const { client } = services;

    switch (method) {
      case 'info': {
        const status = await client.status();
        const data = status.data;
        return {
          path: services.root,
          name: projectId,
          branch: data?.branch ?? null,
          backendLabel: client.backendLabel(),
          clean: data?.clean ?? true,
          // 领先/落后提交数由 status 直接给出，不再单独推算
          ahead: data?.ahead ?? 0,
          behind: data?.behind ?? 0,
        };
      }

      case 'init': {
        const result = await client.init({
          ...(typeof params['branch'] === 'string' ? { branch: params['branch'] } : {}),
          ...(Array.isArray(params['stacks']) ? { stacks: params['stacks'] as never } : {}),
        });
        // 提交身份兜底：产品承诺"用户永不接触命令行"（FR-SET-08），而全新机器上
        // git 往往没有配置 user.name/email——第一次提交会直接被拒。这里在仓库内
        // 写一份本地身份（只影响本仓库，不动全局配置），已配置过的用户不受影响。
        if (result.ok) {
          const identity = await client.readIdentity();
          if (!identity.ok || identity.data?.name == null || identity.data.name.length === 0) {
            const fallback = await client.setIdentity(
              'EveryoneCoding',
              'local@everyonecoding.local',
            );
            if (fallback.ok) {
              result.logs.push({
                level: 'info',
                message: '本机未配置 Git 提交身份，已为本仓库写入默认身份（EveryoneCoding）',
                at: Date.now(),
              });
            }
          }
        }
        return result;
      }

      /* --------------------------- 变更与提交 --------------------------- */
      case 'status':
        return client.status();
      case 'stage':
        return client.stage((params['paths'] as readonly string[] | undefined) ?? []);
      case 'unstage':
        return client.unstage((params['paths'] as readonly string[] | undefined) ?? []);
      case 'commit': {
        const input = (params['input'] ?? {}) as { subject?: unknown; body?: unknown };
        return client.commit({
          subject: String(input.subject ?? ''),
          ...(typeof input.body === 'string' ? { body: input.body } : {}),
        });
      }

      case 'generateCommitMessage':
        return generateCommitMessage(projectId, params);

      case 'diff': {
        const input = (params['options'] ?? {}) as Record<string, unknown>;
        return client.diff({
          ...(typeof input['scope'] === 'string' ? { scope: input['scope'] as never } : {}),
          ...(typeof input['from'] === 'string' ? { from: input['from'] } : {}),
          ...(typeof input['to'] === 'string' ? { to: input['to'] } : {}),
          ...(typeof input['path'] === 'string' ? { path: input['path'] } : {}),
          ...(typeof input['contextLines'] === 'number'
            ? { contextLines: input['contextLines'] }
            : {}),
        });
      }

      /* --------------------------- 分支与历史 --------------------------- */
      case 'branches':
        return client.branches();
      case 'tags':
        return client.tags();
      case 'createBranch':
        return client.createBranch(
          String(params['name'] ?? ''),
          typeof params['startPoint'] === 'string' ? params['startPoint'] : undefined,
        );
      case 'switchBranch':
        return client.switchBranch(String(params['name'] ?? ''), {
          create: params['create'] === true,
        });
      case 'renameBranch':
        return client.renameBranch(String(params['from'] ?? ''), String(params['to'] ?? ''));

      case 'deleteBranch': {
        // 破坏性：删除前把该分支当前指向的提交固化成 backup/<ts> 快照分支。
        // 分支删掉后除 reflog 之外没有别的找回途径，快照是唯一的常规安全网。
        const name = String(params['name'] ?? '');
        const branches = await client.branches();
        const victim = branches.data?.find((branch) => branch.name === name) ?? null;
        const snapshot =
          victim?.lastCommitSha != null && !name.startsWith(BACKUP_PREFIX)
            ? await createSafetySnapshot(services, name)
            : null;
        const deleted = await client.deleteBranch(name, { force: params['force'] === true });
        if (snapshot !== null) {
          deleted.logs.push({
            level: snapshot.ok ? 'info' : 'warn',
            message: snapshot.message,
            at: Date.now(),
          });
        }
        return deleted;
      }

      case 'log': {
        const input = (params['options'] ?? {}) as Record<string, unknown>;
        return client.log({
          ...(typeof input['limit'] === 'number' ? { limit: input['limit'] } : {}),
          ...(typeof input['skip'] === 'number' ? { skip: input['skip'] } : {}),
          ...(typeof input['path'] === 'string' ? { path: input['path'] } : {}),
          ...(typeof input['author'] === 'string' ? { author: input['author'] } : {}),
          ...(typeof input['keyword'] === 'string' ? { keyword: input['keyword'] } : {}),
          ...(typeof input['ref'] === 'string' ? { ref: input['ref'] } : {}),
        });
      }

      case 'commitDetail':
        return services.history.detail(String(params['sha'] ?? ''));

      /* --------------------------- 合并 / 冲突 / 回滚 --------------------------- */
      case 'previewMerge':
        return services.merge.preview(
          String(params['source'] ?? ''),
          String(params['target'] ?? ''),
        );

      case 'merge': {
        const input = (params['options'] ?? {}) as Record<string, unknown>;
        // backup 默认开启：不做成可关闭的开关，否则破坏性操作就没有安全网
        return services.merge.execute(String(params['source'] ?? ''), {
          backup: input['backup'] !== false,
          noFf: input['noFf'] === true,
          ...(typeof input['message'] === 'string' ? { message: input['message'] } : {}),
        });
      }

      case 'rebase': {
        const input = (params['options'] ?? {}) as Record<string, unknown>;
        return services.merge.rebase(String(params['onto'] ?? ''), {
          backup: input['backup'] !== false,
        });
      }

      case 'abort':
        return services.conflicts.abort(params['kind'] === 'rebase' ? 'rebase' : 'merge');

      case 'conflicts':
        return services.conflicts.scan();

      case 'requestAiMerge': {
        const input = (params['input'] ?? {}) as { path?: unknown; blockIndex?: unknown };
        const scanned = await services.conflicts.scan();
        if (!scanned.ok || scanned.data === null) return scanned;
        const file = scanned.data.find((entry: ConflictFile) => entry.path === input['path']);
        if (file === undefined) {
          return {
            ok: false,
            data: null,
            logs: scanned.logs,
            error: {
              code: 'NOT_FOUND',
              message: `未在冲突清单中找到：${String(input['path'] ?? '')}`,
            },
          };
        }
        const index = typeof input['blockIndex'] === 'number' ? input['blockIndex'] : undefined;
        const block = index === undefined ? undefined : file.blocks[index];
        return {
          ok: true,
          data: services.conflicts.buildAiMerge(file, block),
          logs: scanned.logs,
          error: null,
        };
      }

      case 'applyResolution':
        return applyResolution(projectId, params);

      case 'stashList':
        return client.stashList();
      case 'stashPush':
        return client.stashPush(
          typeof params['message'] === 'string' ? params['message'] : undefined,
        );
      case 'stashApply':
        return client.stashApply(Number(params['index']), { drop: params['drop'] === true });
      case 'stashDrop':
        return client.stashDrop(Number(params['index']));

      case 'rollbackPlan': {
        const input = (params['input'] ?? {}) as { sha?: unknown; mode?: unknown };
        return services.recovery.plan({
          sha: String(input.sha ?? ''),
          mode: (input.mode ?? 'revert') as RollbackMode,
        });
      }

      case 'rollbackExecute': {
        // 二次确认：渲染层已弹过对话框，但主进程不采信"UI 自觉"——
        // 计划里带回 `confirmed` 才算数（RecoveryService 内部也会再校验一次）。
        const plan = params['plan'] as RollbackPlan | undefined;
        if (plan === undefined || plan === null) {
          throw new ShellError('INVALID_ARGUMENT', 'rollbackExecute 需要回滚计划（plan）');
        }
        // RecoveryService.execute 自带 backup 分支创建，两处叠加是刻意的：
        // 回滚是唯一会改写 HEAD 的操作，安全网少一层都不划算。
        return services.recovery.execute(plan, { confirmed: params['confirmed'] === true });
      }

      case 'snapshots':
        return services.recovery.listSnapshots();

      /* --------------------------- 远程 --------------------------- */
      case 'remotes':
        return services.remote.list();
      case 'addRemote':
        return services.remote.add(String(params['name'] ?? ''), String(params['url'] ?? ''));
      case 'editRemote':
        return services.remote.edit(String(params['name'] ?? ''), String(params['url'] ?? ''));
      case 'removeRemote':
        return services.remote.remove(String(params['name'] ?? ''));
      case 'testRemote':
        return services.remote.test(String(params['name'] ?? ''));

      case 'push':
      case 'pull':
      case 'fetch': {
        const input = (params['input'] ?? {}) as Record<string, unknown>;
        // 推送/拉取进度不通过回调穿越进程边界（结构化克隆会抛错），
        // 一律经域事件回流；percent 由各阶段自行判定，未知时给 null 让 UI 走不确定进度。
        const onProgress = (event: {
          phase: string;
          message: string;
          percent: number | null;
        }): void => {
          ctx.emit({ type: 'git:progress', ...event });
        };
        if (method === 'push') {
          const force = input['force'] === true || input['forceWithLease'] === true;
          // 强制推送会改写远端历史：本地先固化一份快照分支。
          // 远端被覆盖的部分本地找不回，但至少保证"当前本地状态"可复现，便于比对与重推。
          const snapshot = force ? await createSafetySnapshot(services, 'force-push') : null;
          const pushed = await services.remote.push(
            {
              ...(typeof input['remote'] === 'string' ? { remote: input['remote'] } : {}),
              ...(typeof input['branch'] === 'string' ? { branch: input['branch'] } : {}),
              force: input['force'] === true,
              forceWithLease: input['forceWithLease'] === true,
            },
            onProgress,
          );
          if (snapshot !== null) {
            pushed.logs.push({
              level: snapshot.ok ? 'warn' : 'error',
              message: snapshot.message,
              at: Date.now(),
            });
          }
          return pushed;
        }
        if (method === 'pull') {
          return services.remote.pull(
            {
              ...(typeof input['remote'] === 'string' ? { remote: input['remote'] } : {}),
            },
            onProgress,
          );
        }
        return services.remote.fetch(
          {
            ...(typeof input['remote'] === 'string' ? { remote: input['remote'] } : {}),
            prune: input['prune'] === true,
          },
          onProgress,
        );
      }

      /* --------------------------- 凭据（DPAPI） --------------------------- */
      case 'credentialBindings': {
        requireCredentials();
        return services.remote.listCredentialBindings();
      }

      case 'saveHttpsCredential': {
        requireCredentials();
        const input = (params['input'] ?? {}) as Record<string, unknown>;
        const token = String(input['token'] ?? '');
        if (token.length === 0) throw new ShellError('INVALID_ARGUMENT', '令牌不能为空');
        const remoteName = String(input['remoteName'] ?? '');
        if (remoteName.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少远程名');
        await services.remote.saveHttpsCredential({
          remoteName,
          username: String(input['username'] ?? 'x-access-token'),
          token,
        });
        // 返回值里**绝不含令牌**，连长度都不给——长度也是可被利用的信息
        return { saved: true, remoteName, kind: 'https' };
      }

      case 'saveSshCredential': {
        requireCredentials();
        const input = (params['input'] ?? {}) as Record<string, unknown>;
        const keyPath = String(input['privateKeyPath'] ?? '');
        if (keyPath.length === 0) throw new ShellError('INVALID_ARGUMENT', '私钥路径不能为空');
        const remoteName = String(input['remoteName'] ?? '');
        if (remoteName.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少远程名');
        const passphrase = typeof input['passphrase'] === 'string' ? input['passphrase'] : null;
        await services.remote.saveSshCredential({
          remoteName,
          privateKeyPath: keyPath,
          passphrase,
        });
        return {
          saved: true,
          remoteName,
          kind: 'ssh',
          passphraseStored: passphrase !== null && passphrase.length > 0,
        };
      }

      case 'removeCredential': {
        requireCredentials();
        const remoteName = String(params['remoteName'] ?? '');
        await services.remote.removeCredential(remoteName);
        return { removed: true, remoteName };
      }

      /* --------------------------- 策略与来源 --------------------------- */
      case 'autoCommitPolicy':
        return readAutoCommit();
      case 'setAutoCommitPolicy': {
        const policy = params['policy'] as AutoCommitPolicy | undefined;
        if (policy === undefined || policy === null) {
          throw new ShellError('INVALID_ARGUMENT', '缺少自动提交策略');
        }
        settings.write(AUTO_COMMIT_KEY, policy);
        return undefined;
      }
      case 'changeSources':
        // 暂无来源追踪装配：变更来源由 AI 任务/重命名/迁移各自写入，
        // 属各自任务的后续批次；此处返回空表而不是编造来源。
        return {};

      default:
        throw new ShellError('INVALID_ARGUMENT', `git 域未知方法：${method}`);
    }
  };

  return router;
}

/** 语言标记（写入管线用；与 code 域的语言表同一口径，缺省 plaintext） */
function languageFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'));
  const table: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.json': 'json',
    '.md': 'markdown',
    '.css': 'css',
    '.html': 'html',
    '.sql': 'sql',
  };
  return table[ext] ?? 'plaintext';
}

/** 把（已解析的）diff 还原成可读补丁文本，供提交信息提示词使用 */
function renderDiffText(diff: GitDiff | null): string {
  if (diff === null || diff.files.length === 0) return '';
  const parts: string[] = [];
  for (const file of diff.files) {
    parts.push(`--- ${file.oldPath ?? file.path}`);
    parts.push(`+++ ${file.path} (${file.status}, +${file.additions} -${file.deletions})`);
    if (file.binary || file.skipped) {
      parts.push(file.skipReason ?? '(二进制或被跳过的文件)');
      continue;
    }
    for (const hunk of file.hunks) {
      parts.push(hunk.header);
      for (const line of hunk.lines) {
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        parts.push(`${sign}${line.text}`);
      }
    }
  }
  return parts.join('\n');
}

/**
 * 生成「整文件替换」形态的 unified diff。
 *
 * 为什么不能直接给 WritePipeline 全量内容：`create` 策略对**已存在的文件**会直接
 * blocked（那是防"静默覆盖他人实现"的第一道闸门），所以修改已存在文件只能走 `patch`。
 * 冲突文件的解决结果本身就是"一次性替换整份内容"，用等价的整文件 hunk 表达即可：
 * old 侧是所有原行、new 侧是所有新行，`applyHunk` 按序列匹配后整体替换。
 */
function buildFullFilePatch(before: string, after: string, filePath: string): string {
  const normalize = (text: string): string[] => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = normalize(before);
  const newLines = normalize(after);
  const body = [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)];
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...body,
  ].join('\n');
}
