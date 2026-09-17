import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EcpkgWriter } from '../writer';
import { compareIncrementalVolume, isInIncrementalWindow } from '../incremental';

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-incremental-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** 一个 100 文件代码工程的记忆/文档镜像对象（带 updatedAt） */
interface FixtureObject {
  packagePath: string;
  updatedAt: number;
  content: string;
}

function buildFixture(): FixtureObject[] {
  const objects: FixtureObject[] = [];
  for (let i = 0; i < 100; i += 1) {
    objects.push({
      packagePath: `projects/proj-1/code/src/module_${i}.ts`,
      updatedAt: 1_720_000_000_000 + i * 1000,
      content: `// module ${i}\n${`export const value_${i} = ${i}; // placeholder content for volume test\n`.repeat(20)}`,
    });
  }
  return objects;
}

function writePackage(outputPath: string, objects: readonly FixtureObject[]): number {
  const writer = EcpkgWriter.create(outputPath);
  for (const object of objects) {
    writer.writeTextEntry(object.packagePath, object.content);
  }
  const result = writer.finalize({
    generator: { app: 'EveryoneCoding', version: '0.1.0', platform: 'win32-x64' },
    scope: 'all',
    includes: ['code'],
    excludes: [],
    counts: { projects: 1, memoryItems: 0, documents: 0, pages: 0, codeFiles: objects.length },
    redacted: false,
  });
  return result.archiveSizeBytes;
}

/**
 * 增量包体积与变更量成正比（验收：对比全量包体积）。
 *
 * 口径：100 个代码文件的全量包 vs 只有 2 个文件在游标之后的增量包。
 * 过滤判据与导出流水线（ExportJobRequest.updatedSince）一致：
 * `isInIncrementalWindow(updatedAt, updatedSince)`。
 */
describe('增量包体积对比（T8-04 验收）', () => {
  it('2/100 变更的增量包体积显著小于全量包', () => {
    const fixture = buildFixture();
    const cursorSince = 1_720_000_000_000 + 97 * 1000; // 最后 3 个文件之后

    const fullPath = path.join(workDir, 'full.ecpkg');
    const incrementalPath = path.join(workDir, 'incremental.ecpkg');
    const fullBytes = writePackage(fullPath, fixture);
    const incrementalBytes = writePackage(
      incrementalPath,
      fixture.filter((object) => isInIncrementalWindow(object.updatedAt, cursorSince)),
    );

    const comparison = compareIncrementalVolume(fullBytes, incrementalBytes);
    expect(comparison.incrementalBytes).toBeLessThan(fullBytes * 0.2); // 2% 变更 → 增量 < 20% 全量
    process.stdout.write(
      `[增量体积实测] 全量 ${fullBytes} 字节（100 文件），增量 ${incrementalBytes} 字节（2 文件变更），` +
        `占比 ${(comparison.ratio * 100).toFixed(1)}%\n`,
    );
  });

  it('游标之后无变更 → 增量包只剩骨架（接近最小体积）', () => {
    const fixture = buildFixture();
    const cursorSince = 1_720_000_000_000 + 200 * 1000; // 全部变更都在游标之前
    const fullPath = path.join(workDir, 'full-2.ecpkg');
    const emptyPath = path.join(workDir, 'empty-incremental.ecpkg');
    const fullBytes = writePackage(fullPath, fixture);
    const incrementalBytes = writePackage(
      emptyPath,
      fixture.filter((object) => isInIncrementalWindow(object.updatedAt, cursorSince)),
    );
    expect(incrementalBytes).toBeLessThan(fullBytes * 0.05);
  });
});
