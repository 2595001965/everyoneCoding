import {
  createCodeAnchor,
  fromCodeAnchorRow,
  toCodeAnchorRow,
  type AnchorDeclaration,
  type AnchorKind,
  type AnchorSyncState,
  type CodeAnchor,
  type CodeAnchorRow,
} from './anchor-model';
import { hasMarker } from './comment-marker';
import { defaultAstAdapter, verifyDeclaration, type AnchorVerification, type AstAdapter } from './ast-verify';

/**
 * Code Anchor 仓库（T4-06 要点 1、2）。
 *
 * 数据权威在内存，落盘经可插拔端口（与 `NoteRepository`、`AnchorRepository` 同一套做法）：
 * 生产环境由外壳适配 `code_anchor` 表（PRD §6.2），测试用内存实现。
 *
 * 三重锚定在这里汇合 —— 注册一个锚点时会同时记录：
 * ① 声明（来自 AI 输出）② 注释标记是否真的写进了代码 ③ AST 校验结果。
 * 三者缺一不会阻断注册，但会**如实体现在 `evidence` 与 `syncState` 上**，
 * 面板据此提示"这个锚点不可靠"。
 */

export interface AnchorPersistencePort {
  load(input: { projectId: string }): readonly CodeAnchorRow[] | Promise<readonly CodeAnchorRow[]>;
  save(input: { projectId: string; rows: readonly CodeAnchorRow[] }): void | Promise<void>;
}

export interface AnchorRepositoryOptions {
  projectId: string;
  clock?: (() => number) | undefined;
  idFactory?: ((sequence: number) => string) | undefined;
  persistence?: AnchorPersistencePort | undefined;
  /** AST 适配器（缺省用多语言符号索引器；外壳可注入 ts-morph 实现） */
  adapter?: AstAdapter | undefined;
}

export interface AnchorRegisterInput {
  declarations: readonly AnchorDeclaration[];
  /** 读取生成后（或写入后）的文件内容；返回 null 表示文件不存在 */
  readFile: (path: string) => string | null;
  elementId?: string | null;
  pageId?: string | null;
  featureId?: string | null;
  commitSha?: string | null;
}

export interface AnchorRegistration {
  anchor: CodeAnchor;
  verification: AnchorVerification;
  /** 代码里是否真的带有注释标记 */
  markerFound: boolean;
  /** 本次是新建还是更新 */
  created: boolean;
}

export interface AnchorStats {
  total: number;
  synced: number;
  drift: number;
  missing: number;
  byKind: Record<AnchorKind, number>;
}

export class AnchorRepository {
  readonly projectId: string;
  private readonly clock: () => number;
  private readonly idFactory: (sequence: number) => string;
  private readonly persistence: AnchorPersistencePort | null;
  private readonly adapter: AstAdapter;
  private anchors = new Map<string, CodeAnchor>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private sequence = 0;

  constructor(options: AnchorRepositoryOptions) {
    this.projectId = options.projectId;
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? ((sequence) => `anc-${sequence}`);
    this.persistence = options.persistence ?? null;
    this.adapter = options.adapter ?? defaultAstAdapter;
  }

  /* ------------------------------ 订阅与持久化 ------------------------------ */

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

  private persist(): void {
    if (this.persistence === null) return;
    void this.persistence.save({ projectId: this.projectId, rows: this.rows() });
  }

  async load(): Promise<number> {
    if (this.persistence === null) return 0;
    const rows = await this.persistence.load({ projectId: this.projectId });
    this.hydrate(rows);
    return this.anchors.size;
  }

  hydrate(rows: readonly CodeAnchorRow[]): void {
    this.anchors = new Map(
      rows.filter((row) => row.project_id === this.projectId).map((row) => [row.id, fromCodeAnchorRow(row)]),
    );
    this.emit();
  }

  /** 落库形态（与 PRD §6.2 字段逐条对齐） */
  rows(): CodeAnchorRow[] {
    return [...this.anchors.values()].map(toCodeAnchorRow);
  }

  /* ------------------------------ 注册与校验 ------------------------------ */

