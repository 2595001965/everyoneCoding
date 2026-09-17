import { SecureStore } from '@ec/core';
import type { SecureNamespace, ShellHost } from '@ec/shell-api';

import type { CredentialBinding, GitCredential, GitCredentialKind } from './models';

/**
 * Git 凭据管理（T6-01 要点 4）。
 *
 * 硬约束（NFR-S-04 / 硬约束 7）：
 * - 明文**永不落盘**：令牌与口令只经 `@ec/core` 的 `SecureStore`（DPAPI）写入；
 * - 明文**永不进 argv**：推送 / 拉取时经**环境变量**注入 git
 *   （HTTPS 用 git 2.31+ 的 `GIT_CONFIG_COUNT` 机制设 `http.extraHeader`），
 *   所以进程列表与结构化日志里都看不到令牌；
 * - `listBindings()` 只返回"是否配置了凭据"，绝不返回值本身。
 *
 * SSH 走 `GIT_SSH_COMMAND` 指定 ed25519 私钥路径。私钥内容平台**不复制**，
 * 只引用用户系统里已有的密钥文件；带口令的私钥需要 ssh-agent（见 `buildAuthEnv` 注释）。
 */

/** 密钥环命名空间（已在 shell-api 的 SecureNamespace 中声明） */
export const GIT_CREDENTIAL_NAMESPACE: SecureNamespace = 'git-credential';

const SUFFIX = {
  kind: ':kind',
  username: ':username',
  token: ':token',
  keyPath: ':keyPath',
  passphrase: ':passphrase',
} as const;

export interface GitCredentialStoreOptions {
  /** 直接给外壳（推荐）或已包装好的 SecureStore */
  shell?: ShellHost | undefined;
  store?: SecureStore | undefined;
}

export class GitCredentialStore {
  private readonly store: SecureStore;

  constructor(options: GitCredentialStoreOptions) {
    if (options.store !== undefined) {
      this.store = options.store;
      return;
    }
    if (options.shell === undefined) {
      throw new Error('GitCredentialStore 需要 shell 或 store 之一');
    }
    this.store = new SecureStore(options.shell);
  }

  /** HTTPS：Personal Access Token */
  async setHttpsCredential(input: { remoteName: string; username: string; token: string }): Promise<void> {
    const scope = input.remoteName;
    await this.store.set(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.kind}`, 'https');
    await this.store.set(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.username}`, input.username);
    await this.store.set(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.token}`, input.token);
    await this.store.delete(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.keyPath}`).catch(() => undefined);
    await this.store.delete(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.passphrase}`).catch(() => undefined);
  }

  /** SSH：ed25519 私钥路径（+ 可选口令，建议改用 ssh-agent） */
  async setSshCredential(input: { remoteName: string; privateKeyPath: string; passphrase?: string | null }): Promise<void> {
    const scope = input.remoteName;
    await this.store.set(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.kind}`, 'ssh');
    await this.store.set(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.keyPath}`, input.privateKeyPath);
    if (typeof input.passphrase === 'string' && input.passphrase.length > 0) {
      await this.store.set(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.passphrase}`, input.passphrase);
    } else {
      await this.store.delete(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.passphrase}`).catch(() => undefined);
    }
    await this.store.delete(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.username}`).catch(() => undefined);
    await this.store.delete(GIT_CREDENTIAL_NAMESPACE, `${scope}${SUFFIX.token}`).catch(() => undefined);
  }

  async kindOf(remoteName: string): Promise<GitCredentialKind | null> {
    const kind = await this.store.get(GIT_CREDENTIAL_NAMESPACE, `${remoteName}${SUFFIX.kind}`);
    return kind === 'https' || kind === 'ssh' ? kind : null;
  }

  async has(remoteName: string): Promise<boolean> {
    return (await this.kindOf(remoteName)) !== null;
  }

  /** 读取凭据（返回解密后的明文，仅在内存中短暂存在，绝不落盘/落日志） */
  async get(remoteName: string): Promise<GitCredential | null> {
    const kind = await this.kindOf(remoteName);
    if (kind === null) return null;
    if (kind === 'https') {
      const username = (await this.store.get(GIT_CREDENTIAL_NAMESPACE, `${remoteName}${SUFFIX.username}`)) ?? '';
      const token = await this.store.get(GIT_CREDENTIAL_NAMESPACE, `${remoteName}${SUFFIX.token}`);
      if (token === null || token.length === 0) return null;
      return { kind: 'https', username: username.length > 0 ? username : 'x-access-token', token };
    }
    const privateKeyPath = await this.store.get(GIT_CREDENTIAL_NAMESPACE, `${remoteName}${SUFFIX.keyPath}`);
    if (privateKeyPath === null || privateKeyPath.length === 0) return null;
    const passphrase = await this.store.get(GIT_CREDENTIAL_NAMESPACE, `${remoteName}${SUFFIX.passphrase}`);
    return { kind: 'ssh', privateKeyPath, passphrase: passphrase !== null && passphrase.length > 0 ? passphrase : null };
  }

  async remove(remoteName: string): Promise<void> {
    for (const suffix of Object.values(SUFFIX)) {
      await this.store.delete(GIT_CREDENTIAL_NAMESPACE, `${remoteName}${suffix}`).catch(() => undefined);
    }
  }

  /** 只返回绑定元信息（远程名 + 种类 + 非敏感字段），**不返回任何密钥** */
  async listBindings(): Promise<CredentialBinding[]> {
    const keys = await this.store.listKeys(GIT_CREDENTIAL_NAMESPACE);
    const names = [...new Set(keys.filter((key) => key.endsWith(SUFFIX.kind)).map((key) => key.slice(0, -SUFFIX.kind.length)))];
    const bindings: CredentialBinding[] = [];
    for (const remoteName of names) {
      const kind = await this.kindOf(remoteName);
      if (kind === null) continue;
      const username = kind === 'https' ? await this.store.get(GIT_CREDENTIAL_NAMESPACE, `${remoteName}${SUFFIX.username}`) : null;
      const privateKeyPath = kind === 'ssh' ? await this.store.get(GIT_CREDENTIAL_NAMESPACE, `${remoteName}${SUFFIX.keyPath}`) : null;
      bindings.push({
        remoteName,
        kind,
        keyRef: `${GIT_CREDENTIAL_NAMESPACE}/${remoteName}${SUFFIX.token}`,
        username,
        privateKeyPath,
      });
    }
    return bindings;
  }
}

