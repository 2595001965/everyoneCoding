/** 圆角令牌（px） */
export const radius = {
  none: 0,
  sm: 3,
  md: 6,
  lg: 10,
  full: 9999,
} as const;

export type RadiusToken = keyof typeof radius;
