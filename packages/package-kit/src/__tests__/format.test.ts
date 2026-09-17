import { describe, expect, it } from 'vitest';

import {
  COMPATIBILITY_MATRIX,
  checkFormatCompatibility,
  compareFormatVersions,
  parseFormatVersion,
} from '../format/version';
import {
  assertLayoutStructure,
  attachmentsDir,
  classifyLayoutPath,
  documentDir,
  documentsIndexPath,
  longtermMemoryPath,
  normalizePackagePath,
  projectAnchorsPath,
  projectCodeDir,
  projectMemoryJsonlPath,
  projectMetaPath,
  projectPagesDir,
  projectRegistryPath,
} from '../format/layout';
import { buildManifest, parseManifest } from '../format/manifest';
import {
  buildChecksums,
  parseChecksumFile,
  serializeChecksumFile,
  sha256Hex,
  verifyChecksums,
} from '../format/checksum';
import { generateEd25519KeyPair, signManifest, verifyManifestSignature } from '../format/signature';

describe('格式版本与兼容策略（FR-PKG-03 / NFR-C-04）', () => {
  it('语义化版本解析与比较', () => {
    expect(parseFormatVersion('1.0.0')).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseFormatVersion('1.02.0')).toBeNull();
    expect(parseFormatVersion('1.0')).toBeNull();
    expect(parseFormatVersion('v1.0.0')).toBeNull();

    expect(compareFormatVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareFormatVersions('1.0.0', '1.1.0')).toBe(-1);
    expect(compareFormatVersions('2.0.0', '1.9.9')).toBe(1);
  });

  it('兼容矩阵覆盖近 3 个格式版本场景（逐条断言）', () => {
    for (const matrixCase of COMPATIBILITY_MATRIX) {
      const result = checkFormatCompatibility(matrixCase.packageVersion, matrixCase.clientVersion);
      expect(result.status, matrixCase.name).toBe(matrixCase.expected);
    }
  });

  it('高版本包在低版本客户端给出明确的"需升级"提示（含最低所需版本）', () => {
    const result = checkFormatCompatibility('2.0.0', '1.0.0');
    expect(result.status).toBe('requires-upgrade');
    expect(result.message).toContain('需升级');
    expect(result.message).toContain('2.0.0');
    expect(result.message).toContain('1.0.0');
  });

  it('非法版本同样阻断且不静默', () => {
    const result = checkFormatCompatibility('beta-9', '1.0.0');
    expect(result.status).toBe('requires-upgrade');
    expect(result.message).toContain('不合法');
  });
});

