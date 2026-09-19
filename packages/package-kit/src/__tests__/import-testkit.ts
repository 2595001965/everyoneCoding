/**
 * 导入流水线测试工具：造包（EcpkgWriter）、加密包、篡改包、内存假端口。
 * 非 .test.ts，仅被各 import 测试导入复用。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EcpkgWriter } from '../writer';
import { wrapWithPassword, encryptionMarker } from '../container/envelope';
import type { ContentKind } from '../format/manifest';
import type { EncryptionInfo } from '../format/manifest';
import type { MemoryItem, MemoryScope } from '@ec/memory';
import type { ImportLocalStatePort, ImportTargetPort, PackageObject } from '../import/import-types';

export function tmpFile(name: string): string {
  return path.join(
    os.tmpdir(),
    `ecpkg-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`,
  );
}

/** 构造一个宽松合法的 MemoryItem（测试用，不强制全部不变量） */
export function makeMemoryItem(
  p: Partial<MemoryItem> & { id: string; updatedAt: number },
): MemoryItem {
  return {
    id: p.id,
    userId: p.userId ?? 'U',
    scope: p.scope ?? ('longterm' as MemoryScope),
    projectId: p.projectId ?? null,
    featureId: p.featureId ?? null,
    pageId: p.pageId ?? null,
    elementId: p.elementId ?? null,
    issueId: p.issueId ?? null,
    title: p.title ?? p.content ?? p.id,
    content: p.content ?? '',
    structured: p.structured ?? null,
    tags: p.tags ?? [],
    sourceType: p.sourceType ?? 'manual',
    sourceRef: p.sourceRef ?? null,
    confidence: p.confidence ?? 1,
    importance: p.importance ?? 3,
    status: p.status ?? 'active',
    issueStatus: p.issueStatus ?? null,
    pinned: p.pinned ?? false,
    version: p.version ?? 1,
    createdAt: p.updatedAt,
    updatedAt: p.updatedAt,
    embedding: p.embedding ?? null,
  };
}

export interface PackageSpec {
  memoryLongterm?: MemoryItem[];
  memoryByProject?: Record<string, MemoryItem[]>;
  documents?: Array<{
    id: string;
    name: string;
    projectId: string | null;
    updatedAt: number;
    rawFiles?: Array<{ name: string; content: string }>;
  }>;
  codeFiles?: Array<{ projectId: string; relPath: string; content: string }>;
  designPages?: Array<{
    projectId: string;
    name: string;
    updatedAt: number;
    content: Record<string, unknown>;
  }>;
  registry?: Array<{ projectId: string; updatedAt: number; content: Record<string, unknown> }>;
  anchors?: Array<{ projectId: string; updatedAt: number; content: Record<string, unknown> }>;
  pipeline?: Array<{ projectId: string; relPath: string; content: Record<string, unknown> }>;
  projects?: Array<{ id: string; name: string; meta?: Record<string, unknown> }>;
  formatVersion?: string;
  signWithPrivateKeyPem?: string;
  redacted?: boolean;
  encryption?: EncryptionInfo;
}

export function buildPackage(spec: PackageSpec): string {
  const out = tmpFile('pkg.ecpkg');
  const writer = EcpkgWriter.create(out);
  const includes = new Set<ContentKind>();

  if (spec.memoryLongterm?.length || Object.keys(spec.memoryByProject ?? {}).length)
    includes.add('memory');
  if (spec.documents?.length) includes.add('documents');
  if (spec.codeFiles?.length) includes.add('code');
  if (spec.designPages?.length) includes.add('design');
  if (spec.registry?.length) includes.add('registry');
  if (spec.anchors?.length) includes.add('anchors');
  if (spec.pipeline?.length) includes.add('pipeline');

  if (spec.memoryLongterm?.length) {
    writer.writeTextEntry(
      'memory/longterm.jsonl',
      spec.memoryLongterm.map((m) => JSON.stringify(m)).join('\n') + '\n',
    );
  }
  for (const [pid, items] of Object.entries(spec.memoryByProject ?? {})) {
    writer.writeTextEntry(
      `memory/projects/${pid}/project.jsonl`,
      items.map((m) => JSON.stringify(m)).join('\n') + '\n',
    );
  }
  for (const pr of spec.projects ?? []) {
    writer.writeTextEntry(
      `projects/${pr.id}/meta.json`,
      JSON.stringify({ id: pr.id, name: pr.name, metaJson: JSON.stringify(pr.meta ?? {}) }),
    );
  }
  if (spec.documents?.length) {
    const index = spec.documents.map((d) => ({
      id: d.id,
      name: d.name,
      projectId: d.projectId,
      updatedAt: d.updatedAt,
    }));
    writer.writeTextEntry('documents/index.json', JSON.stringify(index));
    for (const d of spec.documents) {
      for (const f of d.rawFiles ?? []) {
        writer.writeBufferEntry(`documents/${d.id}/${f.name}`, Buffer.from(f.content, 'utf8'));
      }
    }
  }
  for (const dp of spec.designPages ?? []) {
    writer.writeTextEntry(
      `projects/${dp.projectId}/design/pages/${dp.name}.json`,
      JSON.stringify({ ...dp.content, id: dp.name, updatedAt: dp.updatedAt }),
    );
  }
  for (const r of spec.registry ?? []) {
    writer.writeTextEntry(
      `projects/${r.projectId}/registry.json`,
      JSON.stringify({ ...r.content, updatedAt: r.updatedAt }),
    );
  }
  for (const a of spec.anchors ?? []) {
    writer.writeTextEntry(
      `projects/${a.projectId}/anchors.json`,
      JSON.stringify({ ...a.content, updatedAt: a.updatedAt }),
    );
  }
  for (const pl of spec.pipeline ?? []) {
    writer.writeTextEntry(
      `projects/${pl.projectId}/pipeline/${pl.relPath}`,
      JSON.stringify(pl.content),
    );
  }
  for (const c of spec.codeFiles ?? []) {
    writer.writeTextEntry(`projects/${c.projectId}/code/${c.relPath}`, c.content);
  }

  writer.finalize({
    generator: { app: 'everyonecoding', version: '1.0.0', platform: 'win32' },
    scope: 'all',
    includes: [...includes],
    excludes: [],
    counts: {
      projects: spec.projects?.length ?? 0,
      memoryItems:
        (spec.memoryLongterm?.length ?? 0) +
        Object.values(spec.memoryByProject ?? {}).reduce((sum, arr) => sum + arr.length, 0),
      documents: spec.documents?.length ?? 0,
      pages: spec.designPages?.length ?? 0,
      codeFiles: spec.codeFiles?.length ?? 0,
    },
    redacted: spec.redacted ?? false,
    formatVersion: spec.formatVersion,
    signWithPrivateKeyPem: spec.signWithPrivateKeyPem,
    encryption: spec.encryption,
  });
  return out;
}

