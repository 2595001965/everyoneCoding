/**
 * 导入执行器（T8-03）。
 *
 * 流程（两段式：UI 先 verifyPackage / previewImport，再 importPackage）：
 * 1. 包内**重新**校验（不信任外部预览）——失败抛 `ImportVerifyError`；
 * 2. 收集包内对象 → buildDiffPreview（与本地差异分类）；
 * 3. 按模式过滤参与类别，聚合逐条+批量决策；
 * 4. **硬约束（E2E-14）**：存在未决策的冲突条目 → 整体拒绝（抛错）；
 * 5. resolveConflicts → 落库（upsertProject / putObject / putFile / applyMemoryMerge）；
 * 6. 全程 onProgress；单条失败记入 failures 不中断；产出 ImportReportData。
 *
 * 记忆合并复用 `@ec/memory` 的 classifyImport → planMerge → applyMergePlan，
 * 决策映射 keepLocal / takeNew / keepBoth 直接同名传入（'merge' 策略本次不使用）。
 */

import * as fs from 'node:fs';

import { EcpkgReader } from '../reader';
import { verifyPackage } from './verifier';
import { buildDiffPreview, resolveConflicts } from './conflict-resolver';
import { MODE_PARTICIPATING_TYPES, attachmentsAllowed } from './mode-selector';
import {
  classifyImport,
  planMerge,
  applyMergePlan,
  type MemoryItem,
  type MergeDecision,
} from '@ec/memory';
import {
  batchDecideByType,
  type ConflictDecision,
  type ImportJobRequest,
  type ImportLocalStatePort,
  type ImportReportData,
  type ImportTargetPort,
  type PackageObjectType,
  type PackageObject,
  type ResolutionPlan,
  type VerificationReport,
} from './import-types';

/** 校验未通过时抛出的错误（携带 VerificationReport 供 UI 直接展示） */
export class ImportVerifyError extends Error {
  readonly report: VerificationReport;

  constructor(report: VerificationReport) {
    super(report.failureMessage ?? '包校验未通过，无法导入');
    this.name = 'ImportVerifyError';
    this.report = report;
    Object.setPrototypeOf(this, ImportVerifyError.prototype);
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function zeroApplied(): ImportReportData['applied'] {
  return {
    createdProjects: 0,
    updatedProjects: 0,
    createdObjects: 0,
    updatedObjects: 0,
    keptBothObjects: 0,
    memoryCreated: 0,
    memoryUpdated: 0,
    memorySuperseded: 0,
    filesWritten: 0,
  };
}

/* ------------------------------ 包内对象收集 ------------------------------ */

function parseJsonlItems(text: string): MemoryItem[] {
  const out: MemoryItem[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as MemoryItem);
    } catch {
      /* 跳过坏行（单条不影响整体） */
    }
  }
  return out;
}

function memoryObjectFromItem(item: MemoryItem, projectId: string | null): PackageObject {
  return {
    id: item.id,
    type: 'memory',
    projectId,
    name: item.content.slice(0, 20),
    updatedAt: item.updatedAt,
    payload: JSON.stringify(item),
  };
}

function readUpdatedAt(text: string): number {
  try {
    const json = JSON.parse(text) as { updatedAt?: unknown };
    return typeof json.updatedAt === 'number' ? json.updatedAt : 0;
  } catch {
    return 0;
  }
}

function genericObject(
  reader: EcpkgReader,
  path: string,
  projectId: string,
  type: PackageObjectType,
): PackageObject {
  const text = reader.readEntryText(path);
  const name = path.split('/').pop() ?? path;
  const id = name.replace(/\.json$/, '');
  return { id, type, projectId, name, updatedAt: readUpdatedAt(text), payload: text };
}

