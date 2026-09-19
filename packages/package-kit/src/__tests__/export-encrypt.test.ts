/**
 * 加密导出测试（T8-02 / FR-PKG-05）。
 *
 * - 有 password：明文中转 → 包裹成加密包 → 删中转；正确口令可打开且内容完好；
 * - 错误口令：抛 PasswordError 且不产生半解密数据；
 * - 加密包缺口令：明确拒绝；
 * - 口令绝不写入包内任何地方（manifest / 各条目检索不到口令明文）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EcpkgReader } from '../reader';
import { isEncryptedPackage, PasswordError } from '../container/envelope';
import { runExport } from '../export/export-job';
import type { ExportJobRequest } from '../export/export-types';
import { makeFakePort, type FakeProject } from './export-testkit';

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-encrypt-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function plainProject(): FakeProject {
  return {
    id: 'proj-e',
    name: 'E',
    metaJson: JSON.stringify({ id: 'proj-e' }),
    memory: [],
    documents: [{ id: 'doc-e', name: 'e.md', projectId: 'proj-e', updatedAt: 1 }],
    docContents: { 'doc-e': Buffer.from('# 加密文档\n') },
    codeFiles: { 'src/a.ts': Buffer.from('export const x = 1;\n') },
    designPages: {},
    designComponents: {},
    anchors: null,
    registry: null,
    pipeline: {},
    ecignore: null,
  };
}

const PASSWORD = 'correct-horse-battery-🫡';

function selection() {
  return {
    scope: 'all' as const,
    projectIds: [] as string[],
    content: {
      memory: allFalse(),
      documents: true,
      code: true,
      pipeline: false,
      anchors: false,
      registry: false,
      attachments: false,
    },
  };
}

describe('加密导出往返（FR-PKG-05）', () => {
  it('加密包可被正确口令打开，内容完好；明文中转文件已删除', async () => {
    const port = makeFakePort({ projects: [plainProject()], attachments: [] });
    const outPath = path.join(workDir, 'encrypted.ecpkg');
    const request: ExportJobRequest = {
      outputPath: outPath,
      selection: selection(),
      redact: false,
      password: PASSWORD,
    };
    const result = await runExport(request, port);

    expect(result.encrypted).toBe(true);
    expect(isEncryptedPackage(outPath)).toBe(true);
    // 明文中转文件应已清理
    expect(fs.existsSync(`${outPath}.plain.tmp`)).toBe(false);

    const reader = EcpkgReader.open(outPath, { password: PASSWORD });
    try {
      expect(reader.encrypted).toBe(true);
      expect(reader.manifest.encryption.mode).toBe('aes-256-gcm');
      expect(reader.readEntryText('projects/proj-e/code/src/a.ts')).toContain('export const x');
      expect(reader.readEntryText('documents/doc-e/e.md')).toContain('加密文档');
    } finally {
      reader.close();
    }
  });

  it('错误口令：抛 PasswordError 且不留下半解密临时文件', async () => {
    const port = makeFakePort({ projects: [plainProject()], attachments: [] });
    const outPath = path.join(workDir, 'encrypted2.ecpkg');
    await runExport(
      { outputPath: outPath, selection: selection(), redact: false, password: PASSWORD },
      port,
    );
    expect(() => EcpkgReader.open(outPath, { password: 'wrong-password' })).toThrow(PasswordError);
    const leftovers = fs.readdirSync(workDir).filter((n) => n.includes('.decrypted'));
    expect(leftovers).toEqual([]);
  });

  it('加密包缺口令：明确拒绝', async () => {
    const port = makeFakePort({ projects: [plainProject()], attachments: [] });
    const outPath = path.join(workDir, 'encrypted3.ecpkg');
    await runExport(
      { outputPath: outPath, selection: selection(), redact: false, password: PASSWORD },
      port,
    );
    expect(() => EcpkgReader.open(outPath)).toThrow(/口令|必须提供/);
  });

  it('口令绝不写入包内（manifest 与所有条目检索不到口令明文）', async () => {
    const port = makeFakePort({ projects: [plainProject()], attachments: [] });
    const outPath = path.join(workDir, 'encrypted4.ecpkg');
    await runExport(
      { outputPath: outPath, selection: selection(), redact: false, password: PASSWORD },
      port,
    );

    const reader = EcpkgReader.open(outPath, { password: PASSWORD });
    try {
      for (const entry of reader.listEntries()) {
        const text = reader.readEntryText(entry);
        expect(text.includes(PASSWORD), `条目 ${entry} 不应包含口令明文`).toBe(false);
      }
    } finally {
      reader.close();
    }
  });
});

function allFalse() {
  return { longterm: false, project: false, feature: false, page: false, issue: false };
}
