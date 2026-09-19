/**
 * Navbar 导航栏组件（T3-04）。顶部导航，接受 children（右侧自定义内容）。
 */
import type * as React from 'react';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import {
  propBoolean,
  propOptions,
  propString,
  previewOptions,
  previewString,
  withNodeStyle,
} from './render-utils';

export function NavbarRenderer({ node, mode, scope, children }: ComponentRenderProps): JSX.Element {
  const title =
    mode === 'preview' ? previewString(node, 'title', scope, '') : propString(node, 'title', '');
  const logo = propString(node, 'logo', '');
  const sticky = propBoolean(node, 'sticky', false);
  const links =
    mode === 'preview' ? previewOptions(node, 'links', scope) : propOptions(node, 'links');
  const style: React.CSSProperties = withNodeStyle(
    {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      height: '56px',
    },
    node,
  );

  return (
    <nav
      className="ecd-navbar"
      style={style}
      data-sticky={sticky}
      data-component="Navbar"
      data-mode={mode}
    >
      <div className="ecd-navbar__brand">
        {logo ? <img src={logo} alt="logo" className="ecd-navbar__logo" /> : null}
        <span className="ecd-navbar__title">{title || '导航栏'}</span>
      </div>
      <div className="ecd-navbar__links">
        {links.map((link) => (
          <a key={link.value} className="ecd-navbar__link" href="#">
            {link.label}
          </a>
        ))}
        {children}
      </div>
    </nav>
  );
}

export const NavbarMeta: ComponentMeta = {
  type: 'Navbar',
  displayName: '导航栏',
  group: '布局',
  description: '页面顶部导航，含品牌与链接',
  icon: 'navbar',
  defaultProps: { title: '导航栏', logo: '', sticky: false, links: [] },
  defaultStyle: {},
  acceptsChildren: true,
  propSchema: {
    fields: [
      { key: 'title', label: '标题', type: 'text', group: '内容', default: '导航栏' },
      { key: 'logo', label: 'Logo', type: 'image', group: '内容', default: '' },
      { key: 'sticky', label: '吸顶', type: 'boolean', group: '布局', default: false },
      { key: 'links', label: '链接', type: 'options', group: '数据', default: [] },
    ],
  },
};
