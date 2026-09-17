/**
 * 导出测试夹具：内存版 ExportSourcePort（T8-02 集成测试用）。
 *
 * 不依赖 @ec/data / @ec/memory，全部用内存 Map 提供，便于在 vitest 里直接构造
 * 各种工程形态（多项目、大体积 node_modules、含密钥文件、加密等）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  ExportDocumentMeta,
  ExportMemoryItem,
  ExportProjectMeta,
  ExportSourcePort,
} from '../export/export-types';

export interface FakeProject {
  id: string;
  name: string;
  metaJson: string;
  memory: ExportMemoryItem[];
  linksJson?: string;
  documents: ExportDocumentMeta[];
  /** docId → 文档内容（单文件，文件名取 doc.name） */
  docContents: Record<string, Buffer>;
  /** 相对代码根的路径 → 内容 */
  codeFiles: Record<string, Buffer>;
  designPages: Record<string, string>;
  designComponents: Record<string, string>;
  anchors: string | null;
  registry: string | null;
  pipeline: Record<string, Buffer>;
  ecignore: string | null;
}

export interface FakeExportConfig {
  projects: FakeProject[];
  attachments: Array<{ hashName: string; content: Buffer }>;
}

export function makeFakePort(config: FakeExportConfig): ExportSourcePort {
  const projects: ExportProjectMeta[] = config.projects.map((p) => ({ id: p.id, name: p.name, metaJson: p.metaJson }));

  const memoryItems: ExportMemoryItem[] = [];
  const memoryLinks: Array<{ projectId: string; linksJson: string }> = [];
  const documents: ExportDocumentMeta[] = [];
  const docContents = new Map<string, Buffer>();
  const codeByProject = new Map<string, Map<string, Buffer>>();
  const designPages = new Map<string, Map<string, string>>();
  const designComponents = new Map<string, Map<string, string>>();
  const anchors = new Map<string, string | null>();
  const registry = new Map<string, string | null>();
  const pipeline = new Map<string, Map<string, Buffer>>();
  const ecignore = new Map<string, string | null>();

  for (const p of config.projects) {
    for (const m of p.memory) memoryItems.push(m);
    if (p.linksJson !== undefined) memoryLinks.push({ projectId: p.id, linksJson: p.linksJson });
    for (const d of p.documents) documents.push(d);
    for (const [docId, content] of Object.entries(p.docContents)) docContents.set(docId, content);
    codeByProject.set(p.id, new Map(Object.entries(p.codeFiles)));
    designPages.set(p.id, new Map(Object.entries(p.designPages)));
    designComponents.set(p.id, new Map(Object.entries(p.designComponents)));
    anchors.set(p.id, p.anchors);
    registry.set(p.id, p.registry);
    pipeline.set(p.id, new Map(Object.entries(p.pipeline)));
    ecignore.set(p.id, p.ecignore);
  }

  // 附件落到临时文件（writeFileEntry 走磁盘流式）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-att-'));
  const attachments = config.attachments.map((att) => {
    const sourcePath = path.join(tmpDir, att.hashName);
    fs.writeFileSync(sourcePath, att.content);
    return { hashName: att.hashName, sourcePath };
  });

  return {
    listProjects: () => projects,
    listMemory: (projectIds, layers) => {
      const longtermOk = layers.longterm;
      const projOk = layers.project;
      const featureOk = layers.feature;
      const pageOk = layers.page;
      const issueOk = layers.issue;
      return memoryItems.filter((m) => {
        if (projectIds !== null && m.projectId !== null && !projectIds.includes(m.projectId)) return false;
        if (projectIds !== null && m.projectId === null) {
          // 长期记忆：仅当 projectIds 为 null（全范围）时返回
          if (projectIds.length > 0) return false;
        }
        switch (m.layer) {
          case 'longterm':
            return longtermOk;
          case 'project':
            return projOk;
          case 'feature':
            return featureOk;
          case 'page':
            return pageOk;
          case 'issue':
            return issueOk;
          default:
            return false;
        }
      });
    },
    listMemoryLinks: (projectIds) =>
      projectIds === null
        ? memoryLinks
        : memoryLinks.filter((l) => projectIds.includes(l.projectId)),
    listDocuments: (projectIds) =>
      projectIds === null ? documents : documents.filter((d) => d.projectId === null || projectIds.includes(d.projectId)),
    readDocument: (docId) => {
      const content = docContents.get(docId);
      return content === undefined ? null : { content };
    },
    listCodeFiles: (projectId) => [...(codeByProject.get(projectId)?.keys() ?? [])],
    readCodeFile: (projectId, rel) => codeByProject.get(projectId)?.get(rel) ?? null,
    readAnchors: (projectId) => anchors.get(projectId) ?? null,
    listPipelineFiles: (projectId) => [...(pipeline.get(projectId)?.keys() ?? [])],
    readPipelineFile: (projectId, rel) => pipeline.get(projectId)?.get(rel) ?? null,
    readRegistry: (projectId) => registry.get(projectId) ?? null,
    listDesignPages: (projectId) => [...(designPages.get(projectId)?.keys() ?? [])],
    readDesignPage: (projectId, fileName) => designPages.get(projectId)?.get(fileName) ?? null,
    listDesignComponents: (projectId) => [...(designComponents.get(projectId)?.keys() ?? [])],
    readDesignComponent: (projectId, fileName) => designComponents.get(projectId)?.get(fileName) ?? null,
    listAttachments: () => attachments,
    readEcignore: (projectId) => ecignore.get(projectId) ?? null,
  };
}

/** 构造一份含密钥的文本条目内容（测试脱敏用） */
export function secretLadenText(): string {
  return [
    'const config = {',
    '  apiKey: "sk-abcdefghijklmnopqrstuvwxyz012345",',
    '  dbUrl: "postgres://admin:supersecret@db.example.com:5432/app",',
    '  password: "hunter2-password",',
    '};',
    '',
  ].join('\n');
}
