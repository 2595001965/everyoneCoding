import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * UI 状态：面板布局、主题模式、语言。
 * 仅此 store 与设置项持久化（localStorage / 外壳文件由 persist-middleware 接管）。
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Locale = 'zh-CN' | 'en-US';

export interface UiStore {
  theme: ThemeMode;
  locale: Locale;
  /** 左导航宽度（px） */
  leftNavWidth: number;
  /** 右侧面板是否展开 */
  rightPanelOpen: boolean;
  /** 右侧面板宽度（px） */
  rightPanelWidth: number;
  activeRoute: string;
  setTheme(theme: ThemeMode): void;
  setLocale(locale: Locale): void;
  setLeftNavWidth(width: number): void;
  toggleRightPanel(): void;
  setRightPanelWidth(width: number): void;
  setActiveRoute(route: string): void;
}

const UI_STORAGE_KEY = 'ec.ui.v1';

function loadPersisted(): Partial<UiStore> {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (raw === null) return {};
    return sanitizeUiPreferences(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Only accept persisted preferences, never actions or arbitrary store fields. */
export function sanitizeUiPreferences(value: unknown): Partial<UiStore> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: Partial<UiStore> = {};
  if (input['theme'] === 'light' || input['theme'] === 'dark' || input['theme'] === 'system')
    result.theme = input['theme'];
  if (input['locale'] === 'zh-CN' || input['locale'] === 'en-US') result.locale = input['locale'];
  if (typeof input['rightPanelOpen'] === 'boolean') result.rightPanelOpen = input['rightPanelOpen'];
  if (typeof input['leftNavWidth'] === 'number' && Number.isFinite(input['leftNavWidth']))
    result.leftNavWidth = Math.max(160, Math.min(320, input['leftNavWidth']));
  if (typeof input['rightPanelWidth'] === 'number' && Number.isFinite(input['rightPanelWidth']))
    result.rightPanelWidth = Math.max(240, Math.min(640, input['rightPanelWidth']));
  return result;
}

export const useUiStore = create<UiStore>()(
  immer((set) => ({
    theme: 'light',
    locale: 'zh-CN',
    leftNavWidth: 220,
    rightPanelOpen: false,
    rightPanelWidth: 320,
    activeRoute: '/',
    ...loadPersisted(),
    setTheme: (theme) =>
      set((state) => {
        state.theme = theme;
      }),
    setLocale: (locale) =>
      set((state) => {
        state.locale = locale;
      }),
    setLeftNavWidth: (width) =>
      set((state) => {
        if (Number.isFinite(width)) state.leftNavWidth = Math.max(160, Math.min(320, width));
      }),
    toggleRightPanel: () =>
      set((state) => {
        state.rightPanelOpen = !state.rightPanelOpen;
      }),
    setRightPanelWidth: (width) =>
      set((state) => {
        if (Number.isFinite(width)) state.rightPanelWidth = Math.max(240, Math.min(640, width));
      }),
    setActiveRoute: (route) =>
      set((state) => {
        state.activeRoute = route;
      }),
  })),
);

/** 订阅并持久化（仅 ui 相关项） */
useUiStore.subscribe((state) => {
  try {
    localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        theme: state.theme,
        locale: state.locale,
        leftNavWidth: state.leftNavWidth,
        rightPanelOpen: state.rightPanelOpen,
        rightPanelWidth: state.rightPanelWidth,
      }),
    );
  } catch {
    // 存储不可用（隐私模式）时静默
  }
});
