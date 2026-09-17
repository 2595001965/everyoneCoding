/**
 * 代码视图与写入管线（T4-05）对外入口。
 *
 * 使用方式：
 * ```tsx
 * const api = readInjectedCodeApi();               // 外壳注入 globalThis.__EC_CODE__
 * <CodeViewProvider api={api}>
 *   <CodeView path="src/auth/auth.controller.ts" />
 *   <DiffView model={toDiffViewModel(plan)} />
 *   <ApplyBar plan={plan} model={model} onApply={...} />
 * </CodeViewProvider>
 * ```
 * 未注入实现时代码视图展示引导，界面里不会出现任何可保存代码的控件（D-04）。
 */

export {
  CodeViewProvider,
  useCodeViewApi,
  useCodeViewOptional,
  readInjectedCodeApi,
  type CodeFileApi,
  type CodeFileEntry,
  type CodeViewApi,
  type CodeWriteApi,
  type ExternalChangeHint,
  type ReworkRequest,
} from './code-api';
export { CodeView, describeReadOnlyBlock, type CodeViewProps } from './CodeView';
export { AiFixEntry, type AiFixEntryProps } from './AiFixEntry';
export { DiffView, diffLineColor, diffLinePrefix, type DiffLayout, type DiffViewProps } from './DiffView';
export { ApplyBar, type ApplyBarProps } from './ApplyBar';
