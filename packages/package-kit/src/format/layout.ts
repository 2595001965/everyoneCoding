/**
 * `.ecpkg` 包内布局（T8-01 / PRD §14.1）。
 *
 * 目录结构严格按 PRD §14.1：
 * ```
 * project.ecpkg                       ← ZIP 容器（DEFLATE）
 * ├── manifest.json                   ← 格式版本、内容清单、校验和、脱敏与加密标记
 * ├── signature.sig                   ← 可选 Ed25519 签名
 * ├── checksums.sha256                ← 逐文件 SHA-256（manifest.checksums.entries 指向本文件）
 * ├── memory/
 * │   ├── longterm.jsonl              ← 长期记忆（每行一个 MemoryItem JSON）
 * │   └── projects/<projectId>/
 * │       ├── project.jsonl           ← 项目 / 功能 / 页面 / 问题记忆
 * │       └── links.json              ← 记忆 ↔ 文档关联关系
 * ├── documents/
 * │   ├── index.json                  ← 文档元信息与段落锚点
 * │   └── <docId>/<原始文件>           ← Markdown / PDF / Word / 图片
 * ├── projects/<projectId>/
 * │   ├── meta.json                   ← 项目设置、目标端、技术栈指纹
 * │   ├── design/pages/*.dsl.json     ← 页面 DSL
 * │   ├── design/components/*.json    ← 母版与自定义组件
 * │   ├── anchors.json                ← 代码锚点映射表
 * │   ├── pipeline/                   ← 各阶段产物及版本历史
 * │   ├── registry.json               ← 统一标识注册表
 * │   └── code/                       ← 完整工程源码（排除规则见 FR-PKG-06）
 * └── attachments/                    ← 图片、字体等资源（内容寻址去重：<sha256>.<ext>）
 * ```
 *
 * 包内路径统一使用正斜杠、不带 `./` 前缀、绝不允许 `..` 上跳。
 */

/** 包根级固定文件 */
export const PKG_MANIFEST_PATH = 'manifest.json';
export const PKG_SIGNATURE_PATH = 'signature.sig';
export const PKG_CHECKSUM_PATH = 'checksums.sha256';

/** 包内固定目录（前缀） */
export const DIR_MEMORY = 'memory/';
export const DIR_DOCUMENTS = 'documents/';
export const DIR_PROJECTS = 'projects/';
export const DIR_ATTACHMENTS = 'attachments/';

/* ------------------------------ 路径构造 ------------------------------ */

/** 长期记忆 JSONL */
export function longtermMemoryPath(): string {
  return 'memory/longterm.jsonl';
}

/** 某项目的记忆目录前缀：memory/projects/<id>/ */
export function projectMemoryDir(projectId: string): string {
  return `memory/projects/${projectId}/`;
}

/** 某项目的项目/功能/页面/问题记忆 JSONL */
export function projectMemoryJsonlPath(projectId: string): string {
  return `${projectMemoryDir(projectId)}project.jsonl`;
}

/** 某项目的记忆 ↔ 文档关联关系 */
export function projectMemoryLinksPath(projectId: string): string {
  return `${projectMemoryDir(projectId)}links.json`;
}

/** 文档索引（元信息与段落锚点） */
export function documentsIndexPath(): string {
  return 'documents/index.json';
}

/** 某文档目录前缀：documents/<docId>/ */
export function documentDir(docId: string): string {
  return `documents/${docId}/`;
}

/** 某项目目录前缀：projects/<id>/ */
export function projectDir(projectId: string): string {
  return `projects/${projectId}/`;
}

/** 项目 meta.json */
export function projectMetaPath(projectId: string): string {
  return `${projectDir(projectId)}meta.json`;
}

/** 页面 DSL 目录前缀：projects/<id>/design/pages/ */
export function projectPagesDir(projectId: string): string {
  return `${projectDir(projectId)}design/pages/`;
}

/** 母版与自定义组件目录前缀：projects/<id>/design/components/ */
export function projectComponentsDir(projectId: string): string {
  return `${projectDir(projectId)}design/components/`;
}

/** 代码锚点映射表 */
export function projectAnchorsPath(projectId: string): string {
  return `${projectDir(projectId)}anchors.json`;
}

/** 流水线产物目录前缀：projects/<id>/pipeline/ */
export function projectPipelineDir(projectId: string): string {
  return `${projectDir(projectId)}pipeline/`;
}

/** 统一标识注册表 */
export function projectRegistryPath(projectId: string): string {
  return `${projectDir(projectId)}registry.json`;
}

/** 工程源码目录前缀：projects/<id>/code/ */
export function projectCodeDir(projectId: string): string {
  return `${projectDir(projectId)}code/`;
}

