import { useMemo } from 'react';

import { EmptyState } from '@ec/ui';

import { PreviewApiProvider, PreviewWorkspace, readInjectedPreviewApi } from '../features/preview';
import { useAppStore } from '../store/useAppStore';
import { useProjectStore } from '../store/useProjectStore';

/**
 * 预览页面（Wave 6 / T6-05、T6-06 + T12-01 生产端口）。
 *
 * 预览域按 projectId 托管静态服务（端口顺延探测），因此未打开项目时给结构化引导；
 * 外壳未注入 `__EC_PREVIEW__` 时展示装配引导，不崩溃。
 */
export function PreviewPage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const project = useProjectStore((state) => state.current);
  const api = useMemo(() => (void shellReady, readInjectedPreviewApi()), [shellReady]);

  return (
    <section className="ec-page" aria-label="预览">
      <h1 className="ec-page__title">预览</h1>
      {api === null ? (
        <EmptyState
          title="预览服务未初始化"
          description="外壳尚未注入 PreviewApi（__EC_PREVIEW__）。静态预览由外壳侧的受控 HTTP 服务托管。"
        />
      ) : project === null ? (
        <EmptyState
          title="未打开项目"
          description="预览按项目代码根（<工程目录>/code）托管，请先在工作台打开一个项目。"
        />
      ) : (
        <PreviewApiProvider api={api}>
          <PreviewWorkspace />
        </PreviewApiProvider>
      )}
    </section>
  );
}
