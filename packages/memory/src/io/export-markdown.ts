import type { MemoryItem } from '../domain/memory-item';
import { layerOf, type MemoryLayer } from '../domain/scope';

/**
 * 单个导出的 Markdown 文件。
 *
 * `path` 为**相对路径**，用 `/` 分隔（例如 `longterm/命名规范.md`）。
 * 文件名已做非法字符清洗并保证同层唯一（重名追加 `-2`、`-3`）。
 */
export interface ExportedMarkdownFile {
  path: string;
  content: string;
}

/** 层级 → 目录名（与 `layerOf` 结果一一对应）。 */
const LAYER_DIRECTORY: Record<MemoryLayer, string> = {
  longterm: 'longterm',
  project: 'project',
  feature: 'feature',
  page: 'page',
  element: 'element',
  issue: 'issue',
};

/**
 * 由记忆条目推导其所在层级目录名。
 *
 * 直接调用 `layerOf`：长期/项目/功能/页面 → 同名目录；
 * 元素备注（scope=page 且 elementId 非空）→ `element` 目录；
 * 问题 → `issue` 目录。
 */
export function layerDirectoryOf(item: MemoryItem): string {
  return LAYER_DIRECTORY[layerOf(item)];
}

/** 清洗文件名中的文件系统非法字符，空格转下划线，超长截断，空名兜底。 */
function cleanFileName(title: string): string {
  // 先按码点剔除控制字符（换行 / 制表 / DEL）：它们无法出现在文件名里。
  // 用码点过滤而不是控制字符正则，既避免 no-control-regex 规则，也能正确处理补充平面字符。
  const printable = [...title].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  const cleaned = printable
    .join('')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .trim();
  const truncated = cleaned.slice(0, 80);
  return truncated.length > 0 ? truncated : 'memory';
}

/* ------------------------------ YAML front-matter ------------------------------ */

/**
 * 是否需要用双引号包裹（避免与 YAML 语法冲突）。
 * 含换行、首尾空白、特殊指示符、冒号或双引号时强制加引号。
 */