describe('§14.1 布局', () => {
  it('路径构造与 §14.1 目录结构一致', () => {
    expect(longtermMemoryPath()).toBe('memory/longterm.jsonl');
    expect(projectMemoryJsonlPath('p1')).toBe('memory/projects/p1/project.jsonl');
    expect(documentsIndexPath()).toBe('documents/index.json');
    expect(documentDir('doc-1')).toBe('documents/doc-1/');
    expect(projectMetaPath('p1')).toBe('projects/p1/meta.json');
    expect(projectPagesDir('p1')).toBe('projects/p1/design/pages/');
    expect(projectAnchorsPath('p1')).toBe('projects/p1/anchors.json');
    expect(projectRegistryPath('p1')).toBe('projects/p1/registry.json');
    expect(projectCodeDir('p1')).toBe('projects/p1/code/');
    expect(attachmentsDir()).toBe('attachments/');
  });

  it('分区分类正确', () => {
    expect(classifyLayoutPath('manifest.json')).toBe('manifest');
    expect(classifyLayoutPath('signature.sig')).toBe('signature');
    expect(classifyLayoutPath('checksums.sha256')).toBe('checksums');
    expect(classifyLayoutPath('memory/longterm.jsonl')).toBe('memory');
    expect(classifyLayoutPath('memory/projects/p1/project.jsonl')).toBe('memory');
    expect(classifyLayoutPath('documents/index.json')).toBe('documents');
    expect(classifyLayoutPath('projects/p1/code/src/App.tsx')).toBe('project');
    expect(classifyLayoutPath('attachments/abc.png')).toBe('attachments');
    expect(classifyLayoutPath('evil/other.json')).toBe('unknown');
  });

  it('路径归一化：反斜杠转正斜杠，拒绝 .. 上跳', () => {
    expect(normalizePackagePath('projects\\p1\\meta.json')).toBe('projects/p1/meta.json');
    expect(normalizePackagePath('./memory/longterm.jsonl')).toBe('memory/longterm.jsonl');
    expect(() => normalizePackagePath('projects/../evil.json')).toThrow('不允许上跳');
    expect(() => normalizePackagePath('')).toThrow('不能为空');
  });

  it('结构断言：完整 §14.1 包零违规', () => {
    const paths = [
      'manifest.json',
      'signature.sig',
      'checksums.sha256',
      'memory/longterm.jsonl',
      'memory/projects/p1/project.jsonl',
      'memory/projects/p1/links.json',
      'documents/index.json',
      'documents/doc-1/需求.md',
      'projects/p1/meta.json',
      'projects/p1/design/pages/login.dsl.json',
      'projects/p1/design/components/navbar.json',
      'projects/p1/anchors.json',
      'projects/p1/pipeline/S1/需求文档.v3.json',
      'projects/p1/registry.json',
      'projects/p1/code/src/App.tsx',
      'attachments/9f2c1d.png',
    ];
    expect(assertLayoutStructure(paths)).toEqual([]);
  });

  it('结构断言：缺 manifest、缺 meta.json、缺 index.json、未知分区都要指出', () => {
    const violations = assertLayoutStructure([
      'memory/longterm.jsonl',
      'projects/p1/design/pages/a.dsl.json',
      'documents/doc-1/需求.md',
      'evil/other.json',
    ]);
    const reasons = violations.map((violation) => violation.reason);
    expect(reasons.join('；')).toContain('manifest.json');
    expect(reasons.join('；')).toContain('meta.json');
    expect(reasons.join('；')).toContain('index.json');
    expect(violations.find((violation) => violation.path === 'evil/other.json')).toBeTruthy();
  });
});

describe('manifest（PRD §14.1 字段表 + §13.4 示例）', () => {
  it('按 §13.4 示例字段往返', () => {
    const manifest = buildManifest({
      formatVersion: '1.0.0',
      generator: { app: 'EveryoneCoding', version: '0.9.3', platform: 'win32-x64' },
      exportedAt: '2026-09-07T11:20:00Z',
      scope: 'all',
      includes: ['memory', 'documents', 'design', 'code', 'pipeline', 'anchors', 'registry'],
      excludes: ['node_modules/**', 'dist/**', 'target/**', '.git/**', '*.log'],
      counts: { projects: 3, memoryItems: 412, documents: 27, pages: 68, codeFiles: 1830 },
      encryption: { mode: 'aes-256-gcm', kdf: 'PBKDF2-SHA256', iterations: 210000 },
      redacted: true,
    });
    const text = JSON.stringify(manifest, null, 2);
    const parsed = parseManifest(text);
    expect(parsed).toEqual(manifest);
    expect(parsed.checksums).toEqual({ algorithm: 'sha-256', entries: 'checksums.sha256' });
  });

  it('缺字段 / 非法枚举 / 负数 counts 均被 zod 拦下并指出字段', () => {
    expect(() => parseManifest('{"formatVersion":"1.0.0"}')).toThrow('校验失败');
    expect(() =>
      parseManifest(
        JSON.stringify(
          buildManifest({
            formatVersion: '1.0.0',
            generator: { app: 'E', version: '1', platform: 'win32-x64' },
            exportedAt: '2026-09-07T11:20:00Z',
            scope: 'all',
            includes: ['memory'],
            excludes: [],
            counts: { projects: 0, memoryItems: 0, documents: 0, pages: 0, codeFiles: 0 },
            redacted: false,
          }),
        ).replace('"scope":"all"', '"scope":"everything"'),
      ),
    ).toThrow('scope');
    expect(() =>
      parseManifest(
        JSON.stringify({
          formatVersion: '1.0.0',
          generator: { app: 'E', version: '1', platform: 'win32-x64' },
          exportedAt: '2026-09-07T11:20:00Z',
          scope: 'all',
          includes: [],
          excludes: [],
          counts: { projects: -1, memoryItems: 0, documents: 0, pages: 0, codeFiles: 0 },
          checksums: { algorithm: 'sha-256', entries: 'checksums.sha256' },
          encryption: { mode: 'none' },
          redacted: false,
        }),
      ),
    ).toThrow('counts.projects');
  });
});

