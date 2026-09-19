import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  applyPanelSelection,
  emptySelection,
  setBlockOverride,
  toContextPanelModel,
  tokenDistributionRows,
  toggleBlock,
  withPlaceholders,
  describeTruncation,
  type AssembledContext,
  type ContextAssemblyRequest,
  type ContextBlockId,
  type ContextPanelSelection,
  type ContextPanelModel,
} from '@ec/ai';
import { Button, EmptyState, Progress, Tag, Tooltip } from '@ec/ui';

import { BlockCard } from './BlockCard';
import { useContextPanelOptional } from './context-api';

/**
 * ContextPanel：可视化"本次将提交什么"（T4-02 要点 3 / FR-AI-01）。
 *
 * 数据流：
 * ```
 * request ──api.assemble──▶ AssembledContext ──toContextPanelModel──▶ 面板
 *    ▲                                                              │
 *    └──────────── applyPanelSelection(勾选 / 就地编辑) ◀────────────┘
 * ```
 *
 * 面板本身不持有引擎，也不做 token 计算 —— 一切派生量都来自 `@ec/ai` 的纯函数，
 * 因此组件测试可以在 jsdom 里用真实引擎 + 假端口跑通（见 `__tests__`）。
 */

export interface ContextPanelProps {
  /** 基础组装请求（含 userId / projectId / 用途 / 选中元素 / 指令） */
  request: ContextAssemblyRequest;
  /** 外部已组装好的结果（受控用法）；不传则面板自行调用端口组装 */
  context?: AssembledContext | null | undefined;
  /** 勾选 / 编辑状态（受控用法） */
  selection?: ContextPanelSelection | undefined;
  onSelectionChange?: ((selection: ContextPanelSelection) => void) | undefined;
  /** 点击「重新组装」时回调（通常由外层重新调用 assemble） */
  onReassemble?: ((request: ContextAssemblyRequest) => void) | undefined;
  /** 点击备注条目跳转 */
  onOpenNote?: ((noteId: string) => void) | undefined;
  height?: number;
}