/** 附件目录前缀：attachments/（内容寻址：<sha256>.<ext>） */
export function attachmentsDir(): string {
  return 'attachments/';
}

/* ------------------------------ 路径校验与分类 ------------------------------ */

export type LayoutSection =
  | 'manifest'
  | 'signature'
  | 'checksums'
  | 'memory'
  | 'documents'
  | 'project'
  | 'attachments'
  | 'unknown';

/** 归一化包内路径：反斜杠转正斜杠、去掉 `./` 前缀；发现 `..` 上跳直接拒绝 */
export function normalizePackagePath(path: string): string {
  const replaced = path.replace(/\\/g, '/');
  const stripped = replaced.startsWith('./') ? replaced.slice(2) : replaced;
  if (stripped.length === 0) throw new Error('包内路径不能为空');
  const segments = stripped.split('/');
  if (segments.includes('..')) {
    throw new Error(`包内路径不允许上跳（..）：${path}`);
  }
  if (segments.some((segment) => segment.length === 0 && segment !== segments[segments.length - 1]!)) {
    throw new Error(`包内路径含空段：${path}`);
  }
  return segments.join('/');
}

/** 判断包内路径属于哪个布局分区 */
export function classifyLayoutPath(path: string): LayoutSection {
  const normalized = normalizePackagePath(path);
  if (normalized === PKG_MANIFEST_PATH) return 'manifest';
  if (normalized === PKG_SIGNATURE_PATH) return 'signature';
  if (normalized === PKG_CHECKSUM_PATH) return 'checksums';
  if (normalized === DIR_MEMORY || normalized.startsWith(DIR_MEMORY)) return 'memory';
  if (normalized === DIR_DOCUMENTS || normalized.startsWith(DIR_DOCUMENTS)) return 'documents';
  if (normalized === DIR_PROJECTS || normalized.startsWith(DIR_PROJECTS)) return 'project';
  if (normalized === DIR_ATTACHMENTS || normalized.startsWith(DIR_ATTACHMENTS)) return 'attachments';
  return 'unknown';
}

export interface LayoutViolation {
  path: string;
  reason: string;
}

/**
 * 结构断言（T8-01 验收第一条：包结构与 PRD §14.1 完全一致）。
 *
 * 规则：
 * 1. 所有路径必须落在 §14.1 的已知分区（unknown 即违规）；
 * 2. 必须存在 manifest.json；
 * 3. `memory/projects/<id>/` 或 `projects/<id>/` 出现时必须带 `project.jsonl` / `meta.json`；
 * 4. `documents/` 出现时必须带 `index.json`。
 */
export function assertLayoutStructure(paths: readonly string[]): LayoutViolation[] {
  const violations: LayoutViolation[] = [];
  const normalized = paths.map((p) => normalizePackagePath(p));

  if (!normalized.includes(PKG_MANIFEST_PATH)) {
    violations.push({ path: PKG_MANIFEST_PATH, reason: '缺少 manifest.json' });
  }

  const seenMemoryProjects = new Set<string>();
  const seenCodeProjects = new Set<string>();
  for (const path of normalized) {
    const section = classifyLayoutPath(path);
    if (section === 'unknown') {
      violations.push({ path, reason: '不属于 §14.1 定义的任何分区' });
      continue;
    }
    if (section === 'memory') {
      const match = /^memory\/projects\/([^/]+)\//.exec(path);
      if (match !== null) seenMemoryProjects.add(match[1] ?? '');
    }
    if (section === 'project') {
      const match = /^projects\/([^/]+)\//.exec(path);
      if (match !== null) seenCodeProjects.add(match[1] ?? '');
    }
  }

  for (const projectId of seenMemoryProjects) {
    const prefix = projectMemoryDir(projectId);
    const hasJsonl = normalized.some((p) => p.startsWith(prefix) && p.endsWith('project.jsonl'));
    if (!hasJsonl) {
      violations.push({ path: `${prefix}project.jsonl`, reason: `项目 ${projectId} 的记忆目录缺少 project.jsonl` });
    }
  }
  for (const projectId of seenCodeProjects) {
    if (!normalized.includes(projectMetaPath(projectId))) {
      violations.push({ path: projectMetaPath(projectId), reason: `项目 ${projectId} 缺少 meta.json` });
    }
  }

  const hasDocuments = normalized.some((p) => p.startsWith(DIR_DOCUMENTS));
  if (hasDocuments && !normalized.includes(documentsIndexPath())) {
    violations.push({ path: documentsIndexPath(), reason: 'documents/ 目录缺少 index.json' });
  }

  return violations;
}
