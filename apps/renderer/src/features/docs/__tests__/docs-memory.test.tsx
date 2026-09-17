import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ConvertToMemoryDialog } from '../ConvertToMemoryDialog';
import { DocMemoryLink } from '../DocMemoryLink';
import { DocsProvider } from '../docs-api';
import { createFakeDocsApi, seedDocument, type FakeDocsEnvironment } from './fake-docs';

const PROJECT = 'proj-1';
const MARKDOWN = `# 课程平台

## 功能需求

- 课程管理：支持上下架
- 学习进度：支持续播
`;

function renderLinks(env: FakeDocsEnvironment, documentId: string, onOpenDocument = vi.fn()) {
  render(
    <DocsProvider api={env.api}>
      <DocMemoryLink projectId={PROJECT} documentId={documentId} onOpenDocument={onOpenDocument} />
    </DocsProvider>,
  );
  return { onOpenDocument };
}

describe('DocMemoryLink（文档 ↔ 记忆双向关联）', () => {
  let env: FakeDocsEnvironment;
  let docId: string;

  beforeEach(async () => {
    env = createFakeDocsApi();
    env.memory.seedNode({ id: 'mem-project', scope: 'project', title: '课程平台技术栈' });
    env.memory.seedNode({ id: 'mem-longterm', scope: 'longterm', title: '所有代码必须有单元测试' });
    docId = await seedDocument(env.store, { projectId: PROJECT, title: '需求文档', markdown: MARKDOWN });
  });

  it('初始无关联，可选择五类记忆节点建立关联并显示关联文档数', async () => {
    renderLinks(env, docId);
    expect(await screen.findByText('📎 0 个关联记忆')).toBeTruthy();
    expect(screen.getByText('尚未关联任何记忆节点。')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('选择记忆节点'));
    fireEvent.click(screen.getByRole('option', { name: /项目记忆：课程平台技术栈/ }));
    fireEvent.click(screen.getByRole('button', { name: '建立关联' }));

    await waitFor(() => expect(env.memory.links.size).toBe(1));
    expect(await screen.findByText('📎 1 个关联记忆')).toBeTruthy();
    expect(screen.getByText('项目记忆：课程平台技术栈')).toBeTruthy();
    // 记忆卡片语义：📎 N 篇关联文档
    expect(screen.getByText('📎 1 篇关联文档')).toBeTruthy();
  });

  it('关联类型可选（相关 / 支撑 / 派生自）', async () => {
    renderLinks(env, docId);
    await screen.findByText('尚未关联任何记忆节点。');
    fireEvent.click(screen.getByLabelText('关联类型'));
    fireEvent.click(screen.getByRole('option', { name: '支撑' }));
    fireEvent.click(screen.getByLabelText('选择记忆节点'));
    fireEvent.click(screen.getByRole('option', { name: /长期记忆/ }));
    fireEvent.click(screen.getByRole('button', { name: '建立关联' }));

    await waitFor(() => expect(env.memory.links.size).toBe(1));
    expect([...env.memory.links.values()][0]!.link_type).toBe('supports');
  });

  it('反向跳转：查看某记忆被哪些文档引用，点击可跳转到对应文档', async () => {
    await env.api.linkToMemory({ memoryId: 'mem-project', documentId: docId, linkType: 'related' });
    const secondDoc = await seedDocument(env.store, {
      projectId: PROJECT,
      title: '技术文档',
      markdown: '# 技术\n\n## 功能\n- 架构\n',
    });
    await env.api.linkToMemory({ memoryId: 'mem-project', documentId: secondDoc, linkType: 'supports' });

    const { onOpenDocument } = renderLinks(env, docId);
    fireEvent.click(await screen.findByRole('button', { name: '查看引用' }));

    const refs = await screen.findByLabelText('反向引用');
    // 该记忆被两篇文档引用（当前文档 + 技术文档）
    expect(within(refs).getByRole('button', { name: secondDoc })).toBeTruthy();
    fireEvent.click(within(refs).getByRole('button', { name: secondDoc }));
    expect(onOpenDocument).toHaveBeenCalledWith(secondDoc);
  });

  it('取消关联后列表回到空态', async () => {
    await env.api.linkToMemory({ memoryId: 'mem-longterm', documentId: docId, linkType: 'related' });
    renderLinks(env, docId);
    fireEvent.click(await screen.findByRole('button', { name: '取消关联' }));
    await waitFor(() => expect(env.memory.links.size).toBe(0));
    expect(await screen.findByText('尚未关联任何记忆节点。')).toBeTruthy();
  });
});

