/** Read-only migration from historical .ecpkg archives to ordinary source/data ZIPs. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { detectSource, type SourceSnapshot } from '@ec/core';

import { EcpkgReader } from '../reader';
import { verifyPackage } from '../import/verifier';
import { isTextEntry, redactTextIfNeeded } from '../export/redactor';
import { StandardZipWriter } from './standard-zip';

export interface LegacyMigrationResult {
  outputPath: string;
  sourceFiles: number;
  publicDataFiles: number;
  projects: Array<{ name: string; support: string; framework: string | null }>;
}

function safeFolderName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

function readProjectNames(reader: EcpkgReader): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of reader.listEntries()) {
    const match = /^projects\/([^/]+)\/meta\.json$/.exec(entry);
    if (!match) continue;
    const id = match[1]!;
    try {
      const outer = JSON.parse(reader.readEntryText(entry)) as {
        id?: string;
        name?: string;
        metaJson?: string;
      };
      let name = outer.name ?? id;
      if (outer.metaJson) {
        const meta = JSON.parse(outer.metaJson) as { name?: string };
        name = meta.name ?? name;
      }
      names.set(id, safeFolderName(name, id));
    } catch {
      names.set(id, id);
    }
  }
  return names;
}

function migrationCodePath(
  projectId: string,
  relativePath: string,
  projectNames: Map<string, string>,
  onlyProject: boolean,
): string {
  if (onlyProject) return relativePath;
  return `projects/${projectNames.get(projectId) ?? projectId}/${relativePath}`;
}

function isPublicDataPath(entryPath: string): boolean {
  if (
    entryPath === 'manifest.json' ||
    entryPath === 'checksums.sha256' ||
    entryPath === 'signature.sig' ||
    /^projects\/[^/]+\/meta\.json$/.test(entryPath) ||
    /^projects\/[^/]+\/code\//.test(entryPath)
  )
    return false;
  return /^(memory\/|documents\/|attachments\/|projects\/[^/]+\/(?:design\/|pipeline\/|anchors\.json$|registry\.json$))/.test(
    entryPath,
  );
}

function buildSourceSnapshot(
  codeEntries: Array<{ path: string; content: Buffer }>,
): SourceSnapshot {
  const files = codeEntries.map((entry) => entry.path);
  const manifests: Record<string, string> = {};
  for (const entry of codeEntries) {
    if (
      /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|vite\.config\.[^/]+|index\.html)$/.test(
        entry.path,
      )
    ) {
      manifests[entry.path] = entry.content.subarray(0, 64 * 1024).toString('utf8');
    }
  }
  return { files, manifests };
}

/**
 * Read a legacy package and write a plain, unencrypted ZIP. The input is never modified;
 * password and package verification finish before a destination temporary file is created.
 */
export async function migrateLegacyEcpkg(input: {
  packagePath: string;
  outputPath: string;
  password?: string;
}): Promise<LegacyMigrationResult> {
  if (!fs.existsSync(input.packagePath)) throw new Error('旧 .ecpkg 原件不存在');
  if (path.extname(input.packagePath).toLowerCase() !== '.ecpkg') {
    throw new Error('旧包迁移只读取 .ecpkg 文件');
  }
  if (path.extname(input.outputPath).toLowerCase() !== '.zip') {
    throw new Error('迁移结果必须写入普通 .zip 文件');
  }
  const verification = await verifyPackage(input.packagePath, { password: input.password });
  if (!verification.ok) throw new Error(verification.failureMessage ?? '旧包校验失败');

  const reader = EcpkgReader.open(input.packagePath, { password: input.password });
  let writer: StandardZipWriter | null = null;
  try {
    const projectNames = readProjectNames(reader);
    const projectIds = [
      ...new Set(
        reader.listEntries().flatMap((entry) => {
          const match = /^projects\/([^/]+)\/code\//.exec(entry);
          return match ? [match[1]!] : [];
        }),
      ),
    ];
    const onlyProject = projectIds.length === 1;
    const codeEntries: Array<{ path: string; content: Buffer }> = [];
    for (const entry of reader.listEntries()) {
      const match = /^projects\/([^/]+)\/code\/(.+)$/.exec(entry);
      if (!match) continue;
      const outputEntryPath = migrationCodePath(match[1]!, match[2]!, projectNames, onlyProject);
      codeEntries.push({ path: outputEntryPath, content: reader.readEntryBuffer(entry) });
    }
    const detection = detectSource(buildSourceSnapshot(codeEntries));

    writer = new StandardZipWriter(input.outputPath);
    for (const entry of codeEntries) {
      if (isTextEntry(entry.path)) {
        const { text } = redactTextIfNeeded(entry.path, entry.content.toString('utf8'));
        writer.writeTextEntry(entry.path, text);
      } else {
        writer.writeBufferEntry(entry.path, entry.content);
      }
    }
    let publicDataFiles = 0;
    for (const entry of reader.listEntries()) {
      if (!isPublicDataPath(entry)) continue;
      const outputEntryPath = `everyonecoding-data/${entry}`;
      if (isTextEntry(entry)) {
        const { text } = redactTextIfNeeded(outputEntryPath, reader.readEntryText(entry));
        writer.writeTextEntry(outputEntryPath, text);
      } else {
        writer.writeBufferEntry(outputEntryPath, reader.readEntryBuffer(entry));
      }
      publicDataFiles += 1;
    }
    writer.finalizeSource();
    return {
      outputPath: input.outputPath,
      sourceFiles: codeEntries.length,
      publicDataFiles,
      projects: detection.subProjects.map((project) => ({
        name:
          projectNames.get(project.subProjectId) ??
          (onlyProject
            ? (projectNames.get(projectIds[0]!) ?? project.subProjectId)
            : project.subProjectId),
        support: project.supportLevel,
        framework: project.framework,
      })),
    };
  } catch (error) {
    writer?.abort();
    throw error;
  } finally {
    reader.close();
  }
}
