import {
  NOTE_TYPE_META,
  assertNoteValid,
  computeNotePriority,
  defaultIdFactory,
  documentFromText,
  emptyDocument,
  noteMatchesFilter,
  sortNotesForContext,
  toContextNote,
  type ContextNote,
  type CreateNoteInput,
  type Note,
  type NoteChecklistItem,
  type NoteCodeBlock,
  type NoteContextTarget,
  type NoteFilter,
  type NoteRevision,
  type NoteTargetType,
  type NoteType,
  type UpdateNoteInput,
} from './note-model';

/**
 * 备注仓库（T4-01）。
 *
 * 定位：设计器运行在浏览器环境，**不允许**在这里 import SQLite。
 * 因此本仓库是「内存权威副本 + 可插拔持久化端口」：
 * - 组件与测试直接用内存实现；
 * - 生产环境由外壳注入 `NotePersistencePort`（适配 `note` 表 / 项目文件），
 *   写入策略与 `DesignerPorts` 的其他端口一致。
 *
 * 三条不变量：
 * 1. 任何写操作都走 `mutate()`，保证版本号 +1、历史留痕、更新时间一致；
 * 2. 历史版本（`history`）**不含当前版本**，按 version 升序，容量上限 50（超出丢最旧）；
 * 3. `priority` 永远由 `computeNotePriority` 派生，禁止调用方直接写入。
 */

/** 持久化端口：外壳适配（Electron 主进程 / Tauri 命令层） */
export interface NotePersistencePort {
  load(input: { projectId: string }): readonly Note[] | Promise<readonly Note[]>;
  save(input: { projectId: string; notes: readonly Note[] }): void | Promise<void>;
}

export interface NoteRepositoryOptions {
  /** 当前项目 */
  projectId: string;
  /** 时钟注入（测试可控） */
  clock?: () => number;
  /** id 工厂注入 */
  idFactory?: (prefix: string) => string;
  /** 每个备注的历史版本上限 */
  historyLimit?: number;
  /** 持久化端口（缺省为纯内存） */
  persistence?: NotePersistencePort;
  /** 操作者标识（写入 createdBy / 历史 editor） */
  actor?: string;
}

/** 角标信息（元素角标与图层树图标共用） */
export interface NoteBadgeInfo {
  count: number;
  types: NoteType[];
  /** 含禁止事项 —— 角标用红色描边提示 */
  hasMustFollow: boolean;
}

export class NoteRepository {
  readonly projectId: string;
  private readonly clock: () => number;
  private readonly nextId: () => string;
  private readonly historyLimit: number;
  private readonly persistence: NotePersistencePort | null;
  private actor: string;
  private notes = new Map<string, Note>();
  private readonly listeners = new Set<() => void>();
  /** 版本快照序号：任何写操作 +1，供 React 侧 useSyncExternalStore 判定变更 */
  private revision = 0;

  constructor(options: NoteRepositoryOptions) {
    this.projectId = options.projectId;
    this.clock = options.clock ?? (() => Date.now());
    const factory = options.idFactory ?? defaultIdFactory('note');
    this.nextId = () => factory('note');
    this.historyLimit = options.historyLimit ?? 50;
    this.persistence = options.persistence ?? null;
    this.actor = options.actor ?? 'user';
  }

  /* ------------------------------ 订阅 ------------------------------ */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRevision = (): number => this.revision;

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  setActor(actor: string): void {
    this.actor = actor;
  }

  /* ------------------------------ 读写 ------------------------------ */

  /** 批量装载（不触发历史留痕，用于启动时从端口回读） */
  hydrate(notes: readonly Note[]): void {
    this.notes = new Map(notes.filter((note) => note.projectId === this.projectId).map((note) => [note.id, note]));
    this.emit();
  }

  /** 从持久化端口加载 */
  async load(): Promise<number> {
    if (this.persistence === null) return 0;
    const loaded = await this.persistence.load({ projectId: this.projectId });
    this.hydrate(loaded);
    return this.notes.size;
  }

  private async persist(): Promise<void> {
    if (this.persistence === null) return;
    await this.persistence.save({ projectId: this.projectId, notes: [...this.notes.values()] });
  }

  create(input: Omit<CreateNoteInput, 'projectId'> & { projectId?: string }): Note {
    const now = input.createdAt ?? this.clock();
    const type: NoteType = input.type ?? 'todo';
    const content =
      input.content ?? (input.text !== undefined ? documentFromText(input.text) : emptyDocument());
    const note: Note = {
      id: input.id ?? this.nextId(),
      projectId: input.projectId ?? this.projectId,
      targetType: input.targetType,
      targetId: input.targetId,
      type,
      title: (input.title ?? '').trim(),
      content,
      checklists: (input.checklists ?? []).map((item) => ({ ...item })),
      codeBlocks: (input.codeBlocks ?? []).map((block) => ({ ...block })),
      status: 'open',
      priority: computeNotePriority(type, input.manualPriority ?? null),
      manualPriority: NOTE_TYPE_META[type].mustFollow ? null : (input.manualPriority ?? null),
      version: 1,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      createdBy: input.createdBy ?? this.actor,
      history: [],
    };
    assertNoteValid(note);
    this.notes.set(note.id, note);
    void this.persist();
    this.emit();
    return note;
  }