describe('ConvertToMemoryDialog（一键转记忆）', () => {
  let env: FakeDocsEnvironment;
  let docId: string;

  beforeEach(async () => {
    env = createFakeDocsApi();
    docId = await seedDocument(env.store, { projectId: PROJECT, title: '需求文档', markdown: MARKDOWN });
  });

  it('生成 AI 摘要草稿 → 可编辑 → 提交后创建记忆并保留原文链接', async () => {
    const doc = (await env.api.getDocument(docId))!;
    const onConverted = vi.fn();
    render(
      <DocsProvider api={env.api}>
        <ConvertToMemoryDialog
          open
          projectId={PROJECT}
          documentId={docId}
          documentTitle={doc.title}
          sections={doc.sections}
          onClose={vi.fn()}
          onConverted={onConverted}
        />
      </DocsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '生成结构化摘要' }));
    const titleInput = await screen.findByLabelText('记忆标题');
    expect((titleInput as HTMLInputElement).value).toContain('结构化摘要');

    // 草稿可编辑
    fireEvent.change(titleInput, { target: { value: '课程平台：功能范围' } });
    fireEvent.change(screen.getByLabelText('记忆摘要'), { target: { value: '手动润色后的摘要' } });
    expect(screen.getByText(/原文链接将被保留：docId=/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存为记忆' }));
    await waitFor(() => expect(onConverted).toHaveBeenCalled());
    const nodes = [...env.memory.nodes.values()];
    const created = nodes.find((node) => node.title === '课程平台：功能范围');
    expect(created).toBeTruthy();
    expect(created!.scope).toBe('project');
    // derived_from 关联被建立
    expect([...env.memory.links.values()].some((link) => link.link_type === 'derived_from')).toBe(true);
  });

  it('AI 摘要端口缺失时如实报错并给引导（不内置模板顶替）', async () => {
    const noAi = createFakeDocsApi({ withExtraction: false });
    const docId2 = await seedDocument(noAi.store, { projectId: PROJECT, title: '文档', markdown: MARKDOWN });
    const doc = (await noAi.api.getDocument(docId2))!;

    render(
      <DocsProvider api={noAi.api}>
        <ConvertToMemoryDialog
          open
          projectId={PROJECT}
          documentId={docId2}
          documentTitle={doc.title}
          sections={doc.sections}
          onClose={vi.fn()}
          onConverted={vi.fn()}
        />
      </DocsProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '生成结构化摘要' }));
    expect(await screen.findByText(/未接入 AI 摘要端口/)).toBeTruthy();
    // 没有草稿 → 不出现"保存为记忆"
    expect(screen.queryByRole('button', { name: '保存为记忆' })).toBeNull();
  });

  it('选择单个片段（section）时摘要只针对该段落', async () => {
    const doc = (await env.api.getDocument(docId))!;
    render(
      <DocsProvider api={env.api}>
        <ConvertToMemoryDialog
          open
          projectId={PROJECT}
          documentId={docId}
          documentTitle={doc.title}
          sections={doc.sections}
          onClose={vi.fn()}
          onConverted={vi.fn()}
        />
      </DocsProvider>,
    );

    fireEvent.click(screen.getByLabelText('转换范围'));
    fireEvent.click(screen.getByRole('option', { name: /功能需求/ }));
    fireEvent.click(screen.getByLabelText('记忆层级'));
    fireEvent.click(screen.getByRole('option', { name: '功能记忆' }));
    fireEvent.click(screen.getByRole('button', { name: '生成结构化摘要' }));

    await waitFor(() => expect(env.extraction.calls.length).toBe(1));
    expect(env.extraction.calls[0]!.scope).toBe('feature');
    expect(env.extraction.calls[0]!.text).toContain('课程管理');
  });
});
