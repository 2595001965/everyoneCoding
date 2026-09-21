import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  toDiffViewModel,
  type AiPurpose,
  type AssembledContext,
  type DiffViewModel,
  type WritePlan,
  type WriteResult,
} from '@ec/ai';
import { Button, EmptyState, Select, Tag, Textarea } from '@ec/ui';

import { ApplyBar } from '../features/code/ApplyBar';
import { CodeView } from '../features/code/CodeView';
import { DiffView } from '../features/code/DiffView';
import {
  CodeViewProvider,
  readInjectedCodeApi,
  type ExternalChangeHint,
  type ReworkRequest,
} from '../features/code';
import { ContextPanel, ContextPanelProvider, readInjectedContextApi } from '../features/ai';
import { readInjectedDesignerApi } from '../features/designer/designer-api';
import { currentUserId } from '../runtime/project-context';
import { useAppStore } from '../store/useAppStore';
import { useProjectStore } from '../store/useProjectStore';
import { PagePlaceholder } from './PagePlaceholder';

/**
 * 代码与上下文页（T12-02）。
 *
 * 存在的理由：`ContextPanel`（FR-AI-01）与 `CodeView` / `DiffView` / `ApplyBar`
 * （FR-AI-04/11）在此之前**没有任何生产路由挂载**，只有组件测试在驱动 ——
 * 于是"打开上下文面板能看到真实来源与裁剪提示""选中元素生成代码后能预览 diff、
 * 应用、回滚"这两条验收在产品里没有可走的路径。本页把三者接到真实端口：
 *
 * - 上下文面板：选页面 / 元素 + 补充指令 → `ai-context.assemble` → 真实来源、跳过原因与裁剪清单；
 * - 代码视图：只读（`CodeView` 自带键入/粘贴/拖拽拦截与静态扫描约束），外部改动经域事件提示；
 * - 写入：`requestRework`（真实模型）→ 主进程 `WritePipeline.plan()` → 事件回流
 *   → DiffView 预览 → ApplyBar 应用（事务；任一步失败整体回滚）。
 *
 * 本页**不提供任何"保存代码"入口**（D-04）：代码只能由 AI 写入。
 */

const PURPOSE_OPTIONS: ReadonlyArray<{ label: string; value: AiPurpose }> = [
  { value: 'code', label: '代码生成' },
  { value: 'interface', label: '界面生成' },
  { value: 'techdoc', label: '技术文档' },
  { value: 'requirement', label: '需求文档' },
  { value: 'commit-msg', label: '提交信息' },
];

interface ElementOption {
  id: string;
  label: string;
}

/** 从页面 DSL 收集可选中元素（带层级缩进，便于分辨同名元素） */
function collectElements(tree: unknown, depth = 0, out: ElementOption[] = []): ElementOption[] {
  if (tree === null || typeof tree !== 'object') return out;
  const node = tree as { id?: unknown; type?: unknown; name?: unknown; children?: unknown };
  if (typeof node.id === 'string') {
    const type = typeof node.type === 'string' ? node.type : 'Element';
    const name = typeof node.name === 'string' && node.name.length > 0 ? `「${node.name}」` : '';
    out.push({ id: node.id, label: `${'　'.repeat(depth)}${type}${name}` });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectElements(child, depth + 1, out);
  }
  return out;
}

/** 把当前差异里选中文件的增删行拼成"供模型定位"的上下文 */
function diffContextOf(model: DiffViewModel | null, paths: readonly string[]): string {
  if (model === null) return '';
  return model.files
    .filter((file) => paths.includes(file.path))
    .map((file) =>
      file.hunks
        .flatMap((hunk) => hunk.lines)
        .filter((line) => line.kind !== 'context')
        .map((line) => `${line.kind === 'add' ? '+' : '-'}${line.text}`)
        .join('\n'),
    )
    .filter((text) => text.length > 0)
    .join('\n');
}