  update(id: string, patch: UpdateNoteInput, options: { editor?: string } = {}): Note | null {
    const current = this.notes.get(id);
    if (current === null || current === undefined) return null;
    const now = this.clock();

    const nextType = patch.type ?? current.type;
    const mustFollow = NOTE_TYPE_META[nextType].mustFollow;
    const manualPriority = patch.manualPriority !== undefined ? patch.manualPriority : current.manualPriority;

    const draft: Note = {
      ...current,
      type: nextType,
      title: patch.title !== undefined ? patch.title.trim() : current.title,
      content: patch.content ?? current.content,
      checklists: patch.checklists ? patch.checklists.map((item) => ({ ...item })) : current.checklists,
      codeBlocks: patch.codeBlocks ? patch.codeBlocks.map((block) => ({ ...block })) : current.codeBlocks,
      status: patch.status ?? current.status,
      manualPriority: mustFollow ? null : manualPriority,
      priority: computeNotePriority(nextType, mustFollow ? null : manualPriority),
      version: current.version + 1,
      updatedAt: now,
      resolvedAt:
        (patch.status ?? current.status) === 'resolved' ? (current.resolvedAt ?? now) : null,
    };

    const changedFields = changedFieldsBetween(current, draft);
    if (changedFields.length === 0) return current;

    draft.history = this.appendHistory(current, changedFields, options.editor ?? this.actor);
    assertNoteValid(draft);
    this.notes.set(id, draft);
    void this.persist();
    this.emit();
    return draft;
  }

  /** 标记已解决（FR-ANN：未解决备注计入项目仪表盘） */
  resolve(id: string, options: { editor?: string } = {}): Note | null {
    return this.update(id, { status: 'resolved' }, options);
  }

  reopen(id: string, options: { editor?: string } = {}): Note | null {
    return this.update(id, { status: 'open' }, options);
  }

  /** 勾选 / 取消勾选清单项 */
  toggleChecklistItem(noteId: string, itemId: string, options: { editor?: string } = {}): Note | null {
    const current = this.notes.get(noteId);
    if (current === null || current === undefined) return null;
    const checklists: NoteChecklistItem[] = current.checklists.map((item) =>
      item.id === itemId ? { ...item, checked: !item.checked } : { ...item },
    );
    return this.update(noteId, { checklists }, options);
  }

  /** 删除（返回被删对象；历史随之丢失，UI 需二次确认 —— 见 NotePanel） */
  remove(id: string): Note | null {
    const current = this.notes.get(id);
    if (current === null || current === undefined) return null;
    this.notes.delete(id);
    void this.persist();
    this.emit();
    return current;
  }

  get(id: string): Note | null {
    return this.notes.get(id) ?? null;
  }

