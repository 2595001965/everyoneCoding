/**
 * 排除规则测试（T8-02 / FR-PKG-06）。
 *
 * - 模块级：gitignore 子集语法（注释、`*`、`**`、`?`、`/` 锚定、目录规则）、
 *   matchExclude、computeExcludeStats 的每条规则命中数；
 * - 集成级：默认规则下"90% 体积是 node_modules"的假工程，包体积下降率 ≥60%。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EcpkgReader } from '../reader';
import { runExport } from '../export/export-job';
import { computeExcludeStats, matchExclude, parseEcignore, DEFAULT_EXCLUDE_RULES } from '../export/exclude-rules';
import type { ExportJobRequest } from '../export/export-types';
import { makeFakePort, type FakeProject } from './export-testkit';

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-exclude-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('gitignore 子集语法匹配', () => {
  it('注释 / 空行永不命中', () => {
    expect(matchExclude('src/app.ts', parseEcignore('# 这是注释\n\n'))).toBe(false);
  });

  it('`*` 匹配段内任意字符（不含 /）', () => {
    expect(matchExclude('a.log', [{ pattern: '*.log', builtin: false }])).toBe(true);
    expect(matchExclude('dir/a.log', [{ pattern: '*.log', builtin: false }])).toBe(true);
    expect(matchExclude('a.txt', [{ pattern: '*.log', builtin: false }])).toBe(false);
  });

  it('`**` 跨越任意层级目录', () => {
    expect(matchExclude('node_modules/a/b/c.js', [{ pattern: 'node_modules/**', builtin: false }])).toBe(true);
    expect(matchExclude('node_modules/a.js', [{ pattern: 'node_modules/**', builtin: false }])).toBe(true);
  });

  it('目录规则 `foo/` 命中目录本身及全部后代', () => {
    expect(matchExclude('build/out.js', [{ pattern: 'build/', builtin: false }])).toBe(true);
    expect(matchExclude('build/a/b.js', [{ pattern: 'build/', builtin: false }])).toBe(true);
  });

  it('行首 `/` 锚定到工程根（子目录同名不命中）', () => {
    const rules = [{ pattern: '/dist', builtin: false }];
    expect(matchExclude('dist/x.js', rules)).toBe(true);
    expect(matchExclude('src/dist/x.js', rules)).toBe(false);
  });

  it('`?` 匹配单个非 / 字符', () => {
    expect(matchExclude('v1.log', [{ pattern: 'v?.log', builtin: false }])).toBe(true);
    expect(matchExclude('v12.log', [{ pattern: 'v?.log', builtin: false }])).toBe(false);
  });
});

describe('computeExcludeStats 命中统计', () => {
  it('统计每条规则命中数与总量', () => {
    const stats = computeExcludeStats(
      [
        { path: 'node_modules/a.js', bytes: 1000 },
        { path: 'src/app.ts', bytes: 100 },
        { path: 'debug.log', bytes: 200 },
      ],
      [
        { pattern: 'node_modules/**', builtin: true },
        { pattern: '*.log', builtin: true },
      ],
    );
    expect(stats.totalFiles).toBe(3);
    expect(stats.totalBytes).toBe(1300);
    expect(stats.excludedFiles).toBe(2);
    expect(stats.excludedBytes).toBe(1200);
    expect(stats.reductionRatio).toBeCloseTo(1200 / 1300, 5);
    const byPattern = new Map(stats.hitsByPattern.map((h) => [h.pattern, h]));
    expect(byPattern.get('node_modules/**')?.files).toBe(1);
    expect(byPattern.get('*.log')?.files).toBe(1);
  });
});

describe('默认规则 + 项目级 .ecignore 集成（体积下降 ≥60%）', () => {
  it('默认规则下 node_modules 占 90% 体积 → 下降率 ≥0.6，且大文件不进包', async () => {
    const kb = 1024;
    const proj: FakeProject = {
      id: 'proj-x',
      name: 'X',
      metaJson: JSON.stringify({ id: 'proj-x' }),
      memory: [],
      documents: [],
      docContents: {},
      // node_modules 占 900KB（90%），其余散文件共 ~100KB
      codeFiles: {
        'node_modules/big.js': Buffer.alloc(900 * kb, 0x61),
        'src/app.ts': Buffer.alloc(100, 0x62),
        'debug.log': Buffer.alloc(10 * kb, 0x63),
      },
      designPages: {},
      designComponents: {},
      anchors: null,
      registry: null,
      pipeline: {},
      ecignore: null,
    };
    const port = makeFakePort({ projects: [proj], attachments: [] });
    const request: ExportJobRequest = {
      outputPath: path.join(workDir, 'reduced.ecpkg'),
      selection: {
        scope: 'all',
        projectIds: [],
        content: { memory: emptyMem(), documents: false, code: true, pipeline: false, anchors: false, registry: false, attachments: false },
      },
      redact: false,
      useDefaultExcludes: true,
    };
    const result = await runExport(request, port);

    process.stdout.write(
      `[排除率实测] totalBytes=${(result.excludeStats.totalBytes / kb).toFixed(1)}KB, ` +
        `excluded=${(result.excludeStats.excludedBytes / kb).toFixed(1)}KB, ` +
        `reductionRatio=${result.excludeStats.reductionRatio.toFixed(4)}, ` +
        `archive=${(result.archiveSizeBytes / kb).toFixed(1)}KB\n`,
    );

    expect(result.excludeStats.reductionRatio).toBeGreaterThanOrEqual(0.6);
    expect(result.excludeStats.excludedFiles).toBeGreaterThanOrEqual(2);

    const reader = EcpkgReader.open(result.outputPath);
    try {
      // 被排除的大文件 / 日志不应出现在包内
      expect(reader.hasEntry('projects/proj-x/code/node_modules/big.js')).toBe(false);
      expect(reader.hasEntry('projects/proj-x/code/debug.log')).toBe(false);
      // 源码保留
      expect(reader.hasEntry('projects/proj-x/code/src/app.ts')).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('项目级 .ecignore 追加规则（secret/**）生效，命中计入统计', async () => {
    const kb = 1024;
    const proj: FakeProject = {
      id: 'proj-y',
      name: 'Y',
      metaJson: JSON.stringify({ id: 'proj-y' }),
      memory: [],
      documents: [],
      docContents: {},
      codeFiles: {
        'src/app.ts': Buffer.alloc(100, 0x61),
        'secret/key.ts': Buffer.alloc(100 * kb, 0x62),
      },
      designPages: {},
      designComponents: {},
      anchors: null,
      registry: null,
      pipeline: {},
      ecignore: 'secret/**\n# 注释行\n',
    };
    const port = makeFakePort({ projects: [proj], attachments: [] });
    const request: ExportJobRequest = {
      outputPath: path.join(workDir, 'ecignore.ecpkg'),
      selection: {
        scope: 'all',
        projectIds: [],
        content: { memory: emptyMem(), documents: false, code: true, pipeline: false, anchors: false, registry: false, attachments: false },
      },
      redact: false,
      useDefaultExcludes: true,
    };
    const result = await runExport(request, port);
    const hitPatterns = result.excludeStats.hitsByPattern.map((h) => h.pattern);
    expect(hitPatterns).toContain('secret/**');

    const reader = EcpkgReader.open(result.outputPath);
    try {
      expect(reader.hasEntry('projects/proj-y/code/secret/key.ts')).toBe(false);
      expect(reader.hasEntry('projects/proj-y/code/src/app.ts')).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('useDefaultExcludes=false 时默认规则不生效', () => {
    const stats = computeExcludeStats(
      [{ path: 'node_modules/a.js', bytes: 1000 }],
      [...DEFAULT_EXCLUDE_RULES].filter(() => false),
    );
    expect(stats.excludedFiles).toBe(0);
    expect(stats.reductionRatio).toBe(0);
  });
});

function emptyMem() {
  return { longterm: false, project: false, feature: false, page: false, issue: false };
}