  /**
   * 由 AI 生成结果注册锚点：声明 → 校验 → 入库（同 elementId+filePath+symbol 视为同一锚点，更新而非新增）。
   */
  register(input: AnchorRegisterInput): AnchorRegistration[] {
    const registrations: AnchorRegistration[] = [];
    const now = this.clock();

    for (const declaration of input.declarations) {
      const content = input.readFile(declaration.filePath);
      const verification =
        content === null
          ? ({
              elementId: declaration.elementId,
              filePath: declaration.filePath,
              symbol: declaration.symbol,
              status: 'missing' as const,
              reason: '锚点声明的文件不存在',
              resolved: null,
            } satisfies AnchorVerification)
          : verifyDeclaration({ declaration, path: declaration.filePath, content, adapter: this.adapter });

      const markerFound = content === null ? false : hasMarker(content, declaration.elementId);
      const syncState: AnchorSyncState =
        verification.status === 'ok' ? 'synced' : verification.status === 'drift' ? 'drift_detected' : 'missing';

      const existing = this.findExisting(declaration);
      const anchor: CodeAnchor =
        existing === null
          ? createCodeAnchor({
              projectId: this.projectId,
              filePath: declaration.filePath,
              kind: declaration.kind,
              symbol: declaration.symbol,
              startLine: verification.resolved?.startLine ?? declaration.startLine ?? null,
              endLine: verification.resolved?.endLine ?? declaration.endLine ?? null,
              elementId: input.elementId ?? declaration.elementId,
              pageId: input.pageId ?? null,
              featureId: input.featureId ?? null,
              commitSha: input.commitSha ?? null,
              id: this.idFactory((this.sequence += 1)),
              now,
            })
          : { ...existing, updatedAt: now };

      const updated: CodeAnchor = {
        ...anchor,
        symbol: declaration.symbol,
        kind: declaration.kind,
        startLine: verification.resolved?.startLine ?? anchor.startLine,
        endLine: verification.resolved?.endLine ?? anchor.endLine,
        syncState,
        syncDetail: verification.status === 'ok' ? null : verification.reason,
        evidence: { declared: true, commentMarker: markerFound, astVerified: verification.status === 'ok' },
        updatedAt: now,
      };

      this.anchors.set(updated.id, updated);
      registrations.push({ anchor: updated, verification, markerFound, created: existing === null });
    }

    this.persist();
    this.emit();
    return registrations;
  }

  private findExisting(declaration: AnchorDeclaration): CodeAnchor | null {
    for (const anchor of this.anchors.values()) {
      if (
        anchor.elementId === declaration.elementId &&
        anchor.filePath === declaration.filePath &&
        anchor.symbol === declaration.symbol
      ) {
        return anchor;
      }
    }
    return null;
  }

  /* ------------------------------ 查询 ------------------------------ */

  get(id: string): CodeAnchor | null {
    return this.anchors.get(id) ?? null;
  }

  list(): CodeAnchor[] {
    return [...this.anchors.values()].sort((a, b) => {
      if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
      return (a.startLine ?? 0) - (b.startLine ?? 0);
    });
  }

  listByElement(elementId: string): CodeAnchor[] {
    return this.list().filter((anchor) => anchor.elementId === elementId);
  }

  listByFile(filePath: string): CodeAnchor[] {
    return this.list().filter((anchor) => anchor.filePath === filePath);
  }

  /** 已漂移 / 丢失的锚点（面板高亮与「重新关联」入口） */
  listUnhealthy(): CodeAnchor[] {
    return this.list().filter((anchor) => anchor.syncState !== 'synced');
  }

  stats(): AnchorStats {
    const byKind: Record<AnchorKind, number> = {
      controller: 0,
      service: 0,
      dto: 0,
      repo: 0,
      sql: 0,
      test: 0,
      route: 0,
    };
    let synced = 0;
    let drift = 0;
    let missing = 0;
    for (const anchor of this.anchors.values()) {
      byKind[anchor.kind] += 1;
      if (anchor.syncState === 'synced') synced += 1;
      else if (anchor.syncState === 'drift_detected') drift += 1;
      else missing += 1;
    }
    return { total: this.anchors.size, synced, drift, missing, byKind };
  }

  /* ------------------------------ 状态更新 ------------------------------ */

  /** 行号漂移后按新位置更新（由 reassociate 调用） */
  updateLocation(id: string, patch: { startLine: number; endLine: number; symbol?: string | null }): CodeAnchor | null {
    const current = this.anchors.get(id);
    if (current === null || current === undefined) return null;
    const next: CodeAnchor = {
      ...current,
      startLine: patch.startLine,
      endLine: patch.endLine,
      ...(patch.symbol !== undefined ? { symbol: patch.symbol } : {}),
      syncState: 'synced',
      syncDetail: null,
      evidence: { ...current.evidence, astVerified: true },
      updatedAt: this.clock(),
    };
    this.anchors.set(id, next);
    this.persist();
    this.emit();
    return next;
  }

  markDrift(id: string, detail: string): CodeAnchor | null {
    return this.markState(id, 'drift_detected', detail);
  }

  markMissing(id: string, detail: string): CodeAnchor | null {
    return this.markState(id, 'missing', detail);
  }

  private markState(id: string, state: AnchorSyncState, detail: string): CodeAnchor | null {
    const current = this.anchors.get(id);
    if (current === null || current === undefined) return null;
    const next: CodeAnchor = { ...current, syncState: state, syncDetail: detail, updatedAt: this.clock() };
    this.anchors.set(id, next);
    this.persist();
    this.emit();
    return next;
  }

  remove(id: string): boolean {
    const removed = this.anchors.delete(id);
    if (removed) {
      this.persist();
      this.emit();
    }
    return removed;
  }

  removeByElement(elementId: string): number {
    let count = 0;
    for (const [id, anchor] of [...this.anchors.entries()]) {
      if (anchor.elementId !== elementId) continue;
      this.anchors.delete(id);
      count += 1;
    }
    if (count > 0) {
      this.persist();
      this.emit();
    }
    return count;
  }
}
