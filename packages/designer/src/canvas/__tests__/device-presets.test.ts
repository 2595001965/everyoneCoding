import { describe, expect, it } from 'vitest';

import {
  DEVICE_PRESETS,
  canvasSizeOf,
  contentBoxOf,
  defaultPresetFor,
  findPreset,
  foldableStates,
  presetsForPlatform,
  safeAreaOf,
  breakpointLabel,
} from '../device-presets';
import { GRID_SIZE } from '../GridOverlay';

describe('T3-02 多端视口预设', () => {
  it('Web 覆盖 1920 / 1440 / 768 / 375 四个响应式断点', () => {
    const widths = presetsForPlatform('web').map((preset) => preset.width);
    expect(widths).toEqual(expect.arrayContaining([1920, 1440, 768, 375]));
  });

  it('Android / iOS 机型预设符合 PRD 举例', () => {
    expect(presetsForPlatform('android').map((preset) => `${preset.width}x${preset.height}`)).toEqual(
      expect.arrayContaining(['360x800', '412x915']),
    );
    expect(presetsForPlatform('ios').map((preset) => `${preset.width}x${preset.height}`)).toEqual(
      expect.arrayContaining(['390x844', '430x932']),
    );
  });

  it('HarmonyOS 直板 + 折叠屏，折叠屏含三段态安全区', () => {
    const harmony = presetsForPlatform('harmonyos');
    const straight = harmony.find((preset) => preset.id === 'harmony-360x780');
    const foldable = harmony.find((preset) => preset.kind === 'foldable');
    expect(straight?.width).toBe(360);
    expect(foldable).toBeDefined();
    const states = foldableStates(foldable as never);
    expect(states.map((state) => state.id)).toEqual(['folded', 'unfolded', 'halfFolded']);
    for (const state of states) {
      expect(state.safeArea.top).toBeGreaterThan(0);
      expect(state.safeArea.indicatorBar).toBeGreaterThan(0);
    }
  });

  it('桌面三端有窗口预设与标题栏/边框占位', () => {
    for (const platform of ['windows', 'linux', 'macos'] as const) {
      const presets = presetsForPlatform(platform);
      expect(presets.map((preset) => `${preset.width}x${preset.height}`)).toEqual(
        expect.arrayContaining(['1440x900', '1280x800']),
      );
      for (const preset of presets) {
        expect(preset.windowChrome?.titleBarHeight).toBeGreaterThan(0);
      }
    }
  });

  it('移动端与鸿蒙有安全区，Web 无安全区', () => {
    const ios = findPreset('ios-390x844');
    expect(safeAreaOf(ios as never).notch?.height).toBeGreaterThan(0);
    expect(safeAreaOf(ios as never).indicatorBar).toBeGreaterThan(0);

    const web = findPreset('web-1440');
    expect(safeAreaOf(web as never)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(web?.safeArea).toBeUndefined();
  });

  it('非折叠预设调用 foldableStates 时退化为单形态', () => {
    const web = findPreset('web-1440');
    const states = foldableStates(web as never);
    expect(states).toHaveLength(1);
    expect(states[0]?.width).toBe(1440);
  });

  it('默认预设：Web 取 1440，未知端兜底不崩', () => {
    expect(defaultPresetFor('web').width).toBe(1440);
    expect(defaultPresetFor('android').width).toBe(360);
    expect(defaultPresetFor('harmonyos').width).toBe(360);
    expect(findPreset('不存在')).toBeNull();
  });

  it('画布逻辑尺寸与桌面内容区计算', () => {
    const windows = findPreset('windows-1440x900');
    expect(canvasSizeOf(windows as never)).toEqual({ width: 1440, height: 900 });
    const box = contentBoxOf(windows as never);
    expect(box.y).toBe(32);
    expect(box.height).toBe(900 - 32 - 1);
    // 无窗口占位的预设内容区即整块画布
    expect(contentBoxOf(findPreset('web-1440') as never)).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it('栅格常量为 8px；断点标签可用于响应式规则', () => {
    expect(GRID_SIZE).toBe(8);
    expect(breakpointLabel(1920)).toBe('1920');
    expect(breakpointLabel(1500)).toBe('1440');
    expect(breakpointLabel(800)).toBe('768');
    expect(breakpointLabel(375)).toBe('375');
  });

  it('预设 id 全局唯一，且覆盖七端', () => {
    const ids = DEVICE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(DEVICE_PRESETS.map((preset) => preset.platform)).size).toBe(7);
  });
});