/** 收集包内全部可比较对象（记忆 + 文档/设计/注册表/锚点/流水线/代码） */
export function collectPackageObjects(reader: EcpkgReader): PackageObject[] {
  const objects: PackageObject[] = [];

  for (const p of reader.listEntries()) {
    const memLong = /^memory\/longterm\.jsonl$/.exec(p);
    if (memLong) {
      for (const item of parseJsonlItems(reader.readEntryText(p)))
        objects.push(memoryObjectFromItem(item, null));
      continue;
    }
    const memProj = /^memory\/projects\/([^/]+)\/project\.jsonl$/.exec(p);
    if (memProj) {
      const pid = memProj[1] ?? '';
      for (const item of parseJsonlItems(reader.readEntryText(p)))
        objects.push(memoryObjectFromItem(item, pid));
      continue;
    }

    if (p === 'documents/index.json') {
      const docs = parseDocIndex(reader.readEntryText(p));
      for (const d of docs) {
        objects.push({
          id: d.id,
          type: 'document',
          projectId: d.projectId,
          name: d.name.slice(0, 20),
          updatedAt: d.updatedAt,
          payload: JSON.stringify(d),
        });
      }
      continue;
    }

    const page = /^projects\/([^/]+)\/design\/pages\/.+\.json$/.exec(p);
    if (page) {
      objects.push(genericObject(reader, p, page[1] ?? '', 'design'));
      continue;
    }
    const comp = /^projects\/([^/]+)\/design\/components\/.+\.json$/.exec(p);
    if (comp) {
      objects.push(genericObject(reader, p, comp[1] ?? '', 'design'));
      continue;
    }
    const reg = /^projects\/([^/]+)\/registry\.json$/.exec(p);
    if (reg) {
      objects.push({
        id: `registry:${reg[1]}`,
        type: 'registry',
        projectId: reg[1] ?? '',
        name: '注册表',
        updatedAt: readUpdatedAt(reader.readEntryText(p)),
        payload: reader.readEntryText(p),
      });
      continue;
    }
    const anc = /^projects\/([^/]+)\/anchors\.json$/.exec(p);
    if (anc) {
      objects.push({
        id: `anchors:${anc[1]}`,
        type: 'anchor',
        projectId: anc[1] ?? '',
        name: '锚点',
        updatedAt: readUpdatedAt(reader.readEntryText(p)),
        payload: reader.readEntryText(p),
      });
      continue;
    }
    const pipe = /^projects\/([^/]+)\/pipeline\/.+/.exec(p);
    if (pipe) {
      objects.push(genericObject(reader, p, pipe[1] ?? '', 'pipeline'));
      continue;
    }
    const code = /^projects\/([^/]+)\/code\/(.+)$/.exec(p);
    if (code) {
      objects.push({
        id: `code:${code[1]}:${code[2]}`,
        type: 'code',
        projectId: code[1] ?? '',
        name: code[2] ?? '',
        updatedAt: 0,
        payload: reader.readEntryText(p),
      });
      continue;
    }
    // 其余（meta.json、附件、文档原始文件、links、manifest、checksums、signature）不参与对象比对
  }

  return objects;
}

interface DocIndexEntry {
  id: string;
  name: string;
  projectId: string | null;
  updatedAt: number;
}

function parseDocIndex(text: string): DocIndexEntry[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const arr = Array.isArray(parsed) ? parsed : (parsed as { docs?: unknown }).docs;
    if (!Array.isArray(arr)) return [];
    return arr.map((raw) => {
      const d = raw as { id: string; name?: string; projectId?: string | null; updatedAt?: number };
      return {
        id: d.id,
        name: d.name ?? d.id,
        projectId: d.projectId ?? null,
        updatedAt: d.updatedAt ?? 0,
      };
    });
  } catch {
    return [];
  }
}

/** 收集包内原始文件（文档原始文件 + 附件），导入时按 putFile 复制 */
export function collectPackageFiles(
  reader: EcpkgReader,
): Array<{ path: string; kind: 'doc' | 'attachment' }> {
  const files: Array<{ path: string; kind: 'doc' | 'attachment' }> = [];
  for (const p of reader.listEntries()) {
    if (/^documents\/[^/]+\/.+/.test(p)) files.push({ path: p, kind: 'doc' });
    else if (/^attachments\/.+/.test(p)) files.push({ path: p, kind: 'attachment' });
  }
  return files;
}

/** 收集包内项目元信息（projects/<id>/meta.json） */
function collectProjectMetas(
  reader: EcpkgReader,
): Array<{ id: string; name: string; metaJson: string }> {
  const metas: Array<{ id: string; name: string; metaJson: string }> = [];
  for (const p of reader.listEntries()) {
    const m = /^projects\/([^/]+)\/meta\.json$/.exec(p);
    if (m === null) continue;
    const pid = m[1] ?? '';
    const raw = reader.readEntryText(p);
    let parsed: { id?: string; name?: string; metaJson?: string } = {};
    try {
      parsed = JSON.parse(raw) as { id?: string; name?: string; metaJson?: string };
    } catch {
      /* 退化：整体作为 metaJson */
    }
    metas.push({
      id: parsed.id ?? pid,
      name: parsed.name ?? pid,
      metaJson: typeof parsed.metaJson === 'string' ? parsed.metaJson : raw,
    });
  }
  return metas;
}

/* ------------------------------ 执行 ------------------------------ */

/**
 * 执行一次导入。
 *
 * @param request 导入请求（含包路径、模式、口令、决策、预览可选）
 * @param ports 本地状态端口（差异分类用）+ 落库端口（写入用）
 * @throws ImportVerifyError 包校验未通过；普通 Error 存在未决策的冲突条目
 */
