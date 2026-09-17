/**
 * 导出任务（T8-02）。
 *
 * `runExport(request, port)` 串起完整流水线：
 * enumerating → excluding → redacting → writing → encrypting → done。
 *
 * - 范围（all / project / selected）由 `ExportSelection` 决定；
 * - 排除：默认规则 + 项目级 .ecignore 作用于代码文件与附件，统计 ExcludeStats；
 * - 脱敏：redact=true 时全部文本条目逐条打码（默认开启；关闭需 UI 二次确认）；
 * - 写入：按 §14.1 布局逐条写入（记忆 / 文档 / 项目 / 代码 / 附件）；
 * - 加密：有 password 时先 finalize 出明文中转 ZIP，再包裹、删中转；
 * - 自检：导出完成后用 reader 遍历包内文本条目再跑一遍 scanForSecrets；
 * - 失败续跑：条目级错误记入 failures，其余文件继续，整体不中断。
 */

import * as fs from 'node:fs';

import { EcpkgReader } from '../reader';
import { EcpkgWriteError, EcpkgWriter } from '../writer';
import {
  PKG_CHECKSUM_PATH,
  PKG_MANIFEST_PATH,
  PKG_SIGNATURE_PATH,
  attachmentsDir,
  documentDir,
  documentsIndexPath,
  longtermMemoryPath,
  projectCodeDir,
  projectComponentsDir,
  projectMetaPath,
  projectMemoryJsonlPath,
  projectMemoryLinksPath,
  projectPagesDir,
  projectAnchorsPath,
  projectPipelineDir,
  projectRegistryPath,
} from '../format/layout';
import type { ContentKind } from '../format/manifest';

import { computeExcludeStats, matchExclude, parseEcignore, DEFAULT_EXCLUDE_RULES } from './exclude-rules';
import { deletePlainZip, encryptPackage, encryptionInfo } from './encryptor';
import { isTextEntry, redactTextIfNeeded, scanForSecrets } from './redactor';
import { ExportProgressTracker } from './progress';
import type {
  ExportJobRequest,
  ExportJobResult,
  ExportMemoryItem,
  ExportSourcePort,
  RedactionFinding,
} from './export-types';

/** 一条待写入的包内条目 */
type WriteOp =
  | { kind: 'text'; pkgPath: string; text: string }
  | { kind: 'buffer'; pkgPath: string; data: Buffer }
  | { kind: 'file'; pkgPath: string; sourcePath: string };

interface CodeCandidate {
  pid: string;
  rel: string;
  data: Buffer | null;
  size: number;
  excluded: boolean;
}

interface AttachmentCandidate {
  hashName: string;
  sourcePath: string;
  size: number;
  excluded: boolean;
}

function resolveSelectedProjectIds(request: ExportJobRequest): string[] | null {
  const { scope, projectIds } = request.selection;
  if (scope === 'all') return null;
  if (scope === 'project') return projectIds.length > 0 ? [projectIds[0]!] : [];
  return projectIds;
}

