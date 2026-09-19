/**
 * DocViewer（T9-04 / FR-DOC-02/03/05）：正文阅读 + 标题大纲定位 + 版本历史与更新提示。
 *
 * 定位语义（任务卡验收点）：Markdown 用标题锚点（section.anchor → DOM id），
 * PDF 用页码（section.page），点击大纲即滚动到对应段落。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Tag } from '@ec/ui';
import type { DocSummary, DocUpdateStatus, DocVersionSummary } from '@ec/core';

import { useDocs } from './docs-api';

const VERSION_AUTHOR_LABELS: Record<string, string> = {
  user: '用户编辑',
  pipeline: '流水线产物',
  import: '导入',
};

export interface DocViewerProps {
  documentId: string;
  /** 数据变更后通知外层（如删除/恢复） */
  onChanged?: () => void;
}

export function DocViewer({ documentId, onChanged }: DocViewerProps): JSX.Element {
  const api = useDocs();
  const [doc, setDoc] = useState<DocSummary | null>(null);
  const [versions, setVersions] = useState<DocVersionSummary[]>([]);
  const [status, setStatus] = useState<DocUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [detail, versionList, updateStatus] = await Promise.all([
        api.getDocument(documentId),
        api.listVersions(documentId),
        api.evaluateUpdateStatus(documentId),
      ]);
      setDoc(detail);
      setVersions(versionList);
      setStatus(updateStatus);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const outline = useMemo(
    () => (doc ? doc.sections.filter((section) => section.level > 0) : []),
    [doc],
  );

  /** 定位到段落：DOM id 命中后滚动；PDF 段落额外提示页码 */
  const jumpTo = useCallback((anchor: string) => {
    setActiveAnchor(anchor);
    const target = bodyRef.current?.querySelector<HTMLElement>(`#${CSS_ESCAPE(anchor)}`);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
  }, []);

  const ignoreUpdate = useCallback(async () => {
    if (!doc) return;
    await api.ignoreVersion(doc.id, doc.version);
    const next = await api.evaluateUpdateStatus(doc.id);
    setStatus(next);
    onChanged?.();
  }, [api, doc, onChanged]);

  if (error) return <p className="ec-docs__error">{error}</p>;
  if (!doc) {
    return <EmptyState title="未选择文档" description="在左侧文档库中选择一篇文档查看内容。" />;
  }

  return (
    <section className="ec-docs__viewer" aria-label="文档正文">
      <header className="ec-docs__viewer-head">
        <h2 className="ec-docs__viewer-title">{doc.title}</h2>
        <span className="ec-docs__viewer-meta">
          <Tag color="neutral">{`v${doc.version}`}</Tag>
          {doc.sourceRef ? <Tag color="info">{doc.sourceRef}</Tag> : null}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setShowVersions((prev) => !prev)}>
          {showVersions ? '收起版本' : `版本历史（${versions.length}）`}
        </Button>
      </header>

      {status?.updated ? (
        <div className="ec-docs__update-hint" role="status">
          <span>文档已更新至 v{status.currentVersion}，关联记忆可能已过期。</span>
          <Button size="sm" variant="ghost" onClick={() => void ignoreUpdate()}>
            忽略该版本提示
          </Button>
        </div>
      ) : null}

      {showVersions ? (
        <ul className="ec-docs__versions" aria-label="版本历史">
          {versions.map((version) => (
            <li key={version.id}>
              <span>{`v${version.version}`}</span>
              <span>{VERSION_AUTHOR_LABELS[version.createdBy] ?? version.createdBy}</span>
              <span>{formatTime(version.createdAt)}</span>
            </li>
          ))}
          {versions.length === 0 ? <li>暂无历史版本</li> : null}
        </ul>
      ) : null}

      <div className="ec-docs__viewer-body">
        <nav className="ec-docs__outline" aria-label="文档大纲">
          {outline.length === 0 ? (
            <p className="ec-docs__hint">该文档没有标题层级。</p>
          ) : (
            <ul>
              {outline.map((section) => (
                <li
                  key={section.anchor}
                  data-level={section.level}
                  data-active={section.anchor === activeAnchor ? 'true' : 'false'}
                >
                  <button type="button" onClick={() => jumpTo(section.anchor)}>
                    {section.heading}
                    {section.page !== undefined ? `（第 ${section.page} 页）` : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <div className="ec-docs__content" ref={bodyRef}>
          {doc.sections.map((section) => (
            <section
              key={section.anchor}
              id={section.anchor}
              data-anchor={section.anchor}
              className="ec-docs__section"
            >
              {section.heading ? <h3 data-level={section.level}>{section.heading}</h3> : null}
              {section.text ? <p>{section.text}</p> : null}
              {section.page !== undefined ? (
                <span className="ec-docs__page">{`第 ${section.page} 页`}</span>
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}

/** HTML id 选择器转义（锚点来自解析器，允许中文但可能是纯数字开头） */
function CSS_ESCAPE(anchor: string): string {
  return anchor.replace(/([^\w-])/g, '\\$1');
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
