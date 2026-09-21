import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EmptyState, Spinner } from '@ec/ui';
import {
  DesignerProvider,
  MultiPageProvider,
  MultiPageStore,
  createEditorStore,
  deserializePageDsl,
  DSL_VERSION,
  type DesignerPorts,
  type PageDsl,
  type RouteEntry,
} from '@ec/designer';

import { DesignerWorkspace } from '../features/designer/DesignerWorkspace';
import {
  readInjectedDesignerApi,
  type DesignerPageSummary,
  type DesignerPortApi,
} from '../features/designer/designer-api';
import { useAppStore } from '../store/useAppStore';
import { useProjectStore } from '../store/useProjectStore';

/**
 * 设计器页面（Wave 3 + T12-01 生产端口总装）。
 *
 * 项目上下文贯穿：从 `useProjectStore` 取当前打开的项目，页面 / DSL / 页面记忆 /
 * 路由总表全部经 `__EC_DESIGNER__` 端口落到真实工程目录与 SQLite——
 * **不再**固定装配 `createLoginPageDsl()` 的登录页夹具。
 *
 * 未打开项目 / 端口未装配时展示结构化引导（与其它页面同一口径）：
 * - 端口未注入 → 外壳装配引导；
 * - 已注入但没打开项目 → 「先去工作台打开项目」引导。
 */
export function DesignerPage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const project = useProjectStore((state) => state.current);
  // shellReady 变化代表外壳可能刚注入实现，需要重新读取
  const api = useMemo(() => (void shellReady, readInjectedDesignerApi()), [shellReady]);

  if (!api) {
    return (
      <section className="ec-page" aria-label="设计器">
        <h1 className="ec-page__title">设计器</h1>
        <EmptyState
          title="设计器服务未初始化"
          description="外壳尚未注入设计器端口（__EC_DESIGNER__）。页面 DSL、页面记忆与路由总表的读写都在外壳侧完成。"
        />
      </section>
    );
  }
  if (!project) {
    return (
      <section className="ec-page" aria-label="设计器">
        <h1 className="ec-page__title">设计器</h1>
        <EmptyState
          title="未打开项目"
          description="请先在工作台新建或打开一个项目，设计器的页面与改动都会归属到该项目。"
        />
      </section>
    );
  }
  return <DesignerSession key={project.id} api={api} projectId={project.id} />;
}

interface DesignerSessionProps {
  api: DesignerPortApi;
  projectId: string;
}

type SessionStatus = 'loading' | 'ready' | 'error';
type EditorStoreLike = ReturnType<typeof createEditorStore>;

/**
 * 单项目的设计器会话。
 *
 * 生命周期：
 * 1. `openProject` → 幂等建出工程目录，读取页面清单（空项目自动建第一页）；
 * 2. 读全部页面 DSL → 构造真实的 MultiPageStore（页面树 / 路由图数据源）；
 * 3. 编辑器变更 → 防抖原子保存（DSL 落盘 + 页面结构摘要写记忆），成功后清脏标记；
 * 4. 项目切换（`key={project.id}`）时整棵会话卸载，旧订阅 / 旧文档一并释放。
 */
