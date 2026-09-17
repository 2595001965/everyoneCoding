import { useEffect } from 'react';
import { tokensToCssVariables } from './tokens';

/**
 * 主题应用：light / dark / system（跟随系统）。
 * 通过在 <html> 上设置 data-theme 与注入 CSS 变量实现，切换即时生效。
 */

export type ThemeMode = 'light' | 'dark' | 'system';

const STYLE_ELEMENT_ID = 'ec-theme-variables';

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

/** 把令牌写入页面：cssText 注入 + data-theme 标记 */
export function applyTheme(mode: ThemeMode): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  const resolved = resolveTheme(mode);
  const variables = tokensToCssVariables(resolved);

  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (style === null) {
    style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  style.textContent = `:root{${Object.entries(variables)
    .map(([key, value]) => `${key}:${value};`)
    .join('')}}`;

  document.documentElement.dataset['theme'] = resolved;
  return resolved;
}

/** React hook：主题模式变化时自动应用，并跟随系统切换 */
export function useTheme(mode: ThemeMode): 'light' | 'dark' {
  const resolved = resolveTheme(mode);
  useEffect(() => {
    applyTheme(mode);
    if (mode !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => applyTheme('system');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [mode]);
  return resolved;
}
