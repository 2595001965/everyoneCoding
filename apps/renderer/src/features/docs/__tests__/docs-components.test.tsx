import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DocLibrary } from '../DocLibrary';
import { DocViewer } from '../DocViewer';
import { DocsProvider } from '../docs-api';
import { createFakeDocsApi, seedDocument, type FakeDocsEnvironment } from './fake-docs';

const PROJECT = 'proj-1';

const MARKDOWN = `# 在线课程平台

产品说明段落。

## 功能需求

- 课程管理
- 用户注册

### 子项

细节说明。
`;

function renderLibrary(env: FakeDocsEnvironment, onSelect = vi.fn()) {
  const utils = render(
    <DocsProvider api={env.api}>
      <DocLibrary projectId={PROJECT} selectedId={null} onSelect={onSelect} />
    </DocsProvider>,
  );
  return { ...utils, onSelect };
}

describe('DocLibrary（文档库）', () => {
  let env: FakeDocsEnvironment;

  beforeEach(() => {
    env = createFakeDocsApi();
  });

  it('导入 Markdown：正文与标题层级被真实解析后入档，列表出现新文档并自动选中', async () => {
    const { onSelect } = renderLibrary(env);
    expect(await screen.findByText('还没有文档')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '导入文档' }));
    fireEvent.change(await screen.findByLabelText('文档内容'), { target: { value: MARKDOWN } });
    fireEvent.click(screen.getByRole('button', { name: '导入' }));

    await waitFor(() => expect(env.store.docs.size).toBe(1));
    const row = [...env.store.docs.values()][0]!;
    expect(row.title).toBe('在线课程平台');
    expect(row.format).toBe('markdown');
    // 真实解析出的标题层级（# / ## / ###）
    const sections = JSON.parse(row.sections_json!) as Array<{ level: number; heading: string }>;
    expect(sections.map((s) => s.level)).toEqual([1, 2, 3]);
    expect(onSelect).toHaveBeenCalledWith(row.id);
    expect(await screen.findByText('在线课程平台')).toBeTruthy();
  });

  it('docx / pdf 走文件导入端口（由外壳读取解析），格式不可解析时选项被禁用', async () => {
    renderLibrary(env);
    await screen.findByText('还没有文档');
    fireEvent.click(screen.getByRole('button', { name: '导入文档' }));

    // 浏览器安全解析器只支持 markdown / txt → 其它格式选项禁用
    fireEvent.click(screen.getByLabelText('文档格式'));
    const pdfOption = screen.getByRole('option', { name: /PDF/ }) as HTMLElement;
    expect(pdfOption.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(screen.getByRole('option', { name: /Markdown/ }));
    fireEvent.change(screen.getByLabelText('文档内容'), { target: { value: '# 只需文本' } });
    fireEvent.click(screen.getByRole('button', { name: '导入' }));

    await waitFor(() => expect(env.store.docs.size).toBe(1));
    expect(env.fileImports).toEqual([]);
  });

  it('删除 → 进回收站 → 可恢复（二次确认弹窗生效）', async () => {
    const docId = await seedDocument(env.store, { projectId: PROJECT, title: '需求文档', markdown: MARKDOWN });
    renderLibrary(env);

    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(env.store.docs.get(docId)?.deleted_at).not.toBeNull());
    // 默认视图不含已删除文档
    await waitFor(() => expect(screen.getByText('还没有文档')).toBeTruthy());

    fireEvent.click(screen.getByRole('checkbox', { name: /回收站/ }));
    const restore = await screen.findByRole('button', { name: '恢复' });
    fireEvent.click(restore);
    await waitFor(() => expect(env.store.docs.get(docId)?.deleted_at).toBeNull());
  });

  it('彻底删除需再次确认，确认后行被移除', async () => {
    const docId = await seedDocument(env.store, {
      projectId: PROJECT,
      title: '待清理',
      markdown: MARKDOWN,
      deletedAt: Date.now(),
    });
    renderLibrary(env);
    fireEvent.click(await screen.findByRole('checkbox', { name: /回收站/ }));
    fireEvent.click(await screen.findByRole('button', { name: '彻底删除' }));
    expect(screen.getByText(/无法恢复/)).toBeTruthy();
    // 弹窗里也有同名确认按钮
    const dialogs = screen.getAllByRole('button', { name: '彻底删除' });
    fireEvent.click(dialogs[dialogs.length - 1]!);
    await waitFor(() => expect(env.store.docs.has(docId)).toBe(false));
  });

  it('搜索按标题过滤', async () => {
    await seedDocument(env.store, { projectId: PROJECT, title: '课程平台需求', markdown: MARKDOWN });
    await seedDocument(env.store, { projectId: PROJECT, title: '支付需求', markdown: '# 支付\n\n## 功能\n- 下单\n' });
    renderLibrary(env);
    expect(await screen.findByText('课程平台需求')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索文档'), { target: { value: '支付' } });
    await waitFor(() => expect(screen.queryByText('课程平台需求')).toBeNull());
    expect(screen.getByText('支付需求')).toBeTruthy();
  });
});

