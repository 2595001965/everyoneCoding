/**
 * Modal 弹窗组件（T3-04）。设计态为静态占位框；预览态走 @ec/ui 的 Modal。
 */
import { Modal } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { propBoolean, propString, previewString, withNodeStyle } from './render-utils';

export function ModalRenderer({ node, mode, scope, children }: ComponentRenderProps): JSX.Element {
  const title =
    mode === 'preview' ? previewString(node, 'title', scope, '') : propString(node, 'title', '');
  const width = propString(node, 'width', '480px');
  const maskClosable = propBoolean(node, 'maskClosable', true);
  const footerType = propString(node, 'footerType', 'default');

  if (mode === 'design') {
    const style = withNodeStyle({ width }, node);
    return (
      <div
        className="ecd-modal ecd-modal--design"
        style={style}
        role="dialog"
        aria-label={title || '弹窗'}
        data-component="Modal"
        data-mode={mode}
      >
        <div className="ecd-modal__header">{title || '弹窗标题'}</div>
        <div className="ecd-modal__body">
          {children ?? <span className="ecd-placeholder">弹窗内容</span>}
        </div>
        <div className="ecd-modal__footer">底部操作区</div>
      </div>
    );
  }

  const modalProps: Parameters<typeof Modal>[0] = { open: true };
  if (title) modalProps.title = title;
  if (footerType !== 'none')
    modalProps.footer = <span className="ecd-modal__footer-ph">操作区</span>;

  return (
    <span
      data-component="Modal"
      data-mode={mode}
      data-mask-closable={maskClosable}
      data-footer-type={footerType}
    >
      <Modal {...modalProps}>{children}</Modal>
    </span>
  );
}

export const ModalMeta: ComponentMeta = {
  type: 'Modal',
  displayName: '弹窗',
  group: '基础',
  description: '模态对话框，承载重点操作',
  icon: 'modal',
  defaultProps: { title: '弹窗标题', width: '480px', maskClosable: true, footerType: 'default' },
  defaultStyle: {},
  acceptsChildren: true,
  propSchema: {
    fields: [
      { key: 'title', label: '标题', type: 'text', group: '内容', default: '弹窗标题' },
      { key: 'width', label: '宽度', type: 'size', group: '布局', default: '480px' },
      { key: 'maskClosable', label: '点击遮罩关闭', type: 'boolean', group: '交互', default: true },
      {
        key: 'footerType',
        label: '底部类型',
        type: 'enum',
        group: '内容',
        default: 'default',
        options: [
          { value: 'default', label: '默认' },
          { value: 'simple', label: '简洁' },
          { value: 'none', label: '无' },
        ],
      },
    ],
  },
};
