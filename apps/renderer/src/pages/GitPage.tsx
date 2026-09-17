import { EmptyState } from '@ec/ui';

import { GitApiProvider, GitWorkspace, readInjectedGitApi } from '../features/git';

/**
 * 版本管理页面（Wave 6 / T6-01 ~ T6-04）。
 * 外壳未注入 `__EC_GIT__` 时展示装配引导（与流水线 / 预览一致），不崩溃。
 */
export function GitPage(): JSX.Element {
  const api = readInjectedGitApi();
  if (api === null) {
    return (
      <section className="ec-page" aria-label="版本管理">
        <h1 className="ec-page__title">版本管理</h1>
        <EmptyState
          title="Git 服务未初始化"
          description="外壳尚未注入 GitApi（__EC_GIT__）。真实装配属 Wave 9/10 的外壳接线工作，当前先展示领域能力入口。"
        />
      </section>
    );
  }
  return (
    <section className="ec-page" aria-label="版本管理">
      <GitApiProvider api={api}>
        <GitWorkspace />
      </GitApiProvider>
    </section>
  );
}
