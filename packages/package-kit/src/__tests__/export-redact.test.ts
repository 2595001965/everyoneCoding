/**
 * 脱敏测试（T8-02 / FR-PKG-07）。
 *
 * - 默认脱敏（redact=true）：含 sk-xxx / password= / 连接串的文件导出后包内检索不到明文；
 *   导出后自检 selfCheckFindings 为空；
 * - redact=false：明文保留在包内，自检可发现命中（selfCheckFindings 非空）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EcpkgReader } from '../reader';
import { runExport } from '../export/export-job';
import type { ExportJobRequest } from '../export/export-types';
import { makeFakePort, secretLadenText, type FakeProject } from './export-testkit';

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-redact-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function projectWithSecrets(): FakeProject {
  return {
    id: 'proj-s',
    name: 'S',
    metaJson: JSON.stringify({ id: 'proj-s' }),
    memory: [
      {
        id: 'm1',
        layer: 'project',
        projectId: 'proj-s',
        updatedAt: 1,
        json: JSON.stringify({ id: 'm1', content: secretLadenText() }),
      },
    ],
    documents: [],
    docContents: {},
    codeFiles: { 'src/config.ts': Buffer.from(secretLadenText()) },
    designPages: {},
    designComponents: {},
    anchors: null,
    registry: null,
    pipeline: {},
    ecignore: null,
  };
}

const PLAINTEXT_MARKERS = [
  'sk-abcdefghijklmnopqrstuvwxyz012345',
  'hunter2-password',
  'supersecret',
];

function packageTextBlob(reader: EcpkgReader): string {
  return reader
    .listEntries()
    .filter((p) => p !== 'manifest.json' && p !== 'checksums.sha256' && p !== 'signature.sig')
    .map((p) => reader.readEntryText(p))
    .join('\n');
}

describe('导出脱敏（FR-PKG-07）', () => {
  it('默认脱敏：包内检索不到明文密钥，自检零命中', async () => {
    const port = makeFakePort({ projects: [projectWithSecrets()], attachments: [] });
    const request: ExportJobRequest = {
      outputPath: path.join(workDir, 'redacted.ecpkg'),
      selection: {
        scope: 'all',
        projectIds: [],
        content: {
          memory: fullMem(),
          documents: false,
          code: true,
          pipeline: false,
          anchors: false,
          registry: false,
          attachments: false,
        },
      },
      redact: true,
      useDefaultExcludes: false,
    };
    const result = await runExport(request, port);

    expect(result.redacted).toBe(true);
    expect(result.selfCheckFindings.length).toBe(0);

    const reader = EcpkgReader.open(result.outputPath);
    try {
      const blob = packageTextBlob(reader);
      for (const marker of PLAINTEXT_MARKERS) {
        expect(blob.includes(marker), `包内不应出现明文：${marker}`).toBe(false);
      }
      // 但内容本身仍然在（被脱敏，非清空）
      expect(blob.length).toBeGreaterThan(0);
    } finally {
      reader.close();
    }
  });

  it('redact=false：明文保留在包内，自检发现命中', async () => {
    const port = makeFakePort({ projects: [projectWithSecrets()], attachments: [] });
    const request: ExportJobRequest = {
      outputPath: path.join(workDir, 'not-redacted.ecpkg'),
      selection: {
        scope: 'all',
        projectIds: [],
        content: {
          memory: fullMem(),
          documents: false,
          code: true,
          pipeline: false,
          anchors: false,
          registry: false,
          attachments: false,
        },
      },
      redact: false,
      useDefaultExcludes: false,
    };
    const result = await runExport(request, port);

    expect(result.redacted).toBe(false);
    expect(result.selfCheckFindings.length).toBeGreaterThan(0);

    const reader = EcpkgReader.open(result.outputPath);
    try {
      const blob = packageTextBlob(reader);
      for (const marker of PLAINTEXT_MARKERS) {
        expect(blob.includes(marker), `关闭脱敏后包内应保留明文：${marker}`).toBe(true);
      }
    } finally {
      reader.close();
    }
  });

  it('脱敏命中清单回填 ruleId / 行号 / 预览（预览不含明文）', async () => {
    const port = makeFakePort({ projects: [projectWithSecrets()], attachments: [] });
    const request: ExportJobRequest = {
      outputPath: path.join(workDir, 'findings.ecpkg'),
      selection: {
        scope: 'all',
        projectIds: [],
        content: {
          memory: fullMem(),
          documents: false,
          code: true,
          pipeline: false,
          anchors: false,
          registry: false,
          attachments: false,
        },
      },
      redact: true,
      useDefaultExcludes: false,
    };
    const result = await runExport(request, port);
    expect(result.redactionFindings.length).toBeGreaterThan(0);
    for (const finding of result.redactionFindings) {
      expect(finding.ruleId.length).toBeGreaterThan(0);
      expect(finding.line).toBeGreaterThan(0);
      for (const marker of PLAINTEXT_MARKERS) {
        expect(finding.preview.includes(marker), `预览不应含明文：${marker}`).toBe(false);
      }
    }
  });
});

function fullMem() {
  return { longterm: true, project: true, feature: true, page: true, issue: true };
}
