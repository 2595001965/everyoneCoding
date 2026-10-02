import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { newUlid } from '@ec/data';
import { ShellError } from '@ec/shell-api';
import {
  DomSourceRegistry,
  domSelectionSchema,
  domSessionSchema,
  sourceHash,
  type DomAttachment,
  type DomMapping,
  type DomSelection,
  type DomSession,
} from '@ec/preview';
import type { ProjectPaths } from './paths';
import type { SettingStore } from './setting-store';

export class DomInspection {
  readonly registry = new DomSourceRegistry();
  runtimeId: string = randomUUID();
  session: DomSession | null = null;
  constructor(
    private readonly projectId: string,
    private readonly paths: ProjectPaths,
    private readonly settings: SettingStore,
    private readonly settingsScope: string = projectId,
  ) {}
  reset(runtimeId?: string): void {
    this.runtimeId = runtimeId ?? randomUUID();
    this.session = null;
    this.registry.clear();
  }
  open(parentOrigin: unknown): DomSession {
    if (
      typeof parentOrigin !== 'string' ||
      !/^(?:null|file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|tauri\.localhost)(?::\d+)?|tauri:\/\/localhost)$/.test(
        parentOrigin,
      )
    )
      throw new ShellError('INVALID_ARGUMENT', '选取桥只接受本地宿主 origin');
    this.session = {
      projectId: this.projectId,
      runtimeId: this.runtimeId,
      nonce: randomUUID(),
      parentOrigin,
    };
    return this.session;
  }
  validate(input: Record<string, unknown>): DomSelection {
    const session = domSessionSchema.safeParse(input['session']);
    if (
      !session.success ||
      !this.session ||
      Object.entries(this.session).some(
        ([key, value]) => session.data[key as keyof DomSession] !== value,
      )
    )
      throw new ShellError('INVALID_ARGUMENT', '预览实例或选取会话已失效');
    const selection = domSelectionSchema.safeParse(input['selection']);
    if (!selection.success) throw new ShellError('INVALID_ARGUMENT', '非法 DOM 选取载荷');
    return selection.data;
  }
  resolve(selection: DomSelection): DomMapping {
    const evidence = selection.node.sourceToken
      ? this.registry.get(selection.node.sourceToken)
      : null;
    let reason: string | null = evidence
      ? null
      : '未找到本运行实例编译登记的源码映射，请重新选取；未知映射禁止猜位置改写';
    if (evidence && selection.node.tag !== evidence.tag.toLowerCase())
      reason = '节点标签与编译证据不一致';
    if (evidence && !reason) {
      try {
        const content = readFileSync(
          this.paths.inside(this.paths.codeRoot(this.projectId), evidence.sourceRef.filePath),
          'utf8',
        );
        if (sourceHash(content) !== evidence.sourceRevision.contentHash)
          reason = '源码修订已变化，请等待刷新/HMR 后重新选取';
      } catch {
        reason = '源码已删除、不可读或越出项目根';
      }
    }
    const now = Date.now();
    const verified = evidence && !reason ? evidence : null;
    const component = verified?.sourceRef.symbol ?? null;
    return {
      anchor: {
        anchorId: newUlid(),
        projectId: this.projectId,
        runtimeId: this.runtimeId,
        pageRoute: selection.route,
        elementId: selection.node.nodeId,
        sourceRef: verified?.sourceRef ?? null,
        componentSymbol: component,
        instanceHint: `${selection.documentId}:${selection.node.nodeId}:${selection.instanceIndex + 1}/${selection.instanceCount}`,
        sourceRevision: verified?.sourceRevision ?? null,
        mappingKind: verified?.mappingKind ?? 'unknown',
        confidence: verified ? 'exact' : 'unresolved',
        invalidReason: reason,
        capturedAt: now,
        updatedAt: now,
        revision: 0,
      },
      startColumn: verified?.startColumn ?? null,
      endColumn: verified?.endColumn ?? null,
      shared: {
        renderedInstances: selection.instanceCount,
        requiresConfirmation: component !== null || selection.instanceCount > 1,
        scope: component
          ? `${component} 组件定义；当前页 ${selection.instanceCount} 个同源节点实例，其他路由/调用处范围未知`
          : `当前页 ${selection.instanceCount} 个同源节点实例`,
      },
      relatedApis: [],
    };
  }
  save(input: Record<string, unknown>, attached: boolean): DomAttachment {
    const selection = this.validate(input);
    const mapping = this.resolve(selection);
    if (attached && mapping.anchor.confidence !== 'exact')
      throw new ShellError('INVALID_ARGUMENT', mapping.anchor.invalidReason ?? '缺少可信源码映射');
    const note = input['note'];
    const placement = input['placement'];
    const targetPage = input['targetPage'];
    if (
      typeof note !== 'string' ||
      note.length > 4000 ||
      !['before', 'after', 'inside'].includes(String(placement)) ||
      typeof targetPage !== 'string' ||
      !targetPage.startsWith('/') ||
      targetPage.length > 512
    )
      throw new ShellError('INVALID_ARGUMENT', '非法备注、插入位置或目标页面');
    if (attached && mapping.shared.requiresConfirmation && input['sharedConfirmed'] !== true)
      throw new ShellError('INVALID_ARGUMENT', '附加上下文前须确认共享组件影响范围');
    const item: DomAttachment = {
      selection,
      mapping,
      note,
      placement: placement as DomAttachment['placement'],
      targetPage,
      attached,
    };
    const key = `preview_dom_notes:${this.settingsScope}`;
    const existing = this.settings.read<DomAttachment[]>(key) ?? [];
    const path = mapping.anchor.sourceRef?.filePath;
    const line = mapping.anchor.sourceRef?.startLine;
    const notes = existing.filter(
      (entry) =>
        !(
          entry.selection.node.nodeId === selection.node.nodeId ||
          (path &&
            entry.targetPage === targetPage &&
            entry.mapping.anchor.sourceRef?.filePath === path &&
            entry.mapping.anchor.sourceRef.startLine === line &&
            entry.mapping.startColumn === mapping.startColumn &&
            entry.mapping.anchor.sourceRevision?.contentHash ===
              mapping.anchor.sourceRevision?.contentHash)
        ),
    );
    this.settings.write(key, [...notes, item].slice(-100));
    return item;
  }
  readAttachments(): DomAttachment[] {
    return (
      this.settings.read<DomAttachment[]>(`preview_dom_notes:${this.settingsScope}`) ?? []
    ).filter((entry) => {
      if (
        !entry.attached ||
        !entry.mapping.anchor.sourceRef ||
        !entry.mapping.anchor.sourceRevision
      )
        return false;
      try {
        return (
          sourceHash(
            readFileSync(
              this.paths.inside(
                this.paths.codeRoot(this.projectId),
                entry.mapping.anchor.sourceRef.filePath,
              ),
              'utf8',
            ),
          ) === entry.mapping.anchor.sourceRevision.contentHash
        );
      } catch {
        return false;
      }
    });
  }
}
