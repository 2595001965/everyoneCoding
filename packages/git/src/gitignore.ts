import { GITIGNORE_TEMPLATES, renderGitignore, type RenderOptions, type StackId } from '@ec/core';

import type { GitFilerPort } from './backend/types';

/**
 * 仓库初始化时的 `.gitignore` 生成（T6-01 要点 3）。
 *
 * 模板来自 `@ec/core` 的 `gitignore-templates`（T0-11 产物），这里只做三件事：
 * 1. 按技术栈组合（Node / Python / Java / Go / Flutter / HarmonyOS-ArkTS）；
 * 2. 从项目现有文件**推测**技术栈（探测不到时退回 node，并给出提示）；
 * 3. 落盘时用"临时文件 + 原子替换"（硬约束 6），且**不覆盖**用户已有的自定义规则——
 *    已存在时只补 EveryoneCoding 固定忽略段。
 */

export interface GitignoreInitResult {
  /** 最终写入的完整内容 */
  content: string;
  stacks: StackId[];
  written: boolean;
  /** 写入的绝对路径；未写入时为 null */
  path: string | null;
  /** 中文说明（进结构化日志） */
  notes: string[];
  error: string | null;
}

export interface RenderWorkspaceOptions extends RenderOptions {
  /** 是否写入 EveryoneCoding 固定忽略段，默认 true */
  includeEcSection?: boolean;
}

/** 按技术栈渲染 .gitignore 内容 */
export function renderWorkspaceGitignore(stacks: readonly StackId[], options: RenderWorkspaceOptions = {}): string {
  const effective = stacks.length > 0 ? [...stacks] : (['node'] as StackId[]);
  return renderGitignore(effective, options);
}

/** 该内容是否已包含 EveryoneCoding 固定忽略段 */
export function hasEcSection(content: string): boolean {
  return /^# EveryoneCoding 工作区$/m.test(content);
}

const EC_SECTION_BODY = `.ecpkg
.ecpkg.tmp
*.ec-tmp
.ec-snapshots/`;

/** 在已有 .gitignore 末尾补上 EveryoneCoding 段（已存在则原样返回） */
export function ensureEcSection(content: string): string {
  if (hasEcSection(content)) return content;
  const trimmed = content.replace(/\s+$/, '');
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
  return `${prefix}# EveryoneCoding 工作区\n${EC_SECTION_BODY}\n`;
}

/**
 * 从项目根目录的文件名清单推测技术栈。
 * 结论用于 .gitignore 与预览项目识别，属于"猜测"，因此返回的所有证据都要能展示给用户。
 */
export function detectStacksFromFiles(files: readonly string[]): { stacks: StackId[]; evidence: string[] } {
  const lower = files.map((file) => file.toLowerCase());
  const stacks: StackId[] = [];
  const evidence: string[] = [];
  const has = (name: string): boolean => lower.includes(name);
  const hasExt = (ext: string): boolean => lower.some((file) => file.endsWith(ext));

  if (has('build-profile.json5') || has('oh-package.json5') || hasExt('.ets')) {
    stacks.push('harmonyos-arkts');
    evidence.push('发现 build-profile.json5 / oh-package.json5 / .ets 文件 → HarmonyOS（ArkTS）');
  }
  if (has('pubspec.yaml') || hasExt('.dart')) {
    stacks.push('flutter');
    evidence.push('发现 pubspec.yaml / .dart → Flutter');
  }
  if (has('go.mod') || hasExt('.go')) {
    stacks.push('go');
    evidence.push('发现 go.mod / .go → Go');
  }
  if (has('pom.xml') || has('build.gradle') || hasExt('.java')) {
    stacks.push('java');
    evidence.push('发现 pom.xml / build.gradle / .java → Java');
  }
  if (has('requirements.txt') || has('pyproject.toml') || hasExt('.py')) {
    stacks.push('python');
    evidence.push('发现 requirements.txt / pyproject.toml / .py → Python');
  }
  if (has('package.json') || hasExt('.ts') || hasExt('.tsx') || hasExt('.js')) {
    stacks.push('node');
    evidence.push('发现 package.json / .ts / .tsx / .js → Node.js');
  }
  if (stacks.length === 0) evidence.push('未识别出技术栈特征文件，按 Node.js 模板生成（可手动调整）');
  return { stacks: stacks.length > 0 ? stacks : ['node'], evidence };
}

export interface WriteGitignoreInput {
  repoPath: string;
  stacks: readonly StackId[];
  filer: GitFilerPort | null;
  /** 已存在 .gitignore 时的处理：`merge` 只补 EC 段（默认），`replace` 整体覆盖 */
  existing?: 'merge' | 'replace';
  options?: RenderWorkspaceOptions;
}

/** 生成并（有 filer 时）写入 .gitignore */
export async function writeWorkspaceGitignore(input: WriteGitignoreInput): Promise<GitignoreInitResult> {
  const notes: string[] = [];
  const content = renderWorkspaceGitignore(input.stacks, input.options ?? {});
  const path = joinPath(input.repoPath, '.gitignore');

  if (input.filer === null) {
    notes.push('未提供文件端口，.gitignore 仅生成内容、未落盘');
    return { content, stacks: [...input.stacks], written: false, path: null, notes, error: null };
  }

  try {
    const existing = await input.filer.readText(path);
    if (existing !== null && (input.existing ?? 'merge') === 'merge') {
      const merged = ensureEcSection(existing);
      if (merged === existing) {
        notes.push('工作区已有 .gitignore，且包含 EveryoneCoding 忽略段，保持原样');
        return { content: existing, stacks: [...input.stacks], written: false, path, notes, error: null };
      }
      await input.filer.writeAtomic(path, merged);
      notes.push('工作区已有 .gitignore，已追加 EveryoneCoding 忽略段（未改动原有规则）');
      return { content: merged, stacks: [...input.stacks], written: true, path, notes, error: null };
    }
    await input.filer.writeAtomic(path, content);
    notes.push(`已按 ${input.stacks.join(' + ')} 模板生成 .gitignore`);
    return { content, stacks: [...input.stacks], written: true, path, notes, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content, stacks: [...input.stacks], written: false, path: null, notes, error: `写入 .gitignore 失败：${message}` };
  }
}

/** 可选的模板清单（设置页展示用） */
export function listGitignoreTemplates(): readonly { id: StackId; label: string }[] {
  return GITIGNORE_TEMPLATES.map((template) => ({ id: template.id, label: template.label }));
}

function joinPath(root: string, name: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  return `${base}${sep}${name}`;
}
