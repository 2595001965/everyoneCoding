import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EcpkgWriter } from '../writer';
import { EcpkgReader, EcpkgReadError } from '../reader';
import { ZipReader, ZipWriter } from '../container/zip';
import { isEncryptedPackage, PasswordError, wrapWithPassword, encryptionMarker } from '../container/envelope';
import { assertLayoutStructure } from '../format/layout';
import { checkFormatCompatibility } from '../format/version';
import { generateEd25519KeyPair } from '../format/signature';
import { sha256Hex, serializeChecksumFile } from '../format/checksum';
import { buildManifest } from '../format/manifest';

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-roundtrip-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function pkgPath(name: string): string {
  return path.join(workDir, name);
}

/** 构造一个标准 §14.1 布局的测试包（含记忆 / 文档 / 项目 / 代码 / 附件） */
function writeStandardPackage(
  outputPath: string,
  options: {
    formatVersion?: string;
    redacted?: boolean;
    signWithPrivateKeyPem?: string;
    projectCount?: number;
    encrypted?: boolean;
  } = {},
) {
  const writer = EcpkgWriter.create(outputPath);
  const projectCount = options.projectCount ?? 1;
  for (let p = 0; p < projectCount; p += 1) {
    const pid = `proj-${p + 1}`;
    writer.writeTextEntry(
      `memory/projects/${pid}/project.jsonl`,
      JSON.stringify({ id: `m-${pid}-1`, layer: 'project', content: `${pid} 的项目记忆` }),
    );
    writer.writeTextEntry(
      `memory/projects/${pid}/links.json`,
      JSON.stringify([{ sourceId: `m-${pid}-1`, targetType: 'document', targetId: 'doc-1' }]),
    );
    writer.writeTextEntry(
      `projects/${pid}/meta.json`,
      JSON.stringify({ id: pid, name: `项目 ${p + 1}`, targetPlatforms: ['web'] }),
    );
    writer.writeTextEntry(
      `projects/${pid}/design/pages/login.dsl.json`,
      JSON.stringify({ pageId: 'page-login', elements: [] }),
    );
    writer.writeTextEntry(
      `projects/${pid}/anchors.json`,
      JSON.stringify([{ id: 'anc-1', symbol: 'LoginController', filePath: 'src/auth.ts' }]),
    );
    writer.writeTextEntry(`projects/${pid}/pipeline/S1/需求文档.v1.json`, JSON.stringify({ stage: 'S1', version: 1 }));
    writer.writeTextEntry(
      `projects/${pid}/registry.json`,
      JSON.stringify([{ entityType: 'element', entityId: 'el-1', canonicalName: '登录提交' }]),
    );
    writer.writeTextEntry(`projects/${pid}/code/src/auth.ts`, 'export class LoginController {}\n');
  }
  writer.writeTextEntry(
    'memory/longterm.jsonl',
    JSON.stringify({ id: 'm-long-1', layer: 'longterm', content: '以后都用 TypeScript' }),
  );
  writer.writeTextEntry('documents/index.json', JSON.stringify([{ id: 'doc-1', name: '需求.md' }]));
  writer.writeTextEntry('documents/doc-1/需求.md', '# 需求文档\n\n支持账号密码登录。\n');
  writer.writeBufferEntry('attachments/9f2c1d.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]));

  return writer.finalize({
    generator: { app: 'EveryoneCoding', version: '0.9.3', platform: 'win32-x64' },
    scope: 'all',
    includes: ['memory', 'documents', 'design', 'code', 'pipeline', 'anchors', 'registry', 'attachments'],
    excludes: ['node_modules/**', 'dist/**', 'target/**', '.git/**', '*.log'],
    counts: { projects: projectCount, memoryItems: 2, documents: 1, pages: 1, codeFiles: 1 },
    redacted: options.redacted ?? true,
    formatVersion: options.formatVersion,
    signWithPrivateKeyPem: options.signWithPrivateKeyPem,
    encryption: options.encrypted ? encryptionMarker() : undefined,
  });
}

describe('EcpkgWriter / EcpkgReader 往返（T8-01）', () => {
  it('标准包：manifest 字段与 §14.1/§13.4 一致，结构断言零违规', () => {
    const outputPath = pkgPath('standard.ecpkg');
    const result = writeStandardPackage(outputPath);

    expect(result.manifest.formatVersion).toBe('1.0.0');
    expect(result.manifest.generator).toEqual({ app: 'EveryoneCoding', version: '0.9.3', platform: 'win32-x64' });
    expect(result.manifest.scope).toBe('all');
    expect(result.manifest.checksums).toEqual({ algorithm: 'sha-256', entries: 'checksums.sha256' });
    expect(result.manifest.encryption).toEqual({ mode: 'none' });
    expect(result.manifest.redacted).toBe(true);
    expect(result.manifest.counts).toEqual({ projects: 1, memoryItems: 2, documents: 1, pages: 1, codeFiles: 1 });
    expect(fs.existsSync(outputPath)).toBe(true);
    // 临时文件已原子替换走
    expect(fs.existsSync(`${outputPath}.writing.tmp`)).toBe(false);

    const reader = EcpkgReader.open(outputPath);
    try {
      expect(reader.manifest.formatVersion).toBe('1.0.0');
      expect(assertLayoutStructure(reader.listEntries())).toEqual([]);
      expect(reader.hasEntry('memory/longterm.jsonl')).toBe(true);
      expect(reader.hasEntry('projects/proj-1/code/src/auth.ts')).toBe(true);
      expect(reader.readEntryText('projects/proj-1/code/src/auth.ts')).toContain('LoginController');
      expect(reader.readEntryBuffer('attachments/9f2c1d.png').subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      expect(reader.declaredFileCount).toBeGreaterThan(0);
    } finally {
      reader.close();
    }
  });

  it('中文条目名往返无损', () => {
    const outputPath = pkgPath('chinese-names.ecpkg');
    const writer = EcpkgWriter.create(outputPath);
    writer.writeTextEntry('documents/doc-中文/需求说明.md', '# 中文需求\n\n内容含中文与 emoji 🫡。\n');
    writer.finalize({
      generator: { app: 'EveryoneCoding', version: '0.1.0', platform: 'win32-x64' },
      scope: 'project',
      includes: ['documents'],
      excludes: [],
      counts: { projects: 0, memoryItems: 0, documents: 1, pages: 0, codeFiles: 0 },
      redacted: false,
    });

    const reader = EcpkgReader.open(outputPath);
    try {
      expect(reader.readEntryText('documents/doc-中文/需求说明.md')).toContain('🫡');
      expect(reader.listEntries().some((entry) => entry.includes('需求说明.md'))).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('逐文件 SHA-256 完整性校验：完好包通过', async () => {
    const outputPath = pkgPath('intact.ecpkg');
    writeStandardPackage(outputPath);
    const reader = EcpkgReader.open(outputPath);
    try {
      const report = await reader.verifyIntegrity();
      expect(report.ok).toBe(true);
      expect(report.corrupted).toEqual([]);
      expect(report.missing).toEqual([]);
      expect(report.checked).toBeGreaterThanOrEqual(8);
    } finally {
      reader.close();
    }
  });

  it('人为篡改包内文件后校验失败并指出具体文件', async () => {
    const outputPath = pkgPath('tampered.ecpkg');
    writeStandardPackage(outputPath);

    // 用 ZIP 目录精确定位该条目的压缩数据起点，翻转第一个字节
    const zip = ZipReader.open(outputPath);
    const entry = zip.entry('projects/proj-1/code/src/auth.ts');
    const dataOffset = entry.localHeaderOffset + 30 + Buffer.byteLength(entry.path, 'utf8');
    const raw = fs.readFileSync(outputPath);
    raw[dataOffset] = raw[dataOffset]! ^ 0xff;
    fs.writeFileSync(outputPath, raw);
    zip.close();

    const reader = EcpkgReader.open(outputPath);
    try {
      const report = await reader.verifyIntegrity();
      expect(report.ok).toBe(false);
      expect(report.corrupted.length).toBeGreaterThanOrEqual(1);
      const hit = report.corrupted.find((issue) => issue.path === 'projects/proj-1/code/src/auth.ts');
      expect(hit, '必须指出被篡改的具体文件').toBeTruthy();
      expect(hit?.reason).toContain('SHA-256 不符');
    } finally {
      reader.close();
    }
  });

  it('包内缺文件时完整性校验给出缺失清单', async () => {
    const outputPath = pkgPath('missing-entry.ecpkg');
    // 用裸 ZipWriter 构造：checksums 里记账了一条指向不存在文件的记录
    // （EcpkgWriter 的 checksums 只来自真实写入的条目，无法伪造"缺文件"场景）
    const zip = ZipWriter.create(outputPath);
    const content = 'longterm memory line\n';
    const map = new Map<string, string>([
      ['memory/longterm.jsonl', sha256Hex(content)],
      ['projects/proj-1/code/src/not-exist.ts', 'd'.repeat(64)],
    ]);
    zip.addText('memory/longterm.jsonl', content);
    zip.addText('checksums.sha256', serializeChecksumFile(map));
    zip.addText(
      'manifest.json',
      JSON.stringify(
        buildManifest({
          formatVersion: '1.0.0',
          generator: { app: 'E', version: '1', platform: 'win32-x64' },
          exportedAt: new Date().toISOString(),
          scope: 'all',
          includes: ['memory', 'code'],
          excludes: [],
          counts: { projects: 1, memoryItems: 1, documents: 0, pages: 0, codeFiles: 1 },
          redacted: false,
        }),
      ),
    );
    zip.close();

    const reader = EcpkgReader.open(outputPath);
    try {
      const report = await reader.verifyIntegrity();
      expect(report.ok).toBe(false);
      expect(report.missing.some((issue) => issue.path.includes('not-exist.ts'))).toBe(true);
      expect(report.checked).toBe(1);
    } finally {
      reader.close();
    }
  });

  it('Ed25519 签名：签名包可通过校验；未配置公钥时跳过；错误公钥判失败', () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
    const outputPath = pkgPath('signed.ecpkg');
    const result = writeStandardPackage(outputPath, { signWithPrivateKeyPem: privateKeyPem });
    expect(result.manifest.signature).toMatch(/^ed25519:/);

    const reader = EcpkgReader.open(outputPath);
    try {
      const withKey = reader.verifySignature(publicKeyPem);
      expect(withKey.hasSignature).toBe(true);
      expect(withKey.valid).toBe(true);
      expect(withKey.detail).toContain('通过');

      const withoutKey = reader.verifySignature();
      expect(withoutKey.hasSignature).toBe(true);
      expect(withoutKey.valid).toBeNull();
      expect(withoutKey.detail).toContain('跳过');

      const wrongKey = reader.verifySignature(generateEd25519KeyPair().publicKeyPem);
      expect(wrongKey.valid).toBe(false);
      expect(wrongKey.detail).toContain('失败');
    } finally {
      reader.close();
    }
  });

  it('无签名包：hasSignature=false 且跳过', () => {
    const outputPath = pkgPath('unsigned.ecpkg');
    writeStandardPackage(outputPath);
    const reader = EcpkgReader.open(outputPath);
    try {
      const result = reader.verifySignature(generateEd25519KeyPair().publicKeyPem);
      expect(result.hasSignature).toBe(false);
      expect(result.valid).toBeNull();
    } finally {
      reader.close();
    }
  });

  it('非法包被明确拒绝：不是 ZIP / 缺 manifest', () => {
    const notZip = pkgPath('not-zip.ecpkg');
    fs.writeFileSync(notZip, 'plain text, definitely not a zip');
    expect(() => EcpkgReader.open(notZip)).toThrow(EcpkgReadError);

    const noManifest = pkgPath('no-manifest.ecpkg');
    const zip = ZipWriter.create(noManifest);
    zip.addText('memory/longterm.jsonl', 'x');
    zip.close();
    // 没有 manifest.json：不是合法的 .ecpkg
    expect(() => EcpkgReader.open(noManifest)).toThrow(/manifest/);
  });

  it('大文件条目走流式写入与流式解出（10MB）', async () => {
    const outputPath = pkgPath('big-entry.ecpkg');
    const bigFile = path.join(workDir, 'big.bin');
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    const handle = fs.openSync(bigFile, 'w');
    for (let i = 0; i < 10; i += 1) {
      fs.writeSync(handle, chunk, 0, chunk.length, i * chunk.length);
    }
    fs.closeSync(handle);

    const writer = EcpkgWriter.create(outputPath);
    await writer.writeFileEntry('attachments/big.bin', bigFile);
    writer.finalize({
      generator: { app: 'E', version: '1', platform: 'win32-x64' },
      scope: 'selected',
      includes: ['attachments'],
      excludes: [],
      counts: { projects: 0, memoryItems: 0, documents: 0, pages: 0, codeFiles: 0 },
      redacted: false,
    });

    const extracted = path.join(workDir, 'extracted-big.bin');
    const reader = EcpkgReader.open(outputPath);
    try {
      await reader.extractEntryTo('attachments/big.bin', extracted);
    } finally {
      reader.close();
    }
    expect(fs.statSync(extracted).size).toBe(10 * 1024 * 1024);
    expect(fs.readFileSync(extracted).subarray(0, 4)).toEqual(Buffer.from([0x5a, 0x5a, 0x5a, 0x5a]));
  });
});

describe('加密信封（FR-PKG-05 容器层）', () => {
  it('明文包不被误判为加密；加密后可识别', () => {
    const plainPath = pkgPath('plain.ecpkg');
    writeStandardPackage(plainPath);
    expect(isEncryptedPackage(plainPath)).toBe(false);
  });

  it('加密往返：正确口令可打开，口令错误明确提示且不产生半解密数据', () => {
    const plainPath = pkgPath('to-encrypt.ecpkg');
    writeStandardPackage(plainPath, { encrypted: true });

    const encryptedPath = pkgPath('encrypted.ecpkg');
    wrapWithPassword(plainPath, encryptedPath, '正确口令-🫡123');
    expect(isEncryptedPackage(encryptedPath)).toBe(true);

    const reader = EcpkgReader.open(encryptedPath, { password: '正确口令-🫡123' });
    try {
      expect(reader.encrypted).toBe(true);
      expect(reader.manifest.encryption.mode).toBe('aes-256-gcm');
      expect(reader.manifest.encryption.mode === 'aes-256-gcm' && reader.manifest.encryption.iterations).toBe(210000);
      expect(reader.readEntryText('memory/longterm.jsonl')).toContain('TypeScript');
    } finally {
      reader.close();
    }

    // 错误口令：明确报错（PasswordError），且不留下任何解密临时文件
    expect(() => EcpkgReader.open(encryptedPath, { password: '错误口令' })).toThrow(PasswordError);
    const leftovers = fs.readdirSync(workDir).filter((name) => name.includes('.decrypted'));
    expect(leftovers).toEqual([]);
  });

  it('加密包缺口令时明确拒绝', () => {
    const plainPath = pkgPath('to-encrypt-2.ecpkg');
    writeStandardPackage(plainPath, { encrypted: true });
    const encryptedPath = pkgPath('encrypted-2.ecpkg');
    wrapWithPassword(plainPath, encryptedPath, 'secret');
    expect(() => EcpkgReader.open(encryptedPath)).toThrow(/必须提供口令/);
  });

  it('manifest 加密标记与实际信封不一致时拒绝（防篡改标记）', () => {
    const plainPath = pkgPath('inconsistent.ecpkg');
    // manifest 声明加密（encrypted: true），但不做信封包裹 → 交叉校验必须拒绝
    writeStandardPackage(plainPath, { encrypted: true });
    expect(() => EcpkgReader.open(plainPath)).toThrow(/标记|篡改|加密/);
  });
});

describe('高版本包在低版本客户端（FR-PKG-03 验收第 3 条）', () => {
  it('读取 manifest.formatVersion 后判定"需升级"，不静默失败', () => {
    const outputPath = pkgPath('future.ecpkg');
    writeStandardPackage(outputPath, { formatVersion: '2.0.0' });

    const reader = EcpkgReader.open(outputPath);
    try {
      const compatibility = checkFormatCompatibility(reader.manifest.formatVersion, '1.0.0');
      expect(compatibility.status).toBe('requires-upgrade');
      expect(compatibility.message).toContain('需升级');
      expect(compatibility.message).toContain('2.0.0');
    } finally {
      reader.close();
    }
  });

  it('同版本与旧版本包判定兼容', () => {
    const outputPath = pkgPath('current.ecpkg');
    writeStandardPackage(outputPath, { formatVersion: '1.0.0' });
    const reader = EcpkgReader.open(outputPath);
    try {
      expect(checkFormatCompatibility(reader.manifest.formatVersion, '1.0.0').status).toBe('compatible');
    } finally {
      reader.close();
    }

    const oldPath = pkgPath('older.ecpkg');
    writeStandardPackage(oldPath, { formatVersion: '0.9.0' });
    const readerOld = EcpkgReader.open(oldPath);
    try {
      expect(checkFormatCompatibility(readerOld.manifest.formatVersion, '1.0.0').status).toBe('compatible');
    } finally {
      readerOld.close();
    }
  });
});

describe('manifest 样例输出（T8-01 验收：输出真实 manifest 样例）', () => {
  it('生成一份真实 manifest 并核对字段集合', () => {
    const outputPath = pkgPath('sample.ecpkg');
    const result = writeStandardPackage(outputPath, { signWithPrivateKeyPem: generateEd25519KeyPair().privateKeyPem });
    const keys = Object.keys(result.manifest);
    expect(keys).toEqual(
      expect.arrayContaining([
        'formatVersion',
        'generator',
        'exportedAt',
        'scope',
        'includes',
        'excludes',
        'counts',
        'checksums',
        'encryption',
        'redacted',
        'signature',
      ]),
    );
    // 留档样例（供任务报告引用）
    fs.writeFileSync(path.join(workDir, 'manifest-sample.json'), JSON.stringify(result.manifest, null, 2), 'utf8');
  });
});
