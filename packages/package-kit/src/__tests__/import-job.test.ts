import * as fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runImport, ImportVerifyError, writeReportFile } from '../import/import-job';
import type { ConflictDecision, ImportJobRequest, ImportTargetPort } from '../import/import-types';
import {
  buildEncryptedPackage,
  buildPackage,
  makeLocalPort,
  makeMemoryItem,
  makeTargetPort,
  tamperPackage,
} from './import-testkit';
import type { PackageObject } from '../import/import-types';

function memPkg(id: string, content: string, updatedAt: number): PackageObject {
  const m = makeMemoryItem({ id, content, updatedAt });
  return { id, type: 'memory', projectId: null, name: content.slice(0, 20), updatedAt, payload: JSON.stringify(m) };
}

const baseSpec = {
  projects: [{ id: 'P1', name: 'Proj1', meta: { foo: 1 } }],
  memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: '记忆一' })],
  documents: [
    {
      id: 'D1',
      name: '文档一',
      projectId: 'P1',
      updatedAt: 10,
      rawFiles: [{ name: 'readme.md', content: '# hi' }],
    },
  ],
  codeFiles: [{ projectId: 'P1', relPath: 'src/app.ts', content: 'console.log(1)' }],
};

function jobReq(partial: Partial<ImportJobRequest>): ImportJobRequest {
  return {
    packagePath: '',
    mode: 'full-restore',
    decisions: [],
    ...partial,
  };
}

describe('runImport：五种模式集成', () => {
  it('full-restore：项目/记忆/文档/代码/文件全部落库', async () => {
    const pkg = buildPackage(baseSpec);
    const ft = makeTargetPort();
    const report = await runImport(jobReq({ packagePath: pkg, mode: 'full-restore' }), {
      local: makeLocalPort(),
      target: ft.port,
    });
    expect(report.failures).toHaveLength(0);
    expect(report.applied.createdProjects).toBe(1);
    expect(report.applied.memoryCreated).toBe(1);
    expect(report.applied.createdObjects).toBe(2); // D1 + 代码
    expect(report.applied.filesWritten).toBe(1); // 文档原始文件
    expect(ft.memory.has('M1')).toBe(true);
    expect(ft.objects.has('D1')).toBe(true);
    expect(ft.objects.has('code:P1:src/app.ts')).toBe(true);
    expect(ft.files.has('documents/D1/readme.md')).toBe(true);
    expect(report.resolutions).toEqual({ keepLocal: 0, takeNew: 3, keepBoth: 0 });
  });

  it('memory-only：仅记忆落库，其余跳过', async () => {
    const pkg = buildPackage(baseSpec);
    const ft = makeTargetPort();
    const report = await runImport(jobReq({ packagePath: pkg, mode: 'memory-only' }), {
      local: makeLocalPort(),
      target: ft.port,
    });
    expect(report.applied.createdProjects).toBe(0);
    expect(report.applied.createdObjects).toBe(0);
    expect(report.applied.filesWritten).toBe(0);
    expect(report.applied.memoryCreated).toBe(1);
    expect(ft.memory.has('M1')).toBe(true);
    expect(ft.objects.size).toBe(0);
    expect(ft.files.size).toBe(0);
    expect(ft.projects.size).toBe(0);
  });

  it('documents-only：仅文档（含原始文件）落库，记忆/代码跳过', async () => {
    const pkg = buildPackage(baseSpec);
    const ft = makeTargetPort();
    const report = await runImport(jobReq({ packagePath: pkg, mode: 'documents-only' }), {
      local: makeLocalPort(),
      target: ft.port,
    });
    expect(report.applied.memoryCreated).toBe(0);
    expect(report.applied.createdObjects).toBe(1); // D1
    expect(report.applied.filesWritten).toBe(1);
    expect(ft.objects.has('D1')).toBe(true);
    expect(ft.objects.has('code:P1:src/app.ts')).toBe(false);
    expect(ft.memory.size).toBe(0);
  });

  it('code-only：仅代码/设计/注册表/锚点/流水线落库，记忆/文档跳过', async () => {
    const pkg = buildPackage(baseSpec);
    const ft = makeTargetPort();
    const report = await runImport(jobReq({ packagePath: pkg, mode: 'code-only' }), {
      local: makeLocalPort(),
      target: ft.port,
    });
    expect(report.applied.memoryCreated).toBe(0);
    expect(ft.objects.has('code:P1:src/app.ts')).toBe(true);
    expect(ft.objects.has('D1')).toBe(false);
    expect(ft.memory.size).toBe(0);
  });
});

