import { useMemo } from 'react';

import { EmptyState } from '@ec/ui';

import { GitApiProvider, GitWorkspace, readInjectedGitApi } from '../features/git';
import { useAppStore } from '../store/useAppStore';
import { useProjectStore } from '../store/useProjectStore';

/**
 * 版本管理页面（Wave 6 / T6-01 ~ T6-04 + T12-01 生产端口）。
 *
 * 结构化引导三层：
 * 1. 端口未注入（`__EC_GIT__`）→ 外壳装配引导；
 * 2. 已注入但未打开项目 → 「先打开项目」（Git 域按 projectId 绑定仓库）；
 * 3. 已打开但工程目录里还没有仓库 → 页面内提供「初始化仓库」入口（不伪造提交历史）。
 */
export function GitPage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const project = useProjectStore((state) => state.current);
  const api = useMemo(() => (void shellReady, readInjectedGitApi()), [shellReady]);

  return (
    <section className="ec-page" aria-label="版本管理">
      <h1 className="ec-page__title">版本管理</h1>
      {api === null ? (
        <EmptyState
          title="Git 服务未初始化"
          description="外壳尚未注入 GitApi（__EC_GIT__）。仓库的检出、提交、分支与远程操作都由外壳侧的真实 Git 客户端完成。"
        />
      ) : project === null ? (
        <EmptyState
          title="未打开项目"
          description="Git 仓库按项目代码根（<工程目录>/code）维护，请先在工作台打开一个项目。"
        />
      ) : (
        <GitApiProvider api={api}>
          <GitWorkspace />
        </GitApiProvider>
      )}
    </section>
  );
}

