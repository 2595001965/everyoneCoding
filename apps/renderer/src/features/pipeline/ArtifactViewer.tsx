import type { ReactNode } from 'react';

/**
 * 产物渲染（T5-02 要点 2 / FR-PIPE-02）。
 * - Markdown：轻量渲染（标题 / 列表 / 代码块 / 勾选清单），不做重依赖；
 * - Mermaid：从 ```mermaid 围栏抽取源码，未接入渲染器时展示源码框（降级不报错）；
 * - DSL：S4 拆分等 JSON 产物用结构化折叠展示。
 */

/* ------------------------------ 轻量 Markdown ------------------------------ */

export interface MarkdownRenderOptions {
  /** 是否渲染 Mermaid 代码块（无渲染器时降级为源码框） */
  renderMermaid?: boolean | undefined;
}

function inlineText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
}

/** 轻量 Markdown → 行级 HTML（标题/列表/勾选/代码块） */
export function renderMarkdownLines(
  markdown: string,
  options: MarkdownRenderOptions = {},
): string[] {
  void options; // 预留：renderMermaid 关闭时跳过 Mermaid 块（当前总是展示源码，保证零依赖）
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let inCode = false;
  let codeBuffer: string[] = [];

  for (const raw of lines) {
    const line = raw;
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeBuffer = [];
        output.push('<pre class="ec-md-block">');
      } else {
        inCode = false;
        output.push(`<code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }
    if (line.startsWith('### ')) output.push(`<h4>${inlineText(line.slice(4))}</h4>`);
    else if (line.startsWith('## ')) output.push(`<h3>${inlineText(line.slice(3))}</h3>`);
    else if (line.startsWith('# ')) output.push(`<h2>${inlineText(line.slice(2))}</h2>`);
    else if (line.trim() === '') output.push('<div class="ec-md-blank"></div>');
    else if (line.trim().startsWith('- [ ]'))
      output.push(`<li class="ec-md-checkbox">☐ ${inlineText(line.trim().slice(5))}</li>`);
    else if (line.trim().startsWith('- [x]'))
      output.push(`<li class="ec-md-checkbox">☑ ${inlineText(line.trim().slice(5))}</li>`);
    else if (line.trim().startsWith('- ') || line.trim().startsWith('* '))
      output.push(`<li>${inlineText(line.trim().slice(2))}</li>`);
    else output.push(`<p>${inlineText(line)}</p>`);
  }
  if (inCode) output.push(`<code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  return output;
}

/** 从 Markdown 抽取 Mermaid 源码（首个 flowchart 围栏） */
export function extractMermaidSource(markdown: string): string | null {
  const pattern = /```mermaid\s*\n([\s\S]*?)```/;
  const match = pattern.exec(markdown);
  return match?.[1]?.trim() ?? null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ------------------------------ ArtifactViewer ------------------------------ */

export interface ArtifactViewerProps {
  /** 产物正文（Markdown / DSL JSON / 代码） */
  content: string;
  /** 产物类型（决定渲染方式） */
  artifactType?: 'requirement_doc' | 'tech_doc' | 'design_dsl' | 'code_patch' | string | undefined;
  /** 覆盖 Markdown 渲染选项 */
  markdownOptions?: MarkdownRenderOptions | undefined;
}

/** DSL / 代码类产物：结构化折叠预览 */
function DslViewer({ content }: { content: string }): JSX.Element {
  try {
    const parsed = JSON.parse(content) as unknown;
    return (
      <details className="ec-pipe-dsl" open>
        <summary>结构化预览（可折叠）</summary>
        <pre>{JSON.stringify(parsed, null, 2)}</pre>
      </details>
    );
  } catch {
    return <pre className="ec-pipe-code">{content}</pre>;
  }
}

export function ArtifactViewer({
  content,
  artifactType,
  markdownOptions,
}: ArtifactViewerProps): JSX.Element {
  const isDsl = artifactType === 'design_dsl';
  if (isDsl) return <DslViewer content={content} />;

  const isMarkdown =
    artifactType === 'requirement_doc' || artifactType === 'tech_doc' || content.includes('## ');
  if (!isMarkdown) return <pre className="ec-pipe-code">{content}</pre>;

  const mermaid = extractMermaidSource(content);
  const lines = renderMarkdownLines(content, markdownOptions);
  return (
    <div className="ec-pipe-artifact" data-testid="artifact-viewer">
      {lines.map((html, index) => (
        <span key={index} dangerouslySetInnerHTML={{ __html: html }} />
      ))}
      {mermaid !== null && (
        <details className="ec-pipe-mermaid" open>
          <summary>业务流程图（Mermaid 源码）</summary>
          <pre>{mermaid}</pre>
          <p className="ec-pipe-mermaid__hint">
            接入 Mermaid 渲染器后此处显示图形（当前展示源码，保证零依赖）
          </p>
        </details>
      )}
    </div>
  );
}

export interface MarkdownLineProps {
  children: ReactNode;
}

/** 供外部复用的行级标记渲染（可选） */
export function MarkdownLine({ children }: MarkdownLineProps): JSX.Element {
  return <span>{children}</span>;
}