  list(filter: NoteFilter = {}): Note[] {
    const scoped: NoteFilter = { projectId: this.projectId, ...filter };
    return [...this.notes.values()]
      .filter((note) => noteMatchesFilter(note, scoped))
      .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : b.updatedAt - a.updatedAt));
  }

  listForTarget(targetType: NoteTargetType, targetId: string): Note[] {
    return this.list({ targetType, targetId });
  }

  /** 历史版本（升序，不含当前版本） */
  historyOf(id: string): NoteRevision[] {
    return (this.notes.get(id)?.history ?? []).map((revision) => cloneRevision(revision));
  }

  /** 回退到某个历史版本（本身也留痕，便于再回退） */
  restore(id: string, version: number, options: { editor?: string } = {}): Note | null {
    const current = this.notes.get(id);
    if (current === null || current === undefined) return null;
    const target = current.history.find((revision) => revision.version === version);
    if (target === undefined) return null;
    return this.update(
      id,
      {
        title: target.title,
        type: target.type,
        content: target.content,
        checklists: target.checklists,
        codeBlocks: target.codeBlocks,
        status: target.status,
      },
      options,
    );
  }

  /* --------------------------- 上下文注入 --------------------------- */

  /**
   * 目标相关备注（元素级 + 所属页面级 + 所属功能级），仅未解决项，
   * 按「禁止事项置顶 → 优先级降序 → 更新时间降序」排序（FR-ANN-06）。
   */
  getNotesForContext(target: NoteContextTarget): ContextNote[] {
    const related = this.relatedNotes(target).filter((note) => note.status === 'open');
    return sortNotesForContext(related).map((note) => toContextNote(note));
  }

  /**
   * 判断备注是否在 `since` 之后有更新（含新增、内容修改与状态变化）。
   * T4-04 生成前用它判断「备注已更新，建议重新生成该元素」。
   */
  hasNoteUpdatedSince(target: NoteContextTarget, since: number): boolean {
    return this.relatedNotes(target).some((note) => note.updatedAt > since);
  }

  /** 取得更新晚于 since 的备注 id（生成结果页标注「已遵循备注 #id」用） */
  noteIdsUpdatedSince(target: NoteContextTarget, since: number): string[] {
    return this.relatedNotes(target)
      .filter((note) => note.updatedAt > since)
      .map((note) => note.id);
  }

  /** 某备注在 since 之后是否被修改过 */
  isNoteUpdatedSince(noteId: string, since: number): boolean {
    const note = this.notes.get(noteId);
    return note !== undefined && note.updatedAt > since;
  }

  private relatedNotes(target: NoteContextTarget): Note[] {
    const wanted = new Set<string>();
    if (target.elementId !== null && target.elementId !== undefined) wanted.add(`element:${target.elementId}`);
    if (target.pageId !== null && target.pageId !== undefined) wanted.add(`page:${target.pageId}`);
    if (target.featureId !== null && target.featureId !== undefined) wanted.add(`feature:${target.featureId}`);
    if (wanted.size === 0) return [];
    return [...this.notes.values()].filter(
      (note) => note.projectId === target.projectId && wanted.has(`${note.targetType}:${note.targetId}`),
    );
  }

  /* ------------------------------ 统计 ------------------------------ */

  /** 未解决备注计数（项目仪表盘角标） */
  unresolvedCount(filter: NoteFilter = {}): number {
    return this.list({ ...filter, status: 'open' }).length;
  }

  countsByType(filter: NoteFilter = {}): Record<NoteType, number> {
    const result = {
      business_rule: 0,
      validation: 0,
      interaction: 0,
      todo: 0,
      question: 0,
      forbidden: 0,
    } satisfies Record<NoteType, number>;
    for (const note of this.list(filter)) result[note.type] += 1;
    return result;
  }

  /** 目标 id → 角标信息（未解决项）；元素角标与图层树图标都读它 */
  badgeMap(targetType: NoteTargetType): Record<string, NoteBadgeInfo> {
    const map: Record<string, NoteBadgeInfo> = {};
    for (const note of this.list({ targetType, status: 'open' })) {
      const existing = map[note.targetId];
      if (existing === undefined) {
        map[note.targetId] = {
          count: 1,
          types: [note.type],
          hasMustFollow: NOTE_TYPE_META[note.type].mustFollow,
        };
        continue;
      }
      existing.count += 1;
      if (!existing.types.includes(note.type)) existing.types.push(note.type);
      if (NOTE_TYPE_META[note.type].mustFollow) existing.hasMustFollow = true;
    }
    return map;
  }

  /* ---------------------------- 内部工具 ---------------------------- */

  private appendHistory(current: Note, changedFields: string[], editor: string): NoteRevision[] {
    const snapshot: NoteRevision = {
      version: current.version,
      title: current.title,
      type: current.type,
      status: current.status,
      content: current.content,
      checklists: current.checklists.map((item) => ({ ...item })),
      codeBlocks: current.codeBlocks.map((block) => ({ ...block })),
      changedFields,
      editor,
      createdAt: current.updatedAt,
    };
    const merged = [...current.history, snapshot];
    return merged.length > this.historyLimit ? merged.slice(merged.length - this.historyLimit) : merged;
  }
}

function cloneRevision(revision: NoteRevision): NoteRevision {
  return {
    ...revision,
    content: revision.content,
    checklists: revision.checklists.map((item) => ({ ...item })),
    codeBlocks: revision.codeBlocks.map((block) => ({ ...block })),
    changedFields: [...revision.changedFields],
  };
}

/** 字段级变更摘要（相对上一版） */
export function changedFieldsBetween(previous: Note, next: Note): string[] {
  const changed: string[] = [];
  if (previous.title !== next.title) changed.push('title');
  if (previous.type !== next.type) changed.push('type');
  if (JSON.stringify(previous.content) !== JSON.stringify(next.content)) changed.push('content');
  if (JSON.stringify(previous.checklists) !== JSON.stringify(next.checklists)) changed.push('checklists');
  if (JSON.stringify(previous.codeBlocks) !== JSON.stringify(next.codeBlocks)) changed.push('codeBlocks');
  if (previous.status !== next.status) changed.push('status');
  if (previous.manualPriority !== next.manualPriority) changed.push('manualPriority');
  return changed;
}

/** 便捷构造清单项 */
export function createChecklistItem(
  text: string,
  idFactory: () => string,
  checked = false,
): NoteChecklistItem {
  return { id: idFactory(), text, checked };
}

/** 便捷构造代码片段 */
export function createNoteCodeBlock(code: string, language: string, idFactory: () => string): NoteCodeBlock {
  return { id: idFactory(), language, code };
}
