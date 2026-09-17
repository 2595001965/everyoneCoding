/**
 * 导出三种范围集成测试（T8-02 / FR-PKG-02）。
 *
 * 内存 ExportSourcePort + runExport，分别验证：
 * - scope=all：导出全部项目；
 * - scope=project：仅导出指定单项目；
 * - scope=selected：仅导出勾选集合。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EcpkgReader } from '../reader';
import { runExport } from '../export/export-job';
import type { ExportJobRequest, ExportMemoryItem } from '../export/export-types';
import { makeFakePort, type FakeProject } from './export-testkit';

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-scopes-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function mem(id: string, layer: ExportMemoryItem['layer'], projectId: string | null, content: string): ExportMemoryItem {
  return { id, layer, projectId, updatedAt: 1, json: JSON.stringify({ id, layer, content }) };
}

function projectA(): FakeProject {
  return {
    id: 'proj-a',
    name: '项目A',
    metaJson: JSON.stringify({ id: 'proj-a', name: '项目A' }),
    memory: [
      mem('ma1', 'project', 'proj-a', 'A 的项目记忆'),
      mem('ma2', 'feature', 'proj-a', 'A 的功能记忆'),
    ],
    linksJson: JSON.stringify([{ sourceId: 'ma1', targetType: 'document', targetId: 'doc-a' }]),
    documents: [{ id: 'doc-a', name: 'a.md', projectId: 'proj-a', updatedAt: 1 }],
    docContents: { 'doc-a': Buffer.from('# 文档A\n') },
    codeFiles: { 'src/app.ts': Buffer.from('export const a = 1;\n') },
    designPages: { 'home.dsl.json': JSON.stringify({ pageId: 'home' }) },
    designComponents: { 'card.json': JSON.stringify({ name: 'card' }) },
    anchors: JSON.stringify([{ id: 'anc-a', symbol: 'App' }]),
    registry: JSON.stringify([{ entityType: 'element', entityId: 'el-a' }]),
    pipeline: { 'S1/需求.v1.json': Buffer.from(JSON.stringify({ stage: 'S1' })) },
    ecignore: null,
  };
}

function projectB(): FakeProject {
  return {
    id: 'proj-b',
    name: '项目B',
    metaJson: JSON.stringify({ id: 'proj-b', name: '项目B' }),
    memory: [mem('mb1', 'project', 'proj-b', 'B 的项目记忆')],
    documents: [{ id: 'doc-b', name: 'b.md', projectId: 'proj-b', updatedAt: 1 }],
    docContents: { 'doc-b': Buffer.from('# 文档B\n') },
    codeFiles: { 'src/main.ts': Buffer.from('export const b = 2;\n') },
    designPages: {},
    designComponents: {},
    anchors: null,
    registry: null,
    pipeline: {},
    ecignore: null,
  };
}

function baseRequest(outputName: string, selection: ExportJobRequest['selection']): ExportJobRequest {
  return {
    outputPath: path.join(workDir, outputName),
    selection,
    redact: false,
    useDefaultExcludes: false,
  };
}

describe('导出三种范围（T8-02）', () => {
  it('scope=all：导出全部项目记忆/文档/代码/设计/锚点/注册表/流水线', async () => {
    const port = makeFakePort({ projects: [projectA(), projectB()], attachments: [] });
    const result = await runExport(
      baseRequest('all.ecpkg', { scope: 'all', projectIds: [], content: fullContent() }),
      port,
    );
    expect(result.counts.projects).toBe(2);
    expect(result.counts.memoryItems).toBe(3);
    expect(result.counts.documents).toBe(2);
    expect(result.counts.codeFiles).toBe(2);
    expect(result.counts.pages).toBe(1);
    expect(result.excludeStats.excludedFiles).toBe(0);

    const reader = EcpkgReader.open(result.outputPath);
    try {
      expect(reader.hasEntry('projects/proj-a/meta.json')).toBe(true);
      expect(reader.hasEntry('projects/proj-b/meta.json')).toBe(true);
      expect(reader.hasEntry('memory/projects/proj-a/project.jsonl')).toBe(true);
      expect(reader.hasEntry('memory/projects/proj-b/project.jsonl')).toBe(true);
      expect(reader.hasEntry('documents/doc-a/a.md')).toBe(true);
      expect(reader.hasEntry('documents/doc-b/b.md')).toBe(true);
      expect(reader.readEntryText('projects/proj-a/code/src/app.ts')).toContain('export const a');
      expect(reader.readEntryText('projects/proj-b/code/src/main.ts')).toContain('export const b');
      expect(reader.manifest.scope).toBe('all');
    } finally {
      reader.close();
    }
  });

  it('scope=project：仅导出指定单项目（proj-a），proj-b 不出现', async () => {
    const port = makeFakePort({ projects: [projectA(), projectB()], attachments: [] });
    const result = await runExport(
      baseRequest('project.ecpkg', { scope: 'project', projectIds: ['proj-a'], content: fullContent() }),
      port,
    );
    expect(result.counts.projects).toBe(1);
    expect(result.counts.memoryItems).toBe(2);
    expect(result.counts.documents).toBe(1);

    const reader = EcpkgReader.open(result.outputPath);
    try {
      expect(reader.hasEntry('projects/proj-a/meta.json')).toBe(true);
      expect(reader.hasEntry('projects/proj-b/meta.json')).toBe(false);
      expect(reader.hasEntry('documents/doc-a/a.md')).toBe(true);
      expect(reader.hasEntry('documents/doc-b/b.md')).toBe(false);
      expect(reader.manifest.scope).toBe('project');
    } finally {
      reader.close();
    }
  });

  it('scope=selected：仅导出勾选集合（proj-a）', async () => {
    const port = makeFakePort({ projects: [projectA(), projectB()], attachments: [] });
    const result = await runExport(
      baseRequest('selected.ecpkg', { scope: 'selected', projectIds: ['proj-a'], content: fullContent() }),
      port,
    );
    expect(result.counts.projects).toBe(1);
    expect(result.counts.memoryItems).toBe(2);

    const reader = EcpkgReader.open(result.outputPath);
    try {
      expect(reader.hasEntry('projects/proj-a/meta.json')).toBe(true);
      expect(reader.hasEntry('projects/proj-b/meta.json')).toBe(false);
      expect(reader.manifest.scope).toBe('selected');
    } finally {
      reader.close();
    }
  });

  it('自定义勾选：关闭代码/文档，仅导出记忆与元信息', async () => {
    const port = makeFakePort({ projects: [projectA()], attachments: [] });
    const result = await runExport(
      baseRequest('partial.ecpkg', {
        scope: 'all',
        projectIds: [],
        content: {
          memory: { longterm: true, project: true, feature: true, page: true, issue: true },
          documents: false,
          code: false,
          pipeline: false,
          anchors: false,
          registry: false,
          attachments: false,
        },
      }),
      port,
    );
    expect(result.counts.documents).toBe(0);
    expect(result.counts.codeFiles).toBe(0);
    // 设计页面/组件无独立勾选项，始终随项目导出（proj-a 含 1 个页面）
    expect(result.counts.pages).toBe(1);

    const reader = EcpkgReader.open(result.outputPath);
    try {
      expect(reader.hasEntry('documents/doc-a/a.md')).toBe(false);
      expect(reader.hasEntry('projects/proj-a/code/src/app.ts')).toBe(false);
      expect(reader.readEntryText('memory/projects/proj-a/project.jsonl')).toContain('A 的项目记忆');
    } finally {
      reader.close();
    }
  });
});

function fullContent() {
  return {
    memory: { longterm: true, project: true, feature: true, page: true, issue: true },
    documents: true,
    code: true,
    pipeline: true,
    anchors: true,
    registry: true,
    attachments: true,
  };
}
