/**
 * AI 上下文面板的对外入口（Wave 4 / T4-02）。
 *
 * 使用方式：
 * ```tsx
 * const api = readInjectedContextApi();            // 外壳注入 globalThis.__EC_AI_CONTEXT__
 * <ContextPanelProvider api={api}>
 *   <ContextPanel request={{ userId, projectId, purpose: 'code', elementId }} />
 * </ContextPanelProvider>
 * ```
 * 未注入实现时面板展示装配引导，而不是空白或崩溃。
 */

export {
  ContextPanelProvider,
  useContextPanelApi,
  useContextPanelOptional,
  readInjectedContextApi,
  type ContextPanelApi,
} from './context-api';
export { ContextPanel, type ContextPanelProps } from './ContextPanel';
export { BlockCard, type BlockCardProps } from './BlockCard';
