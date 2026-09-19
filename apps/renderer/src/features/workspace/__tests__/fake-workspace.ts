/**
 * 工作台测试夹具：**真实 ProjectService + 内存存储 + 内存指标源**。
 *
 * 这样组件测试能断言真实语义（"点创建后 store 里真的多了一条项目行"、
 * "模板创建真的落了页面与记忆"、"仪表盘数值与源数据一致"），而不用伪造 UI 文案。
 */

import {
  ProjectService,
  PROJECT_TEMPLATES,
  findTemplate,
  runGitImport,
  parseRequirementDocument,
  type GitImportPort,
  type ProjectRowSnapshot,
  type ProjectSummary,
  type ProjectStore,
  type DuplicateOptions,
  type ProjectDuplicatePort,
  type RequirementDigest,
  RECYCLE_BIN_RETENTION_MS,
} from '@ec/core';
import type { TargetPlatform } from '@ec/pipeline';

import type {
  DashboardMetrics,
  DuplicateResult,
  MetricDetail,
  MetricKey,
  ProjectStageInfo,
  WorkspaceApi,
} from '../workspace-api';

const NOW = 1_700_000_000_000;

export class MemoryProjectStore implements ProjectStore {
  readonly rows = new Map<string, ProjectRowSnapshot>();
  loadAll(): Promise<ProjectRowSnapshot[]> {
    return Promise.resolve([...this.rows.values()].map((row) => ({ ...row })));
  }
  loadById(id: string): Promise<ProjectRowSnapshot | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? { ...row } : null);
  }
  insert(row: ProjectRowSnapshot): Promise<void> {
    this.rows.set(row.id, { ...row });
    return Promise.resolve();
  }
  update(id: string, patch: Partial<ProjectRowSnapshot>): Promise<void> {
    const current = this.rows.get(id);
    if (!current) throw new Error(`项目行不存在：${id}`);
    this.rows.set(id, { ...current, ...patch });
    return Promise.resolve();
  }
  deleteRow(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }
}

/** 指标源数据（模拟 memory_item / page / feature / usage_record / git log） */
export interface MetricSource {
  memory: Array<{ id: string; scope: string }>;
  pages: Array<{ id: string; platform: string }>;
  features: Array<{ id: string; done: boolean }>;
  usage: Array<{ modelId: string; tokens: number; cost: number; at: number }>;
  commits: Array<{ sha: string; message: string; author: string; at: number }>;
  periodStart: number;
}

export interface FakeWorkspaceEnvironment {
  api: WorkspaceApi;
  service: ProjectService;
  store: MemoryProjectStore;
  source: MetricSource;
  /** 记录 Git 克隆调用 */
  gitClones: string[];
  /** 模板创建落库内容 */
  templateArtifacts: Array<{ projectId: string; templateId: string; pages: number; memory: number }>;
  /** 由文档导入落库的功能与页面 */
  digestArtifacts: Array<{ projectId: string; features: number; pages: number }>;
  setNow(ms: number): void;
}

