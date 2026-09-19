/**
 * LoginCard 登录卡片（T3-04 业务组件）。承载登录表单与第三方登录入口，接受 children。
 */
import type * as React from 'react';

import type { ComponentMeta, ComponentRenderProps } from '../../registry/component-registry';
import { propBoolean, propString, previewString, withNodeStyle } from '../render-utils';

export function LoginCardRenderer({
  node,
  mode,
  scope,
  children,
}: ComponentRenderProps): JSX.Element {
  const title =
    mode === 'preview'
      ? previewString(node, 'title', scope, '欢迎登录')
      : propString(node, 'title', '欢迎登录');
  const subtitle =
    mode === 'preview'
      ? previewString(node, 'subtitle', scope, '')
      : propString(node, 'subtitle', '');
  const showRemember = propBoolean(node, 'showRemember', true);
  const thirdParty = propBoolean(node, 'thirdParty', false);
  const logo = propString(node, 'logo', '');
  const style: React.CSSProperties = withNodeStyle(
    { width: '400px', padding: '32px', borderRadius: '12px' },
    node,
  );
  const isEmpty = children === undefined || children === null;

  return (
    <div className="ecd-login-card" style={style} data-component="LoginCard" data-mode={mode}>
      <div className="ecd-login-card__header">
        {logo ? <img src={logo} alt="logo" className="ecd-login-card__logo" /> : null}
        <h2 className="ecd-login-card__title">{title}</h2>
        {subtitle ? <p className="ecd-login-card__subtitle">{subtitle}</p> : null}
      </div>
      <div className="ecd-login-card__body">
        {isEmpty ? <span className="ecd-placeholder">拖入登录表单</span> : children}
      </div>
      {showRemember ? (
        <label className="ecd-login-card__remember">
          <input type="checkbox" disabled={mode === 'design'} />
          记住登录
        </label>
      ) : null}
      {thirdParty ? (
        <div className="ecd-login-card__third">
          <span className="ecd-login-card__third-label">第三方登录</span>
        </div>
      ) : null}
    </div>
  );
}

export const LoginCardMeta: ComponentMeta = {
  type: 'LoginCard',
  displayName: '登录卡片',
  group: '业务组件',
  description: '开箱即用的登录卡片，内含表单与第三方登录',
  icon: 'login-card',
  defaultProps: {
    title: '欢迎登录',
    subtitle: '',
    showRemember: true,
    thirdParty: false,
    logo: '',
  },
  defaultStyle: { width: '400px', padding: '32px', borderRadius: '12px' },
  acceptsChildren: true,
  propSchema: {
    fields: [
      { key: 'title', label: '标题', type: 'text', group: '内容', default: '欢迎登录' },
      { key: 'subtitle', label: '副标题', type: 'text', group: '内容', default: '' },
      { key: 'logo', label: 'Logo', type: 'image', group: '内容', default: '' },
      { key: 'showRemember', label: '显示记住登录', type: 'boolean', group: '交互', default: true },
      { key: 'thirdParty', label: '第三方登录', type: 'boolean', group: '交互', default: false },
    ],
  },
};
