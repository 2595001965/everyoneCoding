/**
 * 颜色令牌：浅色为默认主题，深色通过 `[data-theme='dark']` 覆盖。
 * 命名语义化（--ec-color-*），禁止在组件里硬编码色值。
 */

export interface ColorScale {
  bg: string;
  bgSubtle: string;
  bgMuted: string;
  surface: string;
  surfaceHover: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textDisabled: string;
  textOnAccent: string;
}

export interface SemanticColors {
  primary: string;
  primaryHover: string;
  primaryActive: string;
  success: string;
  warning: string;
  danger: string;
  dangerHover: string;
  info: string;
  focusRing: string;
}

/** 浅色（默认） */
export const lightColors: ColorScale & SemanticColors = {
  bg: '#ffffff',
  bgSubtle: '#f7f8fa',
  bgMuted: '#eef0f4',
  surface: '#ffffff',
  surfaceHover: '#f2f4f8',
  border: '#d9dee7',
  borderStrong: '#b7c0cf',
  text: '#1c2333',
  textSecondary: '#5a6478',
  textDisabled: '#9aa3b5',
  textOnAccent: '#ffffff',

  primary: '#2563eb',
  primaryHover: '#1d4fd7',
  primaryActive: '#1a3fb0',
  success: '#16803c',
  warning: '#b45309',
  danger: '#dc2626',
  dangerHover: '#b91c1c',
  info: '#0369a1',
  focusRing: 'rgba(37, 99, 235, 0.35)',
};

/** 深色 */
export const darkColors: ColorScale & SemanticColors = {
  bg: '#141821',
  bgSubtle: '#1a1f2b',
  bgMuted: '#232a39',
  surface: '#1c2230',
  surfaceHover: '#262e40',
  border: '#333c50',
  borderStrong: '#4a5670',
  text: '#e6eaf2',
  textSecondary: '#a8b1c5',
  textDisabled: '#5d6678',
  textOnAccent: '#ffffff',

  primary: '#5b8def',
  primaryHover: '#7aa4f5',
  primaryActive: '#4674d6',
  success: '#3ecf6e',
  warning: '#f0a24b',
  danger: '#f26d6d',
  dangerHover: '#e05252',
  info: '#57b3e8',
  focusRing: 'rgba(91, 141, 239, 0.45)',
};

/** 生成 CSS 变量映射（tokens.css 由脚本语义保持一致） */
export function colorVariables(colors: ColorScale & SemanticColors): Record<string, string> {
  return {
    '--ec-color-bg': colors.bg,
    '--ec-color-bg-subtle': colors.bgSubtle,
    '--ec-color-bg-muted': colors.bgMuted,
    '--ec-color-surface': colors.surface,
    '--ec-color-surface-hover': colors.surfaceHover,
    '--ec-color-border': colors.border,
    '--ec-color-border-strong': colors.borderStrong,
    '--ec-color-text': colors.text,
    '--ec-color-text-secondary': colors.textSecondary,
    '--ec-color-text-disabled': colors.textDisabled,
    '--ec-color-text-on-accent': colors.textOnAccent,
    '--ec-color-primary': colors.primary,
    '--ec-color-primary-hover': colors.primaryHover,
    '--ec-color-primary-active': colors.primaryActive,
    '--ec-color-success': colors.success,
    '--ec-color-warning': colors.warning,
    '--ec-color-danger': colors.danger,
    '--ec-color-danger-hover': colors.dangerHover,
    '--ec-color-info': colors.info,
    '--ec-color-focus-ring': colors.focusRing,
  };
}
