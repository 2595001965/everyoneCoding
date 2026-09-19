/**
 * 重命名对话框（T7-03 要点 1/2/3，FR-UNI-03 / FR-UNI-11 / E2E-15 前置）。
 *
 * 交互链路严格对应 PRD §15.2：
 * ```
 * 输入新名称 ──► ① 合法性校验（同步，不通过即阻断并给 3 个建议名）
 *                 │ 通过
 *                 ▼ ② 300ms 防抖（连续输入只分析最后一次）
 *              ③ 影响面分析面板（三级分组，warn 默认不勾选）
 *                 │ ④ 用户勾选
 *                 ▼ ⑤ 确认执行（二次确认）→ 事务化执行
 * ```
 *
 * 触发点（画布属性面板 / 图层树 / 页面名 / 功能名）由调用方通过 `source` 传入，
 * 防抖与校验逻辑复用领域层的 `createRenameTrigger`（T7-03 的 `rename-trigger.ts`）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  RENAME_DEBOUNCE_MS,
  createRenameTrigger,
  type ConflictCheckResult,
  type ImpactReport,
  type RenameTransactionResult,
  type RenameTriggerSource,
  type RenameTrigger,
  type ResolvedNamingRule,
  type SymbolTable,
} from '@ec/registry';
import { Button, EmptyState, Input, Modal, Spinner, Tag } from '@ec/ui';

import { ConflictWarning } from './ConflictWarning';
import { ImpactPanel, defaultImpactSelection } from './ImpactPanel';
import { useRenameApi, type RenameApi, type RenameTarget } from './rename-api';

export interface RenameDialogProps {
  open: boolean;
  target: RenameTarget | null;
  /** 不传则用 `useRenameApi()` 注入的实现 */
  api?: RenameApi | undefined;
  onClose: () => void;
  onExecuted?: ((result: RenameTransactionResult) => void) | undefined;
  /** 触发点（默认画布属性面板） */
  source?: RenameTriggerSource | undefined;
  /** 防抖窗口；默认 300ms（PRD FR-UNI-03） */
  debounceMs?: number | undefined;
  className?: string | undefined;
}

