import { useMemo } from 'react';
import { EmptyState } from '@ec/ui';
import { ApiWorkbench } from '../features/api-index/ApiWorkbench';
import { readInjectedApiIndex } from '../runtime/api-index-port';
import { useAppStore } from '../store/useAppStore';
import { useProjectStore } from '../store/useProjectStore';

export function ApiPage(): JSX.Element {
  const shellReady = useAppStore((s) => s.shellReady),
    project = useProjectStore((s) => s.current);
  const api = useMemo(() => (void shellReady, readInjectedApiIndex()), [shellReady]);
  return (
    <section className="ec-page" aria-label="接口">
      <h1 className="ec-page__title">接口</h1>
      {!project ? (
        <EmptyState title="未打开项目" description="请在工作台打开项目后识别源码接口。" />
      ) : !api ? (
        <EmptyState
          title="接口服务未初始化"
          description="请重新打开桌面工作台以连接源码索引服务。"
        />
      ) : (
        <ApiWorkbench key={project.id} projectId={project.id} api={api} />
      )}
    </section>
  );
}