describe('DocViewer（正文与定位）', () => {
  let env: FakeDocsEnvironment;
  const scrollSpy = vi.fn();

  beforeEach(() => {
    env = createFakeDocsApi();
    scrollSpy.mockClear();
    // jsdom 无 scrollIntoView
    Element.prototype.scrollIntoView = scrollSpy;
  });

  it('大纲点击定位到对应段落（Markdown 标题锚点）', async () => {
    const docId = await seedDocument(env.store, { projectId: PROJECT, title: '课程平台', markdown: MARKDOWN });
    render(
      <DocsProvider api={env.api}>
        <DocViewer documentId={docId} />
      </DocsProvider>,
    );

    const outline = await screen.findByLabelText('文档大纲');
    const anchorButton = within(outline).getByRole('button', { name: '功能需求' });
    fireEvent.click(anchorButton);

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    // 正文里存在与该锚点对应的可定位元素
    const doc = env.store.docs.get(docId)!;
    const sections = JSON.parse(doc.sections_json!) as Array<{ anchor: string; heading: string }>;
    const anchor = sections.find((section) => section.heading === '功能需求')!.anchor;
    expect(document.getElementById(anchor)).toBeTruthy();
    expect(within(outline).getByRole('button', { name: '功能需求' }).closest('li')?.getAttribute('data-active')).toBe('true');
  });

  it('PDF 文档在大纲标注页码（页码定位可用）', async () => {
    const doc = await env.api.importFromFile({
      projectId: PROJECT,
      format: 'pdf',
      filePath: 'D:/docs/需求说明.pdf',
    });
    render(
      <DocsProvider api={env.api}>
        <DocViewer documentId={doc.id} />
      </DocsProvider>,
    );
    const outline = await screen.findByLabelText('文档大纲');
    expect(within(outline).getByRole('button', { name: /PDF 第二章（第 3 页）/ })).toBeTruthy();
  });

  it('版本 >1 时提示"文档已更新"，忽略后提示消失且状态落库', async () => {
    const docId = await seedDocument(env.store, {
      projectId: PROJECT,
      title: '已更新文档',
      markdown: MARKDOWN,
      version: 3,
      ignoredVersion: null,
    });
    render(
      <DocsProvider api={env.api}>
        <DocViewer documentId={docId} />
      </DocsProvider>,
    );

    expect(await screen.findByText(/文档已更新至 v3/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '忽略该版本提示' }));

    await waitFor(() => expect(env.store.docs.get(docId)?.ignored_version).toBe(3));
    await waitFor(() => expect(screen.queryByText(/文档已更新至 v3/)).toBeNull());
  });

  it('已忽略的版本不再提示（ignored >= current）', async () => {
    const docId = await seedDocument(env.store, {
      projectId: PROJECT,
      title: '已忽略',
      markdown: MARKDOWN,
      version: 2,
      ignoredVersion: 2,
    });
    render(
      <DocsProvider api={env.api}>
        <DocViewer documentId={docId} />
      </DocsProvider>,
    );
    await screen.findByText('已忽略');
    expect(screen.queryByText(/文档已更新/)).toBeNull();
  });

  it('版本历史可展开，含创建者标注', async () => {
    const docId = await seedDocument(env.store, { projectId: PROJECT, title: 'V', markdown: MARKDOWN });
    await env.api.updateDocument({ id: docId, raw: `${MARKDOWN}\n补充一段。` });
    render(
      <DocsProvider api={env.api}>
        <DocViewer documentId={docId} />
      </DocsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /版本历史/ }));
    const list = await screen.findByLabelText('版本历史');
    expect(within(list).getByText('v2')).toBeTruthy();
    expect(within(list).getAllByText('用户编辑').length).toBeGreaterThan(0);
  });

  it('文档不存在时展示空态而非崩溃', async () => {
    render(
      <DocsProvider api={env.api}>
        <DocViewer documentId="missing-id" />
      </DocsProvider>,
    );
    expect(await screen.findByText('未选择文档')).toBeTruthy();
  });
});