describe('runImport：冲突与决策', () => {
  it('merge + takeNew：覆盖本地记忆并取代旧 id', async () => {
    const pkg = buildPackage({ memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'incoming-内容' })] });
    const ft = makeTargetPort();
    const decisions: ConflictDecision[] = [{ id: 'M1', resolution: 'takeNew' }];
    const report = await runImport(jobReq({ packagePath: pkg, mode: 'merge', decisions }), {
      local: makeLocalPort([memPkg('M1', 'local-内容', 100)]),
      target: ft.port,
    });
    expect(report.failures).toHaveLength(0);
    expect(ft.memory.has('M1')).toBe(true);
    expect(ft.memory.get('M1')).toContain('incoming-内容');
    expect(ft.superseded).toContain('M1');
    expect(report.resolutions.takeNew).toBe(1);
  });

  it('默认 keepLocal：不覆盖本地（本地内容保留）', async () => {
    const pkg = buildPackage({ memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'incoming-内容' })] });
    const ft = makeTargetPort();
    // 先写入本地版本
    ft.memory.set('M1', JSON.stringify(memPkg('M1', 'local-内容', 100)));
    const decisions: ConflictDecision[] = [{ id: 'M1', resolution: 'keepLocal' }];
    const report = await runImport(jobReq({ packagePath: pkg, mode: 'merge', decisions }), {
      local: makeLocalPort([memPkg('M1', 'local-内容', 100)]),
      target: ft.port,
    });
    expect(report.resolutions.keepLocal).toBe(1);
    expect(ft.memory.get('M1')).toContain('local-内容'); // 未被覆盖
  });

  it('未决策冲突：整体拒绝（抛错）', async () => {
    const pkg = buildPackage({ memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'incoming-内容' })] });
    await expect(
      runImport(jobReq({ packagePath: pkg, mode: 'merge' }), {
        local: makeLocalPort([memPkg('M1', 'local-内容', 100)]),
        target: makeTargetPort().port,
      }),
    ).rejects.toThrow(/存在未决策的冲突条目/);
  });

  it('keepBoth：生成新 id 落库，原本地保留', async () => {
    const pkg = buildPackage({ memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'incoming-内容' })] });
    const ft = makeTargetPort();
    const decisions: ConflictDecision[] = [{ id: 'M1', resolution: 'keepBoth' }];
    const report = await runImport(jobReq({ packagePath: pkg, mode: 'merge', decisions }), {
      local: makeLocalPort([memPkg('M1', 'local-内容', 100)]),
      target: ft.port,
    });
    expect(report.resolutions.keepBoth).toBe(1);
    // 落库 1 条新 id（不是 M1）
    expect(ft.memory.size).toBe(1);
    const newId = [...ft.memory.keys()][0]!;
    expect(newId).not.toBe('M1');
    expect(ft.memory.get(newId)).toContain('incoming-内容');
  });

  it('按类型批量决策：覆盖全部同类型冲突，不整体拒绝', async () => {
    const pkg = buildPackage({
      projects: [{ id: 'P1', name: 'P1', meta: {} }],
      documents: [
        {
          id: 'D1',
          name: '文档',
          projectId: 'P1',
          updatedAt: 10,
          rawFiles: [{ name: 'a.md', content: 'x' }],
        },
      ],
    });
    const ft = makeTargetPort();
    const report = await runImport(
      jobReq({
        packagePath: pkg,
        mode: 'full-restore',
        batchDecisions: { document: 'takeNew' },
      }),
      {
        local: makeLocalPort([{ id: 'D1', type: 'document', projectId: 'P1', name: '文档', updatedAt: 10, payload: 'local-doc' }]),
        target: ft.port,
      },
    );
    expect(report.failures).toHaveLength(0);
    expect(ft.objects.has('D1')).toBe(true);
    expect(ft.objects.get('D1')!.payload).toContain('文档'); // 包内（incoming）内容
  });
});

describe('runImport：校验失败与失败重试', () => {
  it('包被篡改：抛出 ImportVerifyError', async () => {
    const pkg = buildPackage({ memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'x' })] });
    const bad = tamperPackage(pkg);
    await expect(
      runImport(jobReq({ packagePath: bad }), { local: makeLocalPort(), target: makeTargetPort().port }),
    ).rejects.toBeInstanceOf(ImportVerifyError);
  });

  it('加密包口令错误：ImportVerifyError 且 failureCode=password', async () => {
    const enc = buildEncryptedPackage({ memoryLongterm: [makeMemoryItem({ id: 'M1', updatedAt: 100, content: 'x' })] }, 'secret');
    try {
      await runImport(jobReq({ packagePath: enc, password: 'wrong' }), {
        local: makeLocalPort(),
        target: makeTargetPort().port,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ImportVerifyError);
      expect((e as ImportVerifyError).report.failureCode).toBe('password');
    }
  });

  it('单条失败记入 failures 不中断，且 onProgress 被调用', async () => {
    const pkg = buildPackage(baseSpec);
    const ft = makeTargetPort();
    const calls: string[] = [];
    const failingTarget: ImportTargetPort = {
      ...ft.port,
      putObject(object) {
        if (object.id === 'code:P1:src/app.ts') throw new Error('boom');
        return ft.port.putObject(object);
      },
    };
    const report = await runImport(jobReq({ packagePath: pkg, mode: 'full-restore', onProgress: (s) => calls.push(s) }), {
      local: makeLocalPort(),
      target: failingTarget,
    });
    expect(report.failures.some((f) => f.path === 'code:P1:src/app.ts')).toBe(true);
    expect(calls).toContain('verifying');
    expect(calls).toContain('done');
  });

  it('writeReportFile：写出 JSON 报告', async () => {
    const pkg = buildPackage(baseSpec);
    const report = await runImport(jobReq({ packagePath: pkg, mode: 'full-restore' }), {
      local: makeLocalPort(),
      target: makeTargetPort().port,
    });
    const out = `${pkg}.report.json`;
    writeReportFile(report, out);
    const read = JSON.parse(fs.readFileSync(out, 'utf8')) as { mode: string };
    expect(read.mode).toBe('full-restore');
    fs.unlinkSync(out);
  });
});
