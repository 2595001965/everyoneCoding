/**
 * `@ec/designer` 的**备注子入口**（`exports['./notes']`）。
 *
 * 为什么需要它：备注（FR-ANN）的持久化权威在**外壳**（Electron 主进程 / Tauri 命令层），
 * 而备注的领域规则（六类备注的优先级加权、禁止事项置顶、历史留痕、上下文注入排序）
 * 只在 `notes/note-model.ts` 与 `notes/note-repo.ts` 里成立。若让外壳自己再写一份，
 * 两处口径必然漂移 —— 面板按 `computeNotePriority` 排序、上下文按另一套排序，
 * 「禁止事项置顶」这条硬约束就会时灵时不灵。
 *
 * 与包根入口的区别：包根入口会 `export *` 出 NotePanel/NotePopover 等 React 组件与
 * 画布/拖拽模块，**主进程不能引入**。本入口只导出纯逻辑（运行时依赖仅 `zod`），
 * 依据与 `dsl-entry.ts` 完全一致。
 *
 * 维护约束：往本文件里加模块前，先确认其 import 里没有 `react` / `@dnd-kit/*` /
 * `zustand` / `@ec/ui`；新增模块时应同步更新 `src/__tests__/notes-entry-purity.test.ts`。
 */

export * from './notes/note-model';
export * from './notes/note-repo';