function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (/[\n\r]/.test(value)) return true;
  if (value !== value.trim()) return true;
  if (/^[!&*\-?:,[\]{}#|>'"%@`]/.test(value)) return true;
  if (/[:"]/.test(value)) return true;
  return false;
}

/** 把标量值序列化为 YAML front-matter 可安全解析的形式。 */
function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  return needsQuoting(text) ? JSON.stringify(text) : text;
}

/** front-matter 字段顺序（解析端按 key 取，顺序无关）。 */
const FRONT_MATTER_FIELDS: ReadonlyArray<{ key: string; get: (item: MemoryItem) => unknown }> = [
  { key: 'id', get: (i) => i.id },
  { key: 'userId', get: (i) => i.userId },
  { key: 'scope', get: (i) => i.scope },
  { key: 'layer', get: (i) => layerOf(i) },
  { key: 'projectId', get: (i) => i.projectId },
  { key: 'featureId', get: (i) => i.featureId },
  { key: 'pageId', get: (i) => i.pageId },
  { key: 'elementId', get: (i) => i.elementId },
  { key: 'issueId', get: (i) => i.issueId },
  { key: 'title', get: (i) => i.title },
  { key: 'tags', get: (i) => i.tags },
  { key: 'importance', get: (i) => i.importance },
  { key: 'confidence', get: (i) => i.confidence },
  { key: 'status', get: (i) => i.status },
  { key: 'issueStatus', get: (i) => i.issueStatus },
  { key: 'source', get: (i) => i.sourceRef },
  { key: 'sourceType', get: (i) => i.sourceType },
  { key: 'pinned', get: (i) => i.pinned },
  { key: 'version', get: (i) => i.version },
  { key: 'createdAt', get: (i) => i.createdAt },
  { key: 'updatedAt', get: (i) => i.updatedAt },
];

function renderFrontMatter(item: MemoryItem): string {
  const lines = FRONT_MATTER_FIELDS.map((field) => `${field.key}: ${yamlScalar(field.get(item))}`);
  return lines.join('\n');
}

const STRUCTURED_MARKER = '<details><summary>structured</summary>';

function renderStructuredBlock(item: MemoryItem): string {
  if (!item.structured || Object.keys(item.structured).length === 0) return '';
  return (
    `\n\n${STRUCTURED_MARKER}\n\n` +
    '```json\n' +
    JSON.stringify(item.structured, null, 2) +
    '\n```\n\n</details>\n'
  );
}

/**
 * 把一个记忆条目渲染为 Markdown 文件对象。
 *
 * - front-matter（`---` 包裹的 YAML）含 `id / userId / scope / layer / 各归属 id /
 *   title / tags / importance / confidence / status / issueStatus / source /
 *   sourceType / pinned / version / createdAt / updatedAt`；
 * - 正文为 `item.content`（Markdown，原样保留）；
 * - `structured` 以折叠 JSON 代码块（`<details>`）附在文末。
 *
 * 文件名取 `title` 清洗后的结果，目录由 `layerDirectoryOf` 决定。
 * 同层唯一性（重名 `-2`/`-3`）由 `exportMarkdown` 统一处理。
 */
export function toMarkdownFile(item: MemoryItem): ExportedMarkdownFile {
  const directory = layerDirectoryOf(item);
  const fileName = cleanFileName(item.title);
  const content = `---\n${renderFrontMatter(item)}\n---\n\n${item.content}${renderStructuredBlock(item)}`;
  return { path: `${directory}/${fileName}.md`, content };
}

/**
 * 把一批记忆条目按层级分文件导出为 Markdown。
 *
 * - 每个条目一个 `.md`，落在对应层级目录下；
 * - 文件名重名时追加 `-2`、`-3` 保证同层唯一；
 * - `options.indexFile !== false` 时额外产出 `README.md`（目录 + 条目清单，保留标题层级）。
 *
 * **不写磁盘**：仅返回文件数组，写文件由渲染层经外壳 API 完成。
 */
export function exportMarkdown(
  items: readonly MemoryItem[],
  options?: { indexFile?: boolean },
): ExportedMarkdownFile[] {
  const files: ExportedMarkdownFile[] = [];
  const usedNames = new Map<string, number>();

  for (const item of items) {
    const base = toMarkdownFile(item);
    const dir = base.path.includes('/') ? base.path.slice(0, base.path.lastIndexOf('/')) : '';
    const name = base.path.slice(dir.length + (dir ? 1 : 0));

    const seen = usedNames.get(name) ?? 0;
    usedNames.set(name, seen + 1);
    const finalPath = seen === 0 ? base.path : `${dir}/${name.replace(/\.md$/, '')}-${seen + 1}.md`;
    files.push({ path: finalPath, content: base.content });
  }

  if (options?.indexFile !== false) {
    files.push(buildIndexFile(items));
  }
  return files;
}

/** 生成 README.md 索引：按层级分组，列出条目与关键信息。 */
function buildIndexFile(items: readonly MemoryItem[]): ExportedMarkdownFile {
  const byLayer = new Map<MemoryLayer, MemoryItem[]>();
  for (const item of items) {
    const layer = layerOf(item);
    const bucket = byLayer.get(layer) ?? [];
    bucket.push(item);
    byLayer.set(layer, bucket);
  }

  const lines: string[] = ['# 记忆导出索引', ''];
  for (const layer of ['longterm', 'project', 'feature', 'page', 'element', 'issue'] as const) {
    const bucket = byLayer.get(layer);
    if (!bucket || bucket.length === 0) continue;
    const title = LAYER_DIRECTORY[layer];
    lines.push(`## ${title}（${bucket.length}）`);
    for (const item of bucket) {
      const file = `${title}/${cleanFileName(item.title)}.md`;
      lines.push(`- [${item.title}](./${file}) — ${item.scope} · 重要度 ${item.importance}`);
    }
    lines.push('');
  }

  return { path: 'README.md', content: lines.join('\n').replace(/\n+$/, '\n') };
}
