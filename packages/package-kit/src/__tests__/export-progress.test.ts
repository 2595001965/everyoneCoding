/**
 * 进度事件测试（T8-02）。
 *
 * 通过 onProgress 收集快照，断言：
 * - 阶段按 enumerating → excluding → writing → done 推进；
 * - processed / total 单调非递减，total 在 writing 前已确定；
 * - 条目级失败被记入 failures 且整体不中断（其余文件仍写出）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EcpkgReader } from '../reader';
import { runExport } from '../export/export-job';
import type { ExportJobRequest, ExportProgressSnapshot } from '../export/export-types';
import { makeFakePort, type FakeProject } from './export-testkit';

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-progress-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('导出进度事件', () => {
  it('阶段推进 + processed/total 单调 + 失败续跑', async () => {
    const proj: FakeProject = {
      id: 'proj-p',
      name: 'P',
      metaJson: JSON.stringify({ id: 'proj-p' }),
      memory: [],
      documents: [],
      docContents: {},
      codeFiles: {
        'src/ok.ts': Buffer.from('export const ok = 1;\n'),
        'src/broken.ts': Buffer.from('export const broken = 2;\n'),
      },
      designPages: {},
      designComponents: {},
      anchors: null,
      registry: null,
      pipeline: {},
      ecignore: null,
    };
    // 让其中一个代码文件读取失败
    const port = makeFakePort({ projects: [proj], attachments: [] });
    const originalRead = port.readCodeFile;
    port.readCodeFile = (pid: string, rel: string) =>
      rel === 'src/broken.ts' ? null : originalRead(pid, rel);

    const snapshots: ExportProgressSnapshot[] = [];
    const onProgress = vi.fn((s: ExportProgressSnapshot) => snapshots.push(s));

    const request: ExportJobRequest = {
      outputPath: path.join(workDir, 'progress.ecpkg'),
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
      onProgress,
    };
    const result = await runExport(request, port);

    expect(onProgress).toHaveBeenCalled();
    const stages = snapshots.map((s) => s.stage);
    expect(stages[0]).toBe('enumerating');
    expect(stages).toContain('excluding');
    expect(stages).toContain('writing');
    expect(stages[stages.length - 1]).toBe('done');

    // processed / total 单调非递减
    let prevProcessed = -1;
    let prevTotal = -1;
    for (const s of snapshots) {
      expect(s.processed).toBeGreaterThanOrEqual(prevProcessed);
      prevProcessed = s.processed;
      if (s.total >= 0) {
        expect(s.total).toBeGreaterThanOrEqual(prevTotal);
        prevTotal = s.total;
      }
    }
    // writing 阶段 total 已确定（取第一个 total > 0 的 writing 快照）
    const writingWithTotal = snapshots
      .filter((s) => s.stage === 'writing')
      .find((s) => s.total > 0);
    expect(writingWithTotal?.total).toBeGreaterThan(0);

    // 失败被记录（在进度快照的 failures 中）且整体完成（ok 文件仍写出）
    const lastSnap = snapshots[snapshots.length - 1]!;
    expect(lastSnap.failures.length).toBe(1);
    expect(lastSnap.failures[0]?.path).toContain('src/broken.ts');
    expect(result.counts.codeFiles).toBe(1);

    const reader = EcpkgReader.open(result.outputPath);
    try {
      expect(reader.hasEntry('projects/proj-p/code/src/ok.ts')).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('excludeStats 与 redactionFindings 回填到快照', async () => {
    const port = makeFakePort({ projects: [projectWithSecret()], attachments: [] });
    const snapshots: ExportProgressSnapshot[] = [];
    await runExport(
      {
        outputPath: path.join(workDir, 'progress2.ecpkg'),
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
        useDefaultExcludes: true,
        onProgress: (s) => snapshots.push(s),
      },
      port,
    );
    const last = snapshots[snapshots.length - 1]!;
    expect(last.excludeStats).not.toBeNull();
    expect(last.redactionFindings.length).toBeGreaterThan(0);
  });
});

function allFalse() {
  return { longterm: false, project: false, feature: false, page: false, issue: false };
}
function fullMem() {
  return { longterm: true, project: true, feature: true, page: true, issue: true };
}
function projectWithSecret(): FakeProject {
  return {
    id: 'proj-ps',
    name: 'PS',
    metaJson: JSON.stringify({ id: 'proj-ps' }),
    memory: [
      {
        id: 'm',
        layer: 'project',
        projectId: 'proj-ps',
        updatedAt: 1,
        json: JSON.stringify({ password: 'topsecret-value' }),
      },
    ],
    documents: [],
    docContents: {},
    codeFiles: { 'src/c.ts': Buffer.from('const password = "topsecret-value";\n') },
    designPages: {},
    designComponents: {},
    anchors: null,
    registry: null,
    pipeline: {},
    ecignore: null,
  };
}
