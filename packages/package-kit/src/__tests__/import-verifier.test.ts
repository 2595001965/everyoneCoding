import { describe, expect, it } from 'vitest';

import { generateEd25519KeyPair } from '../format/signature';
import { verifyPackage } from '../import/verifier';
import { buildEncryptedPackage, buildPackage, makeMemoryItem, tamperPackage } from './import-testkit';

describe('verifyPackage：逐步校验', () => {
  it('合法明文包：全部步骤通过 ok=true', async () => {
    const pkg = buildPackage({
      memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: '命名规范' })],
    });
    const report = await verifyPackage(pkg);
    expect(report.ok).toBe(true);
    expect(report.failureCode).toBeNull();
    expect(report.steps.map((s) => s.step)).toEqual([
      'format-version',
      'integrity',
      'signature',
      'decrypt',
    ]);
    expect(report.steps.every((s) => s.ok)).toBe(true);
  });

  it('篡改字节：failureCode=integrity 且列出具体文件', async () => {
    const pkg = buildPackage({
      memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: '命名规范' })],
    });
    const bad = tamperPackage(pkg);
    const report = await verifyPackage(bad);
    expect(report.ok).toBe(false);
    expect(report.failureCode).toBe('integrity');
    expect(report.failureMessage).toContain('memory/longterm.jsonl');
    expect(report.integrity).not.toBeNull();
  });

  it('格式版本过高：failureCode=version 且提示需升级', async () => {
    const pkg = buildPackage({
      memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'x' })],
      formatVersion: '2.0.0',
    });
    const report = await verifyPackage(pkg);
    expect(report.ok).toBe(false);
    expect(report.failureCode).toBe('version');
    expect(report.failureMessage).toContain('需升级');
    expect(report.failureMessage).toContain('2.0.0');
  });

  it('口令错误：failureCode=password 提示口令错误或包已损坏', async () => {
    const enc = buildEncryptedPackage(
      { memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'x' })] },
      'secret',
    );
    const report = await verifyPackage(enc, { password: 'wrong' });
    expect(report.ok).toBe(false);
    expect(report.failureCode).toBe('password');
    expect(report.failureMessage).toBe('口令错误或包已损坏');
  });

  it('口令正确：加密包可正常通过校验', async () => {
    const enc = buildEncryptedPackage(
      { memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'x' })] },
      'secret',
    );
    const report = await verifyPackage(enc, { password: 'secret' });
    expect(report.ok).toBe(true);
    expect(report.steps.find((s) => s.step === 'decrypt')?.detail).toContain('已成功解密');
  });

  it('签名不符：failureCode=signature', async () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    const pkg = buildPackage({
      memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'x' })],
      signWithPrivateKeyPem: a.privateKeyPem,
    });
    const report = await verifyPackage(pkg, { signaturePublicKeyPem: b.publicKeyPem });
    expect(report.ok).toBe(false);
    expect(report.failureCode).toBe('signature');
  });

  it('签名正确：带签名包可正常通过校验', async () => {
    const a = generateEd25519KeyPair();
    const pkg = buildPackage({
      memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'x' })],
      signWithPrivateKeyPem: a.privateKeyPem,
    });
    const report = await verifyPackage(pkg, { signaturePublicKeyPem: a.publicKeyPem });
    expect(report.ok).toBe(true);
  });

  it('包结构违规（projects/<id>/ 缺 meta.json）：failureCode=structure', async () => {
    // 写入 projects/P1/code/... 但不写 projects/P1/meta.json → 结构断言失败
    const pkg = buildPackage({
      codeFiles: [{ projectId: 'P1', relPath: 'src/app.ts', content: 'console.log(1)' }],
    });
    const report = await verifyPackage(pkg);
    expect(report.ok).toBe(false);
    expect(report.failureCode).toBe('structure');
    expect(report.failureMessage).toContain('meta.json');
  });
});
