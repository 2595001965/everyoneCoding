import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  BLOCKED_EDIT_LABELS,
  CODE_SURFACE_READONLY_PROPS,
  CodeViewError,
  createReadOnlyGuard,
  type BlockedEditEvent,
} from '@ec/ai';

import { AiFixEntry } from './AiFixEntry';
import { useCodeViewApi, type CodeFileEntry } from './code-api';

/**
 * CodeView：只读代码视图（T4-05 要点 2 / E2E-18）。
 *
 * 只读由三件事共同保证：
 * 1. 渲染层不使用任何可编辑控件（无 input / textarea / contentEditable）——
 *    代码本体是 `<pre>` 文本，样式与语法高亮都只是视觉层；
 * 2. `createReadOnlyGuard()` 拦截键入 / 粘贴 / 拖拽 / 剪切 / beforeinput，
 *    并把拦截原因交给 `AiFixEntry` 弹出「交给 AI 修改」入口；
 * 3. 静态扫描（`scanReadOnlyCompliance`）在测试中扫描本文件源码，
 *    出现任何可编辑标记即失败（机器可验证，不依赖人工 review）。
 */

export interface CodeViewProps {
  /** 显式指定文件（受控）；不传则使用内部选择 */
  path?: string;
  /** 文件列表（受控）；不传则从端口加载 */
  files?: readonly CodeFileEntry[];
  height?: number;
  /** 跳转到 AI 对话（预填上下文） */
  onRequestAiFix?:
    ((input: { path: string; reason: string; fileName: string }) => void) | undefined;
}

export function CodeView({
  path,
  files,
  height = 420,
  onRequestAiFix,
}: CodeViewProps): JSX.Element {
  const api = useCodeViewApi();
  const [loadedFiles, setLoadedFiles] = useState<readonly CodeFileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(path ?? null);
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [fixEntry, setFixEntry] = useState<BlockedEditEvent | null>(null);
  const blockedCountRef = useRef(0);

  const fileList = files ?? loadedFiles;
  const effectivePath = path ?? activePath;

  useEffect(() => {
    if (files !== undefined) return;
    let cancelled = false;
    void api.files
      .listFiles()
      .then((entries) => {
        if (!cancelled) setLoadedFiles(entries);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, files]);

  useEffect(() => {
    if (path !== undefined) setActivePath(path);
  }, [path]);

  useEffect(() => {
    if (effectivePath === null) return;
    let cancelled = false;
    void api.files
      .readFile(effectivePath)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof CodeViewError
            ? cause.userMessage
            : cause instanceof Error
              ? cause.message
              : String(cause),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, effectivePath]);

  const guard = useMemo(
    () =>
      createReadOnlyGuard({
        onBlockedEdit: (event) => {
          blockedCountRef.current += 1;
          setFixEntry(event);
        },
      }),
    [],
  );

  const closeFixEntry = useCallback(() => setFixEntry(null), []);

  const lines = useMemo(() => content.replace(/\r\n?/g, '\n').split('\n'), [content]);

  return (
    <section
      className="ec-code-view"
      aria-label="代码视图"
      data-read-only="true"
      data-readonly="true"
    >
      <header
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}
      >
        <strong style={{ fontSize: 13 }}>代码（只读）</strong>
        <span style={{ fontSize: 12, color: 'var(--ec-text-secondary, #64748b)' }}>
          代码由 AI 写入，此处仅供查看；尝试编辑会被拦截并引导到 AI 修改入口。
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12 }}>{`共 ${lines.length} 行`}</span>
      </header>

      {fileList.length > 0 && (
        <nav
          className="ec-code-view__files"
          aria-label="代码文件列表"
          style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}
        >
          {fileList.map((file) => (
            <button
              key={file.path}
              type="button"
              data-file-path={file.path}
              aria-current={file.path === effectivePath ? 'true' : undefined}
              style={{
                font: 'inherit',
                padding: '2px 8px',
                borderRadius: 6,
                cursor: 'pointer',
                border: '1px solid var(--ec-border, #e2e8f0)',
                background:
                  file.path === effectivePath ? 'var(--ec-surface-sunken, #f1f5f9)' : 'transparent',
              }}
              onClick={() => setActivePath(file.path)}
            >
              {file.path}
            </button>
          ))}
        </nav>
      )}

      {error !== null && (
        <p role="alert" style={{ fontSize: 12, color: '#dc2626' }}>
          {error}
        </p>
      )}

      {effectivePath === null ? (
        <p style={{ fontSize: 12 }}>请选择一个文件查看。</p>
      ) : (
        <pre
          className="ec-code-view__surface"
          data-testid="ec-code-surface"
          data-file-path={effectivePath}
          aria-label={`${effectivePath} 内容（只读）`}
          {...CODE_SURFACE_READONLY_PROPS}
          {...guard.props}
          tabIndex={0}
          style={{
            margin: 0,
            maxHeight: height,
            overflow: 'auto',
            fontSize: 12,
            lineHeight: 1.5,
            background: 'var(--ec-surface-sunken, #f8fafc)',
            borderRadius: 6,
            padding: 8,
            whiteSpace: 'pre',
          }}
        >
          <code>{content}</code>
        </pre>
      )}

      {fixEntry !== null && (
        <AiFixEntry
          path={effectivePath ?? ''}
          reason={`${BLOCKED_EDIT_LABELS[fixEntry.reason]}已被拦截（代码视图只读）`}
          {...(onRequestAiFix !== undefined ? { onConfirm: onRequestAiFix } : {})}
          onClose={closeFixEntry}
        />
      )}
    </section>
  );
}

/**
 * 只读拦截错误：外壳在 fs 层拒绝写入时抛出，UI 据此提示（而不是显示"保存失败"）。
 */
export function describeReadOnlyBlock(event: BlockedEditEvent): string {
  return `${BLOCKED_EDIT_LABELS[event.reason]}已被拦截：代码只能由 AI 修改（D-04）。`;
}

export { CodeViewError };
