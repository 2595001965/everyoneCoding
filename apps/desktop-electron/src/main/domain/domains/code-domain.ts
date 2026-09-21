import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';

import {
  AnchorRepository,
  OUTPUT_CONTRACT_TEXT,
  createWritePipeline,
  parseGenerationOutput,
  shouldIgnorePath,
  type AnchorPersistencePort,
  type CodeAnchorRow,
  type GenerationOutput,
  type WriteMode,
  type WritePlan,
  type WriteResult,
  type WorkspaceFileSystem,
} from '@ec/ai';
import { ShellError } from '@ec/shell-api';

import type { DomainRouter } from '../runtime';
import type { AiStackHandle } from '../domain-factories';

/**
 * code 域生产路由（T12-02 代码视图 + WritePipeline）。
 *
 * 三条边界（与 D-04 / FR-AI-11 对齐）：
 *
 * 1. **只读两条**：`listFiles` / `readFile` 从 `<projectsDir>/<projectId>/code` 真实读取。
 *    本域**不提供**任何"保存代码"方法 —— 用户侧的修改诉求只能走 `requestRework`。
 * 2. **写入只有一条路**：`plan → preview → apply`，全部由 `@ec/ai` 的 `WritePipeline` 承载
 *    （计划期算 before/after、应用前重新比对磁盘做冲突检测、任一步失败整体回滚）。
 *    域内不自己拼 diff，也不接受调用方塞入任意文本 —— 否则"代码只由 AI 写入"就成了口号。
 * 3. **外部改动必须被看见**：`ExternalChangeWatcher` 监听代码根（排除 .git / node_modules /
 *    dist 等），AI 自身写入经 `suppress` 抑制回响，检测结果经域事件回流渲染层。
 *
 * requestRework 是"AI 重改"的真正入口：真实模型调用 → 输出契约解析 → `WritePipeline.plan()`
 * 生成计划 → 计划经域事件交给 UI 预览，由用户确认后调用 `apply`。
 * AI 栈未装配时如实报 NOT_SUPPORTED 并给出可执行引导，不伪造生成结果。
 */

/**
 * 代码写入端口（T12-04）。
 *
 * 为什么需要它：冲突解决、重命名事务的代码栏、外部改动回滚都必须**经由同一个
 * WritePipeline** 落盘（D-04：代码只由 AI 写入）。让 git / rename 域各自写文件
 * 会把"唯一写入口"变成三份，任何一份漏掉"应用前重新比对磁盘"的冲突检测，
 * 都会静默覆盖用户的磁盘状态。
 *
 * 端口只暴露 plan / apply 两个动作，**不暴露 fs**：
 * 调用方拿不到直接写文件的能力，只能走计划与事务。
 */
export interface CodeWritePort {
  /** 生成结果 → 写入计划（只算不落盘） */
  plan(projectId: string, output: GenerationOutput, mode?: WriteMode): Promise<WritePlan>;
  /** 应用计划（事务写 + 锚点写回） */
  apply(projectId: string, plan: WritePlan): Promise<WriteResult>;
}

export interface CodeDomainOptions {
  db: Database.Database;
  projectsDir: string;
  /** 非请求来源事件（外部改动监视器）：域标识由调用方显式给出 */
  emit: (domain: 'code', payload: unknown) => void;
  aiStack: AiStackHandle | null;
  userId: string;
}

