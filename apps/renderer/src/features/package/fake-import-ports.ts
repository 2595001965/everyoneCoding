/**
 * 导入相关内存假 PackageApi（T8-03 渲染层测试用）。
 *
 * 不依赖 Node 侧能力（fs/crypto），纯内存模拟外壳端口：维护一份"本地对象库"
 * store，importPackage 按决策落库，便于断言"默认不覆盖本地""keepBoth 落库生成新 id"
 * 等效果。其余导出/自愈/备份方法为桩（测试不触及）。
 */

import type {
  ConflictResolution,
  ImportJobRequest,
  ImportMode,
  ImportReportData,
  ModePreview,
  PackageApi,
  PackageDiffItem,
  PackageDiffPreview,
  PackageObjectType,
  VerificationReport,
} from './package-api';

/** 渲染层镜像的包内对象（与 PackageObject 同构，避免引入 Node 包类型） */
export interface FakeObject {
  id: string;
  type: PackageObjectType;
  projectId: string | null;
  name: string;
  updatedAt: number;
  payload: string;
}

const PARTICIPATING: Record<ImportMode, PackageObjectType[]> = {
  'full-restore': ['memory', 'document', 'design', 'registry', 'code', 'anchor', 'pipeline'],
  merge: ['memory', 'document', 'design', 'registry', 'code', 'anchor', 'pipeline'],
  'memory-only': ['memory'],
  'documents-only': ['document'],
  'code-only': ['code', 'design', 'registry', 'anchor', 'pipeline'],
};

export interface FakeImportOptions {
  packagePath?: string | null;
  verifyReport?: VerificationReport;
  diffPreview?: PackageDiffPreview;
  modePreview?: ModePreview;
  localStore?: FakeObject[];
}

export interface FakeImportApi {
  api: PackageApi;
  /** 读取落库后的"本地对象库"（断言效果用） */
  getStore: () => Map<string, FakeObject>;
  /** 最后一次 importPackage 请求（断言用） */
  getLastRequest: () => ImportJobRequest | null;
}

const OK_REPORT: VerificationReport = { ok: true, steps: [], failureCode: null, failureMessage: null };

const EMPTY_PREVIEW: PackageDiffPreview = {
  items: [],
  counts: { added: 0, conflicted: 0, unchanged: 0, missing: 0 },
  missingLocals: [],
};

export function createFakeImportApi(opts: FakeImportOptions = {}): FakeImportApi {
  const store = new Map<string, FakeObject>((opts.localStore ?? []).map((o) => [o.id, o]));
  const path = opts.packagePath ?? '/fake/pkg.ecpkg';
  const verifyReport = opts.verifyReport ?? OK_REPORT;
  const diffPreview = opts.diffPreview ?? EMPTY_PREVIEW;
  const modePreview = opts.modePreview ?? { mode: 'full-restore', toApply: 0, toOverwrite: 0, toSkip: 0, summary: '' };
  let lastRequest: ImportJobRequest | null = null;

  const api = {
    pickPackagePath: async (): Promise<string | null> => path,
    verifyPackage: async (): Promise<VerificationReport> => verifyReport,
    previewImport: async (): Promise<PackageDiffPreview> => diffPreview,
    previewMode: async (_p: string, mode: ImportMode): Promise<ModePreview> => ({ ...modePreview, mode }),
    importPackage: async (req: ImportJobRequest): Promise<ImportReportData> => {
      lastRequest = req;
      const types = new Set(PARTICIPATING[req.mode]);
      const applicable = diffPreview.items.filter((i) => types.has(i.incoming.type));
      const batchByType = req.batchDecisions ?? {};
      const decisionIds = new Set(req.decisions.map((d) => d.id));

      const undecided = applicable.filter(
        (i: PackageDiffItem) =>
          i.classification === 'conflicted' &&
          !decisionIds.has(i.incoming.id) &&
          batchByType[i.incoming.type] === undefined,
      );
      if (undecided.length > 0) {
        throw new Error(`存在未决策的冲突条目（${undecided.length} 条），请逐条或按类型决策`);
      }

      const resolutionById = new Map<string, ConflictResolution>();
      for (const d of req.decisions) resolutionById.set(d.id, d.resolution);
      for (const type of Object.keys(batchByType) as PackageObjectType[]) {
        const r = batchByType[type];
        if (r === undefined) continue;
        for (const it of applicable) {
          if (it.incoming.type === type && it.classification === 'conflicted') resolutionById.set(it.incoming.id, r);
        }
      }

      let keepLocal = 0;
      let takeNew = 0;
      let keepBoth = 0;
      for (const it of applicable) {
        const res = resolutionById.get(it.incoming.id) ?? (it.classification === 'added' ? 'takeNew' : 'keepLocal');
        if (res === 'keepLocal') {
          keepLocal += 1;
        } else if (res === 'takeNew') {
          store.set(it.incoming.id, it.incoming as FakeObject);
          takeNew += 1;
        } else {
          const newId = `kb-${Math.random().toString(36).slice(2, 10)}`;
          store.set(newId, { ...(it.incoming as FakeObject), id: newId });
          keepBoth += 1;
        }
      }

      return {
        mode: req.mode,
        counts: diffPreview.counts,
        applied: {
          createdProjects: 0,
          updatedProjects: 0,
          createdObjects: takeNew + keepBoth,
          updatedObjects: 0,
          keptBothObjects: keepBoth,
          memoryCreated: 0,
          memoryUpdated: 0,
          memorySuperseded: 0,
          filesWritten: 0,
        },
        resolutions: { keepLocal, takeNew, keepBoth },
        failures: [],
        reportPath: null,
        durationMs: 1,
      };
    },
    // —— 其余方法为桩（测试不触及） ——
    pickExportPath: async (): Promise<string | null> => null,
    exportPackage: async () => {
      throw new Error('stub');
    },
    listExportPresets: async () => [],
    saveExportPreset: async () => undefined,
    deleteExportPreset: async () => undefined,
    runHealing: async () => {
      throw new Error('stub');
    },
    adoptAnchorCandidate: async () => false,
    getBackupSettings: async () => {
      throw new Error('stub');
    },
    saveBackupSettings: async () => undefined,
    createBackupNow: async () => {
      throw new Error('stub');
    },
    listSnapshots: async () => [],
    restoreFromSnapshot: async () => {
      throw new Error('stub');
    },
  } as unknown as PackageApi;

  return { api, getStore: () => store, getLastRequest: () => lastRequest };
}