export function createFakeWorkspace(): FakeWorkspaceEnvironment {
  const store = new MemoryProjectStore();
  const gitClones: string[] = [];
  const templateArtifacts: FakeWorkspaceEnvironment['templateArtifacts'] = [];
  const digestArtifacts: FakeWorkspaceEnvironment['digestArtifacts'] = [];
  let now = NOW;
  let idCounter = 0;
  const newId = (): string => {
    idCounter += 1;
    return `p-${String(idCounter).padStart(3, '0')}`;
  };

  const duplicatePort: ProjectDuplicatePort = {
    copyResources: (_sourceId, _targetId, options: DuplicateOptions) =>
      Promise.resolve({
        design: options.includeDesign ? 2 : 0,
        memory: options.includeMemory ? 3 : 0,
        docs: options.includeDocs ? 1 : 0,
        codeFiles: options.includeCode ? 4 : 0,
      }),
  };

  const service = new ProjectService({ store, duplicate: duplicatePort, clock: () => now, newId });

  const source: MetricSource = {
    memory: [],
    pages: [],
    features: [],
    usage: [],
    commits: [],
    periodStart: NOW - 30 * 24 * 60 * 60 * 1000,
  };

  const clonePort: GitImportPort = {
    clone: (url) => {
      gitClones.push(url);
      return Promise.resolve();
    },
    inspect: () =>
      Promise.resolve({
        files: ['pubspec.yaml', 'lib/main.dart'],
        manifests: { 'pubspec.yaml': 'name: mobile_app' },
        defaultBranch: 'main',
        remoteUrl: 'https://example.com/mobile.git',
      }),
    isDirAvailable: () => Promise.resolve(true),
  };

  const metricsFor = (): DashboardMetrics => {
    const started = Date.now();
    const byScope: Record<string, number> = {};
    for (const item of source.memory) byScope[item.scope] = (byScope[item.scope] ?? 0) + 1;
    const byPlatform: Record<string, number> = {};
    for (const page of source.pages) byPlatform[page.platform] = (byPlatform[page.platform] ?? 0) + 1;

    const period = source.usage.filter((record) => record.at >= source.periodStart);
    const byModelMap = new Map<string, { tokens: number; cost: number }>();
    for (const record of source.usage) {
      const current = byModelMap.get(record.modelId) ?? { tokens: 0, cost: 0 };
      current.tokens += record.tokens;
      current.cost += record.cost;
      byModelMap.set(record.modelId, current);
    }

    return {
      memory: { total: source.memory.length, byScope },
      pages: { total: source.pages.length, byPlatform },
      features: {
        done: source.features.filter((feature) => feature.done).length,
        total: source.features.length,
        completion: source.features.length === 0 ? 0 : source.features.filter((f) => f.done).length / source.features.length,
      },
      usage: {
        periodLabel: '近 30 天',
        periodTokens: period.reduce((sum, record) => sum + record.tokens, 0),
        periodCost: period.reduce((sum, record) => sum + record.cost, 0),
        totalTokens: source.usage.reduce((sum, record) => sum + record.tokens, 0),
        totalCost: source.usage.reduce((sum, record) => sum + record.cost, 0),
        byModel: [...byModelMap.entries()].map(([modelId, value]) => ({ modelId, ...value })),
      },
      git: { recent: [...source.commits].sort((a, b) => b.at - a.at).slice(0, 5) },
      computeMs: Date.now() - started,
    };
  };

  const detailFor = (key: MetricKey): MetricDetail => {
    if (key === 'memory') {
      const rows = Object.entries(metricsFor().memory.byScope).map(([scope, count]) => ({
        label: scope,
        value: String(count),
        refId: scope,
      }));
      return { key, title: '记忆条目明细', rows };
    }
    if (key === 'pages') {
      return {
        key,
        title: '页面明细',
        rows: source.pages.map((page) => ({ label: page.id, value: page.platform, refId: page.id })),
      };
    }
    if (key === 'usage') {
      return {
        key,
        title: 'AI 调用明细',
        rows: source.usage.map((record) => ({
          label: record.modelId,
          value: `${record.tokens} tokens / ¥${record.cost.toFixed(2)}`,
        })),
      };
    }
    if (key === 'git') {
      return {
        key,
        title: '最近提交明细',
        rows: source.commits.map((commit) => ({ label: commit.sha.slice(0, 7), value: commit.message, refId: commit.sha })),
      };
    }
    return {
      key,
      title: '功能完成度明细',
      rows: source.features.map((feature) => ({
        label: feature.id,
        value: feature.done ? '已完成' : '未完成',
        refId: feature.id,
      })),
    };
  };

  const api: WorkspaceApi = {
    listProjects: (query) => service.listProjects(query ?? {}),
    getProject: (id) => service.getProject(id),
    createProject: (input) => service.createProject(input),
    updateProject: (id, patch) => service.updateProject(id, patch),
    markOpened: (id) => service.markOpened(id),
    archiveProject: (id) => service.archiveProject(id),
    unarchiveProject: (id) => service.unarchiveProject(id),
    moveToRecycleBin: (id) => service.moveToRecycleBin(id),
    restoreFromRecycleBin: (id) => service.restoreFromRecycleBin(id),
    purgeProject: (id) => service.purgeProject(id),
    cleanupExpiredRecycleBin: async () => (await service.cleanupExpiredRecycleBin()).length,
    duplicateProject: (id, options): Promise<DuplicateResult> => service.duplicateProject(id, options),

    createFromTemplate: async (input) => {
      const template = findTemplate(input.templateId);
      if (!template) throw new Error(`模板不存在：${input.templateId}`);
      const project = await service.createProject({
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        targetPlatforms: template.targetPlatforms as TargetPlatform[],
        techStackFingerprint: template.techStack,
        sourceKind: 'template',
        sourceRef: template.id,
      });
      // 落初始页面与项目记忆（真实装配由外壳写 page / memory_item 表）
      source.pages.push(
        ...template.pages.map((page) => ({ id: `${project.id}-${page.route}`, platform: page.platform as string })),
      );
      source.memory.push(
        ...template.memoryDrafts.map((draft, index) => ({ id: `${project.id}-m${index}`, scope: draft.scope })),
      );
      templateArtifacts.push({
        projectId: project.id,
        templateId: template.id,
        pages: template.pages.length,
        memory: template.memoryDrafts.length,
      });
      return project;
    },

    importFromGit: async (input) => {
      // core 的 clone 端口按 (ratio, message) 回调；堆到端口契约的 stage 形状上，
      // 与主进程经域事件通道推送的三阶段口径保持一致
      const onPortProgress = input.onProgress;
      const plan = await runGitImport(
        {
          url: input.url,
          ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
          targetDir: input.targetDir,
        },
        clonePort,
        onPortProgress === undefined
          ? undefined
          : (ratio, message) => onPortProgress({ stage: 'clone', ratio, message }),
      );
      const project = await service.createProject({
        name: plan.projectName,
        targetPlatforms: plan.profile.platforms,
        techStackFingerprint: plan.profile.techStack,
        sourceKind: 'git_import',
        sourceRef: plan.url,
        ...(plan.defaultBranch ? {} : {}),
      });
      source.memory.push(
        ...plan.profile.memoryDrafts.map((draft, index) => ({ id: `${project.id}-g${index}`, scope: draft.scope })),
      );
      return project;
    },

    createFromDigest: async (input: { digest: RequirementDigest; name: string }) => {
      const project = await service.createProject({ name: input.name, sourceKind: 'doc_import' });
      source.features.push(
        ...input.digest.features.map((_feature, index) => ({ id: `${project.id}-f${index}`, done: false })),
      );
      source.pages.push(
        ...input.digest.pageCandidates.map((page) => ({ id: `${project.id}${page.route}`, platform: 'web' })),
      );
      source.memory.push(
        ...input.digest.memoryDrafts.map((draft, index) => ({ id: `${project.id}-d${index}`, scope: draft.scope })),
      );
      digestArtifacts.push({
        projectId: project.id,
        features: input.digest.features.length,
        pages: input.digest.pageCandidates.length,
      });
      return project;
    },

    getProjectStage: (projectId): Promise<ProjectStageInfo | null> =>
      Promise.resolve(
        store.rows.has(projectId) ? { stage: 'S2', status: 'running', confirmed: 2, total: 7 } : null,
      ),
    getThumbnailUrl: (projectId) =>
      Promise.resolve(projectId.endsWith('0') ? `https://cdn.example.com/${projectId}.png` : null),
    getDashboardMetrics: () => Promise.resolve(metricsFor()),
    getMetricDetail: (_projectId, key) => Promise.resolve(detailFor(key)),
  };

  return {
    api,
    service,
    store,
    source,
    gitClones,
    templateArtifacts,
    digestArtifacts,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

/** 快速造 N 个项目（性能测试用） */
export async function seedProjects(env: FakeWorkspaceEnvironment, count: number): Promise<ProjectSummary[]> {
  const created: ProjectSummary[] = [];
  for (let index = 0; index < count; index += 1) {
    created.push(
      await env.service.createProject({
        name: `项目 ${String(index + 1).padStart(3, '0')}`,
        targetPlatforms: index % 3 === 0 ? ['web'] : index % 3 === 1 ? ['android', 'ios'] : [],
      }),
    );
  }
  return created;
}

export { NOW, RECYCLE_BIN_RETENTION_MS, PROJECT_TEMPLATES, parseRequirementDocument };
