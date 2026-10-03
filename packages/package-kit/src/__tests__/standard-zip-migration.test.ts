import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { detectSource } from '@ec/core';
import { ZipReader } from '../container/zip';
import { runExport } from '../export/export-job';
import type { ExportMemoryItem } from '../export/export-types';
import { runImport } from '../import/import-job';
import { StandardBackupReader, verifyStandardBackup } from '../standard/standard-zip';
import { migrateLegacyEcpkg } from '../standard/legacy-migration';
import {
  buildEncryptedPackage,
  buildPackage,
  makeLocalPort,
  makeMemoryItem,
  makeTargetPort,
} from './import-testkit';
import { makeFakePort, type FakeProject } from './export-testkit';

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standard-zip-migration-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const projectId = 'proj-standard';
const sourceMemory = makeMemoryItem({
  id: 'memory-1',
  scope: 'longterm',
  content: '可恢复记忆',
  updatedAt: 10,
});

function project(): FakeProject {
  const memory: ExportMemoryItem = {
    id: sourceMemory.id,
    layer: 'longterm',
    projectId: null,
    updatedAt: sourceMemory.updatedAt,
    json: JSON.stringify(sourceMemory),
  };
  return {
    id: projectId,
    name: '标准 ZIP 项目',
    metaJson: JSON.stringify({ id: projectId, name: '标准 ZIP 项目' }),
    memory: [memory],
    documents: [{ id: 'doc-1', name: 'notes.md', projectId, updatedAt: 11 }],
    docContents: { 'doc-1': Buffer.from('# 原件文档\n') },
    codeFiles: {
      'package.json': Buffer.from(
        JSON.stringify({
          name: 'migrated-app',
          scripts: { dev: 'vite' },
          dependencies: { react: '18.0.0', vite: '5.0.0' },
        }),
      ),
      'src/main.ts': Buffer.from('export const ready = true;\n'),
    },
    designPages: {},
    designComponents: {},
    anchors: null,
    registry: null,
    pipeline: {},
    ecignore: null,
  };
}

function allFalseMemory() {
  return { longterm: false, project: false, feature: false, page: false, issue: false };
}

