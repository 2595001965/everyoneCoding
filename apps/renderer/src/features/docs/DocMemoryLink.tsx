/**
 * DocMemoryLink（T9-04 / FR-DOC-02/03）：文档 ↔ 记忆的双向关联。
 *
 * - 正向：把文档关联到五类记忆节点之一（长期/项目/功能/页面/问题）
 * - 反向：查看某记忆被哪些文档引用，并可跳转到对应文档
 * - 记忆卡片语义：`📎 N 篇关联文档` 的 N 由端口 `countLinksForMemories` 提供
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Select, Tag } from '@ec/ui';
import {
  DOC_LINK_TYPE_LABELS,
  DOC_LINK_TYPES,
  DOC_MEMORY_SCOPE_LABELS,
  type DocLinkType,
  type DocMemoryLink as DocMemoryLinkModel,
  type DocMemoryNode,
  type DocMemoryScope,
} from '@ec/core';

import { useDocs } from './docs-api';

const SCOPE_ORDER: DocMemoryScope[] = ['longterm', 'project', 'feature', 'page', 'issue'];

export interface DocMemoryLinkProps {
  projectId: string;
  documentId: string;
  /** 点击反向引用中的文档时跳转 */
  onOpenDocument?: (documentId: string) => void;
}

export function DocMemoryLink({
  projectId,
  documentId,
  onOpenDocument,
}: DocMemoryLinkProps): JSX.Element {
  const api = useDocs();
  const [links, setLinks] = useState<DocMemoryLinkModel[]>([]);
  const [nodes, setNodes] = useState<DocMemoryNode[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selectedMemory, setSelectedMemory] = useState<string>('');
  const [linkType, setLinkType] = useState<DocLinkType>('related');
  const [refsOf, setRefsOf] = useState<{ memoryId: string; docs: DocMemoryLinkModel[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [linkList, nodeList] = await Promise.all([
        api.listDocLinks(documentId),
        api.listMemoryNodes(projectId),
      ]);
      setLinks(linkList);
      setNodes(nodeList);
      const memoryIds = linkList.map((link) => link.memoryId);
      setCounts(memoryIds.length > 0 ? await api.countLinksForMemories(memoryIds) : {});
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, documentId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const options = useMemo(
    () =>
      SCOPE_ORDER.flatMap((scope) =>
        nodes
          .filter((node) => node.scope === scope)
          .map((node) => ({
            value: node.id,
            label: `${DOC_MEMORY_SCOPE_LABELS[scope]}：${node.title}`,
          })),
      ),
    [nodes],
  );

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const addLink = useCallback(async () => {
    if (!selectedMemory) return;
    try {
      await api.linkToMemory({ memoryId: selectedMemory, documentId, linkType });
      setSelectedMemory('');
      await load();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, documentId, linkType, load, selectedMemory]);

  const removeLink = useCallback(
    async (id: string) => {
      await api.removeLink(id);
      await load();
    },
    [api, load],
  );

  const inspectRefs = useCallback(
    async (memoryId: string) => {
      const docs = await api.listMemoryRefs(memoryId);
      setRefsOf({ memoryId, docs });
    },
    [api],
  );

  return (
    <section className="ec-docs__links" aria-label="关联记忆">
      <header className="ec-docs__links-head">
        <h3>{`📎 ${links.length} 个关联记忆`}</h3>
      </header>

      {error ? <p className="ec-docs__error">{error}</p> : null}

      <ul className="ec-docs__link-list">
        {links.length === 0 ? <li className="ec-docs__hint">尚未关联任何记忆节点。</li> : null}
        {links.map((link) => {
          const node = nodeById.get(link.memoryId);
          const count = counts[link.memoryId] ?? 0;
          return (
            <li key={link.id}>
              <span className="ec-docs__link-name">
                {node ? `${DOC_MEMORY_SCOPE_LABELS[node.scope]}：${node.title}` : link.memoryId}
              </span>
              <Tag color="neutral">{DOC_LINK_TYPE_LABELS[link.linkType]}</Tag>
              <Tag color="info">{`📎 ${count} 篇关联文档`}</Tag>
              <Button size="sm" variant="ghost" onClick={() => void inspectRefs(link.memoryId)}>
                查看引用
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void removeLink(link.id)}>
                取消关联
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="ec-docs__link-form">
        <Select
          aria-label="选择记忆节点"
          value={selectedMemory}
          placeholder="选择记忆节点"
          options={options}
          onChange={setSelectedMemory}
        />
        <Select
          aria-label="关联类型"
          value={linkType}
          options={DOC_LINK_TYPES.map((value) => ({ value, label: DOC_LINK_TYPE_LABELS[value] }))}
          onChange={(value) => setLinkType(value as DocLinkType)}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={!selectedMemory}
          onClick={() => void addLink()}
        >
          建立关联
        </Button>
      </div>

      {refsOf ? (
        <div className="ec-docs__refs" role="region" aria-label="反向引用">
          <h4>该记忆被以下文档引用</h4>
          <ul>
            {refsOf.docs.map((ref) => (
              <li key={ref.id}>
                <button type="button" onClick={() => onOpenDocument?.(ref.documentId)}>
                  {ref.documentId}
                </button>
              </li>
            ))}
            {refsOf.docs.length === 0 ? <li>暂无其它文档引用该记忆。</li> : null}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