/** 执行一次导出，返回结果（含统计 / 排除 / 脱敏 / 自检 / 加密信息） */
export async function runExport(request: ExportJobRequest, port: ExportSourcePort): Promise<ExportJobResult> {
  const tracker = new ExportProgressTracker(request.onProgress);
  const startTime = Date.now();

  const redact = request.redact ?? true;
  const useDefaultExcludes = request.useDefaultExcludes ?? true;
  const content = request.selection.content;

  // 范围解析
  tracker.setStage('enumerating');
  const allProjects = port.listProjects();
  const selectedProjectIds = resolveSelectedProjectIds(request);
  const includedProjects =
    selectedProjectIds === null ? allProjects : allProjects.filter((p) => selectedProjectIds.includes(p.id));
  const includedProjectIds = new Set(includedProjects.map((p) => p.id));

  const memoryItems = port.listMemory(selectedProjectIds, content.memory);
  const memoryLinks = port.listMemoryLinks(selectedProjectIds).filter((l) => includedProjectIds.has(l.projectId));
  const documents = content.documents ? port.listDocuments(selectedProjectIds) : [];

  // 规则集合：默认 + 额外 + 项目级 .ecignore
  const globalRules = [...DEFAULT_EXCLUDE_RULES];
  if (request.extraExcludes && request.extraExcludes.length > 0) {
    for (const pattern of request.extraExcludes) globalRules.push({ pattern, builtin: false });
  }
  const projectEcignore = new Map<string, ReturnType<typeof parseEcignore>>();
  for (const proj of includedProjects) {
    const text = port.readEcignore(proj.id);
    projectEcignore.set(proj.id, parseEcignore(text));
  }
  const rulesForCode = (pid: string): typeof globalRules => [...globalRules, ...(projectEcignore.get(pid) ?? [])];

  // 排除统计候选收集（代码 + 附件，读取一次内容）
  tracker.setStage('excluding');
  const codeCandidates: CodeCandidate[] = [];
  if (content.code) {
    for (const proj of includedProjects) {
      const files = port.listCodeFiles(proj.id);
      const rules = rulesForCode(proj.id);
      for (const rel of files) {
        const data = port.readCodeFile(proj.id, rel);
        if (data === null) {
          tracker.addFailure({ path: `${projectCodeDir(proj.id)}${rel}`, reason: '读取代码文件失败' });
          continue;
        }
        const excluded = matchExclude(rel, rules);
        codeCandidates.push({ pid: proj.id, rel, data, size: data.length, excluded });
      }
    }
  }

  const attachmentCandidates: AttachmentCandidate[] = [];
  if (content.attachments) {
    for (const att of port.listAttachments()) {
      let size = 0;
      try {
        size = fs.statSync(att.sourcePath).size;
      } catch {
        size = 0;
      }
      const excluded = matchExclude(`${attachmentsDir()}${att.hashName}`, globalRules);
      attachmentCandidates.push({ hashName: att.hashName, sourcePath: att.sourcePath, size, excluded });
    }
  }

  const excludeStats = computeExcludeStats(
    [
      ...codeCandidates.map((c) => ({ path: c.rel, bytes: c.size })),
      ...attachmentCandidates.map((a) => ({ path: `${attachmentsDir()}${a.hashName}`, bytes: a.size })),
    ],
    [...globalRules, ...[...projectEcignore.values()].flat()],
  );
  tracker.setExcludeStats(excludeStats);

  // 组装写入条目
  const ops: WriteOp[] = [];
  const redactionFindings: RedactionFinding[] = [];

  const counts = {
    projects: includedProjects.length,
    memoryItems: 0,
    documents: 0,
    pages: 0,
    codeFiles: 0,
    attachments: 0,
  };

  const memoryHasLayers =
    content.memory.longterm || content.memory.project || content.memory.feature || content.memory.page || content.memory.issue;

  // 记忆：长期层
  if (memoryHasLayers) {
    const longtermItems = memoryItems.filter((m) => m.layer === 'longterm');
    if (longtermItems.length > 0) {
      const text = longtermItems.map((m) => m.json).join('\n') + '\n';
      ops.push({ kind: 'text', pkgPath: longtermMemoryPath(), text });
      counts.memoryItems += longtermItems.length;
    }

    // 记忆：项目 / 功能 / 页面 / 问题层（按项目归组）
    const byProject = new Map<string, ExportMemoryItem[]>();
    for (const m of memoryItems) {
      if (m.layer === 'longterm') continue;
      if (m.projectId === null) continue;
      const arr = byProject.get(m.projectId) ?? [];
      arr.push(m);
      byProject.set(m.projectId, arr);
    }
    for (const [pid, items] of byProject) {
      const text = items.map((m) => m.json).join('\n') + (items.length > 0 ? '\n' : '');
      ops.push({ kind: 'text', pkgPath: projectMemoryJsonlPath(pid), text });
      counts.memoryItems += items.length;
    }

    // 记忆 ↔ 文档关联
    for (const link of memoryLinks) {
      ops.push({ kind: 'text', pkgPath: projectMemoryLinksPath(link.projectId), text: link.linksJson });
    }
  }

  // 文档
  if (content.documents) {
    const indexText = JSON.stringify(
      documents.map((d) => ({ id: d.id, name: d.name, projectId: d.projectId, updatedAt: d.updatedAt })),
    );
    ops.push({ kind: 'text', pkgPath: documentsIndexPath(), text: indexText });
    for (const doc of documents) {
      const file = port.readDocument(doc.id, doc.name);
      if (file === null) {
        tracker.addFailure({ path: `${documentDir(doc.id)}${doc.name}`, reason: '读取文档内容失败' });
        continue;
      }
      const docPath = `${documentDir(doc.id)}${doc.name}`;
      if (isTextEntry(doc.name)) {
        ops.push({ kind: 'text', pkgPath: docPath, text: file.content.toString('utf8') });
      } else {
        ops.push({ kind: 'buffer', pkgPath: docPath, data: file.content });
      }
      counts.documents += 1;
    }
  }

  // 项目级产物
  for (const proj of includedProjects) {
    const pid = proj.id;
    ops.push({ kind: 'text', pkgPath: projectMetaPath(pid), text: proj.metaJson });

    const pages = port.listDesignPages(pid);
    for (const fileName of pages) {
      const page = port.readDesignPage(pid, fileName);
      if (page === null) {
        tracker.addFailure({ path: `${projectPagesDir(pid)}${fileName}`, reason: '读取页面 DSL 失败' });
        continue;
      }
      ops.push({ kind: 'text', pkgPath: `${projectPagesDir(pid)}${fileName}`, text: page });
      counts.pages += 1;
    }

    const components = port.listDesignComponents(pid);
    for (const fileName of components) {
      const component = port.readDesignComponent(pid, fileName);
      if (component === null) {
        tracker.addFailure({ path: `${projectComponentsDir(pid)}${fileName}`, reason: '读取组件失败' });
        continue;
      }
      ops.push({ kind: 'text', pkgPath: `${projectComponentsDir(pid)}${fileName}`, text: component });
    }

    if (content.anchors) {
      const anchors = port.readAnchors(pid);
      if (anchors !== null) ops.push({ kind: 'text', pkgPath: projectAnchorsPath(pid), text: anchors });
    }

    if (content.registry) {
      const registry = port.readRegistry(pid);
      if (registry !== null) ops.push({ kind: 'text', pkgPath: projectRegistryPath(pid), text: registry });
    }

    if (content.pipeline) {
      const pipelineFiles = port.listPipelineFiles(pid);
      for (const rel of pipelineFiles) {
        const data = port.readPipelineFile(pid, rel);
        if (data === null) {
          tracker.addFailure({ path: `${projectPipelineDir(pid)}${rel}`, reason: '读取流水线产物失败' });
          continue;
        }
        const ppath = `${projectPipelineDir(pid)}${rel}`;
        if (isTextEntry(rel)) {
          ops.push({ kind: 'text', pkgPath: ppath, text: data.toString('utf8') });
        } else {
          ops.push({ kind: 'buffer', pkgPath: ppath, data });
        }
      }
    }
  }

  // 代码（排除命中的不写入）
  for (const candidate of codeCandidates) {
    if (candidate.excluded) continue;
    const codePkgPath = `${projectCodeDir(candidate.pid)}${candidate.rel}`;
    if (candidate.data === null) continue;
    if (isTextEntry(candidate.rel)) {
      ops.push({ kind: 'text', pkgPath: codePkgPath, text: candidate.data.toString('utf8') });
    } else {
      ops.push({ kind: 'buffer', pkgPath: codePkgPath, data: candidate.data });
    }
    counts.codeFiles += 1;
  }

  // 附件（排除命中的不写入，二进制流式）
  for (const att of attachmentCandidates) {
    if (att.excluded) continue;
    ops.push({ kind: 'file', pkgPath: `${attachmentsDir()}${att.hashName}`, sourcePath: att.sourcePath });
    counts.attachments += 1;
  }

  // 写入
  if (redact) tracker.setStage('redacting');
  tracker.setStage('writing');
  const plainTmpPath = request.password !== undefined ? `${request.outputPath}.plain.tmp` : request.outputPath;
  const writer = EcpkgWriter.create(plainTmpPath);

  const total = ops.length;
  let processed = 0;
  for (const op of ops) {
    tracker.update(processed, total, op.pkgPath);
    try {
      if (op.kind === 'text') {
        if (redact) {
          const { text: masked, findings } = redactTextIfNeeded(op.pkgPath, op.text);
          for (const finding of findings) redactionFindings.push(finding);
          writer.writeTextEntry(op.pkgPath, masked);
        } else {
          writer.writeTextEntry(op.pkgPath, op.text);
        }
      } else if (op.kind === 'buffer') {
        writer.writeBufferEntry(op.pkgPath, op.data);
      } else {
        await writer.writeFileEntry(op.pkgPath, op.sourcePath);
      }
    } catch (error) {
      tracker.addFailure({ path: op.pkgPath, reason: error instanceof Error ? error.message : String(error) });
    }
    processed += 1;
  }
  tracker.setRedactionFindings(redactionFindings);

  // includes 内容种类
  const includes: ContentKind[] = [];
  if (memoryHasLayers) includes.push('memory');
  if (content.documents) includes.push('documents');
  if (content.code) includes.push('code');
  if (content.pipeline) includes.push('pipeline');
  if (content.anchors) includes.push('anchors');
  if (content.registry) includes.push('registry');
  if (includedProjects.length > 0) includes.push('design');
  if (content.attachments) includes.push('attachments');

  const excludesList = [
    ...DEFAULT_EXCLUDE_RULES.filter(() => useDefaultExcludes).map((r) => r.pattern),
    ...(request.extraExcludes ?? []),
    ...[...projectEcignore.values()].flat().map((r) => r.pattern),
  ];

  try {
    writer.finalize({
      generator: { app: 'EveryoneCoding', version: '0.1.0', platform: process.platform },
      scope: request.selection.scope,
      includes,
      excludes: excludesList,
      counts: {
        projects: counts.projects,
        memoryItems: counts.memoryItems,
        documents: counts.documents,
        pages: counts.pages,
        codeFiles: counts.codeFiles,
      },
      redacted: redact,
      ...(request.password !== undefined ? { encryption: encryptionInfo() } : {}),
      ...(request.signWithPrivateKeyPem !== undefined ? { signWithPrivateKeyPem: request.signWithPrivateKeyPem } : {}),
    });
  } catch (error) {
    tracker.setStage('failed');
    if (error instanceof EcpkgWriteError) throw error;
    throw error;
  }

  let outputPath = request.outputPath;
  let encrypted = false;

  // 加密：明文中转 → 包裹 → 删中转
  if (request.password !== undefined && request.password.length > 0) {
    tracker.setStage('encrypting');
    try {
      encryptPackage(plainTmpPath, request.outputPath, request.password);
      deletePlainZip(plainTmpPath);
      outputPath = request.outputPath;
      encrypted = true;
    } catch (error) {
      deletePlainZip(plainTmpPath);
      tracker.setStage('failed');
      throw error;
    }
  }

  // 自检：遍历包内文本条目再扫一遍密钥
  const selfCheckFindings: RedactionFinding[] = [];
  const reader = EcpkgReader.open(outputPath, request.password !== undefined ? { password: request.password } : {});
  try {
    for (const entryPath of reader.listEntries()) {
      if (entryPath === PKG_MANIFEST_PATH || entryPath === PKG_CHECKSUM_PATH || entryPath === PKG_SIGNATURE_PATH) {
        continue;
      }
      if (!isTextEntry(entryPath)) continue;
      const text = reader.readEntryText(entryPath);
      for (const finding of scanForSecrets(text, entryPath)) {
        selfCheckFindings.push(finding);
      }
    }
  } finally {
    reader.close();
  }

  const durationMs = Date.now() - startTime;
  const archiveSizeBytes = fs.statSync(outputPath).size;

  tracker.setStage('done');

  return {
    outputPath,
    archiveSizeBytes,
    rawSizeBytes: excludeStats.totalBytes,
    durationMs,
    counts,
    excludeStats,
    redacted: redact,
    redactionFindings,
    selfCheckFindings,
    encrypted,
    warnings: [],
  };
}
