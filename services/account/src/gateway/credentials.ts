import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AppConfig } from '../config.ts';
import { AppError, ErrCode } from '../errors.ts';

/** Resolve service-owned references only. The resolved secret never enters a response or log. */
export async function resolvePlatformCredential(
  credentialRef: string,
  config: AppConfig,
): Promise<string> {
  if (credentialRef.startsWith('env:')) {
    const name = credentialRef.slice(4);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
      throw new AppError(ErrCode.CONFLICT, '平台渠道凭据引用配置无效', 409);
    }
    const secret = process.env[name];
    if (!secret) throw new AppError(ErrCode.CONFLICT, '平台渠道凭据尚未配置', 409);
    return secret;
  }

  if (!credentialRef.startsWith('secret://')) {
    throw new AppError(ErrCode.CONFLICT, '平台渠道凭据引用类型不受支持', 409);
  }
  const key = credentialRef.slice('secret://'.length);
  const parts = key.split('/');
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    throw new AppError(ErrCode.CONFLICT, '平台渠道凭据引用路径无效', 409);
  }
  const root = resolve(config.platformSecretDir);
  const file = resolve(root, ...parts);
  const pathFromRoot = relative(root, file);
  if (isAbsolute(pathFromRoot) || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new AppError(ErrCode.CONFLICT, '平台渠道凭据引用路径越界', 409);
  }
  try {
    const secret = (await readFile(file, 'utf8')).replace(/[\r\n]+$/, '');
    if (!secret) throw new Error('empty');
    return secret;
  } catch {
    throw new AppError(ErrCode.CONFLICT, '平台渠道凭据尚未配置', 409);
  }
}
