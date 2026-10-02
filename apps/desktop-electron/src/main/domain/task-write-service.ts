import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  createWritePipeline,
  type GenerationOutput,
  type WriteApplyGuard,
  type WriteMode,
  type WritePlan,
  type WritePlanEntry,
  type WriteResult,
} from '@ec/ai';
import type { GitBackend } from '@ec/git';
import { createProjectPaths, isSafeProjectId } from './paths';
import { contentHash, saveTaskJson, taskFileSystem, taskInventory } from './task-file-system';

/** D06 的数据域 owner；本模块不再创建另一份协调器或进程间租约。 */
export interface TaskWriteOwner {
  assertOwner(): void;
  fencingToken(): number;
  /** D06 BEGIN IMMEDIATE 持有 fencing 检查直到同步磁盘动作结束。 */
  write<T>(action: () => T): T;
}

export interface TaskWriteSpec {
  taskId?: string;
  projectId: string;
  objective: string;
  /** dirty Git 必须显式选择；current 会复制未提交差异，不碰 index/stash。 */
  baseline?: 'head' | 'current';
  readSet?: string[];
  writeSet: string[];
  contractPaths?: string[];
  /** 未隔离的数据库等资源；同一资源的任务在启动前即拒绝重叠。 */
  sharedResources?: string[];
}

