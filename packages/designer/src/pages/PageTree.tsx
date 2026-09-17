/**
 * PageTree：多页面面板（T3-07）。
 *
 * - 页面按端分组（web / android / ios / harmonyos / windows / linux / macos）；
 * - 新建 / 重命名（双击内联）/ 复制 / 删除（删除走二次确认 Modal）；
 * - 选中页面写入 page-store.activePageId，并同步加载进 editor store（三向联动）；
 * - 底部内嵌 RouteGraph（路由跳转关系图），路由表变更经 useRouteMemorySync 写入项目记忆。
 */
import * as React from 'react';
import { Button, EmptyState, Modal } from '@ec/ui';

import { PLATFORMS } from '../dsl/types';
import type { Platform, RouteParam } from '../dsl/types';
import { useDesignerStore } from '../store/designer-context';
import { PageNode } from './PageNode';
import { useMultiPageSnapshot, useMultiPageStore } from './page-store';
import { RouteGraph } from './RouteGraph';
import { patchPageEventAction, useRouteMemorySync } from './route-table';

export interface PageTreeProps {
  /** 面板整体高度（路由图区域按比例分配） */
  height?: number;
}

function newPageId(platform: Platform, count: number): string {
  return `${platform}-page-${count + 1}`;
}

export function PageTree({ height = 520 }: PageTreeProps): React.ReactElement {
  const store = useMultiPageStore();
  const snapshot = useMultiPageSnapshot();
  const editorStore = useDesignerStore();

  const groups = store.pagesByPlatform();
  const projectId = snapshot.pages[0]?.projectId ?? 'P0';

  // 路由总表变更 -> 项目记忆端口
  useRouteMemorySync(projectId, snapshot.pages);

  // 切换激活页面时同步进 editor store（三向联动：图层树 / 画布共享同一 dsl）
  const loadedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (snapshot.activePageId && snapshot.activePageId !== loadedRef.current) {
      const active = snapshot.pages.find((p) => p.id === snapshot.activePageId);
      if (active) {
        editorStore.getState().loadDsl(active);
        loadedRef.current = snapshot.activePageId;
      }
    }
  }, [snapshot.activePageId, snapshot.pages, editorStore]);

  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const confirmPage = confirmId ? snapshot.pages.find((p) => p.id === confirmId) ?? null : null;

  const addPage = (platform: Platform): void => {
    store.createPage({ id: newPageId(platform, snapshot.pages.length), projectId, platform, template: 'blank' });
  };

  const handleUpdateAction = (
    pageId: string,
    eventId: string,
    actionId: string,
    patch: { target?: string; params?: RouteParam[] },
  ): void => {
    const page = snapshot.pages.find((p) => p.id === pageId);
    if (!page) return;
    store.updatePageDsl(pageId, patchPageEventAction(page, eventId, actionId, patch));
  };

  const listHeight = Math.max(160, Math.floor(height * 0.55));
  const graphHeight = Math.max(200, height - listHeight - 48);

  return (
    <div className="ec-page-tree" style={{ height }}>
      <div className="ec-page-tree__list" style={{ height: listHeight }}>
        {snapshot.pages.length === 0 ? (
          <EmptyState
            title="还没有页面"
            description="点击下方按钮新建第一个页面"
            action={
              <Button variant="primary" onClick={() => addPage('web')}>
                新建页面
              </Button>
            }
          />
        ) : (
          PLATFORMS.map((platform) => {
            const pages = groups[platform];
            if (!pages || pages.length === 0) return null;
            return (
              <section key={platform} className="ec-page-group" data-platform={platform}>
                <header className="ec-page-group__header">
                  <span className="ec-page-group__title">{platform}</span>
                  <span className="ec-page-group__count">{pages.length}</span>
                  <IconAddButton label={`在 ${platform} 新建页面`} onClick={() => addPage(platform)} />
                </header>
                <div className="ec-page-group__items">
                  {pages.map((page) => (
                    <PageNode
                      key={page.id}
                      page={page}
                      active={page.id === snapshot.activePageId}
                      onSelect={(id) => store.setActive(id)}
                      onStartRename={() => undefined}
                      onCommitRename={(id, name) => store.renamePage(id, name)}
                      onDuplicate={(id) => store.duplicatePage(id)}
                      onRequestDelete={(id) => setConfirmId(id)}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>

      <div className="ec-page-tree__routes" style={{ height: graphHeight }}>
        <RouteGraph pages={snapshot.pages} height={graphHeight} onUpdateAction={handleUpdateAction} />
      </div>

      <Modal
        open={confirmPage !== null}
        title="删除页面"
        onOpenChange={(open) => {
          if (!open) setConfirmId(null);
        }}
        footer={
          <>
            <Button onClick={() => setConfirmId(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmId) store.removePage(confirmId);
                setConfirmId(null);
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p>
          确定要删除页面「{confirmPage?.name}」吗？该操作会移入回收站，可在回收站中恢复。
        </p>
      </Modal>
    </div>
  );
}

function IconAddButton({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return (
    <button type="button" className="ec-page-group__add" aria-label={label} title={label} onClick={onClick}>
      ＋
    </button>
  );
}
