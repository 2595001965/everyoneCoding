/**
 * 文档中心页面（T9-04）：左文档库 / 右正文 + 关联记忆，顶部一键转记忆。
 */

import { useCallback, useMemo, useState } from 'react';
import { Button, Tabs } from '@ec/ui';
import type { DocSection } from '@ec/core';

import { DocLibrary } from './DocLibrary';
import { DocViewer } from './DocViewer';
import { DocMemoryLink } from './DocMemoryLink';
import { ConvertToMemoryDialog } from './ConvertToMemoryDialog';
import { DocsProvider, DocsUnavailable, useDocsOptional, type DocsApi } from './docs-api';

import './docs.css';

export interface DocsPageProps {
  api: DocsApi | null;
  projectId: string;
}

/** 已装配端口的文档中心 */
function DocsWorkspace({ projectId }: { projectId: string }): JSX.Element {
  const api = useDocsOptional();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('content');
  const [convertOpen, setConvertOpen] = useState(false);
  const [selected, setSelected] = useState<{ id: string; title: string; sections: DocSection[] } | null>(null);

  /** 选中文档时同步取详情（转记忆需要 sections） */
  const handleSelect = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setActiveTab('content');
      if (!api) return;
      const doc = await api.getDocument(id);
      setSelected({ id, title: doc?.title ?? id, sections: doc?.sections ?? [] });
    },
    [api],
  );

  const convertTarget = useMemo(
    () => (selected && selected.id === selectedId ? selected : null),
    [selected, selectedId],
  );

  return (
    <div className="ec-docs">
      <header className="ec-docs__head">
        <h1>文档中心</h1>
        <Button variant="primary" disabled={selectedId === null} onClick={() => setConvertOpen(true)}>
          转为记忆
        </Button>
      </header>

      <div className="ec-docs__panes">
        <DocLibrary
          projectId={projectId}
          selectedId={selectedId}
          onSelect={(id) => void handleSelect(id)}
        />
        <div className="ec-docs__detail">
          {selectedId === null ? (
            <p className="ec-docs__hint">从左侧选择一篇文档，查看正文、大纲与关联记忆。</p>
          ) : (
            <Tabs
              items={[
                { key: 'content', label: '正文' },
                { key: 'memory', label: '关联记忆' },
              ]}
              value={activeTab}
              onChange={setActiveTab}
              // eslint-disable-next-line react/no-children-prop -- Tabs 的 children 是渲染函数
              children={(active) =>
                active === 'content' ? (
                  <DocViewer documentId={selectedId} />
                ) : (
                  <DocMemoryLink
                    projectId={projectId}
                    documentId={selectedId}
                    onOpenDocument={(id) => void handleSelect(id)}
                  />
                )
              }
            />
          )}
        </div>
      </div>

      {convertTarget ? (
        <ConvertToMemoryDialog
          open={convertOpen}
          projectId={projectId}
          documentId={convertTarget.id}
          documentTitle={convertTarget.title}
          sections={convertTarget.sections}
          onClose={() => setConvertOpen(false)}
          onConverted={() => setActiveTab('memory')}
        />
      ) : null}
    </div>
  );
}

/** 文档中心：未注入端口时展示装配引导 */
export function DocsPage({ api, projectId }: DocsPageProps): JSX.Element {
  if (!api) return <DocsUnavailable />;
  return (
    <DocsProvider api={api}>
      <DocsWorkspace projectId={projectId} />
    </DocsProvider>
  );
}

export { DocLibrary } from './DocLibrary';
export { DocViewer } from './DocViewer';
export { DocMemoryLink } from './DocMemoryLink';
export { ConvertToMemoryDialog } from './ConvertToMemoryDialog';
export { DocsProvider, DocsUnavailable, useDocs, useDocsOptional, readInjectedDocsApi } from './docs-api';
export type { DocsApi } from './docs-api';
