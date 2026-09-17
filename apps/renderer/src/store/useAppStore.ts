import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * 会话级状态：外壳信息、当前用户、全局加载态。
 * 不持久化（外壳信息每次启动重新协商）。
 */

export interface AppStore {
  shellKind: string;
  degraded: string[];
  shellReady: boolean;
  currentUser: { id: string; displayName: string } | null;
  setShellReady(kind: string, degraded: string[]): void;
  setUser(user: { id: string; displayName: string } | null): void;
}

export const useAppStore = create<AppStore>()(
  immer((set) => ({
    shellKind: 'mock',
    degraded: [],
    shellReady: false,
    currentUser: null,
    setShellReady: (kind, degraded) =>
      set((state) => {
        state.shellKind = kind;
        state.degraded = degraded;
        state.shellReady = true;
      }),
    setUser: (user) =>
      set((state) => {
        state.currentUser = user;
      }),
  })),
);
