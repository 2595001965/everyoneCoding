/**
 * 设备预设（T3-02 要点 1）。
 *
 * 覆盖七端矩阵所需的画布视口预设：Web 断点、Android / iOS / HarmonyOS 机型、
 * 鸿蒙可折叠三段态、桌面端窗口。画布按预设决定像素尺寸、安全区与窗口占位。
 *
 * 注意：本文件只放纯数据与查询函数，不依赖 React / store，可在 node 环境直接测试。
 */
import type { Platform } from '../dsl/types';

/** 安全区参数（移动端 / 鸿蒙需要，单位 px，对应画布坐标系） */
export interface SafeArea {
  /** 顶部状态栏高度 */
  top: number;
  /** 底部指示条 / home 条高度 */
  bottom: number;
  /** 左侧安全边距 */
  left: number;
  /** 右侧安全边距 */
  right: number;
  /** 刘海 / 挖孔（仅视觉覆盖，不入 DSL） */
  notch?: {
    width: number;
    height: number;
    position: 'center' | 'left';
  };
  /** 底部指示条高度（与 bottom 区分：bottom 为保留区，indicatorBar 为可视条） */
  indicatorBar?: number;
}

/** 桌面端窗口占位（标题栏高度 + 边框宽度，单位 px） */
export interface WindowChrome {
  titleBarHeight: number;
  borderWidth: number;
}

/** 设备 / 视口预设 */
export interface DevicePreset {
  /** 预设唯一 id，如 'ip15' / 'web-1440' / 'harmony-foldable' */
  id: string;
  /** 所属平台 */
  platform: Platform;
  /** 中文显示名 */
  label: string;
  width: number;
  height: number;
  kind: 'web-breakpoint' | 'mobile' | 'foldable' | 'desktop-window';
  /** 安全区（移动端 / 鸿蒙） */
  safeArea?: SafeArea;
  /** 桌面窗口占位（桌面端） */
  windowChrome?: WindowChrome;
}

/** 鸿蒙可折叠三段态 */
export interface FoldableState {
  /** 状态名：折叠 / 展开 / 半折叠 */
  id: 'folded' | 'unfolded' | 'halfFolded';
  label: string;
  width: number;
  height: number;
  safeArea: SafeArea;
}

const webBreakpoints: DevicePreset[] = [
  {
    id: 'web-1920',
    platform: 'web',
    label: '桌面 1920',
    width: 1920,
    height: 1080,
    kind: 'web-breakpoint',
  },
  {
    id: 'web-1440',
    platform: 'web',
    label: '桌面 1440',
    width: 1440,
    height: 900,
    kind: 'web-breakpoint',
  },
  {
    id: 'web-768',
    platform: 'web',
    label: '平板 768',
    width: 768,
    height: 1024,
    kind: 'web-breakpoint',
  },
  {
    id: 'web-375',
    platform: 'web',
    label: '手机 375',
    width: 375,
    height: 667,
    kind: 'web-breakpoint',
  },
];

const androidPresets: DevicePreset[] = [
  {
    id: 'android-360x800',
    platform: 'android',
    label: 'Android 标准机',
    width: 360,
    height: 800,
    kind: 'mobile',
    safeArea: {
      top: 24,
      bottom: 16,
      left: 0,
      right: 0,
      indicatorBar: 4,
    },
  },
  {
    id: 'android-412x915',
    platform: 'android',
    label: 'Android 大屏机',
    width: 412,
    height: 915,
    kind: 'mobile',
    safeArea: {
      top: 28,
      bottom: 20,
      left: 0,
      right: 0,
      indicatorBar: 4,
    },
  },
];

const iosPresets: DevicePreset[] = [
  {
    id: 'ios-390x844',
    platform: 'ios',
    label: 'iPhone 15',
    width: 390,
    height: 844,
    kind: 'mobile',
    safeArea: {
      top: 47,
      bottom: 34,
      left: 0,
      right: 0,
      notch: { width: 120, height: 32, position: 'center' },
      indicatorBar: 8,
    },
  },
  {
    id: 'ios-430x932',
    platform: 'ios',
    label: 'iPhone 15 Pro Max',
    width: 430,
    height: 932,
    kind: 'mobile',
    safeArea: {
      top: 54,
      bottom: 34,
      left: 0,
      right: 0,
      notch: { width: 122, height: 35, position: 'center' },
      indicatorBar: 8,
    },
  },
];

// 鸿蒙直板机（非折叠）与可折叠三段态机器
const harmonyPresets: DevicePreset[] = [
  {
    id: 'harmony-360x780',
    platform: 'harmonyos',
    label: '鸿蒙直板机',
    width: 360,
    height: 780,
    kind: 'mobile',
    safeArea: {
      top: 32,
      bottom: 20,
      left: 0,
      right: 0,
      indicatorBar: 6,
    },
  },
  {
    id: 'harmony-foldable',
    platform: 'harmonyos',
    label: '鸿蒙可折叠（展开）',
    width: 840,
    height: 940,
    kind: 'foldable',
    safeArea: {
      top: 36,
      bottom: 24,
      left: 0,
      right: 0,
      indicatorBar: 8,
    },
  },
];