export function buildEncryptedPackage(spec: PackageSpec, password: string): string {
  const plain = buildPackage({ ...spec, encryption: encryptionMarker() });
  const enc = tmpFile('enc.ecpkg');
  wrapWithPassword(plain, enc, password);
  fs.unlinkSync(plain);
  return enc;
}

/** 翻转一个字节（落在首个内容条目区域），致其 SHA-256 不符 */
export function tamperPackage(srcPath: string): string {
  const dest = tmpFile('tampered.ecpkg');
  const buf = fs.readFileSync(srcPath);
  const copy = Buffer.from(buf);
  const offset = Math.min(60, copy.length - 1);
  copy[offset] = ((copy[offset] ?? 0) ^ 0x01) & 0xff;
  fs.writeFileSync(dest, copy);
  return dest;
}

/** 内存版本地状态端口（差异分类用） */
export function makeLocalPort(seed: PackageObject[] = []): ImportLocalStatePort {
  const store = new Map<string, PackageObject>(seed.map((o) => [o.id, o]));
  return {
    listProjects() {
      const ids = new Set<string>();
      for (const o of store.values()) if (o.projectId) ids.add(o.projectId);
      return [...ids].map((id) => ({ id, name: id, updatedAt: 0 }));
    },
    listObjects(type, projectId) {
      return [...store.values()].filter(
        (o) => o.type === type && (projectId === null || o.projectId === projectId),
      );
    },
  };
}

export interface FakeTarget {
  port: ImportTargetPort;
  objects: Map<string, PackageObject>;
  files: Map<string, Buffer>;
  projects: Map<string, { id: string; name: string; metaJson: string }>;
  memory: Map<string, string>;
  superseded: string[];
}

/** 内存版落库端口（断言落库效果用） */
export function makeTargetPort(): FakeTarget {
  const objects = new Map<string, PackageObject>();
  const files = new Map<string, Buffer>();
  const projects = new Map<string, { id: string; name: string; metaJson: string }>();
  const memory = new Map<string, string>();
  const superseded: string[] = [];

  const port: ImportTargetPort = {
    upsertProject(meta) {
      const existed = projects.has(meta.id);
      projects.set(meta.id, meta);
      return existed ? 'updated' : 'created';
    },
    putObject(object) {
      const existed = objects.has(object.id);
      objects.set(object.id, object);
      return existed ? 'updated' : 'created';
    },
    putFile(packagePath, content) {
      const existed = files.has(packagePath);
      files.set(packagePath, content);
      return existed ? 'updated' : 'created';
    },
    applyMemoryMerge(intents) {
      let created = 0;
      let updated = 0;
      for (const it of intents.toCreate) {
        const parsed = JSON.parse(it.json) as { id: string };
        const existed = memory.has(parsed.id);
        memory.set(parsed.id, it.json);
        if (!existed) created += 1;
        else updated += 1;
      }
      for (const it of intents.toUpdate) {
        const parsed = JSON.parse(it.json) as { id: string };
        memory.set(parsed.id, it.json);
        updated += 1;
      }
      for (const id of intents.toSupersede) superseded.push(id);
      return { created, updated, superseded: intents.toSupersede.length };
    },
  };

  return { port, objects, files, projects, memory, superseded };
}
