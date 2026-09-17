import { EmptyState } from '@ec/ui';

import { PreviewApiProvider, PreviewWorkspace, readInjectedPreviewApi } from '../features/preview';

/**
 * 预览页面（Wave 6 / T6-05、T6-06）。
 * 外壳未注入 `__EC_PREVIEW__` 时展示装配引导（与流水线 / 记忆中心一致），不崩溃。
 */
export function PreviewPage(): JSX.Element {
  const api = readInjectedPreviewApi();
  if (api === null) {
    return (
      <section className="ec-page" aria-label="预览">
        <h1 className="ec-page__title">预览</h1>
        <EmptyState
          title="预览服务未初始化"
          description="外壳尚未注入 PreviewApi（__EC_PREVIEW__）。真实装配属 Wave 9/10 的外壳接线工作，当前先展示领域能力入口。"
        />
      </section>
    );
  }
  return (
    <section className="ec-page" aria-label="预览">
      <PreviewApiProvider api={api}>
        <PreviewWorkspace />
      </PreviewApiProvider>
    </section>
  );
}
