/**
 * 命令目录漂移守卫（设置页「快捷键」类目）。
 *
 * `@ec/core` 的 `APP_COMMANDS` 是命令 id / 标题 / 默认键位的单一事实源，
 * 但它位于包内、看不见渲染层的实际导航与文案，容易悄悄跑偏。
 * 本测试把三处真实来源钉在一起：
 * - 路由集合 ↔ `layout/navigation.ts` 的导航项（改导航必须同步改目录）
 * - 标题 ↔ `i18n/zh-CN.ts` 的 `nav.*` 文案（不另造一套叫法）
 * - 默认键位 ↔ 代码里真的绑定了的键（目前仅命令面板的 Ctrl+K）
 */
import { describe, expect, it } from 'vitest';

import { APP_COMMANDS, defaultKeymap } from '@ec/core';

import { navigation, utilityNavigation } from '../layout/navigation';
import { zhCN } from '../i18n/zh-CN';

const navItems = [...navigation, ...utilityNavigation];

describe('命令目录与导航一致', () => {
  it('导航路由集合与命令目录的 route 集合完全一致（双向，防漏防多）', () => {
    const navRoutes = new Set(navItems.map((item) => item.to));
    const commandRoutes = new Set(APP_COMMANDS.map((command) => command.route).filter((route) => route !== undefined));
    expect([...commandRoutes].sort()).toEqual([...navRoutes].sort());
  });

  it('每个导航命令的标题与 i18n 文案逐字一致', () => {
    for (const item of navItems) {
      const command = APP_COMMANDS.find((candidate) => candidate.route === item.to);
      expect(command, `导航 ${item.to} 缺少对应命令`).toBeDefined();
      expect(command?.title).toBe(zhCN[item.label]);
    }
  });

  it('命令面板打开键位与 TitleBar 的真实绑定一致', () => {
    // TitleBar 的 keydown 监听到的是 Ctrl+K（命令面板），目录里必须与之相同
    const palette = APP_COMMANDS.find((command) => command.id === 'app.commandPalette');
    expect(palette?.defaultKey).toBe('Ctrl+K');
    expect(defaultKeymap()).toEqual({ 'app.commandPalette': 'Ctrl+K' });
  });
});

describe('命令目录自身的完整性', () => {
  it('命令 id 唯一且非空', () => {
    const ids = APP_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.trim().length > 0)).toBe(true);
  });

  it('标题与分组非空，非导航命令不带 route', () => {
    for (const command of APP_COMMANDS) {
      expect(command.title.trim().length, command.id).toBeGreaterThan(0);
      expect(command.group.trim().length, command.id).toBeGreaterThan(0);
      if (command.group === '应用') expect(command.route, command.id).toBeUndefined();
    }
  });

  it('默认键位只登记真实绑定：非 null 的条目必须能在 defaultKeymap 中找到', () => {
    const map = defaultKeymap();
    for (const command of APP_COMMANDS) {
      if (command.defaultKey === null) {
        expect(map[command.id], command.id).toBeUndefined();
      } else {
        expect(map[command.id], command.id).toBe(command.defaultKey);
      }
    }
  });
});
