import { useMemo } from 'react';
import { EmptyState } from '@ec/ui';

import { DocsPage, readInjectedDocsApi } from '../features/docs';
import { useAppStore } from '../store/useAppStore';
import { useProjectStore } from '../store/useProjectStore';

/**
 * 文档中心页（Wave 9 / T9-04）。
 *
 * 端口由外壳注入（`globalThis.__EC_DOCS__`）：文件解析、SQLite 落库与记忆关联
 * 都在外壳侧完成；未注入时展示装配引导，未打开项目时提示先选项目。
 */
export function DocsCenterPage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const projectId = useProjectStore((state) => state.current?.id ?? null);
  const api = useMemo(() => (void shellReady, readInjectedDocsApi()), [shellReady]);

  if (!api) return <DocsPage api={null} projectId="" />;
  if (!projectId) {
    return <EmptyState title="未打开项目" description="请先在工作台打开一个项目，再管理该项目的文档与记忆关联。" />;
  }
  return <DocsPage api={api} projectId={projectId} />;
}
