import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 代码根目录的解析与登记。
 *
 * 背景：按 `WorkspaceLayout` 约定，工程产物在 `<projectsDir>/<projectId>/{design,docs,pipeline,code,meta}`。
 * 但「从 Git 导入」的端口契约里 `targetDir` 是**用户必填的克隆目录**（界面标签「克隆目录」），
 * 仓库可能落在用户指定的任意位置（大仓库换盘是常见诉求）。
 *
 * 因此引入一个极小的登记约定：`<projectDir>/meta/code-root.txt` 存代码根目录的绝对路径。
 * - 没这个文件 → 代码根就是 `<projectDir>/code`（模板 / 空白 / 文档导入都如此）；
 * - 有 → 以登记值为准，导出与复制按它取文件。
 *
 * 为什么不用目录联接（junction）指向用户目录：`purgeProject` 会 `rmSync(projectDir, {recursive:true})`，
 * 而 Windows 上递归删除会**穿过 junction 删掉用户仓库本身**——这个风险不可接受。
 * 登记文件则是纯数据，删除工程目录不会波及用户目录。
 */

const CODE_ROOT_FILE = 'code-root.txt';

export function codeRootPointerPath(projectDir: string): string {
  return join(projectDir, 'meta', CODE_ROOT_FILE);
}

/** 登记代码根目录（幂等；路径为空则不写） */
export function writeCodeRootPointer(projectDir: string, codeRoot: string): void {
  if (codeRoot.trim().length === 0) return;
  mkdirSync(join(projectDir, 'meta'), { recursive: true });
  writeFileSync(codeRootPointerPath(projectDir), codeRoot, 'utf8');
}

/**
 * 解析代码根目录。
 *
 * 登记值不可信（用户可能删掉/移动了目录），故读取时做存在性校验：
 * 登记目录不存在就退回 `<projectDir>/code`，避免让导出/复制在错误的路径上空跑。
 */
export function resolveCodeRoot(projectDir: string): string {
  const fallback = join(projectDir, 'code');
  const pointer = codeRootPointerPath(projectDir);
  if (!existsSync(pointer)) return fallback;
  try {
    const recorded = readFileSync(pointer, 'utf8').trim();
    if (recorded.length === 0) return fallback;
    return existsSync(recorded) ? recorded : fallback;
  } catch {
    return fallback;
  }
}
