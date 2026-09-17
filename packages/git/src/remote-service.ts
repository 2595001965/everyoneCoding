import type { GitCredentialStore } from './credentials';
import type { FetchInput, PushInput } from './backend/types';
import type { CredentialBinding, GitRemote, GitResult } from './models';
import type { GitClient } from './git-client';

/**
 * 远程服务（T6-03 要点 2）。
 *
 * - 远程 CRUD 与连通性测试（`ls-remote`，失败时返回**可读原因**而不是抛错）；
 * - Push / Pull / Fetch 带阶段回调（`onProgress`）供 UI 进度条使用；
 * - 凭据读写一律走 `GitCredentialStore`（DPAPI），UI 只能看到"是否已配置"。
 *
 * 关于进度的诚实说明：git 的传输进度是 stderr 上的 `\r` 刷新文本，
 * 本层目前只上报**阶段切换**（连接 / 传输 / 完成 / 失败），`percent` 恒为 null。
 * 要做真实百分比需要解析 stderr 进度流，属后续增强（见报告"未完成项"）。
 */

export type TransferPhase = 'idle' | 'connecting' | 'transferring' | 'done' | 'error';

export interface TransferProgress {
  phase: TransferPhase;
  /** 中文说明，直接显示在进度条上方 */
  message: string;
  /** 0–100；当前实现恒为 null（见文件头说明） */
  percent: number | null;
}

export type ProgressListener = (progress: TransferProgress) => void;

export interface RemoteTestResult {
  remote: string;
  ok: boolean;
  /** 远端分支引用条数 */
  branches: number;
  /** 中文结论 */
  message: string;
}

/** 根据 URL 推断凭据种类（UI 预填凭据表单用） */
export function suggestedCredentialKind(url: string): 'https' | 'ssh' | 'none' {
  if (/^https?:\/\//i.test(url)) return 'https';
  if (/^ssh:\/\//i.test(url) || /^[^/\s]+@[^/\s]+:/.test(url)) return 'ssh';
  return 'none';
}

export class RemoteService {
  constructor(
    private readonly client: GitClient,
    private readonly credentials: GitCredentialStore | null = null,
  ) {}

  list(): Promise<GitResult<GitRemote[]>> {
    return this.client.remotes();
  }

  add(name: string, url: string): Promise<GitResult<string>> {
    return this.client.addRemote(name, url);
  }

  edit(name: string, url: string): Promise<GitResult<string>> {
    return this.client.setRemoteUrl(name, url);
  }

  /** 删除远程（破坏性：UI 二次确认后调用；只删本地 remote 配置，不动远端仓库） */
  async remove(name: string): Promise<GitResult<string>> {
    const result = await this.client.removeRemote(name);
    if (result.ok && this.credentials !== null) await this.credentials.remove(name);
    return result;
  }

  async test(name: string): Promise<GitResult<RemoteTestResult>> {
    const result = await this.client.testRemote(name);
    if (!result.ok) {
      return {
        ...result,
        data: { remote: name, ok: false, branches: 0, message: result.error?.message ?? '连通性测试失败' },
      };
    }
    return {
      ok: true,
      error: null,
      logs: result.logs,
      data: { remote: name, ok: true, branches: result.data?.length ?? 0, message: '连通正常' },
    };
  }

  async push(
    input: PushInput & { remote?: string },
    onProgress?: ProgressListener,
  ): Promise<GitResult<{ summary: string; upToDate: boolean; forced: boolean }>> {
    const remote = input.remote ?? 'origin';
    emit(onProgress, { phase: 'connecting', message: `正在连接 ${remote}`, percent: null });
    emit(onProgress, { phase: 'transferring', message: '正在传输对象', percent: null });
    const result = await this.client.push(input);
    emit(
      onProgress,
      result.ok
        ? { phase: 'done', message: result.data?.upToDate === true ? '远端已是最新' : '推送完成', percent: null }
        : { phase: 'error', message: result.error?.message ?? '推送失败', percent: null },
    );
    return result;
  }

  async pull(
    input: FetchInput & { remote?: string },
    onProgress?: ProgressListener,
  ): Promise<GitResult<{ conflictFiles: string[]; upToDate: boolean; fastForward: boolean }>> {
    const remote = input.remote ?? 'origin';
    emit(onProgress, { phase: 'connecting', message: `正在连接 ${remote}`, percent: null });
    emit(onProgress, { phase: 'transferring', message: '正在抓取并合并', percent: null });
    const result = await this.client.pull(input);
    if (!result.ok || result.data === null) {
      emit(onProgress, { phase: 'error', message: result.error?.message ?? '拉取失败', percent: null });
      return { ...result, data: null };
    }
    const conflicts = result.data.conflictFiles;
    emit(onProgress, {
      phase: 'done',
      message: conflicts.length > 0 ? `存在 ${conflicts.length} 个冲突文件` : '拉取完成',
      percent: null,
    });
    return {
      ok: true,
      error: null,
      logs: result.logs,
      data: { conflictFiles: conflicts, upToDate: result.data.upToDate, fastForward: result.data.fastForward },
    };
  }

  async fetch(
    input: FetchInput & { remote?: string },
    onProgress?: ProgressListener,
  ): Promise<GitResult<{ summary: string; upToDate: boolean }>> {
    const remote = input.remote ?? 'origin';
    emit(onProgress, { phase: 'connecting', message: `正在连接 ${remote}`, percent: null });
    const result = await this.client.fetch(input);
    emit(
      onProgress,
      result.ok
        ? { phase: 'done', message: '抓取完成', percent: null }
        : { phase: 'error', message: result.error?.message ?? '抓取失败', percent: null },
    );
    return result;
  }

  /* ------------------------------ 凭据 ------------------------------ */

  /** 保存 HTTPS 令牌（进 DPAPI 密钥环，明文不落盘） */
  async saveHttpsCredential(input: { remoteName: string; username: string; token: string }): Promise<void> {
    if (this.credentials === null) throw new Error('未装配凭据存储');
    await this.credentials.setHttpsCredential(input);
  }

  /** 保存 SSH 私钥路径 */
  async saveSshCredential(input: { remoteName: string; privateKeyPath: string; passphrase?: string | null }): Promise<void> {
    if (this.credentials === null) throw new Error('未装配凭据存储');
    await this.credentials.setSshCredential(input);
  }

  /** 只返回绑定的元信息（**不含任何密钥**） */
  async listCredentialBindings(): Promise<CredentialBinding[]> {
    if (this.credentials === null) return [];
    return this.credentials.listBindings();
  }

  async removeCredential(remoteName: string): Promise<void> {
    if (this.credentials === null) return;
    await this.credentials.remove(remoteName);
  }
}

function emit(listener: ProgressListener | undefined, progress: TransferProgress): void {
  if (listener === undefined) return;
  listener(progress);
}