export function CodePage(): JSX.Element {
  const navigate = useNavigate();
  const shellReady = useAppStore((state) => state.shellReady);
  const project = useProjectStore((state) => state.current);
  // shellReady 变化代表外壳可能刚注入端口，需要重新读取
  const codeApi = (void shellReady, readInjectedCodeApi());
  const contextApi = (void shellReady, readInjectedContextApi());
  const designerApi = (void shellReady, readInjectedDesignerApi());

  const [pages, setPages] = useState<
    readonly { pageId: string; name: string; route: string | null }[]
  >([]);
  const [pageId, setPageId] = useState('');
  const [elements, setElements] = useState<readonly ElementOption[]>([]);
  const [elementId, setElementId] = useState('');
  const [purpose, setPurpose] = useState<AiPurpose>('code');
  const [instruction, setInstruction] = useState('');
  const [context, setContext] = useState<AssembledContext | null>(null);
  const [plan, setPlan] = useState<WritePlan | null>(null);
  const [applied, setApplied] = useState<WriteResult | null>(null);
  const [reworkComment, setReworkComment] = useState('');
  const [reworkPaths, setReworkPaths] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [changes, setChanges] = useState<readonly ExternalChangeHint[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const projectId = project?.id ?? '';

  /* -------------------- 真实页面与元素清单 -------------------- */
  useEffect(() => {
    if (designerApi === null || projectId.length === 0) return;
    let cancelled = false;
    void designerApi.listPages(projectId).then((items) => {
      if (cancelled) return;
      setPages(items);
      setPageId((current) => (current.length > 0 ? current : (items[0]?.pageId ?? '')));
    });
    return () => {
      cancelled = true;
    };
  }, [designerApi, projectId]);

  useEffect(() => {
    if (designerApi === null || projectId.length === 0 || pageId.length === 0) {
      setElements([]);
      return;
    }
    let cancelled = false;
    void designerApi
      .loadPage(projectId, pageId)
      .then((envelope) => {
        if (cancelled) return;
        setElements(collectElements((envelope as { page?: { tree?: unknown } }).page?.tree));
      })
      .catch(() => {
        if (!cancelled) setElements([]);
      });
    return () => {
      cancelled = true;
    };
  }, [designerApi, projectId, pageId]);

  /* -------------------- 写入计划回流（AI 重改的两段式回执） -------------------- */
  useEffect(() => {
    if (codeApi?.subscribeWritePlan === undefined) return;
    return codeApi.subscribeWritePlan((hint) => {
      setPlan(hint.plan);
      setApplied(null);
      setBusy(false);
      setNotice('模型已返回差异：确认无误后点击应用（写入会走事务，失败整体回滚）。');
    });
  }, [codeApi]);

  /* -------------------- 外部改动提示 -------------------- */
  useEffect(() => {
    if (codeApi?.subscribeExternalChanges === undefined) return;
    return codeApi.subscribeExternalChanges((change) => {
      setChanges((previous) => [change, ...previous].slice(0, 5));
    });
  }, [codeApi]);

  const request = useMemo(
    () => ({
      userId: currentUserId(),
      projectId,
      purpose,
      target: purpose === 'code' ? 'backend-code' : purpose,
      ...(elementId.length > 0 ? { elementId } : {}),
      ...(pageId.length > 0 ? { pageId } : {}),
      ...(instruction.trim().length > 0 ? { instruction: instruction.trim() } : {}),
    }),
    [projectId, purpose, elementId, pageId, instruction],
  );

  /* -------------------- 上下文组装（页面持有结果，面板受控渲染） -------------------- */
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    if (contextApi === null || projectId.length === 0) return;
    let cancelled = false;
    void contextApi
      .assemble(requestRef.current)
      .then((result) => {
        if (!cancelled) setContext(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setNotice(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [contextApi, projectId, request]);

  const model: DiffViewModel | null = useMemo(
    () => (plan === null ? null : toDiffViewModel(plan)),
    [plan],
  );

  const submitRework = useCallback(async () => {
    if (codeApi === null || projectId.length === 0) return;
    const paths =
      reworkPaths.length > 0 ? [...reworkPaths] : (model?.files.map((file) => file.path) ?? []);
    if (paths.length === 0) {
      setNotice('请先选择要重改的文件：可以在差异面板里勾选文件，或让代码视图的拦截入口带上文件。');
      return;
    }
    const rework: ReworkRequest = {
      instruction:
        reworkComment.trim().length > 0
          ? reworkComment.trim()
          : '请按更简洁、更符合既有工程约定的方向调整这些文件。',
      context: diffContextOf(model, paths),
      paths,
    };
    setBusy(true);
    setNotice(null);
    try {
      await codeApi.write.requestRework(rework);
      setNotice('已交给 AI 重改：模型返回后差异会在此展示，确认后再应用。');
    } catch (cause) {
      setBusy(false);
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [codeApi, projectId, reworkPaths, reworkComment, model]);

  const applyPlan = useCallback(
    async (target: WritePlan): Promise<WriteResult> => {
      if (codeApi === null) {
        return {
          ok: false,
          planId: target.id,
          applied: [],
          skipped: [],
          rolledBack: [],
          error: '代码端口未注入，无法应用',
        };
      }
      const result = await codeApi.write.apply(target);
      setApplied(result);
      if (result.ok) setReloadKey((value) => value + 1);
      return result;
    },
    [codeApi],
  );

  /* -------------------- 空态与装配引导 -------------------- */

  if (project === null) {
    return (
      <PagePlaceholder
        title="代码与上下文"
        description="代码视图与上下文组装都需要一个已打开的项目：请先在工作台打开或新建项目。"
      />
    );
  }

  if (codeApi === null && contextApi === null) {
    return (
      <PagePlaceholder
        title="代码与上下文"
        description="当前外壳尚未注入代码视图与上下文端口（需要 Electron 主进程的 SQLite 与工程目录能力）。"
      />
    );
  }

  return (
    <section className="ec-page" aria-label="代码与上下文页">
      <h1 className="ec-page__title">代码与上下文</h1>
      <p className="ec-page__desc">
        左侧是本次将提交给模型的上下文（可勾选、折叠、就地编辑）；右侧是项目代码的只读视图。
        代码只能由 AI 写入：任何修改诉求都走「交给 AI 修改」，由模型产出差异后再确认应用。
      </p>

      {changes.length > 0 && (
        <div
          data-testid="ec-external-change-banner"
          role="status"
          style={{
            border: '1px solid #e6a23c',
            background: '#fdf6ec',
            color: '#1f2329',
            padding: 10,
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          <strong style={{ fontSize: 13 }}>检测到外部改动</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {changes.map((change) => (
              <li key={change.path} style={{ fontSize: 12, marginBottom: 4 }}>
                {change.message}
                <span style={{ marginLeft: 8, display: 'inline-flex', gap: 6 }}>
                  {change.actions.map((action) => (
                    <Button
                      key={action.key}
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (action.key === 'regenerate') {
                          setReworkPaths([change.path]);
                          setReworkComment(`请重新生成 ${change.path}：外部修改与生成结果冲突。`);
                          return;
                        }
                        // 回滚由 Git 模块负责（含安全快照与二次确认）；
                        // 这里只做导航，不在代码页里另造一套"恢复文件"的旁路。
                        navigate('/git');
                      }}
                    >
                      {action.label}
                    </Button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 420px', minWidth: 340 }}>
          <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>上下文</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <Select
              aria-label="目标页面"
              size="sm"
              value={pageId}
              onChange={(next) => {
                setPageId(next);
                setElementId('');
              }}
              options={
                pages.length === 0
                  ? [{ label: '（该项目暂无页面）', value: '' }]
                  : pages.map((page) => ({
                      value: page.pageId,
                      label: page.route !== null ? `${page.name} ${page.route}` : page.name,
                    }))
              }
            />
            <Select
              aria-label="选中元素"
              size="sm"
              value={elementId}
              onChange={setElementId}
              options={[
                { label: '（不选中元素／整页）', value: '' },
                ...elements.map((element) => ({ value: element.id, label: element.label })),
              ]}
            />
            <Select
              aria-label="用途"
              size="sm"
              value={purpose}
              onChange={(next) => setPurpose(next as AiPurpose)}
              options={PURPOSE_OPTIONS.map((option) => ({ ...option }))}
            />
          </div>
          <Textarea
            aria-label="补充指令"
            placeholder="补充要求（可选）：例如「登录按钮必须校验图形验证码」"
            value={instruction}
            onChange={setInstruction}
            rows={2}
            style={{ width: '100%', marginBottom: 8 }}
          />

          {context !== null && (
            <p style={{ fontSize: 12, margin: '0 0 6px' }} data-testid="ec-context-summary">
              <Tag>{`${context.totalTokens} / ${context.budget} token`}</Tag>
              {context.aggressive && <Tag color="warning">已激进裁剪</Tag>}
              {context.truncation !== null && (
                <Tag color="warning">{`已省略 ${context.truncation.omittedCount} 项`}</Tag>
              )}
              {context.skipped.length > 0 && (
                <span style={{ marginLeft: 8 }} data-testid="ec-context-skipped">
                  {`未参与本次提交的块：${context.skipped
                    .map((entry) => `${entry.block}（${entry.reason}）`)
                    .join('；')}`}
                </span>
              )}
            </p>
          )}

          <ContextPanel
            request={request}
            context={context}
            onReassemble={(next) => {
              if (contextApi === null) return;
              void contextApi
                .assemble(next)
                .then(setContext)
                .catch((cause: unknown) =>
                  setNotice(cause instanceof Error ? cause.message : String(cause)),
                );
            }}
          />
        </div>

        <div style={{ flex: '1 1 480px', minWidth: 380 }}>
          <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>项目代码（只读）</h2>
          <CodeView
            key={reloadKey}
            onRequestAiFix={(input) => {
              setReworkPaths([input.path]);
              setReworkComment(`${input.reason}（${input.fileName}）`);
            }}
          />

          {notice !== null && (
            <p role="status" style={{ fontSize: 12, marginTop: 8 }} data-testid="ec-code-notice">
              {notice}
            </p>
          )}

          {plan !== null && model !== null ? (
            <div style={{ marginTop: 12 }} data-testid="ec-write-plan">
              <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>写入预览</h2>
              <DiffView
                model={model}
                onRequestRework={(paths) => {
                  setReworkPaths(paths);
                }}
              />
              <ApplyBar plan={plan} model={model} onApply={applyPlan} />
              {applied !== null && (
                <p
                  role="status"
                  style={{ fontSize: 12, marginTop: 6 }}
                  data-testid="ec-code-apply-result"
                >
                  {applied.ok
                    ? `已应用 ${applied.applied.length} 个文件`
                    : `应用失败：${applied.error ?? '未知错误'}${
                        applied.rolledBack.length > 0
                          ? `（已回滚 ${applied.rolledBack.length} 个文件，未留中间态）`
                          : ''
                      }`}
                </p>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <EmptyState
                title="暂无待应用的写入计划"
                description="代码只能由 AI 写入。填写下方要求交给 AI 修改，模型产出差异后会在此预览，确认后再应用。"
              />
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <Textarea
              aria-label="AI 修改要求"
              placeholder="要求 AI 修改什么？（例如：给登录接口补上图形验证码校验）"
              value={reworkComment}
              onChange={setReworkComment}
              rows={2}
              style={{ width: '100%', marginBottom: 8 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Button onClick={() => void submitRework()} loading={busy}>
                交给 AI 修改
              </Button>
              {reworkPaths.length > 0 && (
                <span style={{ fontSize: 12 }}>{`涉及文件：${reworkPaths.join('、')}`}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * 路由入口：注入代码视图与上下文面板端口。
 *
 * 未注入时两个 Provider 的 `api` 为 null，组件各自展示"未初始化"引导 ——
 * 而不是崩溃或伪造空数据（Tauri / mock 外壳下即为此形态）。
 */
export function CodeWorkspacePage(): JSX.Element {
  const codeApi = readInjectedCodeApi();
  const contextApi = readInjectedContextApi();
  return (
    <CodeViewProvider api={codeApi}>
      <ContextPanelProvider api={contextApi}>
        <CodePage />
      </ContextPanelProvider>
    </CodeViewProvider>
  );
}
