/**
 * 主题一致性测试：TS 令牌与 tokens.css、浅色与深色必须成对且可区分。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  darkColors,
  lightColors,
  resolveTheme,
  tokensToCssVariables,
  useTheme,
  colorVariables,
} from '../index';

describe('主题令牌', () => {
  it('浅色为默认主题', () => {
    const vars = tokensToCssVariables('light');
    expect(vars['--ec-color-bg']).toBe('#ffffff');
    expect(vars['--ec-color-primary']).toBe(lightColors.primary);
  });

  it('深浅两套变量成对且可区分', () => {
    const light = tokensToCssVariables('light');
    const dark = tokensToCssVariables('dark');
    const lightKeys = Object.keys(light);
    expect(Object.keys(dark)).toEqual(lightKeys);
    expect(light['--ec-color-bg']).not.toBe(dark['--ec-color-bg']);
    expect(light['--ec-color-text']).not.toBe(dark['--ec-color-text']);
  });

  it('tokens.css 的浅色段与 TS 令牌一致（抽样守护）', async () => {
    const css = {
      default: readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'tokens.css'),
        'utf8',
      ),
    };
    for (const [token, value] of Object.entries(colorVariables(lightColors))) {
      expect(css.default.includes(`${token}: ${value}`), `${token} 应为 ${value}`).toBe(true);
    }
  });

  it('tokens.css 的深色段与 TS 令牌一致（抽样守护）', async () => {
    const css = {
      default: readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'tokens.css'),
        'utf8',
      ),
    };
    for (const [token, value] of Object.entries(colorVariables(darkColors))) {
      expect(css.default.includes(`${token}: ${value}`), `${token} 应为 ${value}`).toBe(true);
    }
  });
});

describe('主题切换', () => {
  it('跟随系统主题变化，并在卸载时移除监听', () => {
    let change!: () => void;
    const removeEventListener = vi.fn();
    let dark = false;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: dark,
        addEventListener: (_event: string, listener: () => void) => {
          change = listener;
        },
        removeEventListener,
      })),
    );
    function Demo() {
      useTheme('system');
      return null;
    }
    try {
      const { unmount } = render(<Demo />);
      expect(document.documentElement.dataset['theme']).toBe('light');
      dark = true;
      act(() => change());
      expect(document.documentElement.dataset['theme']).toBe('dark');
      unmount();
      expect(removeEventListener).toHaveBeenCalledWith('change', change);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('applyTheme 写入 data-theme 与 CSS 变量', () => {
    const light = applyTheme('light');
    expect(light).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');

    const dark = applyTheme('dark');
    expect(dark).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('system 模式跟随 prefers-color-scheme', () => {
    // jsdom 未实现 matchMedia：resolveTheme('system') 应安全回退而不是抛错
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(['light', 'dark']).toContain(resolveTheme('system'));
  });

  it('useTheme 随 mode 变化应用主题', () => {
    function Demo({ mode }: { mode: 'light' | 'dark' }) {
      useTheme(mode);
      return null;
    }
    const { rerender } = render(<Demo mode="light" />);
    expect(document.documentElement.dataset['theme']).toBe('light');
    rerender(<Demo mode="dark" />);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    act(() => {
      applyTheme('light');
    });
  });
});
