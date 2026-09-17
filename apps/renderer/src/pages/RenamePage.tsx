import { EmptyState } from '@ec/ui';

import { RenameApiProvider, RenameWorkspace, readInjectedRenameApi } from '../features/rename';

/**
 * 统一重命名页面（Wave 7 / T7-01 ~ T7-05）。
 *
 * 外壳未注入 `__EC_RENAME__` 时展示装配引导（与流水线 / Git / 预览一致），不崩溃。
 * 真实装配属 Wave 9/10：把注册表仓库、出现位置索引（T7-02）、执行器端口
 * （文件 / 文档 / 记忆 / DSL / 锚点）接到 `RenameApi` 上。
 */
export function RenamePage(): JSX.Element {
  const api = readInjectedRenameApi();
  if (api === null) {
    return (
      <section className="ec-page" aria-label="统一重命名">
        <h1 className="ec-page__title">统一重命名</h1>
        <EmptyState
          title="重命名服务未初始化"
          description="外壳尚未注入 RenameApi（__EC_RENAME__）。真实装配属 Wave 9/10 的外壳接线工作，当前先展示领域能力入口。"
        />
      </section>
    );
  }
  return (
    <section className="ec-page" aria-label="统一重命名">
      <RenameApiProvider api={api}>
        <RenameWorkspace />
      </RenameApiProvider>
    </section>
  );
}