/* -------------------------------------------------------------------------- */
/* 凭据 → 环境变量（不进 argv）                                                */
/* -------------------------------------------------------------------------- */

export interface AuthEnvResult {
  env: Record<string, string>;
  /** 需要交给日志脱敏的密文清单 */
  secrets: string[];
  /** 中文提示（例如"带口令的私钥需要 ssh-agent"），由调用方转成结构化日志 */
  notes: string[];
}

/**
 * 把凭据编码成 git 可用的环境变量。
 *
 * HTTPS：`GIT_CONFIG_COUNT=1` + `GIT_CONFIG_KEY_0=http.extraHeader` +
 * `GIT_CONFIG_VALUE_0=Authorization: Basic <base64(user:token)>`。
 * 这是 git 2.31+ 支持的"环境变量配置"机制 —— **不需要临时文件、不需要 argv、不需要 askpass**，
 * 因此满足"明文不落盘、日志无令牌"的验收标准。
 *
 * SSH：`GIT_SSH_COMMAND` 指定 ed25519 私钥。无口令时加 `BatchMode=yes`
 * （绝不弹交互）；有口令时无法由环境变量传递，需依赖 ssh-agent，此时不设 BatchMode 并给出提示。
 */
export function buildAuthEnv(credential: GitCredential | null): AuthEnvResult {
  if (credential === null) return { env: {}, secrets: [], notes: [] };

  if (credential.kind === 'https') {
    const basic = base64Encode(`${credential.username}:${credential.token}`);
    return {
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
      secrets: [credential.token, basic],
      notes: ['已通过环境变量注入 HTTPS 令牌（未写入任何文件，也未出现在命令参数中）'],
    };
  }

  const hasPassphrase = credential.passphrase !== null && credential.passphrase.length > 0;
  const flags = [`-i "${credential.privateKeyPath}"`, '-o IdentitiesOnly=yes'];
  if (!hasPassphrase) flags.push('-o BatchMode=yes');
  return {
    env: { GIT_SSH_COMMAND: `ssh ${flags.join(' ')}` },
    secrets: hasPassphrase ? [credential.passphrase ?? ''] : [],
    notes: hasPassphrase
      ? ['SSH 私钥带口令：口令无法经环境变量传给 ssh，请把该密钥交给 ssh-agent 后再推送']
      : ['SSH 凭据已就绪（ed25519 私钥，BatchMode 保证不弹交互）'],
  };
}

/** 纯实现 base64（不依赖 Buffer / btoa，浏览器与 Node 行为一致） */
export function base64Encode(input: string): string {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = new TextEncoder().encode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += table[b0 >> 2] ?? '';
    out += table[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? '';
    out += b1 === undefined ? '=' : (table[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? '=');
    out += b2 === undefined ? '=' : (table[b2 & 0x3f] ?? '=');
  }
  return out;
}