describe('V2-D15 标准 ZIP', () => {
  it('源码 ZIP 是普通 ZIP，根目录直接放源码且不要求产品元数据', async () => {
    const outputPath = path.join(workDir, 'source.zip');
    await runExport(
      {
        outputPath,
        archiveFormat: 'standard-zip',
        archiveKind: 'source',
        selection: {
          scope: 'project',
          projectIds: [projectId],
          content: {
            memory: allFalseMemory(),
            documents: false,
            code: true,
            pipeline: false,
            anchors: false,
            registry: false,
            attachments: false,
          },
        },
      },
      makeFakePort({ projects: [project()], attachments: [] }),
    );

    const zip = ZipReader.open(outputPath);
    try {
      expect(
        zip
          .list()
          .map((entry) => entry.path)
          .sort(),
      ).toEqual(['package.json', 'src/main.ts']);
      expect(zip.has('manifest.json')).toBe(false);
      expect(zip.has('everyonecoding-backup.json')).toBe(false);
      expect(JSON.parse(zip.readEntry('package.json').toString('utf8')).name).toBe('migrated-app');
      const sourceEntries = zip.list().map((entry) => entry.path);
      const detection = detectSource({
        files: sourceEntries,
        manifests: Object.fromEntries(
          sourceEntries
            .filter((entryPath) => entryPath === 'package.json')
            .map((entryPath) => [entryPath, zip.readEntry(entryPath).toString('utf8')]),
        ),
      });
      expect(detection.subProjects[0]?.framework).toBe('react-vite');
      expect(detection.subProjects[0]?.supportLevel).toBe('supported');
    } finally {
      zip.close();
    }
  });

  it('完整数据 ZIP 可由标准工具读取，冲突未决时不写入，决策后完整恢复', async () => {
    const outputPath = path.join(workDir, 'backup.zip');
    await runExport(
      {
        outputPath,
        archiveFormat: 'standard-zip',
        archiveKind: 'backup',
        selection: {
          scope: 'all',
          projectIds: [],
          content: {
            memory: { longterm: true, project: true, feature: true, page: true, issue: true },
            documents: true,
            code: true,
            pipeline: true,
            anchors: true,
            registry: true,
            attachments: true,
          },
        },
      },
      makeFakePort({ projects: [project()], attachments: [] }),
    );

    expect(verifyStandardBackup(outputPath).ok).toBe(true);
    const standard = StandardBackupReader.open(outputPath);
    try {
      expect(standard.listEntries()).toContain('memory/longterm.jsonl');
      expect(standard.listEntries()).toContain('documents/doc-1/notes.md');
      expect(standard.listEntries()).toContain(`projects/${projectId}/code/package.json`);
      expect(standard.listEntries()).not.toContain('manifest.json');
      expect(standard.readEntryText('documents/doc-1/notes.md')).toContain('原件文档');
    } finally {
      standard.close();
    }

    const localMemory = makeMemoryItem({
      id: 'memory-1',
      scope: 'longterm',
      content: '本地版本',
      updatedAt: 9,
    });
    const local = makeLocalPort([
      {
        id: localMemory.id,
        type: 'memory',
        projectId: null,
        name: localMemory.title,
        updatedAt: localMemory.updatedAt,
        payload: JSON.stringify(localMemory),
      },
    ]);
    const target = makeTargetPort();
    await expect(
      runImport(
        {
          packagePath: outputPath,
          archiveFormat: 'standard-backup',
          mode: 'full-restore',
          decisions: [],
        },
        { local, target: target.port },
      ),
    ).rejects.toThrow(/未决策的冲突/);
    expect(target.projects.size).toBe(0);
    expect(target.objects.size).toBe(0);

    const restoredTarget = makeTargetPort();
    const report = await runImport(
      {
        packagePath: outputPath,
        archiveFormat: 'standard-backup',
        mode: 'full-restore',
        decisions: [{ id: 'memory-1', resolution: 'keepLocal' }],
      },
      { local, target: restoredTarget.port },
    );
    expect(report.applied.createdProjects).toBe(1);
    expect(report.applied.memoryCreated).toBe(0); // 明确保留本地冲突记忆
    expect(restoredTarget.objects.get(`code:${projectId}:package.json`)?.payload).toContain(
      'migrated-app',
    );
    expect(restoredTarget.files.get('documents/doc-1/notes.md')?.toString()).toContain('原件文档');
  });

  it('旧明文包迁移会保留原件，输出无专有 manifest 的源码 ZIP 并走同一识别器', async () => {
    const legacyPath = buildPackage({
      projects: [{ id: 'legacy-project', name: '旧项目' }],
      codeFiles: [
        {
          projectId: 'legacy-project',
          relPath: 'package.json',
          content: JSON.stringify({
            scripts: { dev: 'vite' },
            dependencies: { react: '18.0.0', vite: '5.0.0' },
          }),
        },
        {
          projectId: 'legacy-project',
          relPath: 'src/main.ts',
          content: 'export const app = true;\n',
        },
      ],
      documents: [
        {
          id: 'legacy-doc',
          name: 'design.md',
          projectId: 'legacy-project',
          updatedAt: 4,
          rawFiles: [{ name: 'design.md', content: '# 旧文档' }],
        },
      ],
      memoryLongterm: [sourceMemory],
    });
    const original = fs.readFileSync(legacyPath);
    const outputPath = path.join(workDir, 'migrated.zip');
    const migrated = await migrateLegacyEcpkg({ packagePath: legacyPath, outputPath });
    expect(fs.readFileSync(legacyPath)).toEqual(original);
    expect(migrated.sourceFiles).toBe(2);
    expect(migrated.publicDataFiles).toBeGreaterThan(0);
    expect(migrated.projects).toEqual([
      { name: '旧项目', support: 'supported', framework: 'react-vite' },
    ]);

    const output = ZipReader.open(outputPath);
    try {
      expect(output.has('package.json')).toBe(true);
      expect(output.has('manifest.json')).toBe(false);
      expect(output.has('everyonecoding-backup.json')).toBe(false);
      expect(output.has('everyonecoding-data/memory/longterm.jsonl')).toBe(true);
      expect(output.readEntry('package.json').toString('utf8')).toContain('vite');
    } finally {
      output.close();
    }
  });

  it('旧加密包错误密码或坏包失败，不留下迁移结果/临时明文且原件保留', async () => {
    const encryptedPath = buildEncryptedPackage(
      {
        projects: [{ id: 'encrypted-project', name: '加密旧项目' }],
        codeFiles: [
          { projectId: 'encrypted-project', relPath: 'src/index.ts', content: 'export {};' },
        ],
      },
      'correct-password',
    );
    const original = fs.readFileSync(encryptedPath);
    const wrongOutput = path.join(workDir, 'wrong-password.zip');
    await expect(
      migrateLegacyEcpkg({
        packagePath: encryptedPath,
        outputPath: wrongOutput,
        password: 'wrong-password',
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(wrongOutput)).toBe(false);
    expect(fs.existsSync(`${wrongOutput}.writing.tmp`)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(encryptedPath)).some((name) => name.includes('.decrypted.tmp')),
    ).toBe(false);
    expect(fs.readFileSync(encryptedPath)).toEqual(original);

    const badPath = path.join(workDir, 'broken.ecpkg');
    fs.writeFileSync(badPath, 'not a valid archive');
    const badOutput = path.join(workDir, 'broken-migrated.zip');
    await expect(
      migrateLegacyEcpkg({ packagePath: badPath, outputPath: badOutput }),
    ).rejects.toThrow();
    expect(fs.existsSync(badOutput)).toBe(false);
    expect(fs.readFileSync(badPath, 'utf8')).toBe('not a valid archive');
  });
});
