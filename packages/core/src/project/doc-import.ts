/**
 * 需求文档导入（T9-01 / FR-WSP-02 第四类来源）。
 *
 * 输入：需求文档的纯文本（Markdown / Word / PDF 提取后的文本，提取由文档域负责）。
 * 输出：可确认的功能清单 + 页面候选 + 项目记忆草稿，供新建项目向导展示与写入。
 *
 * 纯启发式、零依赖、可测试；不做"智能总结"（真正的结构化摘要属 AI 域，经端口）。
 */

import type { TemplateMemoryDraft } from './project-templates';

/** 提取出的功能项 */
export interface ExtractedFeature {
  name: string;
  description: string;
  /** 来源行号（1-based，供"可追溯到原文"） */
  line: number;
  /** 所属章节标题 */
  section: string;
}

/** 页面候选 */
export interface ExtractedPage {
  name: string;
  route: string;
  line: number;
  section: string;
}

/** 解析结果 */
export interface RequirementDigest {
  title: string;
  summary: string;
  features: ExtractedFeature[];
  pageCandidates: ExtractedPage[];
  nonFunctional: string[];
  memoryDrafts: TemplateMemoryDraft[];
  /** 解析告警（如"未识别到功能清单，请手动补充"） */
  warnings: string[];
}

const FEATURE_SECTION_HINTS = ['功能', '需求', '模块', '特性', '范围'];
const PAGE_SECTION_HINTS = ['页面', '界面', '路由', '视图'];
const NFR_SECTION_HINTS = ['非功能', '性能', '安全', '约束'];

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+/.exec(line);
  return match ? match[1]!.length : 0;
}

function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').trim();
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
}

function listText(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
}

/** 去掉 Markdown 强调符号，取纯文本 */
function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .trim();
}

/** 解析单条列表项 → { 名称, 描述 } */
function parseListItem(text: string): { name: string; description: string } {
  // 链接开头：`[功能名](url) 补充说明` → 名称取链接文本
  const linkFirst = /^\s*\[([^\]]+)\]\(([^)]*)\)\s*(.*)$/.exec(text);
  if (linkFirst) {
    return { name: linkFirst[1]!.trim(), description: stripInline(linkFirst[3] ?? '') };
  }
  const plain = stripInline(text);
  const split = /^(.{2,40}?)\s*[:：\-—]\s*(.*)$/.exec(plain);
  if (split) return { name: split[1]!.trim(), description: split[2]!.trim() };
  return {
    name: plain.length > 40 ? `${plain.slice(0, 40)}…` : plain,
    description: '',
  };
}

/** 名称：优先取"冒号/破折号"前的短标题，否则整行前 40 字 */
function toFeatureName(text: string): string {
  return parseListItem(text).name;
}

function toFeatureDescription(text: string): string {
  return parseListItem(text).description;
}

function sectionMatches(section: string, hints: readonly string[]): boolean {
  return hints.some((hint) => section.includes(hint));
}

/** 由页面名推导路由（中文名 → 拼音不可得时用序号 + 语义化英文占位） */
function routeForPage(name: string, index: number): string {
  const ascii = /^[A-Za-z][\w-]*$/.test(name) ? name : null;
  return ascii ? `/${ascii.toLowerCase()}` : `/page-${index + 1}`;
}

/**
 * 解析需求文档。
 *
 * 规则（可预测、可解释）：
 * 1. 首个 H1 作标题；无 H1 时用首行非空文本。
 * 2. 章节标题（H2/H3）命中「功能/需求/模块/特性/范围」→ 其下列表项视为功能项；
 *    命中「页面/界面/路由/视图」→ 视为页面候选；命中「非功能/性能/安全/约束」→ 记为 NFR。
 * 3. 表格行 | 功能 | 说明 | 在含"功能"表头的表格中同样计入。
 * 4. 无任何功能项时给出 warning，由 UI 提示用户手动补充（不静默产出空项目）。
 */