export interface TaskTestEvidence {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TaskWriteRecord {
  taskId: string;
  projectId: string;
  objective: string;
  root: string;
  copyRoot: string;
  worktreeRoot: string | null;
  repositoryRoot: string | null;
  dataDir: string;
  baseline: 'head' | 'current';
  baseRevision: { head: string | null; hash: string };
  readSet: string[];
  writeSet: string[];
  contracts: Record<string, string | null>;
  baselineHashes: Record<string, string>;
  resources: string[];
  state:
    | 'creating'
    | 'running'
    | 'awaiting_confirmation'
    | 'queued'
    | 'applying'
    | 'merged'
    | 'failed'
    | 'conflicted'
    | 'cancelled'
    | 'cleaned';
  revision: number;
  fencingToken: number;
  createdAt: number;
  updatedAt: number;
  plan: WritePlan | null;
  journal: WritePlanEntry[];
  result: WriteResult | null;
  conflicts: Array<{
    path: string;
    reason: string;
    base: string | null;
    ours: string | null;
    theirs: string | null;
  }>;
  tests: TaskTestEvidence[];
  log: Array<{ at: number; event: string; fencingToken: number }>;
}

export interface TaskWriteServiceOptions {
  storageDir: string;
  codeRoot(projectId: string): string;
  owner: TaskWriteOwner;
  git: GitBackend;
  /** 合入后运行受影响验证；失败仍在 WritePipeline 事务内补偿。 */
  validate(root: string, changed: string[], task: TaskWriteRecord): Promise<TaskTestEvidence[]>;
  emit?(task: TaskWriteRecord): void;
  /** 与 D06 实体持久化衔接，不从本服务发模型请求。 */
  onTask?(task: TaskWriteRecord): void;
}

const ACTIVE = new Set<TaskWriteRecord['state']>([
  'creating',
  'running',
  'awaiting_confirmation',
  'queued',
  'applying',
  'conflicted',
]);
const managedResource = (path: string): string[] => {
  if (/(?:^|\/)(?:[^/]*lock[^/]*|package\.json|Cargo\.toml|go\.mod)$/.test(path))
    return ['dependencies'];
  if (/(?:^|\/)(?:migrations?|ddl)(?:\/|$)|(?:^|\/)schema\.(?:sql|prisma)$/i.test(path))
    return ['database-schema'];
  if (/(?:^|\/)(?:generated|__generated__)(?:\/|$)/.test(path)) return ['generated'];
  return [];
};

/** V2-D07：工作副本/合入队列是既有 WritePipeline 的宿主事务适配器。 */
export class TaskWriteService {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly paths;
  constructor(private readonly options: TaskWriteServiceOptions) {
    this.paths = createProjectPaths({ projectsDir: options.storageDir });
    mkdirSync(options.storageDir, { recursive: true });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      this.options.owner.assertOwner();
      return work();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private taskDir(id: string): string {
    if (!isSafeProjectId(id)) throw new Error('非法任务标识');
    return this.paths.inside(this.options.storageDir, id);
  }
  private save(task: TaskWriteRecord, event: string): void {
    this.options.owner.assertOwner();
    task.revision += 1;
    task.updatedAt = Date.now();
    task.fencingToken = this.options.owner.fencingToken();
    task.log.push({ at: task.updatedAt, event, fencingToken: task.fencingToken });
    this.options.owner.write(() =>
      saveTaskJson(join(this.taskDir(task.taskId), 'task.json'), task),
    );
    // 先持久化文件事务；实体/事件发布失败不会把已完成文件事务回滚成未知状态。
    try {
      this.options.onTask?.(structuredClone(task));
      this.options.emit?.(structuredClone(task));
    } catch {
      /* 已持久化的任务可由快照恢复事件，观察者不能使文件事务失败。 */
    }
  }

  get(id: string): TaskWriteRecord {
    const task = JSON.parse(
      readFileSync(join(this.taskDir(id), 'task.json'), 'utf8'),
    ) as TaskWriteRecord;
    if (task.taskId !== id || resolve(task.root) !== resolve(this.options.codeRoot(task.projectId)))
      throw new Error('任务持久化源码根与授权项目不一致');
    const directory = resolve(this.taskDir(id));
    if (![task.copyRoot, task.dataDir].every((path) => resolve(path).startsWith(directory + sep)))
      throw new Error('任务副本越出管理目录');
    return task;
  }
  list(projectId?: string): TaskWriteRecord[] {
    return readdirSync(this.options.storageDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          isSafeProjectId(entry.name) &&
          existsSync(join(this.taskDir(entry.name), 'task.json')),
      )
      .map((entry) => this.get(entry.name))
      .filter((task) => projectId === undefined || task.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  create(spec: TaskWriteSpec): Promise<TaskWriteRecord> {
    return this.serial(async () => {
      const taskId = spec.taskId ?? randomUUID();
      const directory = this.taskDir(taskId);
      if (existsSync(join(directory, 'task.json')))
        throw new Error('任务工作副本已存在，不能重复创建');
      const root = resolve(this.options.codeRoot(spec.projectId));
      const sourcePaths = createProjectPaths({ projectsDir: root });
      const normalize = (values: string[]): string[] => [
        ...new Set(
          values.map((path) => {
            sourcePaths.inside(root, path);
            if (path.length === 0 || path.includes('\\') || path.split('/').includes('.'))
              throw new Error('依赖必须是精确 POSIX 相对文件路径');
            if (
              /(?:^|\/)(?:\.git|node_modules)(?:\/|$)|(?:^|\/)\.env(?!\.example$)|\.ec-tmp-/i.test(
                path,
              )
            )
              throw new Error('禁止写入工作副本管理目录或本机环境值');
            return path;
          }),
        ),
      ];
      const writeSet = normalize(spec.writeSet);
      if (writeSet.length === 0) throw new Error('写任务必须声明允许写集');
      const resources = [
        ...new Set([
          ...writeSet.flatMap(managedResource),
          ...(spec.sharedResources ?? []).map((resource) => `shared:${resource}`),
        ]),
      ];
      for (const other of this.list(spec.projectId)) {
        if (
          ACTIVE.has(other.state) &&
          resources.some((resource) => other.resources.includes(resource))
        ) {
          throw new Error(`排他资源由任务 ${other.taskId} 使用，请先完成或取消该任务`);
        }
      }
      mkdirSync(root, { recursive: true });
      // 非 Git 不调用 init；Git 没有提交时用隔离副本保留用户现场。
      const isRepo = await this.options.git.isRepo(root);
      const head = isRepo ? await this.options.git.headSha(root) : null;
      const dirty = isRepo && (await this.options.git.status(root)).length > 0;
      if (head !== null && dirty && spec.baseline === undefined)
        throw new Error('仓库含未提交修改，请显式选择 HEAD 或当前目录基线');
      const baseline = spec.baseline ?? 'current';
      if (baseline === 'head' && head === null) throw new Error('此项目没有可用的 HEAD 基线');
      const originalHashes = taskInventory(root);
      let copyRoot = join(directory, 'code');
      const repositoryRoot =
        head !== null && this.options.git.repositoryRoot !== undefined
          ? resolve(await this.options.git.repositoryRoot(root))
          : null;
      const worktreeRoot = repositoryRoot !== null ? join(directory, 'worktree') : null;
      if (repositoryRoot !== null && worktreeRoot !== null) {
        // Windows TEMP 可能是 8.3 短路径（RUNNER~1），git 返回的是规范长路径：
        // 先取真实路径再求相对，否则 relative() 会算出穿越管理目录的 bogus 相对路径。
        let realRoot = root;
        let realRepository = repositoryRoot;
        try {
          realRoot = realpathSync(root);
          realRepository = realpathSync(repositoryRoot);
        } catch {
          /* 路径不存在时退回原形态，后续 containment 会如实报错 */
        }
        copyRoot = join(worktreeRoot, relative(realRepository, realRoot));
      }
      const task: TaskWriteRecord = {
        taskId,
        projectId: spec.projectId,
        objective: spec.objective,
        root,
        copyRoot,
        worktreeRoot,
        repositoryRoot,
        dataDir: join(directory, 'data'),
        baseline,
        baseRevision: { head, hash: '' },
        readSet: normalize(spec.readSet ?? Object.keys(originalHashes)),
        writeSet,
        contracts: {},
        baselineHashes: {},
        resources,
        state: 'creating',
        revision: 0,
        fencingToken: this.options.owner.fencingToken(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        plan: null,
        journal: [],
        result: null,
        conflicts: [],
        tests: [],
        log: [],
      };
      this.save(task, 'copy-creating');
      try {
        if (worktreeRoot !== null) {
          if (this.options.git.createWorktree === undefined)
            throw new Error('Git 后端未提供安全 worktree 能力');
          await this.options.git.createWorktree(root, worktreeRoot, head as string);
        }
        this.options.owner.assertOwner();
        mkdirSync(copyRoot, { recursive: true });
        if (baseline === 'current') {
          // overlay 明确选择的脏基线：只读原目录，精确复制包括未跟踪/删除的源码。
          const copyHashes = taskInventory(copyRoot);
          for (const path of Object.keys(copyHashes)) {
            if (originalHashes[path] === undefined) rmSync(sourcePaths.inside(copyRoot, path));
          }
          for (const path of Object.keys(originalHashes)) {
            this.options.owner.assertOwner();
            const from = sourcePaths.inside(root, path);
            const bytes = readFileSync(from);
            if (contentHash(bytes) !== originalHashes[path])
              throw new Error('创建工作副本期间源码已变化，请重新选择基线');
            const to = sourcePaths.inside(copyRoot, path);
            mkdirSync(dirname(to), { recursive: true });
            writeFileSync(to, bytes);
          }
          if (JSON.stringify(taskInventory(root)) !== JSON.stringify(originalHashes))
            throw new Error('创建工作副本期间源码已变化');
        }
        mkdirSync(task.dataDir, { recursive: true });
        task.baselineHashes = taskInventory(copyRoot);
        task.baseRevision.hash = contentHash(JSON.stringify(task.baselineHashes)) as string;
        for (const path of normalize(spec.contractPaths ?? []))
          task.contracts[path] = task.baselineHashes[path] ?? null;
        task.readSet = [...new Set([...task.readSet, ...Object.keys(task.contracts)])];
        task.state = 'running';
        this.save(task, 'copy-ready');
        return task;
      } catch (error) {
        task.state = 'failed';
        this.save(task, `copy-failed:${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    });
  }

  plan(taskId: string, output: GenerationOutput, mode: WriteMode = 'preview'): Promise<WritePlan> {
    return this.serial(async () => {
      const task = this.get(taskId);
      if (task.state !== 'running') throw new Error('任务已生成计划或不在运行中');
      for (const file of output.files) {
        if (!task.writeSet.includes(file.path)) throw new Error(`超出任务允许写集：${file.path}`);
      }
      const pipeline = createWritePipeline({ fs: taskFileSystem(task.copyRoot) });
      const plan = await pipeline.plan({ output, mode });
      plan.id = randomUUID();
      plan.taskId = taskId;
      task.plan = plan;
      task.state = 'awaiting_confirmation';
      this.save(task, 'plan-ready');
      return plan;
    });
  }

  /** 已有内部写端口使用的同一计划路径，允许立即按已确认流水线步骤执行。 */
  async planOutput(
    projectId: string,
    output: GenerationOutput,
    mode: WriteMode = 'preview',
    spec: Partial<TaskWriteSpec> = {},
  ): Promise<WritePlan> {
    const task = await this.create({
      ...spec,
      projectId,
      objective: spec.objective ?? output.summary,
      writeSet: spec.writeSet ?? output.files.map((file) => file.path),
    });
    return this.plan(task.taskId, output, mode);
  }

  merge(plan: WritePlan): Promise<WriteResult> {
    // 进入队列前持久化；重启只恢复/暂停该请求，绝不自动重放确认。
    return this.serial(async () => {
      if (plan.taskId === undefined) throw new Error('计划没有任务工作副本，拒绝直接写共享目录');
      const task = this.get(plan.taskId);
      const stored = task.plan;
      if (stored === null || stored.id !== plan.id) throw new Error('计划与持久化任务不匹配');
      if (task.state === 'merged' && task.result !== null) return task.result;
      if (task.state !== 'awaiting_confirmation' && task.state !== 'queued')
        throw new Error('任务不在可确认合入状态');
      // 仅允许用户改变勾选范围；before/after/anchors 等不相信 IPC 传回的对象。
      const withoutSelection = (value: WritePlan): string =>
        JSON.stringify({
          ...value,
          entries: value.entries.map(({ selected: _selected, ...entry }) => entry),
        });
      if (withoutSelection(plan) !== withoutSelection(stored))
        throw new Error('计划内容被篡改，请重新生成');
      const selected = stored.entries.map((entry, index) => ({
        ...entry,
        selected: plan.entries[index]?.selected === true,
      }));
      const proposed = { ...stored, entries: selected };
      task.state = 'queued';
      this.save(task, 'merge-confirmed');
      const original = taskFileSystem(task.root, this.options.owner);
      for (const path of [
        ...new Set([
          ...task.readSet,
          ...selected.filter((entry) => entry.selected).map((entry) => entry.path),
        ]),
      ]) {
        const current = await original.readText(path);
        const full = this.paths.inside(task.root, path);
        const actualHash = contentHash(existsSync(full) ? readFileSync(full) : null);
        if (actualHash !== (task.baselineHashes[path] ?? null)) {
          const entry = selected.find((candidate) => candidate.path === path);
          task.conflicts.push({
            path,
            reason:
              task.contracts[path] !== undefined
                ? '接口契约版本已变化，必须重新验证调用方'
                : '文件基线或读依赖已变化',
            base: await taskFileSystem(task.copyRoot).readText(path),
            ours: entry?.after ?? null,
            theirs: current,
          });
        }
      }
      if (task.conflicts.length > 0) {
        task.state = 'conflicted';
        const result: WriteResult = {
          ok: false,
          planId: plan.id,
          applied: [],
          skipped: [],
          rolledBack: [],
          error: task.conflicts
            .map((conflict) => `${conflict.path}: ${conflict.reason}`)
            .join('\n'),
          conflicts: task.conflicts.map((conflict) => conflict.path),
        };
        task.result = result;
        this.save(task, 'merge-conflicted');
        return result;
      }
      if (selected.some((entry) => entry.selected && entry.blocked))
        throw new Error('计划包含被拒绝的变更，请重新生成');
      const draft = await createWritePipeline({ fs: taskFileSystem(task.copyRoot) }).apply(
        proposed,
      );
      if (!draft.ok) {
        task.state = 'conflicted';
        task.result = draft;
        this.save(task, 'copy-conflicted');
        return draft;
      }
      const guard: WriteApplyGuard = {
        assertOwner: () => this.options.owner.assertOwner(),
        prepare: async (entries) => {
          task.journal = [...entries];
          task.state = 'applying';
          this.save(task, 'write-prepared');
        },
        validate: async () => {
          task.tests = await this.options.validate(
            task.root,
            selected.filter((entry) => entry.selected && entry.changed).map((entry) => entry.path),
            task,
          );
          if (task.tests.length === 0 || task.tests.some((test) => !test.ok))
            throw new Error('受影响验证未通过，合入已补偿');
          // 测试/外部脚本也可能改动源码；最终状态必须仍是本任务的产物。
          for (const entry of task.journal)
            if ((await original.readText(entry.path)) !== entry.after)
              throw new Error(`${entry.path} 验证期间已被修改`);
        },
        finish: async (result) => {
          task.result = result;
          task.state = result.ok
            ? 'merged'
            : (result.conflicts?.length ?? 0) > 0
              ? 'conflicted'
              : 'failed';
          this.save(task, result.ok ? 'merge-completed' : 'merge-compensated');
        },
      };
      const pipeline = createWritePipeline({
        fs: original,
        transaction: { run: (_plan, apply) => apply(guard) },
      });
      return pipeline.apply(proposed);
    });
  }

  /** 崩溃恢复只补偿 prepared 日志；不重新执行模型、测试或用户确认。 */
  recover(): Promise<TaskWriteRecord[]> {
    return this.serial(async () => {
      const recovered: TaskWriteRecord[] = [];
      for (const task of this.list()) {
        if (task.state === 'applying') {
          const fs = taskFileSystem(task.root, this.options.owner);
          const rolledBack: string[] = [];
          const conflicts: string[] = [];
          for (const entry of [...task.journal].reverse()) {
            this.options.owner.assertOwner();
            const current = await fs.readText(entry.path);
            if (current === entry.before) continue;
            if (
              current !== entry.after ||
              !(await fs.compareAndSwap?.(entry.path, entry.after, entry.before))
            ) {
              conflicts.push(entry.path);
              task.conflicts.push({
                path: entry.path,
                reason: '恢复时文件已不属于本任务，保留现场',
                base: entry.before,
                ours: entry.after,
                theirs: current,
              });
            } else rolledBack.push(entry.path);
          }
          task.result = {
            ok: false,
            planId: task.plan?.id ?? '',
            applied: [],
            skipped: [],
            rolledBack,
            conflicts,
            error: '进程中断，已按所有权检查补偿；需要重新生成并确认',
          };
          task.state = conflicts.length > 0 ? 'conflicted' : 'failed';
          this.save(task, 'crash-recovered');
          recovered.push(task);
        } else if (task.state === 'creating' || task.state === 'queued') {
          task.state = 'failed';
          this.save(task, 'interrupted-before-write');
          recovered.push(task);
        }
      }
      return recovered;
    });
  }

  cancel(taskId: string): Promise<void> {
    return this.serial(async () => {
      const task = this.get(taskId);
      if (task.state === 'applying') throw new Error('任务正在写入，请等待补偿完成');
      if (task.state === 'merged' || task.state === 'cleaned') throw new Error('任务已完成');
      task.state = 'cancelled';
      this.save(task, 'cancelled');
    });
  }

  cleanup(taskId: string, confirmed: boolean): Promise<void> {
    return this.serial(async () => {
      if (!confirmed) throw new Error('清理工作副本需要用户明确确认');
      const task = this.get(taskId);
      if (!['merged', 'failed', 'cancelled'].includes(task.state))
        throw new Error('仍活动或冲突中的工作副本不可清理');
      const directory = this.taskDir(taskId);
      for (const target of [task.copyRoot, task.dataDir, task.worktreeRoot].filter(
        (path): path is string => path !== null,
      )) {
        if (!resolve(target).startsWith(resolve(directory) + sep))
          throw new Error('拒绝清理任务目录以外的内容');
      }
      if (task.worktreeRoot !== null) {
        // dirty worktree 不 force-remove；保留 Git 登记，用户可在任务内审查/处理产物。
        if (this.options.git.removeWorktree === undefined)
          throw new Error('Git 后端不支持安全清理');
        await this.options.git.removeWorktree(task.root, task.worktreeRoot);
      } else if (existsSync(task.copyRoot)) {
        // 先改名再移除本服务明确拥有的目录，绝不碰原源码根。
        const trash = join(directory, `retired-${randomUUID()}`);
        renameSync(task.copyRoot, trash);
        rmSync(trash, { recursive: true });
      }
      task.state = 'cleaned';
      this.save(task, 'copy-cleaned');
    });
  }
}
