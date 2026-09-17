/**
 * 远程管理（T6-03 要点 4）：远程列表 + 新增 / 编辑 / 删除（二次确认）+ 连通性测试
 * + Push / Pull / Fetch（含进度回显）+ 凭据表单。
 *
 * 硬约束：
 * - 用户永不接触命令行：一切由按钮触发，结果以结构化日志 / 进度条回显；
 * - 强制推送默认关闭，且开启后必须二次确认（比 `--force` 安全的 `--force-with-lease` 优先）；
 * - 令牌只走密钥环（NFR-S-04）：输入框 `type="password"`，绝不进入任何展示文案。
 */
import { useCallback, useEffect, useState } from 'react';

import { Button, Checkbox, Input, Modal, Progress, Select, Tag } from '@ec/ui';
import { suggestedCredentialKind, type CredentialBinding, type GitRemote } from '@ec/git';

import { useGitApi, type GitProgressEvent, type RemoteTestResult } from './git-api';

export interface RemoteManagerProps {
  /** 远程变更后回调（工作区刷新头部状态） */
  onChanged?: () => void;
}

type Transport = 'idle' | 'push' | 'pull' | 'fetch';

export function RemoteManager({ onChanged }: RemoteManagerProps): JSX.Element {
  const api = useGitApi();
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [bindings, setBindings] = useState<CredentialBinding[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<RemoteTestResult | null>(null);

  const [force, setForce] = useState(false);
  const [pendingForcePush, setPendingForcePush] = useState(false);
  const [progress, setProgress] = useState<GitProgressEvent | null>(null);
  const [transport, setTransport] = useState<Transport>('idle');
  const [notice, setNotice] = useState<string | null>(null);

  const [tokenUser, setTokenUser] = useState('');
  const [token, setToken] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [credentialSaved, setCredentialSaved] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const result = await api.remotes();
    if (result.ok && result.data !== null) {
      setRemotes(result.data);
      setSelected((current) => (current === '' && result.data !== null && result.data.length > 0 ? result.data[0]?.name ?? '' : current));
    }
    const creds = await api.credentialBindings();
    setBindings(creds);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = remotes.find((remote) => remote.name === selected) ?? null;
  const credentialKind = current === null ? 'none' : suggestedCredentialKind(current.url);

  const openCreate = (): void => {
    setEditing(null);
    setFormName('');
    setFormUrl('');
    setFormOpen(true);
  };

  const openEdit = (remote: GitRemote): void => {
    setEditing(remote.name);
    setFormName(remote.name);
    setFormUrl(remote.url);
    setFormOpen(true);
  };

  const submitForm = useCallback(async () => {
    const name = formName.trim();
    const url = formUrl.trim();
    if (name.length === 0 || url.length === 0) return;
    const result = editing === null ? await api.addRemote(name, url) : await api.editRemote(name, url);
    if (result.ok) {
      setFormOpen(false);
      setNotice(editing === null ? `已新增远程 ${name}` : `已更新远程 ${name}`);
      await reload();
      onChanged?.();
    } else {
      setNotice(result.error?.message ?? '保存远程失败');
    }
  }, [api, editing, formName, formUrl, reload, onChanged]);

  const confirmDelete = useCallback(async () => {
    if (pendingDelete === null) return;
    const result = await api.removeRemote(pendingDelete);
    if (result.ok) {
      setPendingDelete(null);
      setNotice(`已删除远程 ${pendingDelete}`);
      await reload();
      onChanged?.();
    }
  }, [api, pendingDelete, reload, onChanged]);

  const runTest = useCallback(async () => {
    if (selected === '') return;
    setTestResult(null);
    const result = await api.testRemote(selected);
    setTestResult(result.data ?? { remote: selected, ok: false, branches: 0, message: result.error?.message ?? '连通性测试失败' });
  }, [api, selected]);

  const runPush = useCallback(
    async (useForce: boolean) => {
      if (selected === '') return;
      setTransport('push');
      setProgress({ phase: 'connecting', message: '正在连接远程…', percent: null });
      const result = await api.push(
        { remote: selected, ...(useForce ? { forceWithLease: true } : {}) },
        (event) => setProgress(event),
      );
      setTransport('idle');
      setProgress({ phase: result.ok ? 'done' : 'error', message: result.ok ? '推送完成' : (result.error?.message ?? '推送失败'), percent: 100 });
      if (result.ok) onChanged?.();
    },
    [api, selected, onChanged],
  );

  const handlePushClick = (): void => {
    if (force) {
      setPendingForcePush(true);
      return;
    }
    void runPush(false);
  };

  const runPull = useCallback(async () => {
    if (selected === '') return;
    setTransport('pull');
    const result = await api.pull({ remote: selected }, (event) => setProgress(event));
    setTransport('idle');
    setProgress({
      phase: result.ok ? 'done' : 'error',
      message: result.ok ? (result.data?.upToDate === true ? '已是最新' : '拉取完成') : (result.error?.message ?? '拉取失败'),
      percent: 100,
    });
    if (result.ok) onChanged?.();
  }, [api, selected, onChanged]);

  const runFetch = useCallback(async () => {
    if (selected === '') return;
    setTransport('fetch');
    const result = await api.fetch({ remote: selected, prune: true }, (event) => setProgress(event));
    setTransport('idle');
    setProgress({
      phase: result.ok ? 'done' : 'error',
      message: result.ok ? (result.data?.upToDate === true ? '已是最新' : '抓取完成') : (result.error?.message ?? '抓取失败'),
      percent: 100,
    });
    if (result.ok) onChanged?.();
  }, [api, selected, onChanged]);

  const saveCredential = useCallback(async () => {
    if (selected === '') return;
    setCredentialSaved(false);
    if (credentialKind === 'https') {
      await api.saveHttpsCredential({ remoteName: selected, username: tokenUser, token });
      // 保存后立刻清空本地明文，避免在组件状态里久留
      setToken('');
    } else if (credentialKind === 'ssh') {
      await api.saveSshCredential({ remoteName: selected, privateKeyPath: sshKey, passphrase: null });
    }
    const creds = await api.credentialBindings();
    setBindings(creds);
    setCredentialSaved(true);
  }, [api, selected, credentialKind, tokenUser, token, sshKey]);

  const binding = bindings.find((item) => item.remoteName === selected) ?? null;

  return (
    <div className="ec-remote-manager" data-testid="remote-manager" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="ec-remote-manager__toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button size="sm" variant="primary" onClick={openCreate} data-testid="remote-add">
          新增远程
        </Button>
        <Select
          aria-label="选择远程"
          value={selected}
          onChange={setSelected}
          options={remotes.map((remote) => ({ label: `${remote.name}（${remote.url}）`, value: remote.name }))}
          data-testid="remote-select"
        />
        {notice !== null && (
          <span role="status" style={{ color: 'var(--ec-color-text-secondary)' }} data-testid="remote-notice">
            {notice}
          </span>
        )}
      </div>

      {loading && <span role="status">读取远程中…</span>}
      {!loading && remotes.length === 0 && <span role="status">尚未配置任何远程仓库。</span>}

      {remotes.length > 0 && (
        <ul className="ec-remote-manager__list" data-testid="remote-list">
          {remotes.map((remote) => (
            <li
              key={remote.name}
              className="ec-remote-manager__item"
              data-testid={`remote-item-${remote.name}`}
              style={{ display: 'flex', gap: 8, alignItems: 'center' }}
            >
              <span style={{ minWidth: 96 }}>{remote.name}</span>
              <code style={{ fontFamily: 'monospace', color: 'var(--ec-color-text-secondary)' }}>{remote.url}</code>
              <Tag color="neutral">{remote.kind}</Tag>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => openEdit(remote)} data-testid={`remote-edit-${remote.name}`} style={linkBtn}>
                编辑
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(remote.name)}
                data-testid={`remote-delete-${remote.name}`}
                style={{ ...linkBtn, color: 'var(--ec-color-danger)' }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}

      {remotes.length > 0 && (
        <div className="ec-remote-manager__actions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button size="sm" onClick={runTest} data-testid="remote-test">
            测试连通性
          </Button>
          <Button size="sm" variant="primary" onClick={handlePushClick} loading={transport === 'push'} data-testid="remote-push">
            推送
          </Button>
          <Button size="sm" onClick={runPull} loading={transport === 'pull'} data-testid="remote-pull">
            拉取
          </Button>
          <Button size="sm" onClick={runFetch} loading={transport === 'fetch'} data-testid="remote-fetch">
            抓取
          </Button>
          <Checkbox
            checked={force}
            onChange={setForce}
            aria-label="强制推送"
            disabled={false}
          />
          <span style={{ color: force ? 'var(--ec-color-danger)' : 'var(--ec-color-text-secondary)' }}>强制推送</span>
        </div>
      )}

      {testResult !== null && (
        <div role="status" data-testid="remote-test-result" style={{ color: testResult.ok ? 'var(--ec-color-success)' : 'var(--ec-color-danger)' }}>
          {testResult.ok ? `连通正常，远端有 ${testResult.branches} 个分支` : `连通失败：${testResult.message}`}
        </div>
      )}

      {progress !== null && (
        <div className="ec-remote-manager__progress" data-testid="remote-progress" role="status">
          {progress.phase === 'transferring' ? <Progress {...(progress.percent !== null ? { value: progress.percent, max: 100 } : { indeterminate: true })} /> : null}
          <span>{progress.message}</span>
        </div>
      )}

      {/* 凭据表单：按 URL 推断种类（HTTPS 令牌 / SSH 私钥路径） */}
      {selected !== '' && credentialKind !== 'none' && (
        <div className="ec-remote-manager__credential" data-testid="remote-credential" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--ec-color-text-secondary)' }}>
            凭据类型：{credentialKind === 'https' ? 'HTTPS 令牌' : 'SSH 私钥'}
            {binding !== null ? '（已保存）' : '（未保存）'}
          </span>
          {credentialKind === 'https' ? (
            <>
              <Input aria-label="HTTPS 用户名" placeholder="用户名" value={tokenUser} onChange={setTokenUser} data-testid="cred-username" />
              <Input
                aria-label="HTTPS 令牌"
                placeholder="访问令牌"
                type="password"
                value={token}
                onChange={setToken}
                data-testid="cred-token"
              />
            </>
          ) : (
            <Input
              aria-label="SSH 私钥路径"
              placeholder="例如 ~/.ssh/id_ed25519"
              value={sshKey}
              onChange={setSshKey}
              data-testid="cred-ssh-key"
            />
          )}
          <Button size="sm" onClick={saveCredential} data-testid="cred-save">
            保存凭据
          </Button>
          {credentialSaved && (
            <span role="status" data-testid="cred-saved">
              凭据已存入密钥环（不会明文落盘）
            </span>
          )}
        </div>
      )}

      <Modal
        open={formOpen}
        onOpenChange={setFormOpen}
        title={editing === null ? '新增远程' : `编辑远程 ${editing}`}
        footer={
          <>
            <Button size="sm" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={submitForm} data-testid="remote-form-submit">
              保存
            </Button>
          </>
        }
      >
        <Input aria-label="远程名称" placeholder="例如 origin" value={formName} onChange={setFormName} data-testid="remote-form-name" />
        <Input
          aria-label="远程地址"
          placeholder="例如 https://example.com/group/repo.git"
          value={formUrl}
          onChange={setFormUrl}
          data-testid="remote-form-url"
        />
      </Modal>

      <Modal
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="删除远程确认"
        footer={
          <>
            <Button size="sm" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button size="sm" variant="danger" onClick={confirmDelete} data-testid="remote-delete-confirm">
              删除
            </Button>
          </>
        }
      >
        <p>
          即将删除远程 <strong>{pendingDelete}</strong>，本地仓库内容不受影响，但之后无法再向该远程推送。确认继续？
        </p>
      </Modal>

      <Modal
        open={pendingForcePush}
        onOpenChange={(open) => {
          if (!open) setPendingForcePush(false);
        }}
        title="强制推送确认"
        footer={
          <>
            <Button size="sm" onClick={() => setPendingForcePush(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                setPendingForcePush(false);
                void runPush(true);
              }}
              data-testid="force-push-confirm"
            >
              强制推送
            </Button>
          </>
        }
      >
        <p>
          强制推送会覆盖远程分支上已有的提交（优先使用 <code>--force-with-lease</code> 降低误伤风险）。
          团队协作分支上这样做可能导致他人提交丢失，确认继续？
        </p>
      </Modal>
    </div>
  );
}

const linkBtn = {
  background: 'none',
  border: 'none',
  color: 'var(--ec-color-info)',
  cursor: 'pointer',
  padding: '0 4px',
} as const;
