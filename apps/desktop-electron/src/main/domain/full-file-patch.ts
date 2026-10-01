/**
 * 生成「整文件替换」形态的 unified diff（WritePipeline 的 `patch` 输入）。
 *
 * 为什么不能直接给 WritePipeline 全量内容：`create` 策略对**已存在的文件**会直接
 * blocked（那是防"静默覆盖他人实现"的第一道闸门），所以修改已存在文件只能走 `patch`。
 * 结果本身是"一次性替换整份内容"时，用等价的整文件 hunk 表达即可：
 * old 侧是所有原行、new 侧是所有新行，`applyHunk` 按序列匹配后整体替换。
 *
 * 与 git 域冲突落盘的同名私有函数同一口径（流水线 S5 重新生成已存在文件时复用）。
 */
export function buildFullFilePatch(before: string, after: string, filePath: string): string {
  const normalize = (text: string): string[] => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = normalize(before);
  const newLines = normalize(after);
  const body = [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)];
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...body,
  ].join('\n');
}

/** 语言标记（写入管线用；缺省 plaintext） */
export function languageFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'));
  const table: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.vue': 'vue',
    '.dart': 'dart',
    '.ets': 'arkts',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.rs': 'rust',
    '.py': 'python',
    '.java': 'java',
    '.json': 'json',
    '.md': 'markdown',
    '.css': 'css',
    '.html': 'html',
    '.sql': 'sql',
  };
  return table[ext] ?? 'plaintext';
}
