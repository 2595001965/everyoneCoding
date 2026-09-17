import { useMemo } from 'react';

import { DesignerProvider, createEditorStore, createLoginPageDsl } from '@ec/designer';
import { MultiPageProvider, MultiPageStore } from '@ec/designer';

import { DesignerWorkspace } from '../features/designer/DesignerWorkspace';

/**
 * 设计器页面（Wave 3）。
 *
 * 装配职责（与 Wave 2 记忆中心一致）：
 * - 创建编辑器 store（文档 + 选中态 + 撤销栈）
 * - 创建多页面集合，供页面树 / 路由图使用
 * - 注入 `DesignerPorts`（记忆、AI、文件）——真实实现属 Wave 9/10 的外壳装配，
 *   这里先以空端口运行，各能力入口自动降级为引导提示
 */
export function DesignerPage(): JSX.Element {
  const editorStore = useMemo(() => createEditorStore({ dsl: createLoginPageDsl() }), []);
  const pageStore = useMemo(() => new MultiPageStore({ pages: [createLoginPageDsl()] }), []);

  return (
    <DesignerProvider store={editorStore}>
      <MultiPageProvider store={pageStore}>
        <DesignerWorkspace />
      </MultiPageProvider>
    </DesignerProvider>
  );
}
