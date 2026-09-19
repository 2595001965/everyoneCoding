/**
 * 路径守卫。
 *
 * 所有来自上层（AI 生成、用户输入、导入包）的路径都必须先过这一层：
 * - 拒绝 `..` 逃逸
 * - 拒绝绝对路径穿越（跨盘符 / 跨根目录）
 * - 拒绝 NUL 与控制字符
 * - 可选：拒绝符号链接指向工作区之外（需要外壳 fs 提供 stat）
 */

export class PathEscapeError extends Error {
  readonly root: string;
  readonly target: string;

  constructor(root: string, target: string, reason: string) {
    super(`路径越界：${target} 不在工作区 ${root} 之内（${reason}）`);
    this.name = 'PathEscapeError';
    this.root = root;
    this.target = target;
    Object.setPrototypeOf(this, PathEscapeError.prototype);
  }
}

/** 归一化：统一分隔符为 /，解析 . 与 ..，去掉重复斜杠与结尾斜杠 */
export function normalizePath(input: string): string {
  const posix = input.replace(/\\/g, '/');
  const isAbs = posix.startsWith('/') || /^[a-zA-Z]:\//.test(posix);
  const drive = /^([a-zA-Z]):\//.exec(posix)?.[1];
  const parts: string[] = [];
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!isAbs) parts.push('..');
      continue;
    }
    parts.push(segment);
  }
  // Windows 盘符只作为前缀出现一次，不能重复拼进路径段
  const dropDrive =
    drive !== undefined &&
    parts[0] !== undefined &&
    parts[0].toLowerCase() === `${drive.toLowerCase()}:`;
  const segments = dropDrive ? parts.slice(1) : parts;
  const prefix = drive ? `${drive}:/` : isAbs ? '/' : '';
  return `${prefix}${segments.join('/')}`;
}

/** 路径段是否包含非法字符（NUL / 控制字符） */
export function hasIllegalChars(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export class PathGuard {
  readonly root: string;

  constructor(root: string) {
    this.root = normalizePath(root);
  }

  /** 判断目标是否位于根目录内（含根目录自身） */
  isWithin(target: string): boolean {
    if (hasIllegalChars(target)) return false;
    const normalized = normalizePath(target);
    if (normalized === this.root) return true;
    return normalized.startsWith(this.root.endsWith('/') ? this.root : `${this.root}/`);
  }

  /** 解析到绝对路径；越界抛 PathEscapeError */
  resolve(target: string): string {
    if (hasIllegalChars(target)) {
      throw new PathEscapeError(this.root, target, '包含非法字符');
    }
    const normalized = normalizePath(target);
    if (!this.isWithin(normalized)) {
      throw new PathEscapeError(this.root, target, '归一化后不在根目录内');
    }
    return normalized;
  }

  /** 相对路径版本：把 target 解析为相对 root 的路径 */
  relative(target: string): string {
    const resolved = this.resolve(target);
    if (resolved === this.root) return '.';
    return resolved.slice(this.root.length).replace(/^\//, '');
  }
}

/**
 * 便捷函数：把 target 解析到 root 之内。
 * 越界一律抛错，绝不返回"看起来没事"的路径。
 */
export function resolveInWorkspace(root: string, target: string): string {
  return new PathGuard(root).resolve(target);
}
