/**
 * 内联 SVG 图标集（T3-04）—— 不引任何外部图标库。
 *
 * 每个图标都是一个 React 节点（`<svg>`），通过 `getIcon(name)` 取用、`iconNames()` 列举。
 * 覆盖 15+ 类组件图标与常用操作图标，供组件面板、属性面板、画布工具条复用。
 */

import * as React from 'react';

/** 统一构造一个 24x24 线性图标 */
function icon(children: React.ReactNode): React.ReactNode {
  return React.createElement(
    'svg',
    {
      width: '1em',
      height: '1em',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    },
    children,
  );
}

/** 生成一条 path */
function p(d: string, extra?: Record<string, unknown>): React.ReactNode {
  return React.createElement('path', { key: d, d, ...extra });
}

function dot(d: string): React.ReactNode {
  return React.createElement('path', { key: d, d, strokeLinecap: 'round' });
}

export const ICON_SET: Record<string, React.ReactNode> = {
  // —— 组件图标 ——
  container: icon([p('M3 3h18v18H3z'), p('M3 9h18'), p('M3 15h18'), p('M9 3v18')]),
  text: icon([p('M5 5h14'), p('M12 5v14')]),
  image: icon([p('M3 3h18v18H3z'), p('M8.5 8.5a1.5 1.5 0 103 0 1.5 1.5 0 00-3 0z'), p('M21 15l-5-5L5 21')]),
  button: icon([p('M3 8h18v8H3z')]),
  input: icon([p('M3 7h18v10H3z'), dot('M7 12h.01')]),
  select: icon([p('M3 7h18v10H3z'), p('M15 10l2 2 2-2')]),
  table: icon([p('M3 4h18v16H3z'), p('M3 9h18'), p('M3 14h18'), p('M9 4v16')]),
  list: icon([p('M8 6h13'), p('M8 12h13'), p('M8 18h13'), dot('M3 6h.01'), dot('M3 12h.01'), dot('M3 18h.01')]),
  form: icon([p('M4 3h16v18H4z'), p('M8 8h8'), p('M8 12h8'), p('M8 16h5')]),
  modal: icon([p('M3 5h18v14H3z'), p('M3 9h18')]),
  tabs: icon([p('M3 4h7v16H3z'), p('M14 4h7v16h-7z')]),
  navbar: icon([p('M3 5h18v5H3z'), p('M3 15h18')]),
  chart: icon([p('M4 20V12'), p('M9 20V8'), p('M14 20V14'), p('M19 20V6')]),
  dashboard: icon([
    p('M3 3h8v8H3z'),
    p('M13 3h8v8h-8z'),
    p('M3 13h8v8H3z'),
    p('M13 13h8v8h-8z'),
  ]),
  // —— 业务组件图标 ——
  'login-card': icon([p('M3 4h18v16H3z'), p('M9 10a2 2 0 104 0 2 2 0 00-4 0z'), p('M6 16c0-2 2-3 3-3s3 1 3 3')]),
  'dashboard-template': icon([p('M2 3h20v14H2z'), p('M2 8h20'), p('M8 21h8')]),
  'list-page-template': icon([p('M3 4h18v16H3z'), p('M7 8h10'), p('M7 12h10'), p('M7 16h6')]),
  // —— 常用操作图标 ——
  eye: icon([p('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z'), p('M12 12a3 3 0 100 6 3 3 0 000-6z')]),
  'eye-off': icon([
    p('M9.9 4.2A10.9 10.9 0 0112 4c6.5 0 10 7 10 7a17 17 0 01-3 3.7'),
    p('M6.6 6.6A17 17 0 002 11s3.5 7 10 7a10.9 10.9 0 003.1-.4'),
    p('M3 3l18 18'),
  ]),
  lock: icon([p('M5 11h14v10H5z'), p('M8 11V7a4 4 0 018 0v4')]),
  unlock: icon([p('M5 11h14v10H5z'), p('M8 11V7a4 4 0 017.5-2')]),
  trash: icon([p('M4 7h16'), p('M9 7V4h6v3'), p('M6 7l1 13h10l1-13')]),
  copy: icon([p('M9 9h11v11H9z'), p('M5 15V5a2 2 0 012-2h8')]),
  plus: icon([p('M12 5v14'), p('M5 12h14')]),
  minus: icon([p('M5 12h14')]),
  close: icon([p('M6 6l12 12'), p('M18 6L6 18')]),
  search: icon([p('M11 11a7 7 0 100-14 7 7 0 000 14z'), p('M21 21l-4.3-4.3')]),
  'chevron-down': icon([p('M6 9l6 6 6-6')]),
  'chevron-right': icon([p('M9 6l6 6-6 6')]),
  drag: icon([
    dot('M9 6h.01'),
    dot('M9 12h.01'),
    dot('M9 18h.01'),
    dot('M15 6h.01'),
    dot('M15 12h.01'),
    dot('M15 18h.01'),
  ]),
};

/** 取图标节点；未知 id 返回 null */
export function getIcon(name: string): React.ReactNode {
  return ICON_SET[name] ?? null;
}

/** 全部图标 id */
export function iconNames(): string[] {
  return Object.keys(ICON_SET);
}