export async function runImport(
  request: ImportJobRequest,
  ports: { local: ImportLocalStatePort; target: ImportTargetPort },
): Promise<ImportReportData> {
  const start = Date.now();
  const onProgress = request.onProgress;

  // ① 包内重新校验（不信任外部预览）
  onProgress?.('verifying', 0, 1, null);
  const verify = await verifyPackage(request.packagePath, {
    password: request.password,
    signaturePublicKeyPem: request.signaturePublicKeyPem,
  });
  if (!verify.ok) throw new ImportVerifyError(verify);

  const reader = EcpkgReader.open(request.packagePath, { password: request.password });
  const applied = zeroApplied();
  const failures: Array<{ path: string; reason: string }> = [];

  try {
    onProgress?.('collecting', 0, 1, null);
    const incoming = collectPackageObjects(reader);
    const files = collectPackageFiles(reader);
    const preview = buildDiffPreview(incoming, ports.local);

    const types = MODE_PARTICIPATING_TYPES[request.mode];
    const applicable = preview.items.filter((i) => types.has(i.incoming.type));

    // 聚合逐条 + 批量决策
    const batchByType = request.batchDecisions ?? {};
    const batchDecisions = batchDecideByType(preview, batchByType);
    const allDecisions: ConflictDecision[] = [...request.decisions, ...batchDecisions];
    const decisionIds = new Set(request.decisions.map((d) => d.id));

    // ④ 硬约束（E2E-14）：冲突条目必须有决策（逐条或按类型批量覆盖）
    const undecided = applicable.filter(
      (i) =>
        i.classification === 'conflicted' &&
        !decisionIds.has(i.incoming.id) &&
        batchByType[i.incoming.type] === undefined,
    );
    if (undecided.length > 0) {
      throw new Error(`存在未决策的冲突条目（${undecided.length} 条），请逐条或按类型决策`);
    }

    const plan: ResolutionPlan = resolveConflicts(preview, allDecisions);

    const total = applicable.length + files.length;
    let processed = 0;
    onProgress?.('applying', processed, total, null);

    // 项目容器（仅 full-restore / merge 覆盖同名项目）
    if (request.mode === 'full-restore' || request.mode === 'merge') {
      for (const meta of collectProjectMetas(reader)) {
        try {
          const result = ports.target.upsertProject(meta);
          if (result === 'created') applied.createdProjects += 1;
          else applied.updatedProjects += 1;
          processed += 1;
          onProgress?.('applying', processed, total, `projects/${meta.id}/meta.json`);
        } catch (error) {
          failures.push({ path: `projects/${meta.id}/meta.json`, reason: errMsg(error) });
          processed += 1;
        }
      }
    }

    // 通用对象（document/design/registry/code/anchor/pipeline）
    for (const outcome of plan.outcomes) {
      if (!types.has(outcome.incoming.type)) continue; // 模式不涵盖 → 跳过
      if (outcome.incoming.type === 'memory') continue; // 记忆单独处理
      if (outcome.resolution === 'keepLocal') {
        processed += 1;
        continue;
      }
      const obj =
        outcome.resolution === 'keepBoth' && outcome.created !== null
          ? outcome.created
          : outcome.incoming;
      try {
        const result = ports.target.putObject(obj);
        if (result === 'created') {
          applied.createdObjects += 1;
          if (outcome.resolution === 'keepBoth') applied.keptBothObjects += 1;
        } else if (result === 'updated') {
          applied.updatedObjects += 1;
        }
        processed += 1;
        onProgress?.('applying', processed, total, outcome.incoming.id);
      } catch (error) {
        failures.push({ path: outcome.incoming.id, reason: errMsg(error) });
        processed += 1;
      }
    }

    // 原始文件（文档原始文件 + 附件）：文档参与时复制
    if (attachmentsAllowed(request.mode)) {
      for (const f of files) {
        try {
          const content = reader.readEntryBuffer(f.path);
          const result = ports.target.putFile(f.path, content);
          if (result !== 'skipped') applied.filesWritten += 1;
          processed += 1;
          onProgress?.('applying', processed, total, f.path);
        } catch (error) {
          failures.push({ path: f.path, reason: errMsg(error) });
          processed += 1;
        }
      }
    }

    // 记忆合并（复用 @ec/memory planMerge / applyMergePlan）
    if (types.has('memory')) {
      const incomingMemory = incoming
        .filter((o) => o.type === 'memory')
        .map((o) => JSON.parse(o.payload) as MemoryItem);
      const localMemory = ports.local
        .listObjects('memory', null)
        .map((o) => JSON.parse(o.payload) as MemoryItem);
      const memPreview = classifyImport(incomingMemory, localMemory);
      const memDecisions: MergeDecision[] = allDecisions
        .filter((d) => memPreview.items.some((it) => it.incoming.id === d.id))
        .map((d) => ({ id: d.id, strategy: d.resolution }));
      const memPlan = planMerge(memPreview, memDecisions);
      const intents = applyMergePlan(memPlan);
      try {
        const result = ports.target.applyMemoryMerge({
          toCreate: intents.toCreate.map((it) => ({ json: JSON.stringify(it) })),
          toUpdate: intents.toUpdate.map((it) => ({ json: JSON.stringify(it) })),
          toSupersede: intents.toSupersede,
        });
        applied.memoryCreated = result.created;
        applied.memoryUpdated = result.updated;
        applied.memorySuperseded = result.superseded;
      } catch (error) {
        failures.push({ path: 'memory', reason: errMsg(error) });
      }
    }

    onProgress?.('done', total, total, null);

    return {
      mode: request.mode,
      counts: preview.counts,
      applied,
      resolutions: plan.summary,
      failures,
      reportPath: null,
      durationMs: Date.now() - start,
    };
  } finally {
    reader.close();
  }
}

/**
 * 把导入报告写入磁盘（JSON）。UI 的"导出报告"按钮调用本函数。
 */
export function writeReportFile(report: ImportReportData, path: string): void {
  fs.writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
}