const desktopPresets: DevicePreset[] = [
  {
    id: 'windows-1440x900',
    platform: 'windows',
    label: 'Windows 窗口 1440×900',
    width: 1440,
    height: 900,
    kind: 'desktop-window',
    windowChrome: { titleBarHeight: 32, borderWidth: 1 },
  },
  {
    id: 'windows-1280x800',
    platform: 'windows',
    label: 'Windows 窗口 1280×800',
    width: 1280,
    height: 800,
    kind: 'desktop-window',
    windowChrome: { titleBarHeight: 32, borderWidth: 1 },
  },
  {
    id: 'linux-1440x900',
    platform: 'linux',
    label: 'Linux 窗口 1440×900',
    width: 1440,
    height: 900,
    kind: 'desktop-window',
    windowChrome: { titleBarHeight: 28, borderWidth: 1 },
  },
  {
    id: 'linux-1280x800',
    platform: 'linux',
    label: 'Linux 窗口 1280×800',
    width: 1280,
    height: 800,
    kind: 'desktop-window',
    windowChrome: { titleBarHeight: 28, borderWidth: 1 },
  },
  {
    id: 'macos-1440x900',
    platform: 'macos',
    label: 'macOS 窗口 1440×900',
    width: 1440,
    height: 900,
    kind: 'desktop-window',
    windowChrome: { titleBarHeight: 28, borderWidth: 0 },
  },
  {
    id: 'macos-1280x800',
    platform: 'macos',
    label: 'macOS 窗口 1280×800',
    width: 1280,
    height: 800,
    kind: 'desktop-window',
    windowChrome: { titleBarHeight: 28, borderWidth: 0 },
  },
];

/** 全部设备预设 */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  ...webBreakpoints,
  ...androidPresets,
  ...iosPresets,
  ...harmonyPresets,
  ...desktopPresets,
];

/** 按平台过滤预设 */
export function presetsForPlatform(platform: Platform): DevicePreset[] {
  return DEVICE_PRESETS.filter((preset) => preset.platform === platform);
}

/** 按 id 查找预设（找不到返回 null） */
export function findPreset(id: string): DevicePreset | null {
  return DEVICE_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 平台默认预设：Web / 桌面优先 1440 宽（与 PageDsl 默认视口一致），其余取首个机型 */
export function defaultPresetFor(platform: Platform): DevicePreset {
  const candidates = DEVICE_PRESETS.filter((preset) => preset.platform === platform);
  const preferred = candidates.find((preset) => preset.width === 1440);
  if (preferred) return preferred;
  const first = candidates[0];
  if (first) return first;
  return DEVICE_PRESETS.find((preset) => preset.id === 'web-1440') as DevicePreset;
}

/** 取预设的安全区（无则为零安全区） */
export function safeAreaOf(preset: DevicePreset): SafeArea {
  if (preset.safeArea) return preset.safeArea;
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

/**
 * 鸿蒙可折叠三段态安全区与尺寸。
 *
 * 约定（基于 harmony-foldable 展开态派生）：
 * - 折叠：仅外屏，直板近似（360×780）
 * - 展开：内屏全展开（840×940）
 * - 半折叠：帐篷态，宽度介于两者之间，安全区沿用展开态
 */
export function foldableStates(preset?: DevicePreset): FoldableState[] {
  // 显式传入非折叠预设：按其自身尺寸退化为一态，便于调用方统一处理
  if (preset !== undefined && preset.kind !== 'foldable') {
    return [
      {
        id: 'unfolded',
        label: '默认形态',
        width: preset.width,
        height: preset.height,
        safeArea: safeAreaOf(preset),
      },
    ];
  }
  const expanded = preset ?? findPreset('harmony-foldable');
  const base = expanded?.safeArea ?? { top: 36, bottom: 24, left: 0, right: 0, indicatorBar: 8 };
  return [
    {
      id: 'folded',
      label: '折叠',
      width: 360,
      height: 780,
      safeArea: { top: 32, bottom: 20, left: 0, right: 0, indicatorBar: 6 },
    },
    {
      id: 'unfolded',
      label: '展开',
      width: expanded?.width ?? 840,
      height: expanded?.height ?? 940,
      safeArea: base,
    },
    {
      id: 'halfFolded',
      label: '半折叠',
      width: 600,
      height: 940,
      safeArea: base,
    },
  ];
}

/** 画布逻辑尺寸（未缩放的设计稿尺寸） */
export function canvasSizeOf(preset: DevicePreset): { width: number; height: number } {
  return { width: preset.width, height: preset.height };
}

/**
 * 桌面窗口的内容区（扣除标题栏与边框占位）；非桌面预设即整块画布。
 * 供画布渲染「窗口标题栏 / 边框」占位使用。
 */
export function contentBoxOf(preset: DevicePreset): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const chrome = preset.windowChrome;
  if (chrome === undefined) return { x: 0, y: 0, width: preset.width, height: preset.height };
  const border = chrome.borderWidth;
  return {
    x: border,
    y: chrome.titleBarHeight,
    width: preset.width - border * 2,
    height: preset.height - chrome.titleBarHeight - border,
  };
}

/** 宽度 → 最近的响应式断点标签（供 T3-11 响应式规则与预览断点使用） */
export function breakpointLabel(width: number): string {
  if (width >= 1920) return '1920';
  if (width >= 1440) return '1440';
  if (width >= 768) return '768';
  return '375';
}