export function parseRequirementDocument(
  text: string,
  options: { maxFeatures?: number } = {},
): RequirementDigest {
  const maxFeatures = options.maxFeatures ?? 100;
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];

  let title = '';
  const features: ExtractedFeature[] = [];
  const pages: ExtractedPage[] = [];
  const nonFunctional: string[] = [];

  let section = '';
  let tableIsFeatureTable = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const lineNo = i + 1;
    const level = headingLevel(raw);

    if (level > 0) {
      const text2 = headingText(raw);
      if (level === 1 && !title) {
        title = text2;
        continue;
      }
      section = text2;
      tableIsFeatureTable = sectionMatches(section, FEATURE_SECTION_HINTS);
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!title && !/^[|>-]/.test(trimmed)) {
      title = stripInline(trimmed).slice(0, 60);
      continue;
    }

    // 表格分隔行 |---|---|
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue;

    // 表头行：判断本表是否功能表
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((cell) => stripInline(cell));
      if (cells.some((cell) => cell.includes('功能') || cell.includes('需求'))) {
        tableIsFeatureTable = true;
        continue;
      }
      const first = cells[0] ?? '';
      if (tableIsFeatureTable && first && !/^-+$/.test(first)) {
        features.push({
          name: toFeatureName(first),
          description: stripInline(cells.slice(1).join(' ')).slice(0, 200),
          line: lineNo,
          section: section || '（未命名章节）',
        });
      }
      continue;
    }

    if (!isListLine(trimmed)) continue;
    const body = listText(trimmed);
    if (!body) continue;

    if (sectionMatches(section, PAGE_SECTION_HINTS)) {
      // 支持 `- 首页 /home` 形式的"名称 + 路由"写法
      const plain = stripInline(body);
      const withRoute = /^(.*?)\s+(\/\S*)$/.exec(plain);
      const name = withRoute ? withRoute[1]!.trim() : toFeatureName(body);
      const route = withRoute ? withRoute[2]! : routeForPage(name, pages.length);
      pages.push({ name, route, line: lineNo, section });
      continue;
    }
    if (sectionMatches(section, NFR_SECTION_HINTS)) {
      nonFunctional.push(stripInline(body).slice(0, 200));
      continue;
    }
    if (sectionMatches(section, FEATURE_SECTION_HINTS)) {
      features.push({
        name: toFeatureName(body),
        description: toFeatureDescription(body),
        line: lineNo,
        section,
      });
    }
  }

  // 去重（按名称）
  const seen = new Set<string>();
  const dedupedFeatures = features.filter((feature) => {
    if (!feature.name || seen.has(feature.name)) return false;
    seen.add(feature.name);
    return true;
  });

  if (dedupedFeatures.length === 0) {
    warnings.push(
      '未在文档中识别到功能清单（请确认存在"## 功能"等章节与列表项），可在下一步手动补充。',
    );
  }
  if (!title) {
    title = '导入的需求文档';
    warnings.push('未识别到文档标题，已使用默认标题。');
  }

  const limited = dedupedFeatures.slice(0, maxFeatures);
  if (dedupedFeatures.length > maxFeatures) {
    warnings.push(`功能项超过 ${maxFeatures} 条，已截断，剩余请在项目内补充。`);
  }

  const memoryDrafts: TemplateMemoryDraft[] = [
    {
      scope: 'project',
      title: `${title}：功能范围`,
      content: limited.length
        ? limited
            .map(
              (feature) =>
                `- ${feature.name}${feature.description ? `：${feature.description}` : ''}`,
            )
            .join('\n')
        : '（未自动识别功能清单，待补充）',
      tags: ['需求', '范围'],
    },
  ];
  if (nonFunctional.length > 0) {
    memoryDrafts.push({
      scope: 'project',
      title: `${title}：非功能约束`,
      content: nonFunctional.map((item) => `- ${item}`).join('\n'),
      tags: ['非功能', '约束'],
    });
  }

  return {
    title,
    summary: limited.length
      ? `共识别 ${limited.length} 项功能${pages.length ? `、${pages.length} 个页面候选` : ''}。`
      : '文档已导入，功能清单待补充。',
    features: limited,
    pageCandidates: pages.slice(0, maxFeatures),
    nonFunctional,
    memoryDrafts,
    warnings,
  };
}

/** 由解析结果生成项目名称建议 */
export function projectNameFromDigest(digest: RequirementDigest): string {
  const title = digest.title.replace(/需求文档|需求说明书|PRD/gi, '').trim();
  return title || '新建项目';
}
