/**
 * 备注与批注系统（T4-01）对外 API。
 *
 * - `note-model`：备注实体、六类型元数据、富文本纯函数、优先级与排序、上下文视图
 * - `note-repo`：内存权威副本 + 可插拔持久化端口 + 上下文注入接口
 * - 组件：`NotePopover`（编辑）/ `NoteBadge` + `ElementNoteBadges`（角标）/ `NotePanel`（集中查看）/ `NoteHistory`（留痕）
 *
 * 对 T4-02 的契约：`NoteRepository.getNotesForContext(target)` 返回按优先级排序的备注
 * （禁止事项置顶），`hasNoteUpdatedSince(target, since)` 供生成前判断「备注已更新」。
 */

export * from './note-model';
export * from './note-repo';
export { NoteBadge, ElementNoteBadges, describeNoteBadge } from './NoteBadge';
export type { NoteBadgeProps, ElementNoteBadgesProps, MeasuredRect } from './NoteBadge';
export { NotePopover, RichTextPreview } from './NotePopover';
export type { NotePopoverProps, NoteTargetRef } from './NotePopover';
export { NotePanel, useNotesRevision } from './NotePanel';
export type { NotePanelProps, NoteJumpTarget, NoteCountSnapshot } from './NotePanel';
export { NoteHistory } from './NoteHistory';
export type { NoteHistoryProps } from './NoteHistory';
