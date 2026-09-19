import type { ReactNode } from 'react';

/**
 * 极简 Markdown 预览渲染器。
 *
 * 为什么自建：硬约束要求"不引入第三方 UI 框架"，且这里只需要覆盖记忆正文的常见语法
 * （标题、列表、引用、代码块、行内粗体与代码），引入完整 Markdown 库属于过度设计。
 * 纯文本渲染，不解析 HTML —— 记忆正文可能来自模型输出，**不做 raw HTML 注入**。
 */

export interface MarkdownPreviewProps {
  text: string;
  className?: string;
}

export function MarkdownPreview({ text, className }: MarkdownPreviewProps): JSX.Element {
  return (
    <div className={className ?? 'ec-markdown'} data-testid="markdown-preview">
      {renderBlocks(text)}
    </div>
  );
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let buffer: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let listItems: string[] = [];
  let key = 0;

  const flushParagraph = (): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ');
    blocks.push(<p key={`p-${key++}`}>{renderInline(joined)}</p>);
    buffer = [];
  };

  const flushList = (): void => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`}>
        {listItems.map((item, index) => (
          <li key={`li-${key}-${index}`}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        blocks.push(
          <pre key={`code-${key++}`}>
            <code>{codeLines.join('\n')}</code>
          </pre>,
        );
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]?.length ?? 1;
      const content = heading[2] ?? '';
      const Tag = `h${Math.min(6, level + 2)}` as 'h3';
      blocks.push(<Tag key={`h-${key++}`}>{renderInline(content)}</Tag>);
      continue;
    }

    const listItem = /^\s*[-*]\s+(.*)$/.exec(line);
    if (listItem) {
      flushParagraph();
      listItems.push(listItem[1] ?? '');
      continue;
    }

    if (line.trimStart().startsWith('> ')) {
      flushParagraph();
      flushList();
      blocks.push(
        <blockquote key={`quote-${key++}`}>{renderInline(line.trimStart().slice(2))}</blockquote>,
      );
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    buffer.push(line);
  }

  if (inCode && codeLines.length > 0) {
    blocks.push(
      <pre key={`code-${key++}`}>
        <code>{codeLines.join('\n')}</code>
      </pre>,
    );
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** 行内语法：`**粗体**` 与 `` `代码` `` */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<code key={`c-${key++}`}>{token.slice(1, -1)}</code>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
