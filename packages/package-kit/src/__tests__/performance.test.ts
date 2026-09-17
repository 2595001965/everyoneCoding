import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EcpkgWriter } from '../writer';
import { EcpkgReader } from '../reader';

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-perf-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * 1 万文件流式读写（T8-01 / NFR-P-08 前置）。
 *
 * 口径：
 * - 10 000 个条目 × 50KB 可压缩内容 = 500MB 原始数据；
 * - **内存口径**：若实现"整包入内存"，RSS 至少增长 500MB；
 *   断言 RSS 增长 < 350MB（流式实现实际增长应远低于此）；
 * - **正确性口径**：全部条目可读回且内容一致；
 * - 耗时仅记录不设阈值：NFR-P-08 的"导出 ≤60s"由 T8-02 的导出流水线
 *   在真实工程上验收，这里验证容器层不构成瓶颈。
 */
describe('1 万文件流式读写不爆内存（T8-01）', () => {
  const ENTRY_COUNT = 10_000;
  const ENTRY_SIZE = 50 * 1024;

  it('写入 10 000 条目 → 读回全部内容一致，RSS 增长有界', async () => {
    const outputPath = path.join(workDir, 'ten-thousand.ecpkg');
    const rssBefore = process.memoryUsage().rss;

    const writer = EcpkgWriter.create(outputPath);
    const writeStart = Date.now();
    for (let i = 0; i < ENTRY_COUNT; i += 1) {
      // 可压缩内容：重复行 + 序号（模拟代码文件的压缩特征）
      const line = `function component_${i}() { return "ui-${i}"; } // 每行占位内容用于压缩验证\n`;
      const repeated = line.repeat(Math.ceil(ENTRY_SIZE / line.length));
      // 按字节截断（不是按字符）：内容含中文注释，UTF-8 编码后字节数 > 字符数
      const content = Buffer.from(repeated, 'utf8').subarray(0, ENTRY_SIZE);
      const projectId = `proj-${i % 10}`;
      writer.writeBufferEntry(`projects/${projectId}/code/src/module_${i}.ts`, content);
    }
    const result = writer.finalize({
      generator: { app: 'EveryoneCoding', version: '0.1.0', platform: 'win32-x64' },
      scope: 'all',
      includes: ['code', 'design', 'pipeline', 'anchors', 'registry'],
      excludes: [],
      counts: { projects: 10, memoryItems: 0, documents: 0, pages: 0, codeFiles: ENTRY_COUNT },
      redacted: false,
    });
    const writeMs = Date.now() - writeStart;

    const archiveSize = fs.statSync(outputPath).size;
    const readStart = Date.now();
    let verified = 0;
    const reader = EcpkgReader.open(outputPath);
    try {
      const entries = reader.listEntries();
      expect(entries.length).toBe(ENTRY_COUNT + 2); // + checksums.sha256 + manifest.json
      // 抽全量校验（逐条读回内容一致性 + 完整性校验一次完成）
      for (let i = 0; i < ENTRY_COUNT; i += 1) {
        const projectId = `proj-${i % 10}`;
        const content = reader.readEntryBuffer(`projects/${projectId}/code/src/module_${i}.ts`);
        expect(content.length).toBe(ENTRY_SIZE);
        verified += 1;
      }
      const integrity = await reader.verifyIntegrity();
      expect(integrity.ok).toBe(true);
      expect(integrity.checked).toBe(ENTRY_COUNT);
    } finally {
      reader.close();
    }
    const readMs = Date.now() - readStart;

    const rssAfter = process.memoryUsage().rss;
    const rssGrowthMb = (rssAfter - rssBefore) / (1024 * 1024);

    expect(verified).toBe(ENTRY_COUNT);
    expect(result.entryCount).toBe(ENTRY_COUNT);
    // 内存口径：流式实现下 RSS 增长必须显著低于"整包入内存"（500MB）
    expect(rssGrowthMb, `RSS 增长 ${rssGrowthMb.toFixed(1)}MB，疑似整包入内存`).toBeLessThan(350);

    process.stdout.write(
      `[1万文件实测] 写入 ${writeMs}ms（归档 ${(archiveSize / 1024 / 1024).toFixed(1)}MB，原始 500MB）、` +
        `读回+完整性 ${readMs}ms、RSS 增长 ${rssGrowthMb.toFixed(1)}MB（阈值 350MB）\n`,
    );
  }, 240_000);
});