function DesignerSession({ api, projectId }: DesignerSessionProps): JSX.Element {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<PageDsl[]>([]);
  const [pageStore, setPageStore] = useState<MultiPageStore | null>(null);
  const [editorStore, setEditorStore] = useState<EditorStoreLike | null>(null);
  /** 已落盘登记的页面 id（避免每次订阅都全量重写） */
  const savedPagesRef = useRef<Set<string>>(new Set());

  /* ---------------- 1. 打开项目 + 读取页面 ---------------- */
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        await api.openProject(projectId);
        let summaries: readonly DesignerPageSummary[] = await api.listPages(projectId);
        if (summaries.length === 0) {
          await api.createPage(projectId, { name: '首页', route: '/', platform: 'web' });
          summaries = await api.listPages(projectId);
        }
        const loaded: PageDsl[] = [];
        for (const summary of summaries) {
          try {
            const envelope = (await api.loadPage(projectId, summary.pageId)) as {
              dslVersion?: number;
              page?: unknown;
            };
            const { dsl } = deserializePageDsl(JSON.stringify(envelope));
            loaded.push(dsl);
            savedPagesRef.current.add(dsl.id);
          } catch {
            // 坏 DSL 不阻塞整页装配，由页面树反映缺失
          }
        }
        if (cancelled) return;
        if (loaded.length === 0) throw new Error('项目内没有可用的页面 DSL，请重新创建页面');
        setPages(loaded);
        setPageStore(new MultiPageStore({ pages: loaded, activePageId: loaded[0]?.id ?? null }));
        setEditorStore(createEditorStore({ dsl: loaded[0] as PageDsl }));
        setStatus('ready');
      } catch (cause) {
        if (cancelled) return;
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, projectId]);

  /* ---------------- 2. 端口注入（记忆 / 路由 / AI） ---------------- */
  const ports = useMemo<DesignerPorts>(() => {
    if (!pageStore) return {};
    /**
     * 路由总表的同步视图。
     *
     * `ProjectRouteMemoryPort.readRoutes` 是**同步**签名，而权威副本在项目记忆里
     * （异步 RPC，见 `upsertRoutes`）。这里用「已从工程目录加载的真实页面集」投影出
     * 同一份路由表：它既是真实数据（不是夹具），又能在冲突检测的同步读里立刻拿到。
     * 页面新增/改名 → `pageStore` 变化 → 本 memo 重算，视图与权威副本保持同步。
     */
    const routesCache: RouteEntry[] = pages.map((page) => ({
      path: page.route,
      pageId: page.id,
      pageName: page.name,
      platform: page.platform,
      params: [],
    }));
    return {
      // 页面记忆：结构摘要由外壳用 @ec/memory 的精简器生成
      memory: {
        writePageStructure: async (input) => {
          const page = pageStore.getSnapshot().pages.find((item) => item.id === input.pageId);
          // `route` 在 exactOptionalPropertyTypes 下不能传 undefined：用条件展开
          await api.writePageStructure({
            projectId: input.projectId,
            pageId: input.pageId,
            pageName: page?.name ?? input.pageId,
            ...(page?.route !== undefined ? { route: page.route } : {}),
            dsl: input.dsl,
          });
        },
        listStructureRevisions: (pageId) => api.listStructureRevisions(pageId),
      },
      projectMemory: {
        upsertRoutes: async (input) => {
          await api.upsertRoutes(input.projectId, input.routes);
        },
        readRoutes: () => routesCache,
      },
      design: {
        supportsVision: false,
        generatePage: (request) =>
          api.generatePage(projectId, {
            prompt: request.prompt,
            platform: request.platform,
            route: request.route,
          }),
      },
      apiCatalog: {
        // 接口清单来自当前页面声明的接口依赖（不伪造「已定义」）
        listApis: (id) => {
          const page = pageStore.getSnapshot().pages.find((item) => item.id === id);
          return page?.apiDeps ?? [];
        },
      },
      clock: () => Date.now(),
    };
  }, [api, pageStore, pages, projectId]);

  /* ---------------- 3. 编辑器变更 → 原子保存 ---------------- */
  const persistPage = useCallback(
    async (store: EditorStoreLike, page: PageDsl): Promise<void> => {
      await api.savePage(projectId, { dslVersion: DSL_VERSION, page });
      savedPagesRef.current.add(page.id);
      // 页面树数据源同步刷新，切回该页时拿到的是已保存内容
      pageStore?.updatePageDsl(page.id, page);
      store.getState().markSaved();
      await api.writePageStructure({
        projectId,
        pageId: page.id,
        pageName: page.name,
        route: page.route,
        dsl: page,
      });
    },
    [api, pageStore, projectId],
  );

  useEffect(() => {
    if (!editorStore || status !== 'ready') return;
    let timer: number | undefined;
    const unsubscribe = editorStore.subscribe((state) => {
      if (!state.dirty) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void persistPage(editorStore, state.dsl).catch((cause: unknown) => {
          console.error(
            `[designer] 保存失败：${cause instanceof Error ? cause.message : String(cause)}`,
          );
        });
      }, 600);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [editorStore, persistPage, status]);

  /* ---------------- 4. 页面树新建/改名 → 同步落盘 ---------------- */
  useEffect(() => {
    if (!pageStore || status !== 'ready') return;
    let timer: number | undefined;
    const unsubscribe = pageStore.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const snapshot = pageStore.getSnapshot();
        void (async () => {
          for (const page of snapshot.pages) {
            if (savedPagesRef.current.has(page.id)) continue;
            try {
              await api.savePage(projectId, { dslVersion: DSL_VERSION, page });
              savedPagesRef.current.add(page.id);
            } catch (cause) {
              console.error(
                `[designer] 新页面落盘失败：${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
          }
        })();
      }, 300);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [api, pageStore, projectId, status]);

  if (status === 'loading') {
    return (
      <section className="ec-page" aria-label="设计器">
        <h1 className="ec-page__title">设计器</h1>
        <p className="ec-page__desc">
          <Spinner /> 正在读取项目页面…
        </p>
      </section>
    );
  }
  if (status === 'error') {
    return (
      <section className="ec-page" aria-label="设计器">
        <h1 className="ec-page__title">设计器</h1>
        <EmptyState title="页面读取失败" description={error ?? '未知错误'} />
      </section>
    );
  }
  if (!pageStore || !editorStore) {
    return (
      <section className="ec-page" aria-label="设计器">
        <h1 className="ec-page__title">设计器</h1>
        <EmptyState title="页面尚未就绪" description="项目页面仍在装配，请稍候或重新打开设计器。" />
      </section>
    );
  }
  return (
    <DesignerProvider store={editorStore} ports={ports}>
      <MultiPageProvider store={pageStore}>
        <DesignerWorkspace />
      </MultiPageProvider>
    </DesignerProvider>
  );
}

