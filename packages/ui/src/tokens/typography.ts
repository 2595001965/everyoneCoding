/** 字号 / 行高令牌（px / unitless） */
export const typography = {
  fontFamily: "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', system-ui, -apple-system, sans-serif",
  fontFamilyMono: "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
  fontSize: {
    xs: 12,
    sm: 13,
    md: 14,
    lg: 16,
    xl: 20,
    '2xl': 26,
  } as const,
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.7,
  } as const,
  fontWeight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  } as const,
};
