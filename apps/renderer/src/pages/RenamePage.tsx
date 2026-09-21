import { useMemo } from 'react';

import { EmptyState } from '@ec/ui';

import { RenameApiProvider, RenameWorkspace, readInjectedRenameApi } from '../features/rename';
import { useAppStore } from '../store/useAppStore';
import { useProjectStore } from '../store/useProjectStore';

/**
 * 统一重命名页面（Wave 7 / T7-01 ~ T7-05 + T12-01 生产端口）。
 *
 * 外壳未注入 `__EC_RENAME__` 时展示装配引导；已注入但未打开项目时提示先选项目。
 * 注册表清单来自真实 `registry_entry` 表（按 projectId 过滤）；
 * 影响面 / 事务执行依赖完整 AST 引擎（T12-11），届时由外壳如实降级并给引导。
 */
export function RenamePage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const project = useProjectStore((state) => state.current);
  const api = useMemo(() => (void shellReady, readInjectedRenameApi()), [shellReady]);

  return (
    <section className="ec-page" aria-label="统一重命名">
      <h1 className="ec-page__title">统一重命名</h1>
      {api === null ? (
        <EmptyState
          title="重命名服务未初始化"
          description="外壳尚未注入 RenameApi（__EC_RENAME__）。注册表与命名规则的读取都由外壳侧完成。"
        />
      ) : project === null ? (
        <EmptyState
          title="未打开项目"
          description="重命名只在项目内生效（D-07 / FR-UNI-13），请先在工作台打开一个项目。"
        />
      ) : (
        <RenameApiProvider api={api}>
          <RenameWorkspace />
        </RenameApiProvider>
      )}
    </section>
  );
}
