/**
 * 当前项目上下文（T12-01 项目上下文贯穿）。
 *
 * 工作台打开项目 → `useProjectStore.openProject` → 本模块的活跃项目。
 * 生产端口适配器（git / preview / rename / nav / designer / code …）在每次调用前
 * 读这里的 projectId 并注入跨进程参数，因此「项目 A 的调用串到项目 B」在结构上不可能。
 *
 * 为什么不放在 `useProjectStore` 里直接读：适配器是纯函数风格、不参与 React 渲染，
 * 而项目切换必须能**同步**拿到新 id（否则打开项目后第一次调用还在用旧 id）。
 * zustand 的 `getState()` 恰好满足这一点，这里只是把它包成端口适配器的明确入口。
 */

import { ShellError } from '@ec/shell-api';

import { useProjectStore, type ProjectSummary } from '../store/useProjectStore';

/** 当前打开的项目；未打开为 null（页面据此展示「先打开项目」引导） */
export function getActiveProject(): ProjectSummary | null {
  return useProjectStore.getState().current;
}

/** 必须已打开项目，否则抛结构化错误（页面层应在此之前给出引导） */
export function requireActiveProject(): ProjectSummary {
  const project = getActiveProject();
  if (project === null) {
    throw new ShellError(
      'INVALID_ARGUMENT',
      '尚未打开项目：请先在工作台打开一个项目，再使用该功能',
      undefined,
      'unknown',
    );
  }
  return project;
}

/**
 * 订阅活跃项目变化（返回退订函数）。
 * 端口适配器用它做「项目切换时清理旧订阅与旧状态」的挂点。
 */
export function onActiveProjectChange(
  listener: (project: ProjectSummary | null, previous: ProjectSummary | null) => void,
): () => void {
  return useProjectStore.subscribe((state, previousState) => {
    if (state.current?.id !== previousState.current?.id) {
      listener(state.current, previousState.current);
    }
  });
}

/** 当前用户 id：外壳会注入 `__EC_USER_ID__`；未注入时用占位值由外壳做兜底查询 */
export function currentUserId(): string {
  const injected = (globalThis as unknown as { __EC_USER_ID__?: string }).__EC_USER_ID__;
  return typeof injected === 'string' && injected.length > 0 ? injected : 'local-user';
}
