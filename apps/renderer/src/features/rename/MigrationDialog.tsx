/**
 * 数据库迁移对话框（T7-05 要点 2/3，E2E-20）。
 *
 * 打开后生成 SQL 预览（前向 + 回滚两栏）、影响行数、锁表 / 耗时风险；
 * 默认只生成脚本不自动执行（D-08）。点击「确认并执行」必须二次确认（高危操作需两次），
 * 执行时订阅流式日志，结束后展示结果（成功 / 回滚 / 拒绝）。planMigration 返回错误时如实展示。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  MigrationExecutionResult,
  MigrationLogLine,
  MigrationPreview,
} from '@ec/registry';
import { SQL_RISK_LABELS } from '@ec/registry';
import { Button, Checkbox, Input, Modal, Spinner, Tag } from '@ec/ui';

import { useRenameApi } from './rename-api';
import type { MigrationPlanError, RenameApi, RenameTarget } from './rename-api';
import './components.css';

export interface MigrationDialogProps {
  api?: RenameApi;
  target: RenameTarget;
  open: boolean;
  onClose: () => void;
}

type AckStep = 'none' | 'ack' | 'confirm';

export function MigrationDialog(props: MigrationDialogProps): JSX.Element {
  const { api, target, open, onClose } = props;
  const injected = useRenameApi();
  const client = api ?? injected;

  const [table, setTable] = useState('users');
  const [oldColumn, setOldColumn] = useState(target.projections.apiField);
  const [newColumn, setNewColumn] = useState(target.projections.apiField);

  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [planError, setPlanError] = useState<MigrationPlanError | null>(null);
  const [logLines, setLogLines] = useState<readonly MigrationLogLine[]>([]);
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<MigrationExecutionResult | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ackStep, setAckStep] = useState<AckStep>('none');
  const [acked, setAcked] = useState(false);

  const inputsRef = useRef({ table, oldColumn, newColumn });
  inputsRef.current = { table, oldColumn, newColumn };

  const runPlan = useCallback(async (): Promise<void> => {
    setPlanError(null);
    setPreview(null);
    setExecResult(null);
    setLogLines([]);
    const current = inputsRef.current;
    const result = await client.planMigration({
      registryId: target.registryId,
      table: current.table,
      oldColumn: current.oldColumn,
      newColumn: current.newColumn,
    });
    if ('error' in result) {
      setPlanError({ error: result.error, guidance: result.guidance });
    } else {
      setPreview(result);
    }
  }, [client, target.registryId]);

  useEffect(() => {
    if (!open) return;
    setConfirmOpen(false);
    setAckStep('none');
    setAcked(false);
    void runPlan();
  }, [open, runPlan]);

  const runExec = useCallback(async (): Promise<void> => {
    if (preview === null) return;
    setExecuting(true);
    setLogLines([]);
    setExecResult(null);
    const unsubscribe = client.subscribeMigrationLog((line) => {
      setLogLines((prev) => [...prev, line]);
    });
    try {
      const result = await client.runMigration({
        migrationId: preview.migrationId,
        confirmed: true,
        secondConfirmed: preview.requiresSecondConfirm,
      });
      setExecResult(result);
    } finally {
      unsubscribe();
      setExecuting(false);
      setConfirmOpen(false);
      setAckStep('none');
      setAcked(false);
    }
  }, [client, preview]);

  const openConfirm = (): void => {
    setAcked(false);
    setAckStep(preview?.requiresSecondConfirm ? 'ack' : 'none');
    setConfirmOpen(true);
  };

  const highRisk = preview?.requiresSecondConfirm === true;

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title="数据库列迁移"
        size="lg"
      >
        <div className="ec-rename-root" data-testid="migration-dialog">
          <div className="ec-rename-grid">
            <label className="ec-rename-block">
              <span>表名</span>
              <Input value={table} aria-label="表名" onChange={setTable} />
            </label>
            <label className="ec-rename-block">
              <span>旧列名</span>
              <Input value={oldColumn} aria-label="旧列名" onChange={setOldColumn} />
            </label>
            <label className="ec-rename-block">
              <span>新列名</span>
              <Input value={newColumn} aria-label="新列名" onChange={setNewColumn} />
            </label>
          </div>

          <div className="ec-rename-actions">
            <Button onClick={() => void runPlan()} data-testid="migration-plan">
              生成预览
            </Button>
          </div>

          {planError !== null && (
            <div className="ec-rename-rollback" data-testid="migration-error">
              <strong className="ec-rename-danger">无法生成迁移预览</strong>
              <div>{planError.error}</div>
              <div className="ec-rename-muted">{planError.guidance}</div>
            </div>
          )}

          {planError === null && preview === null && (
            <div className="ec-rename-inline">
              <Spinner size={18} />
              <span>正在生成迁移预览…</span>
            </div>
          )}

          {preview !== null && (
            <div className="ec-rename-block">
              <p className="ec-rename-muted" data-testid="migration-default-action">
                默认只生成脚本，不自动执行（D-08）：确认 SQL 与影响行数后，可点击「确认并执行」。
              </p>

              <div className="ec-rename-sql-grid">
                <div className="ec-rename-sql-col" data-testid="migration-sql-forward">
                  <strong>前向脚本</strong>
                  {preview.statements.map((stmt, index) => (
                    <div className="ec-rename-sql-stmt" key={`f-${index}`}>
                      <code>{stmt.sql}</code>
                      {stmt.risk !== null && <Tag color="danger">{SQL_RISK_LABELS[stmt.risk]}</Tag>}
                    </div>
                  ))}
                </div>
                <div className="ec-rename-sql-col" data-testid="migration-sql-rollback">
                  <strong>回滚脚本</strong>
                  {preview.rollbackStatements.map((stmt, index) => (
                    <div className="ec-rename-sql-stmt" key={`r-${index}`}>
                      <code>{stmt.sql}</code>
                      {stmt.risk !== null && <Tag color="warning">{SQL_RISK_LABELS[stmt.risk]}</Tag>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="ec-rename-grid">
                <div data-testid="migration-affected-rows">
                  <strong>影响行数</strong>
                  <div className="ec-rename-muted">{preview.affectedRows.detail}</div>
                </div>
                <div data-testid="migration-lock-risk">
                  <strong>锁表 / 耗时风险</strong>
                  <div className="ec-rename-muted">
                    {preview.lockRisk.level}：{preview.lockRisk.detail}
                  </div>
                  <div className="ec-rename-muted">预计耗时 {preview.estimatedMs} ms</div>
                </div>
              </div>

              {preview.backupRecommended && (
                <div className="ec-rename-muted">建议执行前先备份数据库。</div>
              )}

              <div className="ec-rename-log" data-testid="migration-log">
                {logLines.length === 0 ? (
                  <span className="ec-rename-muted">执行日志将在此处流式展示</span>
                ) : (
                  logLines.map((line, index) => (
                    <div
                      key={index}
                      className={`ec-rename-log__line ec-rename-log__line--${line.level}`}
                      data-testid="migration-log-line"
                    >
                      {line.message}
                    </div>
                  ))
                )}
              </div>

              {execResult !== null && (
                <div className="ec-rename-block" data-testid="migration-result">
                  {execResult.ok ? (
                    <Tag color="success">迁移成功</Tag>
                  ) : execResult.rolledBack ? (
                    <Tag color="warning">已回滚</Tag>
                  ) : (
                    <Tag color="danger">迁移未执行</Tag>
                  )}
                  {execResult.refused !== null && <div className="ec-rename-muted">{execResult.refused}</div>}
                  {execResult.failure !== null && <div className="ec-rename-danger">{execResult.failure}</div>}
                  {execResult.rollbackFailure !== null && (
                    <div className="ec-rename-danger">回滚失败：{execResult.rollbackFailure}</div>
                  )}
                </div>
              )}

              <div className="ec-rename-actions">
                <Button
                  variant="primary"
                  disabled={executing}
                  data-testid="migration-confirm"
                  onClick={openConfirm}
                >
                  确认并执行
                </Button>
                <Button onClick={onClose}>关闭</Button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      <Modal open={confirmOpen} onOpenChange={setConfirmOpen} title="确认执行迁移" size="sm">
        <div className="ec-rename-block" data-testid="migration-confirm-dialog">
          {!highRisk && <p>即将执行迁移脚本，该操作会直接修改数据库。确认继续？</p>}
          {highRisk && ackStep === 'ack' && (
            <div className="ec-rename-block">
              <p className="ec-rename-danger">高危操作：本次迁移命中 DROP / 类型变更 / NOT NULL 收紧，可能导致数据丢失。</p>
              <label className="ec-rename-inline">
                <Checkbox
                  checked={acked}
                  data-testid="migration-ack"
                  aria-label="我已知晓风险并已备份"
                  onChange={setAcked}
                />
                <span>我已知晓风险并已备份</span>
              </label>
              <div className="ec-rename-actions">
                <Button disabled={!acked} onClick={() => setAckStep('confirm')}>
                  继续
                </Button>
              </div>
            </div>
          )}
          {highRisk && ackStep === 'confirm' && (
            <p className="ec-rename-danger">请再次确认执行该高危迁移脚本。</p>
          )}
          {(ackStep === 'none' || ackStep === 'confirm') && (
            <div className="ec-rename-actions">
              <Button variant="danger" disabled={executing} data-testid="migration-confirm-final" onClick={() => void runExec()}>
                确认并执行
              </Button>
              <Button onClick={() => setConfirmOpen(false)}>取消</Button>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
