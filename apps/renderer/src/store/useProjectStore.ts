import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * 当前项目状态：项目元信息、最近打开与收藏。
 * 持久化策略由 T0-09 的 persist-middleware 接管（Wave 后续接入）。
 */

export interface ProjectSummary {
  id: string;
  name: string;
  /** 目标端（七端矩阵） */
  targetPlatforms: string[];
  updatedAt: number;
}

export interface ProjectStore {
  current: ProjectSummary | null;
  recent: ProjectSummary[];
  favorites: string[];
  openProject(project: ProjectSummary): void;
  closeProject(): void;
  toggleFavorite(projectId: string): void;
}

export const useProjectStore = create<ProjectStore>()(
  immer((set) => ({
    current: null,
    recent: [],
    favorites: [],
    openProject: (project) =>
      set((state) => {
        state.current = project;
        state.recent = [project, ...state.recent.filter((item) => item.id !== project.id)].slice(
          0,
          10,
        );
      }),
    closeProject: () =>
      set((state) => {
        state.current = null;
      }),
    toggleFavorite: (projectId) =>
      set((state) => {
        if (state.favorites.includes(projectId)) {
          state.favorites = state.favorites.filter((id) => id !== projectId);
        } else {
          state.favorites.push(projectId);
        }
      }),
  })),
);