export function ContextPanel({
  request,
  context = null,
  selection: controlledSelection,
  onSelectionChange,
  onReassemble,
  onOpenNote,
  height = 480,
}: ContextPanelProps): JSX.Element {
  const api = useContextPanelOptional();
  const [selection, setSelection] = useState<ContextPanelSelection>(
    controlledSelection ?? emptySelection(),
  );
  const [assembled, setAssembled] = useState<AssembledContext | null>(context);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeSelection = controlledSelection ?? selection;
  const activeContext = context ?? assembled;

  // 依赖用请求指纹而不是对象引用：调用方（生成面板）常常在渲染期新建请求对象，
  // 若依赖对象本身，就会出现「渲染 → 组装 → setState → 再渲染 → 再组装」的死循环。
  const requestRef = useRef(request);
  requestRef.current = request;
  const requestKey = JSON.stringify(request);

  const updateSelection = useCallback(
    (next: ContextPanelSelection) => {
      if (controlledSelection === undefined) setSelection(next);
      onSelectionChange?.(next);
    },
    [controlledSelection, onSelectionChange],
  );

  const runAssemble = useCallback(
    async (target: ContextAssemblyRequest) => {
      if (api === null) return;
      setLoading(true);
      setError(null);
      try {
        setAssembled(await api.assemble(target));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  // 端口就绪且未受控时自动组装一次（切换元素 / 用途后由 reassemble 触发）
  useEffect(() => {
    if (context !== null && context !== undefined) return;
    if (api === null || !api.ready) return;
    void runAssemble(requestRef.current);
  }, [api, context, requestKey, runAssemble]);

  const model: ContextPanelModel | null = useMemo(
    () =>
      activeContext === null
        ? null
        : withPlaceholders(toContextPanelModel(activeContext, activeSelection)),
    [activeContext, activeSelection],
  );

  if (api === null) {
    return (
      <section className="ec-context-panel" aria-label="上下文面板">
        <EmptyState
          title="上下文面板未初始化"
          description="当前运行环境尚未注入上下文装配端口（记忆检索、备注、设计器 DSL、文档与代码索引）。"
        />
      </section>
    );
  }

  if (!api.ready) {
    return (
      <section className="ec-context-panel" aria-label="上下文面板">
        <EmptyState
          title="上下文服务未就绪"
          description={api.reason ?? '外壳正在初始化本地数据层与记忆检索，稍后重试。'}
        />
      </section>
    );
  }

  return (
    <section
      className="ec-context-panel"
      aria-label="上下文面板"
      data-total-tokens={model?.totalTokens ?? 0}
    >
      <header
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}
      >
        <strong style={{ fontSize: 13 }}>本次将提交的上下文</strong>
        {model !== null && <Tag color="info">{`${model.totalTokens} / ${model.budget} token`}</Tag>}
        {model !== null && <Tag color="neutral">{`利用率 ${model.usagePercent}%`}</Tag>}
        {model !== null && <Tag color="neutral">{`组装 ${model.tookMs} ms`}</Tag>}
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="ghost"
          loading={loading}
          disabled={onReassemble === undefined}
          aria-label="重新组装上下文"
          onClick={() => onReassemble?.(applyPanelSelection(request, activeSelection))}
        >
          重新组装
        </Button>
      </header>

      {model !== null && (
        <div aria-label="上下文预算利用率" style={{ marginBottom: 8 }}>
          <Progress value={Math.min(100, model.usagePercent)} />
        </div>
      )}

      {error !== null && (
        <p role="alert" style={{ color: '#dc2626', fontSize: 12 }}>
          {`组装失败：${error}`}
        </p>
      )}

      {model === null ? (
        <EmptyState
          title={loading ? '正在组装上下文…' : '尚未组装'}
          description="选择元素并生成时会自动组装，也可手动触发。"
        />
      ) : (
        <div className="ec-context-panel__body" style={{ maxHeight: height, overflow: 'auto' }}>
          {model.warnings.length > 0 && (
            <ul
              className="ec-context-panel__warnings"
              data-testid="ec-context-warnings"
              style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12 }}
            >
              {model.warnings.map((warning) => (
                <li key={warning} style={{ color: '#b45309' }}>
                  {warning}
                </li>
              ))}
            </ul>
          )}

          {model.blocks.length === 0 && (
            <EmptyState
              title="没有可提交的上下文"
              description="所有块都被取消勾选或没有数据；生成质量会明显下降。"
            />
          )}

          {model.allBlocks.map((block) => (
            <BlockCard
              key={block.id}
              block={block}
              onToggle={(id: ContextBlockId) => updateSelection(toggleBlock(activeSelection, id))}
              onEdit={(id, text, original) =>
                updateSelection(setBlockOverride(activeSelection, id, text, original))
              }
              {...(onOpenNote !== undefined ? { onOpenNote } : {})}
            />
          ))}

          {model.truncation !== null && model.truncation.omittedCount > 0 && (
            <details className="ec-context-panel__omitted" data-testid="ec-context-omitted" open>
              <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                {describeTruncation(model.truncation)}
              </summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
                {model.truncation.items.map((item) => (
                  <li key={`${item.block}:${item.label}`} data-omitted-reason={item.reason}>
                    <Tooltip content={item.preview}>
                      <span>{`${item.blockLabel} · ${item.label}（${item.tokens} token，${OMIT_LABELS[item.reason]}）`}</span>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {(model.noteIds.length > 0 || model.memoryIds.length > 0) && (
            <footer
              className="ec-context-panel__refs"
              data-testid="ec-context-refs"
              style={{ marginTop: 8, fontSize: 12 }}
            >
              {model.noteIds.length > 0 && (
                <div>
                  <span>已注入备注：</span>
                  {model.noteIds.map((id) => (
                    <Tag key={id} color="info">{`#${id}`}</Tag>
                  ))}
                </div>
              )}
              {model.memoryIds.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <span>{`已注入记忆 ${model.memoryIds.length} 条`}</span>
                </div>
              )}
            </footer>
          )}

          {model.blocks.length > 0 && (
            <div data-testid="ec-context-distribution" style={{ marginTop: 8, fontSize: 12 }}>
              {tokenDistributionRows(model)
                .filter((row) => row.tokens > 0)
                .map((row) => (
                  <div
                    key={row.id}
                    data-row-tokens={row.tokens}
                  >{`${row.label}：${row.tokens} token（${row.percent}%）`}</div>
                ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const OMIT_LABELS: Record<string, string> = {
  'block-over-quota': '超出该块配额',
  'block-over-budget': '总预算不足，优先级较低',
  'aggressive-trim': '超限后的激进裁剪',
  'block-disabled': '已被手动取消勾选',
};
