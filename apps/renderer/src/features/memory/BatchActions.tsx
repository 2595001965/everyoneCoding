import { useState } from 'react';

import { Button, Modal, Select } from '@ec/ui';
import { LAYER_LABELS, MEMORY_LAYERS, type MemoryLayer, type MemoryScope } from '@ec/memory';

import type { LayerMoveTarget } from './memory-api';

/**
 * 批量操作条（FR-MEM-21：导出 / 删除 / 移动层级）。
 *
 * 破坏性操作一律二次确认（硬约束 6），删除走"可撤销"语义：
 * 删除后出现「撤销删除」按钮，点击即恢复；撤销入口消失前不允许再次删除。
 */

export interface BatchActionsProps {
  checkedIds: readonly string[];
  /** 上一次删除的条目（用于撤销提示） */
  lastRemovedIds?: readonly string[];
  busy?: boolean;
  onExport: (format: 'json' | 'markdown') => void;
  onRemove: (ids: readonly string[]) => Promise<void> | void;
  onUndoRemove: () => Promise<void> | void;
  onMoveLayer: (target: LayerMoveTarget) => Promise<void> | void;
  /** 层级移动的默认归属（例如当前所在项目/页面），缺省则只有 scope 变更 */
  moveContext?: Omit<LayerMoveTarget, 'scope'>;
}

/** 层级 → 归属 scope 的映射（element 层在库里是 scope=page + element_id） */
export function scopeForLayer(layer: MemoryLayer): MemoryScope {
  return layer === 'element' ? 'page' : layer;
}

export function BatchActions({
  checkedIds,
  lastRemovedIds = [],
  busy = false,
  onExport,
  onRemove,
  onUndoRemove,
  onMoveLayer,
  moveContext = {},
}: BatchActionsProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [movingOpen, setMovingOpen] = useState(false);
  const [targetLayer, setTargetLayer] = useState<MemoryLayer>('project');

  const count = checkedIds.length;
  const hasSelection = count > 0;

  return (
    <div className="ec-memory-batch" role="group" aria-label="批量操作">
      <span className="ec-memory-batch__count">已选 {count} 条</span>
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasSelection || busy}
        onClick={() => onExport('json')}
      >
        导出选中为 JSON
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasSelection || busy}
        onClick={() => onExport('markdown')}
      >
        导出选中为 Markdown
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasSelection || busy}
        onClick={() => setMovingOpen(true)}
      >
        移动层级
      </Button>
      <Button
        size="sm"
        variant="danger"
        disabled={!hasSelection || busy}
        onClick={() => setConfirming(true)}
      >
        删除
      </Button>

      {lastRemovedIds.length > 0 && (
        <span className="ec-memory-batch__undo" role="status">
          已删除 {lastRemovedIds.length} 条
          <Button size="sm" variant="ghost" onClick={() => void onUndoRemove()} disabled={busy}>
            撤销删除
          </Button>
        </span>
      )}

      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        title="确认删除记忆条目？"
        size="sm"
        footer={
          <div className="ec-memory-batch__modal-foot">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                void onRemove([...checkedIds]);
                setConfirming(false);
              }}
            >
              确认删除
            </Button>
          </div>
        }
      >
        <p>
          将删除 {count}{' '}
          条记忆。删除后可通过「撤销删除」恢复；删除只影响当前项目，不会改动其他项目。
        </p>
      </Modal>

      <Modal
        open={movingOpen}
        onOpenChange={setMovingOpen}
        title="移动层级"
        size="sm"
        footer={
          <div className="ec-memory-batch__modal-foot">
            <Button variant="secondary" onClick={() => setMovingOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                void onMoveLayer({ ...moveContext, scope: scopeForLayer(targetLayer) });
                setMovingOpen(false);
              }}
            >
              移动
            </Button>
          </div>
        }
      >
        <p>
          把选中的 {count} 条记忆移动到目标层级；若目标层级与现有条目同标题，将按继承规则产生覆盖。
        </p>
        <Select
          options={MEMORY_LAYERS.map((layer) => ({ value: layer, label: LAYER_LABELS[layer] }))}
          value={targetLayer}
          onChange={(value) => setTargetLayer(value as MemoryLayer)}
          aria-label="目标层级"
        />
      </Modal>
    </div>
  );
}
