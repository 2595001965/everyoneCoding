export * from './color';
export * from './spacing';
export * from './radius';
export * from './typography';
export * from './shadow';
export * from './z-index';
export * from './control-height';

import { colorVariables, darkColors, lightColors } from './color';
import { spacing, radius, typography, shadow, zIndex, controlHeight } from './dimension';

export { colorVariables, darkColors, lightColors };

/** 生成指定主题的全部 CSS 变量（含尺寸令牌） */
export function tokensToCssVariables(theme: 'light' | 'dark'): Record<string, string> {
  const colors = colorVariables(theme === 'dark' ? darkColors : lightColors);
  return {
    ...colors,
    '--ec-space-xs': `${spacing.xs}px`,
    '--ec-space-sm': `${spacing.sm}px`,
    '--ec-space-md': `${spacing.md}px`,
    '--ec-space-lg': `${spacing.lg}px`,
    '--ec-space-xl': `${spacing.xl}px`,
    '--ec-space-2xl': `${spacing['2xl']}px`,
    '--ec-radius-sm': `${radius.sm}px`,
    '--ec-radius-md': `${radius.md}px`,
    '--ec-radius-lg': `${radius.lg}px`,
    '--ec-font-family': typography.fontFamily,
    '--ec-font-family-mono': typography.fontFamilyMono,
    '--ec-font-size-xs': `${typography.fontSize.xs}px`,
    '--ec-font-size-sm': `${typography.fontSize.sm}px`,
    '--ec-font-size-md': `${typography.fontSize.md}px`,
    '--ec-font-size-lg': `${typography.fontSize.lg}px`,
    '--ec-control-height-sm': `${controlHeight.sm}px`,
    '--ec-control-height-md': `${controlHeight.md}px`,
    '--ec-control-height-lg': `${controlHeight.lg}px`,
    '--ec-shadow-sm': shadow.sm,
    '--ec-shadow-md': shadow.md,
    '--ec-shadow-lg': shadow.lg,
    '--ec-z-drawer': `${zIndex.drawer}`,
    '--ec-z-modal': `${zIndex.modal}`,
    '--ec-z-popover': `${zIndex.popover}`,
    '--ec-z-tooltip': `${zIndex.tooltip}`,
    '--ec-z-toast': `${zIndex.toast}`,
  };
}