describe('SHA-256 校验（FR-PKG-04）', () => {
  it('构建 / 序列化 / 解析 checksums.sha256 往返一致', () => {
    const entries = [
      { path: 'b.txt', content: 'beta' },
      { path: 'a.txt', content: 'alpha' },
    ];
    const map = buildChecksums(entries);
    const text = serializeChecksumFile(map);
    expect(text).toBe(`${sha256Hex('alpha')}  a.txt\n${sha256Hex('beta')}  b.txt\n`);
    expect(parseChecksumFile(text)).toEqual(map);
  });

  it('verifyChecksums 检出篡改与缺失并指出具体文件', async () => {
    const map = new Map<string, string>([
      ['a.txt', sha256Hex('alpha')],
      ['b.txt', sha256Hex('beta')],
      ['gone.txt', sha256Hex('gone')],
    ]);
    const report = await verifyChecksums(map, async (path) => {
      if (path === 'a.txt') return 'alpha';
      if (path === 'b.txt') return 'beta-TAMPERED';
      return null;
    });
    expect(report.ok).toBe(false);
    expect(report.corrupted.map((issue) => issue.path)).toEqual(['b.txt']);
    expect(report.corrupted[0]?.reason).toContain('SHA-256 不符');
    expect(report.missing.map((issue) => issue.path)).toEqual(['gone.txt']);
    expect(report.checked).toBe(2);
  });

  it('parseChecksumFile 拒绝坏行并保留注释/空行兼容', () => {
    const text = `# 注释\n\n${sha256Hex('alpha')}  a.txt\n`;
    expect(parseChecksumFile(text).size).toBe(1);
    expect(() => parseChecksumFile('deadbeef a.txt\n')).toThrow('双空格');
  });
});

describe('Ed25519 签名（FR-PKG-04 验收第 4 条）', () => {
  it('签名可生成与校验；篡改 manifest 后校验失败', () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
    const manifest = { formatVersion: '1.0.0', redacted: true, note: '测试' };
    const signature = signManifest(manifest, privateKeyPem);
    expect(signature.startsWith('ed25519:')).toBe(true);
    expect(verifyManifestSignature(manifest, signature, publicKeyPem)).toBe(true);

    const tampered = { ...manifest, redacted: false };
    expect(verifyManifestSignature(tampered, signature, publicKeyPem)).toBe(false);
  });

  it('签名对象是去掉 signature 字段的规范化字节（回填 signature 后仍可验）', () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
    const base = { formatVersion: '1.0.0', generator: { app: 'E', version: '1', platform: 'win32-x64' } };
    const signature = signManifest(base, privateKeyPem);
    const withSignature = { ...base, signature };
    expect(verifyManifestSignature(withSignature, signature, publicKeyPem)).toBe(true);
  });

  it('非法签名串直接返回 false 而不抛错', () => {
    const { publicKeyPem } = generateEd25519KeyPair();
    expect(verifyManifestSignature({ a: 1 }, 'not-a-signature', publicKeyPem)).toBe(false);
  });
});