export function RenameDialog({
  open,
  target,
  api,
  onClose,
  onExecuted,
  source = 'inspector',
  debounceMs = RENAME_DEBOUNCE_MS,
}: RenameDialogProps): JSX.Element | null {
  const injected = useRenameApi();
  const client = api ?? injected;

  const [name, setName] = useState('');
  const [check, setCheck] = useState<ConflictCheckResult | null>(null);
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<
    'idle' | 'checking' | 'analyzing' | 'ready' | 'executed' | 'failed'
  >('idle');
  const [result, setResult] = useState<RenameTransactionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const symbolsRef = useRef<SymbolTable | null>(null);
  const targetRef = useRef<RenameTarget | null>(target);
  targetRef.current = target;
  const ruleRef = useRef<ResolvedNamingRule | null>(null);
  const triggerRef = useRef<RenameTrigger | null>(null);
  const [ruleReady, setRuleReady] = useState(false);

  /**
   * 命名规则由端口提供（含项目级覆盖）。触发器**必须**用真实规则构造：
   * 校验依赖八类投影规则（禁用字符 / 长度上限），占位规则会直接崩。
   * 因此这里先取规则、再建触发器（`ruleRef` 缓存，避免每次输入都重取）。
   */
  useEffect(() => {
    let cancelled = false;
    void client
      .resolveRule()
      .then((resolved) => {
        if (cancelled) return;
        ruleRef.current = resolved;
        triggerRef.current?.dispose();
        triggerRef.current = createRenameTrigger({
          rule: resolved,
          debounceMs,
          onIntent: (intent) => {
            void (async () => {
              try {
                const next = await client.analyze({
                  registryId: intent.registryId,
                  newName: intent.newName,
                });
                setReport(next);
                setSelection(defaultImpactSelection(next));
                setStatus('ready');
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
                setStatus('failed');
              }
            })();
          },
          onBlocked: () => setStatus('idle'),
        });
        setRuleReady(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus('failed');
      });
    return () => {
      cancelled = true;
      triggerRef.current?.dispose();
      triggerRef.current = null;
    };
  }, [client, debounceMs]);

  // 打开 / 换对象时重置
  useEffect(() => {
    if (!open) {
      triggerRef.current?.cancel();
      return;
    }
    const current = targetRef.current;
    setName(current?.canonicalName ?? '');
    setCheck(null);
    setReport(null);
    setSelection(new Set());
    setResult(null);
    setError(null);
    setConfirming(false);
    setStatus('idle');
    void client
      .symbolTable()
      .then((table) => {
        symbolsRef.current = table;
      })
      .catch(() => {
        symbolsRef.current = null;
      });
    return () => triggerRef.current?.cancel();
  }, [open, target, client]);

  const runCheck = useCallback(
    (newName: string) => {
      const current = targetRef.current;
      if (current === null) return;
      setStatus('checking');
      void client
        .check({ registryId: current.registryId, newName })
        .then((next) => {
          setCheck(next);
          setReport(null);
          if (!next.ok) {
            setStatus('idle');
            return;
          }
          setStatus('analyzing');
          triggerRef.current?.trigger({
            registryId: current.registryId,
            projectId: '',
            entityType: current.entityType,
            entityId: current.entityId,
            oldName: current.canonicalName,
            newName,
            source,
          });
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setStatus('failed');
        });
    },
    [client, source],
  );

  const onChangeName = (value: string): void => {
    setName(value);
    if (value.trim().length === 0) {
      triggerRef.current?.cancel();
      setCheck(null);
      setReport(null);
      setStatus('idle');
      return;
    }
    runCheck(value);
  };

  const pickSuggestion = (value: string): void => {
    onChangeName(value);
  };

  const execute = async (): Promise<void> => {
    const current = targetRef.current;
    if (current === null) return;
    setConfirming(false);
    try {
      const executed = await client.execute({
        registryId: current.registryId,
        newName: name,
        selection: [...selection],
        showRevisionMarks: true,
      });
      setResult(executed);
      setStatus(executed.ok ? 'executed' : 'failed');
      if (!executed.ok) setError(executed.failures.join('；'));
      onExecuted?.(executed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('failed');
    }
  };

  if (!open) return null;

  const blocked = check !== null && !check.ok;
  const canExecute = status === 'ready' && report !== null && selection.size > 0;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="重命名"
      size="lg"
      footer={
        <div
          style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}
          data-testid="rename-dialog-footer"
        >
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!canExecute}
            data-testid="rename-execute"
            onClick={() => setConfirming(true)}
          >
            确认执行 {selection.size} 处
          </Button>
        </div>
      }
    >
      <div
        data-testid="rename-dialog"
        data-state={status}
        data-rule-ready={ruleReady ? 'true' : 'false'}
        style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 560 }}
      >
        {target === null ? (
          <EmptyState title="未选择对象" description="请先在设计器中选中一个元素、页面或功能" />
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: 'var(--ec-color-text-secondary)' }}>稳定 ID</span>
              <code data-testid="rename-entity-id">{target.entityId}</code>
              <Tag color="neutral">{target.ownerName ?? '当前项目'}</Tag>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>新名称</span>
              <Input
                value={name}
                onChange={onChangeName}
                aria-label="新名称"
                placeholder="请输入新的显示名"
              />
            </label>

            <ConflictWarning result={blocked ? check : null} onPick={pickSuggestion} />

            {status === 'analyzing' && (
              <div
                style={{ display: 'flex', gap: 8, alignItems: 'center' }}
                data-testid="rename-analyzing"
              >
                <Spinner size={14} />
                <span>正在分析影响面…</span>
              </div>
            )}

            {!blocked && (
              <ImpactPanel
                report={report}
                loading={status === 'analyzing'}
                error={status === 'failed' ? error : null}
                selection={selection}
                onSelectionChange={setSelection}
                busy={false}
              />
            )}

            {error !== null && status === 'failed' && (
              <p
                data-testid="rename-error"
                style={{ margin: 0, color: 'var(--ec-color-danger, #d4380d)' }}
              >
                {error}
              </p>
            )}

            {result !== null && (
              <section
                data-testid="rename-dialog-result"
                data-ok={result.ok ? 'true' : 'false'}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: 8,
                  border: '1px solid var(--ec-color-border)',
                  borderRadius: 6,
                }}
              >
                {result.ok ? (
                  <>
                    <Tag color="success">已完成</Tag>
                    <span>已修改 {result.applied} 处</span>
                    {result.commitSha !== null && <code>commit {result.commitSha}</code>}
                    <span style={{ color: 'var(--ec-color-text-secondary)' }}>
                      投影已更新：{report?.newProjections.component ?? ''}
                    </span>
                  </>
                ) : (
                  <>
                    <Tag color="danger">已失败并回滚</Tag>
                    <span>{result.failures.join('；')}</span>
                  </>
                )}
              </section>
            )}

            {confirming && (
              <section
                data-testid="rename-confirm"
                style={{
                  padding: 10,
                  border: '1px solid var(--ec-color-warning, #d48806)',
                  borderRadius: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <strong>确认执行？</strong>
                <span>
                  将修改 {selection.size} 处（其中确认区 {report?.totals.confirm ?? 0} 处、警告区{' '}
                  {report?.totals.warn ?? 0} 处），并生成一次 Git 提交。执行后可一键撤销。
                </span>
                <span style={{ color: 'var(--ec-color-text-secondary)' }}>
                  {report?.scopeNotice ?? ''}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    variant="danger"
                    onClick={() => void execute()}
                    data-testid="rename-confirm-execute"
                  >
                    确认执行
                  </Button>
                  <Button onClick={() => setConfirming(false)}>再想想</Button>
                </div>
              </section>
            )}

            {report !== null && status === 'ready' && (
              <p
                style={{ margin: 0, color: 'var(--ec-color-text-secondary)' }}
                data-testid="rename-selection-count"
              >
                当前勾选 {selection.size} 处（自动区 {report.totals.auto} / 确认区{' '}
                {report.totals.confirm} / 警告区 {report.totals.warn}）
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
