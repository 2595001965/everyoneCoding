/**
 * 导出性能测试（T8-02 / NFR-P-08）。
 *
 * 1 万代码文件（每个 30KB）导出 ≤60s。实测耗时打印到 stdout（vitest 会吞 console.info，
 * 用 process.stdout.write）。复用内存假端口，单文件内容共享一份 buffer 避免无意义分配。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runExport } from '../export/export-job';
import type { ExportJobRequest, ExportSourcePort } from '../export/export-types';

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-perf-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const ENTRY_COUNT = 10_000;
const ENTRY_SIZE = 30 * 1024;

function makePerfPort(): ExportSourcePort {
  // 单行 30KB 内容（无换行 → 自检 split 成本低；无密钥 → 不命中脱敏规则）
  const shared = Buffer.alloc(ENTRY_SIZE, 0x78); // 'x' repeated
  const files: string[] = [];
  for (let i = 0; i < ENTRY_COUNT; i += 1)
    files.push(`src/module_${i.toString().padStart(5, '0')}.ts`);

  return {
    listProjects: () => [
      { id: 'proj-perf', name: 'perf', metaJson: JSON.stringify({ id: 'proj-perf' }) },
    ],
    listMemory: () => [],
    listMemoryLinks: () => [],
    listDocuments: () => [],
    readDocument: () => null,
    listCodeFiles: () => files,
    readCodeFile: () => shared,
    readAnchors: () => null,
    listPipelineFiles: () => [],
    readPipelineFile: () => null,
    readRegistry: () => null,
    listDesignPages: () => [],
    readDesignPage: () => null,
    listDesignComponents: () => [],
    readDesignComponent: () => null,
    listAttachments: () => [],
    readEcignore: () => null,
  };
}

describe('1 万文件导出性能（T8-02）', () => {
  it('写入 10 000 × 30KB 代码文件 ≤60s', async () => {
    const request: ExportJobRequest = {
      outputPath: path.join(workDir, 'ten-thousand.ecpkg'),
      selection: {
        scope: 'all',
        projectIds: [],
        content: {
          memory: allFalse(),
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
    const start = Date.now();
    const result = await runExport(request, makePerfPort());
    const ms = Date.now() - start;

    process.stdout.write(
      `[1万文件导出实测] ${ms}ms（归档 ${(result.archiveSizeBytes / 1024 / 1024).toFixed(1)}MB、` +
        `codeFiles=${result.counts.codeFiles}、排除=${result.excludeStats.excludedFiles}）\n`,
    );

    expect(result.counts.codeFiles).toBe(ENTRY_COUNT);
    expect(ms).toBeLessThanOrEqual(60_000);
  }, 180_000);
});

function allFalse() {
  return { longterm: false, project: false, feature: false, page: false, issue: false };
}