const LANG_BY_EXT: Record<string, string> = {
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

/** 单次生成的上限（防止一次模型输出把工程目录写爆） */
const MAX_GENERATED_FILES = 40;

export function createCodeDomain(options: CodeDomainOptions): {
  router: DomainRouter;
  dispose: () => Promise<void>;
  /** 供 git（冲突落盘）与 rename（代码栏）复用的唯一写入口 */
  writePort: CodeWritePort;
} {
  const { db } = options;
  const watchHandles = new Map<string, { close: () => void }>();
  const suppressed = new Map<string, number>();
  /** AI 自身写入的抑制窗口（毫秒）：文件监听会把刚写的文件也报成 modify */
  const SUPPRESS_WINDOW_MS = 1_500;

  const codeRootOf = (projectId: string): string => {
    const base = resolve(join(options.projectsDir, projectId, 'code'));
    if (!base.startsWith(resolve(options.projectsDir) + sep)) {
      throw new ShellError('INVALID_ARGUMENT', '非法项目标识');
    }
    return base;
  };

  const listFilesRecursive = (current: string, depth = 0): string[] => {
    if (depth > 12 || !existsSync(current)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (shouldIgnorePath(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) out.push(...listFilesRecursive(full, depth + 1));
      else out.push(full.slice(current.length + 1).replace(/\\/g, '/'));
    }
    return out;
  };

  /* ------------------------------ 文件系统端口（WritePipeline 用） ------------------------------ */

  const relativeOf = (root: string, path: string): string => {
    const full = resolve(join(root, path));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new ShellError('INVALID_ARGUMENT', `路径越界，已拒绝访问：${path}`);
    }
    return full;
  };

  const fsOf = (root: string): WorkspaceFileSystem => ({
    async readText(path) {
      const full = relativeOf(root, path);
      return existsSync(full) ? readFileSync(full, 'utf8') : null;
    },
    async writeAtomic(path, content) {
      const full = relativeOf(root, path);
      const dir = full.slice(0, Math.max(full.lastIndexOf(sep), full.lastIndexOf('/')));
      if (dir.length > 0 && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      // 原子替换：临时文件 + rename（NFR-R-02）。fsync 后再 rename，
      // 保证崩溃时不会留下"长度为 0 的正常文件名"。
      const tmpRel = `${path}.ec-tmp`;
      const tmp = `${full}.ec-tmp`;
      // 抑制要在写入**之前**生效：文件监听器对本进程的 create/rename 同样会报事件，
      // 只抑制最终路径会漏掉临时文件的 create（实测会刷出多条"外部改动"假警报）。
      suppress(path);
      suppress(tmpRel);
      const fd = openSync(tmp, 'w');
      try {
        writeFileSync(fd, content, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, full);
    },
    async exists(path) {
      return existsSync(relativeOf(root, path));
    },
    async remove(path) {
      const full = relativeOf(root, path);
      suppress(path);
      if (existsSync(full)) rmSync(full, { force: true });
    },
    async stat(path) {
      const full = relativeOf(root, path);
      if (!existsSync(full)) return null;
      const stat = statSync(full);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    async mkdir(path) {
      const full = relativeOf(root, path);
      if (!existsSync(full)) mkdirSync(full, { recursive: true });
    },
  });

  /* ------------------------------ 外部改动监视 ------------------------------ */

  function suppress(path: string): void {
    suppressed.set(path.replace(/\\/g, '/'), Date.now() + SUPPRESS_WINDOW_MS);
  }

  const isSuppressed = (path: string): boolean => {
    const key = path.replace(/\\/g, '/');
    const until = suppressed.get(key);
    if (until === undefined) return false;
    if (until < Date.now()) {
      suppressed.delete(key);
      return false;
    }
    return true;
  };

  interface FileStamp {
    size: number;
    mtimeMs: number;
  }

  /** 可被外部改动检测关注的源码文件（与 listFiles 的语言白名单一致） */
  const isTrackedFile = (rel: string): boolean => LANG_BY_EXT[extname(rel)] !== undefined;

  /** 递归扫描代码根的「路径 → 大小 / mtime」索引（有界深度，忽略构建产物） */
  const scanIndex = (
    root: string,
    current: string,
    depth = 0,
    out = new Map<string, FileStamp>(),
  ): Map<string, FileStamp> => {
    if (depth > 8 || !existsSync(current)) return out;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (shouldIgnorePath(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        scanIndex(root, full, depth + 1, out);
        continue;
      }
      const rel = full.slice(root.length + 1).replace(/\\/g, '/');
      if (!isTrackedFile(rel)) continue;
      try {
        const stat = statSync(full);
        out.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 扫描期间被删除：跳过，下一次扫描会把它当成"移除"
      }
    }
    return out;
  };

  /**
   * 外部改动检测：**事件只当触发器，真相来自索引比对**。
   *
   * 为什么不能直接用 `fs.watch` 给的 `filename`：Windows 的 ReadDirectoryChangesW
   * 对"目录内文件被修改"经常只报**目录名**（实测本机对 `src/a.ts` 的写入报成 `src`），
   * 文件名时有时无，且同一个写入会重复上报。若直接采信，UI 会收到
   * "代码已被外部修改（src）"这类无意义提示，同时真正改动的文件反而被漏掉。
   * 索引比对给出的是精确的相对路径，且天然过滤掉临时文件与自身写入（抑制窗口）。
   */
  const startWatcher = (projectId: string): void => {
    if (watchHandles.has(projectId)) return;
    const root = codeRootOf(projectId);
    if (!existsSync(root)) return;
    let index = scanIndex(root, root);
    let timer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      timer = null;
      const next = scanIndex(root, root);
      const changed: string[] = [];
      for (const [rel, stamp] of next) {
        const previous = index.get(rel);
        if (
          previous === undefined ||
          previous.size !== stamp.size ||
          previous.mtimeMs !== stamp.mtimeMs
        ) {
          changed.push(rel);
        }
      }
      for (const rel of index.keys()) if (!next.has(rel)) changed.push(rel);
      index = next;
      for (const rel of changed) {
        if (isSuppressed(rel)) continue;
        options.emit('code', {
          type: 'code:external-change',
          path: rel,
          changeType: next.has(rel) ? 'modify' : 'remove',
          message: `代码已被外部修改（${rel}），建议回滚到最近提交或让 AI 重新生成。`,
        });
      }
    };
    try {
      const handle = watch(root, { recursive: true }, () => {
        // 事件是高频的（一次写入可触发数条），合并到一个短窗口里做一次索引比对
        if (timer !== null) return;
        timer = setTimeout(flush, 250);
      });
      watchHandles.set(projectId, {
        close: () => {
          if (timer !== null) clearTimeout(timer);
          handle.close();
        },
      });
    } catch {
      // 目录不可监听：静默降级（无外部改动检测），不炸装配
    }
  };

  /* ------------------------------ 锚点写回 ------------------------------ */

  const anchorRepos = new Map<string, AnchorRepository>();

  const anchorRepoOf = (projectId: string): AnchorRepository => {
    const cached = anchorRepos.get(projectId);
    if (cached !== undefined) return cached;

    const persistence: AnchorPersistencePort = {
      load: ({ projectId: pid }) =>
        db
          .prepare(`SELECT * FROM code_anchor WHERE project_id = ?`)
          .all(pid) as unknown as CodeAnchorRow[],
      save: ({ projectId: pid, rows }) => {
        const replace = db.transaction((next: readonly CodeAnchorRow[]) => {
          db.prepare(`DELETE FROM code_anchor WHERE project_id = ?`).run(pid);
          const insert = db.prepare(
            `INSERT INTO code_anchor (id, project_id, element_id, page_id, feature_id, file_path, symbol, start_line, end_line, kind, commit_sha, created_at, updated_at)
             VALUES (@id, @project_id, @element_id, @page_id, @feature_id, @file_path, @symbol, @start_line, @end_line, @kind, @commit_sha, @created_at, @updated_at)`,
          );
          for (const row of next) insert.run(row);
        });
        replace(rows);
      },
    };

    const repo = new AnchorRepository({ projectId, persistence });
    repo.hydrate(
      db
        .prepare(`SELECT * FROM code_anchor WHERE project_id = ?`)
        .all(projectId) as unknown as CodeAnchorRow[],
    );
    anchorRepos.set(projectId, repo);
    return repo;
  };

  /* ------------------------------ 装配 ------------------------------ */

  const pipelines = new Map<string, ReturnType<typeof createWritePipeline>>();
  const pipelineOf = (projectId: string): ReturnType<typeof createWritePipeline> => {
    const cached = pipelines.get(projectId);
    if (cached !== undefined) return cached;
    const root = codeRootOf(projectId);
    const pipeline = createWritePipeline({ fs: fsOf(root) });
    pipelines.set(projectId, pipeline);
    return pipeline;
  };

  /**
   * 应用写入计划（含锚点写回）。
   *
   * 路由的 `apply` 与 `CodeWritePort.apply` 共用这一段：冲突解决 / 重命名事务
   * 落盘时也必须享受同一套事务与锚点维护，否则"改完代码 Ctrl+点击失效"会
   * 以"偶发"的形态长期存在。
   */
  const applyPlan = async (projectId: string, plan: WritePlan): Promise<WriteResult> => {
    const root = codeRootOf(projectId);
    const result = await pipelineOf(projectId).apply(plan);
    if (result.ok && plan.anchors.length > 0) {
      // T4-05 要点 6：写入后 Code Anchor 写回（AST 校验 + 注释标记校验都在仓库里）
      anchorRepoOf(projectId).register({
        declarations: plan.anchors,
        readFile: (path) => {
          const full = join(root, path);
          return existsSync(full) ? readFileSync(full, 'utf8') : null;
        },
      });
    }
    return result;
  };

  const writePort: CodeWritePort = {
    plan: (projectId, output, mode) =>
      pipelineOf(projectId).plan({
        output,
        mode: mode ?? 'preview',
      }),
    apply: (projectId, plan) => applyPlan(projectId, plan),
  };

  const dispose = async (): Promise<void> => {
    for (const handle of watchHandles.values()) {
      try {
        handle.close();
      } catch {
        // 忽略关闭失败：进程退出路径不应被监听器拖住
      }
    }
    watchHandles.clear();
  };

  const router: DomainRouter = async (method, params) => {
    const projectId = String(params['projectId'] ?? '');
    if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
    const root = codeRootOf(projectId);
    startWatcher(projectId);

    switch (method) {
      case 'listFiles': {
        if (!existsSync(root)) return [];
        return listFilesRecursive(root)
          .filter((rel) => LANG_BY_EXT[extname(rel)] !== undefined)
          .map((rel) => ({ path: rel, language: LANG_BY_EXT[extname(rel)] ?? 'plaintext' }));
      }

      case 'readFile': {
        const rel = String(params['path'] ?? '');
        const target = join(root, rel);
        if (!target.startsWith(root + sep)) {
          throw new ShellError('INVALID_ARGUMENT', '路径越界，已拒绝读取');
        }
        if (!existsSync(target)) throw new ShellError('NOT_FOUND', `文件不存在：${rel}`);
        return readFileSync(target, 'utf8');
      }

      /* --------- 写入三段式：plan（只算不落）→ apply（事务写） --------- */

      case 'plan': {
        const input = params['output'] as GenerationOutput | undefined;
        const mode = (params['mode'] ?? 'preview') as WriteMode;
        if (input === undefined || input === null) {
          throw new ShellError('INVALID_ARGUMENT', 'plan 需要生成结果（output）');
        }
        if (input.files.length > MAX_GENERATED_FILES) {
          throw new ShellError(
            'INVALID_ARGUMENT',
            `单次生成文件数超限（${input.files.length} > ${MAX_GENERATED_FILES}），请拆分后重试`,
          );
        }
        const noteIds = params['noteIds'] as readonly string[] | undefined;
        return pipelineOf(projectId).plan({
          output: input,
          mode,
          ...(noteIds !== undefined ? { noteIds } : {}),
        });
      }

      case 'apply': {
        const plan = params['plan'] as WritePlan | undefined;
        if (plan === undefined || plan === null) {
          throw new ShellError('INVALID_ARGUMENT', 'apply 需要写入计划（plan）');
        }
        // 计划只在同一进程内产生，跨调用重放时由 WritePipeline 的 before 比对兜底
        return applyPlan(projectId, plan);
      }

      /* --------- AI 重改：真实模型 → 输出契约 → WritePipeline.plan --------- */

      case 'requestRework': {
        const request = (params['request'] ?? {}) as {
          instruction?: unknown;
          context?: unknown;
          paths?: unknown;
        };
        const instruction = typeof request.instruction === 'string' ? request.instruction : '';
        if (instruction.trim().length === 0) {
          throw new ShellError('INVALID_ARGUMENT', 'AI 重改需要重改要求（instruction）');
        }
        if (options.aiStack === null) {
          throw new ShellError(
            'NOT_SUPPORTED',
            'AI 栈未装配：请先在设置页配置模型服务与 API Key，再使用「交给 AI 修改」。代码视图本身是只读的（D-04）。',
          );
        }
        const contextText = typeof request.context === 'string' ? request.context : '';
        let raw = '';
        for await (const chunk of options.aiStack.gateway.chat({
          userId: options.userId,
          purpose: 'code',
          projectId,
          messages: [
            {
              role: 'system',
              content: `${OUTPUT_CONTRACT_TEXT}\n\n你正在按用户要求重改已有代码。`,
            },
            {
              role: 'user',
              content: [instruction, '', '当前差异（供你定位）：', contextText].join('\n'),
            },
          ],
        })) {
          if (chunk.type === 'chunk' && typeof chunk.text === 'string') raw += chunk.text;
          if (chunk.type === 'error') {
            throw new ShellError('UNKNOWN', `重改生成失败：${String(chunk['error'] ?? '')}`);
          }
        }

        const output = parseGenerationOutput(extractJson(raw));
        if (output === null) {
          throw new ShellError(
            'UNKNOWN',
            '模型输出不符合输出契约，无法生成补丁（已保留原始输出供查看，请重试或调整描述）。',
          );
        }
        const plan = await pipelineOf(projectId).plan({ output, mode: 'preview' });
        options.emit('code', {
          type: 'code:write-plan',
          projectId,
          plan,
          source: 'rework',
        });
        return undefined;
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `code 域未知方法：${method}`);
    }
  };

  return { router, dispose, writePort };
}

/**
 * 从模型输出里取 JSON 对象。
 *
 * 与 `@ec/ai` 的解析器同一口径：先去掉 Markdown 围栏，再取第一个 `{` 到最后一个 `}` 的切片。
 * 需要它的原因：重改走的是"自由文本 + 输出契约"，模型偶尔仍会包一层围栏或加一句说明。
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}
