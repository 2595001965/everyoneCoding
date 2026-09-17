/** 层级令牌（画布内浮层 / 全局浮层分离） */
export const zIndex = {
  base: 0,
  raised: 10,
  sticky: 100,
  drawer: 200,
  modal: 300,
  popover: 400,
  tooltip: 500,
  toast: 600,
  max: 999,
} as const;
