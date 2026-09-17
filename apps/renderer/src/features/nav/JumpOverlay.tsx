/**
 * 跳转浮层（T6-07 要点 1）：悬停元素名展示可跳转目标列表；Ctrl + 点击按层级选择。
 *
 * - 悬停：展示 `hoverTargets` 结果（后端接口 / 数据库表 / 测试用例 / 技术文档章节 …），
 *   顺序即端口给出的相关度降序，UI 不重排；
 * - Ctrl + 点击：`needsChoice` 为真时展开层级下拉（Controller 方法 → Service →
 *   数据访问层 → 测试），选中后 `commitJump` 落地。
 */
import { NAV_TARGET_LABELS, type NavElementRef } from '@ec/ai';

import { useHoverJump } from './nav-api';

export interface JumpOverlayProps {
  pageId: string;
  element: NavElementRef;
  currentFile?: string | null | undefined;
}

export function JumpOverlay({ pageId, element, currentFile }: JumpOverlayProps): JSX.Element {
  const jump = useHoverJump(
    currentFile === undefined || currentFile === null
      ? { pageId, element }
      : { pageId, element, currentFile },
  );

  const showLayers = jump.resolution !== null && jump.resolution.needsChoice && jump.resolution.layers.length > 0;

  return (
    <span className="ec-jump-overlay" style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="ec-jump-overlay__anchor"
        data-testid={`jump-anchor-${element.elementId}`}
        onMouseEnter={jump.onHoverStart}
        onMouseLeave={jump.onHoverEnd}
        onClick={(event) => jump.onCtrlClick({ ctrlKey: event.ctrlKey, metaKey: event.metaKey })}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--ec-color-info)',
          cursor: 'pointer',
          textDecoration: 'underline dotted',
        }}
      >
        {element.name}
      </button>

      {jump.open && jump.targets.length > 0 && (
        <div
          className="ec-jump-overlay__list"
          role="listbox"
          aria-label="可跳转目标"
          data-testid="jump-target-list"
          style={panelStyle}
        >
          {jump.targets.map((target) => (
            <button
              key={target.id}
              type="button"
              role="option"
              aria-selected={false}
              className="ec-jump-overlay__item"
              data-testid={`jump-target-${target.id}`}
              data-kind={target.kind}
              onClick={() => jump.choose(target)}
              style={itemStyle}
            >
              <span className="ec-jump-overlay__kind" data-testid={`jump-kind-${target.id}`} style={{ color: 'var(--ec-color-text-secondary)' }}>
                {NAV_TARGET_LABELS[target.kind]}
              </span>
              <span style={{ flex: 1 }}>
                {target.label}
                <span style={{ color: 'var(--ec-color-text-secondary)' }}> · {target.detail}</span>
              </span>
              <span data-testid={`jump-score-${target.id}`} style={{ color: 'var(--ec-color-info)' }}>
                {target.score.toFixed(2)}
              </span>
            </button>
          ))}
        </div>
      )}

      {showLayers && jump.resolution !== null && (
        <div
          className="ec-jump-overlay__layers"
          role="menu"
          aria-label="按层级选择跳转目标"
          data-testid="jump-layer-menu"
          style={panelStyle}
        >
          <div style={{ color: 'var(--ec-color-text-secondary)', marginBottom: 4 }}>
            该元素有多个候选，请选择层级：
          </div>
          {jump.resolution.layers.map((layer) => (
            <div key={layer.layer} className="ec-jump-overlay__layer" data-testid={`jump-layer-${layer.layer}`}>
              <div style={{ fontWeight: 600 }}>{layer.label}</div>
              {layer.targets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  role="menuitem"
                  className="ec-jump-overlay__item"
                  data-testid={`jump-layer-target-${target.id}`}
                  onClick={() => jump.choose(target)}
                  style={itemStyle}
                >
                  <span style={{ flex: 1 }}>
                    {target.label}
                    <span style={{ color: 'var(--ec-color-text-secondary)' }}> · {target.detail}</span>
                  </span>
                  <span style={{ color: 'var(--ec-color-text-secondary)' }}>{NAV_TARGET_LABELS[target.kind]}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

const panelStyle = {
  position: 'absolute',
  top: '100%',
  left: 0,
  zIndex: 20,
  minWidth: 320,
  maxHeight: 280,
  overflow: 'auto',
  padding: 6,
  border: '1px solid var(--ec-color-border)',
  borderRadius: 6,
  background: 'var(--ec-color-surface)',
  color: 'var(--ec-color-text)',
  boxShadow: 'var(--ec-shadow-md, 0 4px 12px rgba(0,0,0,0.12))',
} as const;

const itemStyle = {
  display: 'flex',
  gap: 8,
  alignItems: 'baseline',
  width: '100%',
  padding: '4px 6px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--ec-color-text)',
  cursor: 'pointer',
  textAlign: 'left',
} as const;
