/**
 * 工作台联动事件（T9-01 / FR-WSP-03）。
 *
 * 场景：项目设置里修改"目标端"后，设计器画布尺寸预设与组件库需联动切换。
 * 工作台与设计器分属两个特性，直接互相 import 会形成循环依赖，
 * 因此用**轻量事件总线**解耦：设置页 emit，设计器工作区订阅。
 *
 * 载荷里的 `canvasPresets` 由 `@ec/designer` 的设备预设推导（本模块是唯一推导点，
 * 便于测试断言"改目标端 → 画布预设真的变了"）。
 */

import { COMPONENT_GROUPS, canvasSizeOf, defaultPresetFor, type Platform } from '@ec/designer';

import { TARGET_PLATFORM_KEYS, type TargetPlatform } from '@ec/core';

export const TARGETS_CHANGED_EVENT = 'workspace:project-targets-changed';

export interface CanvasPresetHint {
  platform: TargetPlatform;
  presetId: string;
  label: string;
  width: number;
  height: number;
}

export interface TargetsChangedPayload {
  projectId: string;
  /** 新选目标端（七端子集） */
  platforms: TargetPlatform[];
  /** 每个端推荐的画布预设（设计器 `defaultPresetFor` 推导） */
  canvasPresets: CanvasPresetHint[];
  /** 联动后的组件库分组（设计器组件库分组常量） */
  componentGroups: string[];
}

type Listener = (payload: TargetsChangedPayload) => void;

const listeners = new Set<Listener>();

/** 由目标端推导画布预设（纯函数，可测） */
export function buildCanvasPresets(platforms: readonly TargetPlatform[]): CanvasPresetHint[] {
  return platforms.map((platform) => {
    const preset = defaultPresetFor(platform as Platform);
    const size = canvasSizeOf(preset);
    return {
      platform,
      presetId: preset.id,
      label: `${preset.label}（${size.width}×${size.height}）`,
      width: size.width,
      height: size.height,
    };
  });
}

/** 构造完整联动载荷 */
export function buildTargetsPayload(
  projectId: string,
  platforms: readonly TargetPlatform[],
): TargetsChangedPayload {
  return {
    projectId,
    platforms: [...platforms],
    canvasPresets: buildCanvasPresets(platforms),
    componentGroups: [...COMPONENT_GROUPS],
  };
}

/** 广播（设置页保存后调用） */
export function emitTargetsChanged(payload: TargetsChangedPayload): void {
  for (const listener of listeners) listener(payload);
}

/** 订阅（设计器工作区/预览页订阅；返回取消函数） */
export function onTargetsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 校验目标端取值合法（对应后端 target_platforms 的过滤口径） */
export function isValidPlatform(value: string): value is TargetPlatform {
  return (TARGET_PLATFORM_KEYS as readonly string[]).includes(value);
}
