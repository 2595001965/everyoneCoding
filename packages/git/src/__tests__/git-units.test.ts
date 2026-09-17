import { describe, expect, it } from 'vitest';

import {
  classifyStatus,
  parseBlame,
  parseBranches,
  parseLog,
  parseNameStatusZ,
  parsePorcelainZ,
  parseStashSubject,
  classifyRemoteUrl,
  splitRecords,
} from '../backend/cli-backend';
import { createCliGitBackend } from '../backend/cli-backend';
import { createGit2Backend } from '../backend/git2-backend';
import { selectBackend } from '../backend';
import type { GitBackend, GitProcessRunner, GitRunResult } from '../backend/types';
import {
  alignHunk,
  buildHunkPatch,
  foldAlignedRows,
  formatBytes,
  languageFromPath,
  parseHunkHeader,
  parseUnifiedDiff,
  summarizeDiff,
} from '../diff-service';
import {
  AUTO_COMMIT_TRIGGER_LABELS,
  buildAutoCommitMessage,
  createCommitMessage,
  formatCommitMessage,
  normalizeAiCommitMessage,
  parseCommitMessage,
  shouldAutoCommit,
  validateCommitMessage,
} from '../commit-message';
import { buildBranchGraph, buildBranchTree } from '../branch-service';
import { filterCommits, matchesQuery } from '../history-service';
import {
  buildAiMergeRequest,
  hasUnterminatedConflict,
  parseConflictFile,
  resolveConflictFile,
  summarizeConflicts,
} from '../conflict-service';
import { base64Encode, buildAuthEnv, GitCredentialStore } from '../credentials';
import { detectStacksFromFiles, ensureEcSection, hasEcSection, listGitignoreTemplates, renderWorkspaceGitignore } from '../gitignore';
import { backupBranchName, isBackupBranch } from '../merge-service';
import { isValidBranchName, changeSourceLabel } from '../git-client';
import { GitLogger, redactSecrets, BIG_FILE_THRESHOLD_BYTES } from '../models';
import type { GitCommit } from '../models';
import type { SecureNamespace, ShellHost } from '@ec/shell-api';

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

function commit(partial: Partial<GitCommit> & { sha: string; parents?: string[] }): GitCommit {
  return {
    sha: partial.sha,
    shortSha: partial.sha.slice(0, 7),
    subject: partial.subject ?? 'feat: 初始提交',
    body: partial.body ?? '',
    authorName: partial.authorName ?? '小吴',
    authorEmail: partial.authorEmail ?? 'wu@ec.local',
    authoredAt: partial.authoredAt ?? 1_700_000_000_000,
    parents: partial.parents ?? [],
    refs: partial.refs ?? [],
  };
}

/** 内存密钥环的假外壳（组件/领域测试绝不允许碰真实 DPAPI） */
function fakeShell(): ShellHost {
  const store = new Map<string, string>();
  const key = (namespace: SecureNamespace, name: string): string => `${namespace}/${name}`;
  return {
    kind: 'mock',
    secureStore: {
      async set(namespace: SecureNamespace, name: string, value: string) {
        store.set(key(namespace, name), value);
      },
      async get(namespace: SecureNamespace, name: string) {
        return store.get(key(namespace, name)) ?? null;
      },
      async delete(namespace: SecureNamespace, name: string) {
        store.delete(key(namespace, name));
      },
      async has(namespace: SecureNamespace, name: string) {
        return store.has(key(namespace, name));
      },
      async listKeys(namespace: SecureNamespace) {
        return [...store.keys()].filter((entry) => entry.startsWith(`${namespace}/`)).map((entry) => entry.slice(namespace.length + 1));
      },
    },
  } as unknown as ShellHost;
}

/** 记录所有调用的假 runner（用于后端选择测试） */
function recordingRunner(result: Partial<GitRunResult> = {}): { runner: GitProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitProcessRunner = {
    async run(args) {
      calls.push([...args]);
      return { args: [...args], stdout: result.stdout ?? 'git version 2.55.0.windows.5', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 };
    },
  };
  return { runner, calls };
}

/* -------------------------------------------------------------------------- */
/* 解析：porcelain / name-status / log / branch / blame                        */
/* -------------------------------------------------------------------------- */

describe('git 解析器', () => {
  it('porcelain -z 解析重命名：首字段是新路径、次字段是旧路径（已实测 git 输出格式）', () => {
    const raw = 'R  改名后.txt\u0000中文文件名.txt\u0000';
    const entries = parsePorcelainZ(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('改名后.txt');
    expect(entries[0]?.oldPath).toBe('中文文件名.txt');
    expect(entries[0]?.status).toBe('renamed');
    expect(entries[0]?.staged).toBe(true);
  });

  it('porcelain -z 解析多状态：未跟踪 / 已修改 / 已删除 / 冲突', () => {
    const raw = ['?? 新文件.ts', ' M 已改.ts', 'D  已删.ts', 'UU 冲突.ts'].join('\u0000') + '\u0000';
    const entries = parsePorcelainZ(raw);
    expect(entries.map((entry) => entry.status)).toEqual(['untracked', 'modified', 'deleted', 'conflicted']);
    expect(entries.map((entry) => entry.staged)).toEqual([false, false, true, true]);
  });

  it('classifyStatus 覆盖空位与未知组合', () => {
    expect(classifyStatus('?', '?')).toBe('untracked');
    expect(classifyStatus('A', ' ')).toBe('added');
    expect(classifyStatus(' ', 'M')).toBe('modified');
    expect(classifyStatus('T', ' ')).toBe('typechange');
    expect(classifyStatus('C', ' ')).toBe('copied');
  });

  it('name-status -z 解析（含相似度后缀与重命名三字段）', () => {
    const raw = 'R075\u0000my file.txt\u0000改 名.txt\u0000M\u0000src/app.ts\u0000A\u0000新增.md\u0000D\u0000旧.txt\u0000';
    const entries = parseNameStatusZ(raw);
    expect(entries).toEqual([
      { path: '改 名.txt', oldPath: 'my file.txt', status: 'renamed' },
      { path: 'src/app.ts', oldPath: null, status: 'modified' },
      { path: '新增.md', oldPath: null, status: 'added' },
      { path: '旧.txt', oldPath: null, status: 'deleted' },
    ]);
  });

  it('log 解析：多记录、多父提交、ref 标记、空 body', () => {
    const sep = '\u001f';
    const raw =
      [
        ['a'.repeat(40), 'aaaaaaa', 'feat(login): 新增登录页', '说明一\n说明二', '小吴', 'wu@ec.local', '1700000200', `${'b'.repeat(40)} ${'c'.repeat(40)}`, 'HEAD -> main, tag: v1'].join(sep),
        ['b'.repeat(40), 'bbbbbbb', 'fix: 修复超时', '', '主人', 'zr@ec.local', '1700000100', '', ''].join(sep),
      ].join('\u001e') + '\u001e';
    const commits = parseLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ subject: 'feat(login): 新增登录页', parents: ['b'.repeat(40), 'c'.repeat(40)] });
    expect(commits[0]?.refs).toEqual(['HEAD -> main', 'tag: v1']);
    expect(commits[0]?.authoredAt).toBe(1_700_000_200_000);
    expect(commits[1]?.parents).toEqual([]);
    expect(commits[1]?.body).toBe('');
  });

  it('splitRecords 清理记录边界的换行（git 会在每条记录后补 \\n，回归用例）', () => {
    const raw = 'aaa\u001f \u001f\u001f\u001f\u001fsubject A\u001e\nmain\u001f*\u001f\u001f\u001f\u001fsubject B\u001e\n';
    const records = splitRecords(raw);
    expect(records).toHaveLength(2);
    expect(records[0]?.startsWith('aaa')).toBe(true);
    expect(records[1]?.startsWith('main')).toBe(true);
    expect(records[1]?.startsWith('\n')).toBe(false);
    const branches = parseBranches(raw);
    expect(branches.map((branch) => branch.name)).toEqual(['aaa', 'main']);
    expect(branches[1]?.current).toBe(true);
  });

  it('branch 解析：ahead / behind / gone 三态', () => {    const sep = '\u001f';
    const raw =
      [
        ['main', '*', 'origin/main', '[ahead 2, behind 1]', 'f'.repeat(40), 'feat: 主分支'].join(sep),
        ['feat/x', ' ', 'origin/feat/x', '[gone]', 'e'.repeat(40), 'fix: 修复'].join(sep),
        ['local-only', ' ', '', '', 'd'.repeat(40), ''].join(sep),
      ].join('\u001e') + '\u001e';
    const branches = parseBranches(raw);
    expect(branches[0]).toMatchObject({ name: 'main', current: true, ahead: 2, behind: 1, gone: false });
    expect(branches[1]).toMatchObject({ name: 'feat/x', gone: true, upstream: 'origin/feat/x' });
    expect(branches[2]).toMatchObject({ name: 'local-only', upstream: null, lastCommitSubject: null });
  });

  it('stash subject 两种形态都能拆出分支与说明', () => {
    expect(parseStashSubject('WIP on main: a1b2c3d feat: x')).toEqual({ branch: 'main', message: 'feat: x' });
    expect(parseStashSubject('On feat/login: 登录页改到一半')).toEqual({ branch: 'feat/login', message: '登录页改到一半' });
    expect(parseStashSubject('莫名其妙的说明')).toEqual({ branch: '', message: '莫名其妙的说明' });
  });

  it('blame --line-porcelain 解析出行号 / sha / 作者 / 时间', () => {
    const raw = [
      'a'.repeat(40) + ' 1 1 1',
      'author 小吴',
      'author-time 1700000000',
      '\t第一行代码',
      'b'.repeat(40) + ' 2 2 1',
      'author 主人',
      'author-time 1700000300',
      '\t第二行代码',
    ].join('\n');
    const lines = parseBlame(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line: 1, authorName: '小吴', text: '第一行代码' });
    expect(lines[1]?.authoredAt).toBe(1_700_000_300_000);
  });

  it('远程 URL 分类：https / ssh / 本地路径', () => {
    expect(classifyRemoteUrl('https://github.com/a/b.git')).toBe('https');
    expect(classifyRemoteUrl('git@github.com:a/b.git')).toBe('ssh');
    expect(classifyRemoteUrl('ssh://git@host:22/a.git')).toBe('ssh');
    expect(classifyRemoteUrl('D:\\repo\\remote.git')).toBe('local');
    expect(classifyRemoteUrl('/tmp/remote.git')).toBe('local');
  });
});

/* -------------------------------------------------------------------------- */
/* diff 解析                                                                   */
/* -------------------------------------------------------------------------- */

const SAMPLE_PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,6 @@
 import x from 'x';
 
-const a = 1;
+const a = 2;
+const b = 3;
 export default a;
 export const t = true;
 
@@ -20,3 +21,3 @@ function tail() {
   return 1;
-  return 2;
+  return 3;
 }
diff --git a/logo.png b/logo.png
index 3333333..4444444 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/old.md b/new.md
similarity index 90%
rename from old.md
rename to new.md
--- a/old.md
+++ b/new.md
@@ -1 +1 @@
-旧
+新
`;

describe('diff 解析', () => {
  it('解析文件级与 hunk 级结构，统计增删行', () => {
    const entries = [
      { path: 'src/app.ts', oldPath: null, status: 'modified' as const },
      { path: 'logo.png', oldPath: null, status: 'modified' as const },
      { path: 'new.md', oldPath: 'old.md', status: 'renamed' as const },
    ];
    const parsed = parseUnifiedDiff(SAMPLE_PATCH, { entries });
    expect(parsed.files).toHaveLength(3);
    expect(parsed.files[0]?.hunks).toHaveLength(2);
    // hunk1：-1 / +2；hunk2：-1 / +1；new.md：-1 / +1
    expect(parsed.files[0]?.additions).toBe(3);
    expect(parsed.files[0]?.deletions).toBe(2);
    expect(parsed.additions).toBe(4);
    expect(parsed.deletions).toBe(3);
  });

  it('二进制文件跳过内容并给出中文提示', () => {
    const parsed = parseUnifiedDiff(SAMPLE_PATCH, {
      entries: [
        { path: 'src/app.ts', oldPath: null, status: 'modified' },
        { path: 'logo.png', oldPath: null, status: 'modified' },
        { path: 'new.md', oldPath: 'old.md', status: 'renamed' },
      ],
    });
    const binary = parsed.files.find((file) => file.path === 'logo.png');
    expect(binary?.binary).toBe(true);
    expect(binary?.skipped).toBe(true);
    expect(binary?.skipReason).toContain('二进制');
    expect(parsed.skippedFiles).toBe(1);
  });

  it('重命名文件用权威清单里的 oldPath，且从 git 头也能兜底解析', () => {
    const withEntries = parseUnifiedDiff(SAMPLE_PATCH, {
      entries: [
        { path: 'src/app.ts', oldPath: null, status: 'modified' },
        { path: 'logo.png', oldPath: null, status: 'modified' },
        { path: 'new.md', oldPath: 'old.md', status: 'renamed' },
      ],
    });
    expect(withEntries.files[2]?.status).toBe('renamed');
    expect(withEntries.files[2]?.oldPath).toBe('old.md');

    const noEntries = parseUnifiedDiff(SAMPLE_PATCH);
    expect(noEntries.files[2]?.status).toBe('renamed');
    expect(noEntries.files[2]?.path).toBe('new.md');
    expect(noEntries.files[2]?.oldPath).toBe('old.md');
  });

  it('>1MB 文件跳过内容对比并给出体积提示', () => {
    const parsed = parseUnifiedDiff(SAMPLE_PATCH, {
      entries: [
        { path: 'src/app.ts', oldPath: null, status: 'modified' },
        { path: 'logo.png', oldPath: null, status: 'modified' },
        { path: 'new.md', oldPath: 'old.md', status: 'renamed' },
      ],
      sizes: { 'src/app.ts': BIG_FILE_THRESHOLD_BYTES + 1 },
    });
    const big = parsed.files.find((file) => file.path === 'src/app.ts');
    expect(big?.skipped).toBe(true);
    expect(big?.hunks).toHaveLength(0);
    expect(big?.skipReason).toContain('1.0 MB');
    expect(big?.skipReason).toContain('已跳过内容差异');
    expect(parsed.skippedFiles).toBe(2);
  });

  it('hunk 头解析：单行 hunk（无逗号）与 section 文本', () => {
    expect(parseHunkHeader('@@ -1 +1 @@')).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, section: null });
    expect(parseHunkHeader('@@ -20,3 +21,3 @@ function tail() {')).toMatchObject({ oldStart: 20, oldLines: 3, section: 'function tail() {' });
  });

  it('并排对齐：连续删改配成 replace，数量不等时一侧为 null，行号严格对齐', () => {
    const parsed = parseUnifiedDiff(SAMPLE_PATCH, {
      entries: [
        { path: 'src/app.ts', oldPath: null, status: 'modified' },
        { path: 'logo.png', oldPath: null, status: 'modified' },
        { path: 'new.md', oldPath: 'old.md', status: 'renamed' },
      ],
    });
    const rows = alignHunk(parsed.files[0]!.hunks[0]!);
    const replaced = rows.filter((row) => row.kind === 'replace');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.left?.text).toBe('const a = 1;');
    expect(replaced[0]?.right?.text).toBe('const a = 2;');
    const extra = rows.filter((row) => row.kind === 'add');
    expect(extra).toHaveLength(1);
    expect(extra[0]?.left).toBeNull();
    expect(extra[0]?.right?.text).toBe('const b = 3;');
  });

  it('折叠未修改区域：长上下文折成一条 count 提示', () => {
    const hunk = {
      index: 1,
      header: '@@ -1,30 +1,30 @@',
      oldStart: 1,
      oldLines: 30,
      newStart: 1,
      newLines: 30,
      section: null,
      lines: [
        ...Array.from({ length: 20 }, (_, i) => ({ kind: 'context' as const, text: `line ${i}`, oldNumber: i + 1, newNumber: i + 1 })),
        { kind: 'add' as const, text: '新增', oldNumber: null, newNumber: 21 },
      ],
    };
    const rows = alignHunk(hunk);
    const folded = foldAlignedRows(rows, 3);
    const fold = folded.find((row) => row.kind === 'fold');
    expect(fold).toBeDefined();
    expect(fold?.kind === 'fold' ? fold.count : 0).toBe(20 - 6);
    // 3（保留头部）+ 1（折叠提示）+ 3（保留尾部）+ 1（新增行）
    expect(folded).toHaveLength(8);
  });

  it('brief 摘要与体积格式化文案都是中文', () => {
    const parsed = parseUnifiedDiff(SAMPLE_PATCH);
    expect(summarizeDiff(parsed)).toContain('个文件');
    expect(summarizeDiff({ files: [], additions: 0, deletions: 0, skippedFiles: 0 })).toBe('没有文件变更');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB');
  });

  it('语法高亮按扩展名映射', () => {
    expect(languageFromPath('a/b.ts')).toBe('typescript');
    expect(languageFromPath('a/b.tsx')).toBe('tsx');
    expect(languageFromPath('x/y.ets')).toBe('arkts');
    expect(languageFromPath('Makefile')).toBe('plaintext');
  });

  it('hunk 勾选后可组装成可应用 patch（含新增/删除/重命名头部）', () => {
    const parsed = parseUnifiedDiff(SAMPLE_PATCH, {
      entries: [
        { path: 'src/app.ts', oldPath: null, status: 'modified' },
        { path: 'logo.png', oldPath: null, status: 'modified' },
        { path: 'new.md', oldPath: 'old.md', status: 'renamed' },
      ],
    });
    const patch = buildHunkPatch(parsed.files[0]!, [2]);
    expect(patch).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(patch).toContain('@@ -20,3 +21,3 @@');
    expect(patch).not.toContain('@@ -1,5 +1,6 @@');
    expect(buildHunkPatch(parsed.files[0]!, [])).toBe('');
    const renamed = buildHunkPatch(parsed.files[2]!, [1]);
    expect(renamed).toContain('rename from old.md');
    expect(renamed).toContain('rename to new.md');
  });
});

/* -------------------------------------------------------------------------- */
/* 提交信息                                                                    */
/* -------------------------------------------------------------------------- */

describe('提交信息（Conventional Commits）', () => {
  it('解析带 scope / breaking / footer 的提交信息', () => {
    const message = parseCommitMessage('feat(login)!: 新增登录\n\n正文一\n\nBREAKING CHANGE: 接口签名变更\nRefs: #12');
    expect(message).toMatchObject({ type: 'feat', scope: 'login', subject: '新增登录', breaking: true });
    expect(message?.body).toBe('正文一');
    expect(message?.footer).toContain('BREAKING CHANGE: 接口签名变更');
  });

  it('校验：非法 type / 非法 scope / 缺 subject 都报错，长 subject 与缺 body 只给警告', () => {
    expect(validateCommitMessage('添加登录页').valid).toBe(false);
    expect(validateCommitMessage('add: 登录页').errors.join()).toContain('type「add」');
    expect(validateCommitMessage('feat(登录页): x').errors.join()).toContain('scope');
    const long = validateCommitMessage(`feat: ${'x'.repeat(90)}`);
    expect(long.valid).toBe(true);
    expect(long.warnings.join()).toContain('subject 超过');
    expect(validateCommitMessage('feat: 登录页').warnings.join()).toContain('body');
  });

  it('格式化与构造：来源标记写进 body', () => {
    const text = createCommitMessage({ type: 'feat', scope: 'login', subject: '新增登录页', body: '按设计稿实现', sources: ['生成节点 node-7'] });
    expect(text.split('\n')[0]).toBe('feat(login): 新增登录页');
    expect(text).toContain('来源：生成节点 node-7');
    expect(formatCommitMessage(parseCommitMessage(text)!)).toBe(text);
  });

  it('AI 输出清洗：代码围栏 / 解释文字 / 非法 type / 无头部兜底', () => {
    const fenced = normalizeAiCommitMessage('好的，这是提交信息：\n```\nfeat(login): 新增登录页\n\n实现了表单校验\n```\n希望有帮助！');
    expect(fenced.text.split('\n')[0]).toBe('feat(login): 新增登录页');
    expect(fenced.text).toContain('实现了表单校验');
    expect(fenced.adjustments).toEqual([]);

    const mapped = normalizeAiCommitMessage('update: 修复登出超时');
    expect(mapped.message.type).toBe('fix');
    expect(mapped.adjustments.join()).toContain('不在白名单');

    const fallback = normalizeAiCommitMessage('随手的说明，没有任何头部', { fallbackSubject: '更新生成产物' });
    expect(fallback.message.type).toBe('chore');
    expect(fallback.text).toContain('更新生成产物');
    expect(fallback.adjustments.join()).toContain('兜底');
  });

  it('自动提交策略：默认关闭，按阶段 / 按节点各自生效', () => {
    expect(AUTO_COMMIT_TRIGGER_LABELS.off).toContain('默认');
    expect(shouldAutoCommit({ trigger: 'off', convention: 'angular' }, 'stage')).toBe(false);
    expect(shouldAutoCommit({ trigger: 'per-stage', convention: 'angular' }, 'stage')).toBe(true);
    expect(shouldAutoCommit({ trigger: 'per-stage', convention: 'angular' }, 'node')).toBe(false);
    expect(shouldAutoCommit({ trigger: 'per-node', convention: 'angular' }, 'node')).toBe(true);
  });

  it('自动提交信息带生成节点来源标记且符合规范', () => {
    const text = buildAutoCommitMessage({
      policy: { trigger: 'per-stage', convention: 'angular' },
      kind: 'stage',
      ref: 'node-12',
      displayName: '登录页',
      scope: 'login',
      fileCount: 4,
    });
    expect(text.split('\n')[0]).toBe('feat(login): 完成阶段产物 登录页');
    expect(text).toContain('生成节点 node-12');
    expect(validateCommitMessage(text).valid).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 分支图                                                                      */
/* -------------------------------------------------------------------------- */

describe('分支树与提交图', () => {
  const branches = [
    { name: 'main', current: true, upstream: null, ahead: 0, behind: 0, lastCommitSha: 'm1', lastCommitSubject: 'x', gone: false },
    { name: 'feat/login', current: false, upstream: null, ahead: 0, behind: 0, lastCommitSha: 'f1', lastCommitSubject: 'y', gone: false },
    { name: 'feat/pay', current: false, upstream: null, ahead: 0, behind: 0, lastCommitSha: 'p1', lastCommitSubject: 'z', gone: false },
  ];

  it('按 / 分层构建分支树，叶子节点挂真实分支信息', () => {
    const tree = buildBranchTree(branches);
    const feat = tree.find((node) => node.name === 'feat');
    expect(feat).toBeDefined();
    expect(feat?.children.map((child) => child.label)).toEqual(['login', 'pay']);
    expect(feat?.children[0]?.branch?.lastCommitSha).toBe('f1');
    expect(tree.find((node) => node.name === 'main')?.branch?.current).toBe(true);
  });

  it('提交图标出分叉点与合并点，泳道数正确，父边指向父提交所在泳道', () => {
    const commits = [
      commit({ sha: 'm3', subject: 'merge feat', parents: ['m2', 'f2'] }),
      commit({ sha: 'f2', subject: 'feat 改', parents: ['f1'] }),
      commit({ sha: 'f1', subject: 'feat 起', parents: ['m1'] }),
      commit({ sha: 'm2', subject: 'main 改', parents: ['m1'] }),
      commit({ sha: 'm1', subject: '初始', parents: [] }),
    ];
    const graph = buildBranchGraph({ commits, branches, headSha: 'm3' });
    expect(graph.nodes).toHaveLength(5);
    expect(graph.merges).toEqual(['m3']);
    expect(graph.lanes).toBeGreaterThanOrEqual(2);
    const merge = graph.nodes.find((node) => node.sha === 'm3');
    expect(merge?.isMerge).toBe(true);
    expect(merge?.parents.map((parent) => parent.sha)).toEqual(['m2', 'f2']);
    expect(merge?.parents[0]?.lane).toBe(merge?.lane);
    const root = graph.nodes.find((node) => node.sha === 'm1');
    expect(root?.parents).toEqual([]);
    expect(graph.nodes.find((node) => node.sha === 'm3')?.isHead).toBe(true);
  });

  it('分支名会挂到对应提交上，tag 也会标记', () => {
    const commits = [commit({ sha: 'm1', refs: ['HEAD -> main', 'tag: v1.0.0'] }), commit({ sha: 'f1', parents: ['m1'] })];
    const graph = buildBranchGraph({ commits, branches, tags: [{ name: 'v1.0.0', sha: 'm1' }], headSha: 'm1' });
    expect(graph.nodes.find((node) => node.sha === 'm1')?.branches).toContain('main');
    expect(graph.nodes.find((node) => node.sha === 'm1')?.tags).toContain('v1.0.0');
    expect(graph.nodes.find((node) => node.sha === 'f1')?.branches).toContain('feat/login');
  });
});

/* -------------------------------------------------------------------------- */
/* 历史过滤                                                                    */
/* -------------------------------------------------------------------------- */

describe('历史过滤', () => {
  const commits = [
    commit({ sha: 'a', subject: 'feat: 新增登录页', body: '表单校验', authorName: '小吴', authorEmail: 'wu@ec.local', authoredAt: 1_700_000_200_000 }),
    commit({ sha: 'b', subject: 'fix: 修复超时', authorName: '主人', authorEmail: 'zr@ec.local', authoredAt: 1_700_000_100_000 }),
  ];

  it('按关键词 / 作者 / 时间范围过滤，且能搜 body', () => {
    expect(filterCommits(commits, { keyword: '表单' }).map((item) => item.sha)).toEqual(['a']);
    expect(filterCommits(commits, { author: 'zr@' }).map((item) => item.sha)).toEqual(['b']);
    expect(filterCommits(commits, { keyword: 'FEAT' }).map((item) => item.sha)).toEqual(['a']);
    expect(filterCommits(commits, { since: 1_700_000_150_000 }).map((item) => item.sha)).toEqual(['a']);
    expect(filterCommits(commits, { until: 1_700_000_150_000 }).map((item) => item.sha)).toEqual(['b']);
    expect(matchesQuery(commits[0]!, {})).toBe(true);
  });

  it('路径过滤不参与本地筛选（避免把结果筛空，路径条件由 git 侧执行）', () => {
    expect(filterCommits(commits, { path: 'src/app.ts' })).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 冲突解析                                                                    */
/* -------------------------------------------------------------------------- */

describe('冲突解析与解决', () => {
  const MERGE_STYLE = ['before', '<<<<<<< HEAD', 'const a = 1;', '=======', 'const a = 2;', '>>>>>>> feat/x', 'after'].join('\n');
  const DIFF3_STYLE = ['<<<<<<< HEAD', 'ours', '||||||| base', 'base', '=======', 'theirs', '>>>>>>> feat/x'].join('\n');

  it('解析 merge 风格冲突块（含 ours/theirs 与起始行）', () => {
    const file = parseConflictFile(MERGE_STYLE, { path: 'a.ts' });
    expect(file.path).toBe('a.ts');
    expect(file.blocks).toHaveLength(1);
    expect(file.blocks[0]?.ours).toEqual(['const a = 1;']);
    expect(file.blocks[0]?.theirs).toEqual(['const a = 2;']);
    expect(file.blocks[0]?.base).toEqual([]);
    expect(file.blocks[0]?.startLine).toBe(2);
    expect(file.oursLabel).toContain('当前');
    expect(file.theirsLabel).toContain('传入');
  });

  it('解析 diff3 风格冲突块（多出基线一栏）', () => {
    const file = parseConflictFile(DIFF3_STYLE);
    expect(file.blocks[0]?.base).toEqual(['base']);
    expect(file.blocks[0]?.ours).toEqual(['ours']);
    expect(file.blocks[0]?.theirs).toEqual(['theirs']);
  });

  it('多冲突块按序编号，未闭合冲突能被识别', () => {
    const multi = [MERGE_STYLE, DIFF3_STYLE].join('\n');
    const file = parseConflictFile(multi);
    expect(file.blocks.map((block) => block.index)).toEqual([1, 2]);
    expect(hasUnterminatedConflict('<<<<<<< HEAD\nx')).toBe(true);
    expect(hasUnterminatedConflict(MERGE_STYLE)).toBe(false);
  });

  it('逐块选择：采用当前 / 传入 / 两侧都要 / 未解决保留标记', () => {
    const file = parseConflictFile([MERGE_STYLE, DIFF3_STYLE].join('\n'));
    const ours = resolveConflictFile(file, { 1: 'ours', 2: 'theirs' });
    expect(ours.unresolved).toBe(0);
    expect(ours.content).toContain('const a = 1;');
    expect(ours.content).not.toContain('<<<<<<<');

    const both = resolveConflictFile(file, { 1: 'both', 2: 'ours' });
    expect(both.content).toContain('const a = 1;');
    expect(both.content).toContain('const a = 2;');

    const partial = resolveConflictFile(file, { 1: 'ours' });
    expect(partial.unresolved).toBe(1);
    expect(partial.content).toContain('<<<<<<<');
  });

  it('冲突统计与「交给 AI 合并」载荷都带中文说明', () => {
    const file = parseConflictFile([MERGE_STYLE, DIFF3_STYLE].join('\n'), { path: 'src/a.ts' });
    const summary = summarizeConflicts([file]);
    expect(summary).toMatchObject({ files: 1, blocks: 2, unresolved: 2 });
    expect(summary.perFile[0]?.path).toBe('src/a.ts');

    const request = buildAiMergeRequest(file, file.blocks[0]!);
    expect(request.instruction).toContain('第 1 处冲突');
    expect(request.context).toContain('当前（HEAD）侧');
    expect(request.paths).toEqual(['src/a.ts']);
    const all = buildAiMergeRequest(file);
    expect(all.instruction).toContain('2 处冲突');
  });
});

/* -------------------------------------------------------------------------- */
/* 凭据                                                                       */
/* -------------------------------------------------------------------------- */

describe('凭据（DPAPI 密钥环 + 不进 argv）', () => {
  it('base64 纯实现正确（含中文与填充）', () => {
    expect(base64Encode('abc')).toBe('YWJj');
    expect(base64Encode('a')).toBe('YQ==');
    expect(base64Encode('ab')).toBe('YWI=');
    expect(base64Encode('user:token')).toBe('dXNlcjp0b2tlbg==');
  });

  it('HTTPS 凭据经环境变量注入（GIT_CONFIG_*），token 不出现在 argv', () => {
    const auth = buildAuthEnv({ kind: 'https', username: 'x-access-token', token: 'ghp_SECRET_TOKEN_123' });
    expect(auth.env['GIT_CONFIG_KEY_0']).toBe('http.extraHeader');
    expect(auth.env['GIT_CONFIG_VALUE_0']).toContain('Authorization: Basic ');
    expect(Object.values(auth.env).join(' ')).not.toContain('ghp_SECRET_TOKEN_123');
    expect(auth.secrets).toContain('ghp_SECRET_TOKEN_123');
    expect(auth.notes.join()).toContain('环境变量注入');
  });

  it('SSH 凭据用 GIT_SSH_COMMAND 指定 ed25519 私钥；带口令时提示需要 ssh-agent', () => {
    const plain = buildAuthEnv({ kind: 'ssh', privateKeyPath: 'C:/keys/id_ed25519', passphrase: null });
    expect(plain.env['GIT_SSH_COMMAND']).toContain('id_ed25519');
    expect(plain.env['GIT_SSH_COMMAND']).toContain('BatchMode=yes');

    const withPass = buildAuthEnv({ kind: 'ssh', privateKeyPath: 'C:/keys/id_ed25519', passphrase: 'p@ss' });
    expect(withPass.env['GIT_SSH_COMMAND']).not.toContain('BatchMode');
    expect(withPass.notes.join()).toContain('ssh-agent');
    expect(withPass.secrets).toContain('p@ss');
  });

  it('密钥环读写：listBindings 只返回元信息，绝不返回值', async () => {
    const store = new GitCredentialStore({ shell: fakeShell() });
    await store.setHttpsCredential({ remoteName: 'origin', username: 'x-access-token', token: 'ghp_SUPER_SECRET_VALUE' });
    expect(await store.kindOf('origin')).toBe('https');
    expect(await store.has('origin')).toBe(true);

    const credential = await store.get('origin');
    expect(credential).toEqual({ kind: 'https', username: 'x-access-token', token: 'ghp_SUPER_SECRET_VALUE' });

    const bindings = await store.listBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ remoteName: 'origin', kind: 'https', username: 'x-access-token' });
    expect(JSON.stringify(bindings)).not.toContain('ghp_SUPER_SECRET_VALUE');

    await store.setSshCredential({ remoteName: 'backup', privateKeyPath: 'C:/keys/id_ed25519' });
    expect(await store.kindOf('backup')).toBe('ssh');
    const ssh = await store.get('backup');
    expect(ssh).toEqual({ kind: 'ssh', privateKeyPath: 'C:/keys/id_ed25519', passphrase: null });

    await store.remove('origin');
    expect(await store.has('origin')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 日志脱敏                                                                    */
/* -------------------------------------------------------------------------- */

describe('结构化日志与脱敏', () => {
  it('登记的密文在 message 与 raw 里都被替换，但级别与时间戳保留', () => {
    const logger = new GitLogger({ clock: () => 1_700_000_000_000 });
    logger.registerSecret('CUSTOM_TOKEN_abcdefg');
    const entry = logger.info('推送完成', 'Authorization: CUSTOM_TOKEN_abcdefg\n其余输出');
    expect(entry.message).toBe('推送完成');
    expect(entry.raw).not.toContain('CUSTOM_TOKEN_abcdefg');
    expect(entry.raw).toContain('***');
    expect(entry.at).toBe(1_700_000_000_000);
    logger.unregisterSecret('CUSTOM_TOKEN_abcdefg');
    expect(logger.redact('CUSTOM_TOKEN_abcdefg')).toContain('CUSTOM_TOKEN_abcdefg');
  });

  it('内置脱敏规则覆盖 sk- 前缀令牌与邮箱', () => {
    const masked = redactSecrets('token=sk-abcdefghijklmnopqrstuvwxyz mail: 小吴@ec.local', []);
    expect(masked).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(masked).toContain('@ec.local');
  });

  it('日志滚动窗口按上限裁剪，drain 后清空', () => {
    const logger = new GitLogger({ max: 3, clock: () => 1 });
    for (let i = 0; i < 5; i += 1) logger.debug(`第 ${i} 条`);
    expect(logger.all()).toHaveLength(3);
    expect(logger.all()[0]?.message).toBe('第 2 条');
    expect(logger.drain()).toHaveLength(3);
    expect(logger.all()).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* .gitignore                                                                  */
/* -------------------------------------------------------------------------- */

describe('.gitignore 生成（复用 T0-11 模板）', () => {
  it('按技术栈组合渲染，包含 EveryoneCoding 固定忽略段', () => {
    const content = renderWorkspaceGitignore(['node', 'harmonyos-arkts']);
    expect(content).toContain('node_modules/');
    expect(content).toContain('.hvigor/');
    expect(content).toContain('oh_modules/');
    expect(hasEcSection(content)).toBe(true);
    expect(content).toContain('.ecpkg');
  });

  it('技术栈为空时退回 Node 模板；模板清单可用于设置页展示', () => {
    expect(renderWorkspaceGitignore([])).toContain('node_modules/');
    expect(listGitignoreTemplates().map((template) => template.id)).toContain('flutter');
  });

  it('ensureEcSection 幂等且不破坏原有规则', () => {
    const existing = '# 我自己的规则\nsecret.txt\n';
    const merged = ensureEcSection(existing);
    expect(merged).toContain('secret.txt');
    expect(hasEcSection(merged)).toBe(true);
    expect(ensureEcSection(merged)).toBe(merged);
  });

  it('按项目文件清单推测技术栈并给出证据', () => {
    const nt = detectStacksFromFiles(['package.json', 'src/app.ts']);
    expect(nt.stacks).toEqual(['node']);
    expect(nt.evidence.join()).toContain('Node.js');

    const hb = detectStacksFromFiles(['build-profile.json5', 'entry/src/main.ets']);
    expect(hb.stacks).toContain('harmonyos-arkts');

    const multi = detectStacksFromFiles(['pubspec.yaml', 'requirements.txt', 'go.mod', 'pom.xml']);
    expect(multi.stacks).toEqual(['flutter', 'go', 'java', 'python']);

    const empty = detectStacksFromFiles([]);
    expect(empty.stacks).toEqual(['node']);
    expect(empty.evidence.join()).toContain('未识别');
  });
});

/* -------------------------------------------------------------------------- */
/* 回滚 / 分支名 / 后端选择                                                    */
/* -------------------------------------------------------------------------- */

describe('回滚快照命名与校验', () => {
  it('备份分支名符合 backup/YYYYMMDD-HHMMSS 且可识别', () => {
    const name = backupBranchName(new Date(2026, 8, 12, 7, 30, 0).getTime());
    expect(name).toBe('backup/20260912-073000');
    expect(isBackupBranch(name)).toBe(true);
    expect(isBackupBranch('backup/latest')).toBe(false);
    expect(isBackupBranch('main')).toBe(false);
  });

  it('分支名合法性校验拦住明显非法输入', () => {
    expect(isValidBranchName('feat/login')).toBe(true);
    expect(isValidBranchName('-bad')).toBe(false);
    expect(isValidBranchName('bad name')).toBe(false);
    expect(isValidBranchName('bad..name')).toBe(false);
    expect(isValidBranchName('bad~name')).toBe(false);
    expect(isValidBranchName('ends/')).toBe(false);
    expect(isValidBranchName('')).toBe(false);
  });

  it('变更来源标签区分可跳转与不可跳转', () => {
    expect(changeSourceLabel({ kind: 'ai-task', ref: 'node-1', label: 'AI 生成', jumpable: true })).toBe('AI 生成');
    expect(changeSourceLabel({ kind: 'external', ref: null, label: '外部改动', jumpable: false })).toContain('不可跳转');
    expect(changeSourceLabel(null)).toBe('来源未知');
  });
});

describe('后端选择与回退（对上层透明）', () => {
  it('强制 CLI：只有一次探测，未加载 libgit2', async () => {
    const { runner, calls } = recordingRunner();
    let loaderCalled = false;
    const selection = await selectBackend({
      deps: { runner },
      preferred: 'cli',
      loadGit2: async () => {
        loaderCalled = true;
        return { binding: null, detail: '' };
      },
    });
    expect(selection.used).toBe('cli');
    expect(loaderCalled).toBe(false);
    expect(selection.notes.join()).toContain('系统 Git CLI');
    expect(calls[0]?.join(' ')).toContain('--version');
  });

  it('git2 绑定不可用 → 自动回退 CLI 并如实记录原因', async () => {
    const { runner } = recordingRunner();
    const selection = await selectBackend({
      deps: { runner },
      preferred: 'git2',
      loadGit2: async () => ({ binding: null, detail: '未安装 libgit2 绑定，将使用系统 Git CLI：Cannot find module nodegit' }),
    });
    expect(selection.used).toBe('cli');
    expect(selection.notes.join()).toContain('已自动回退系统 Git CLI');
    expect(selection.notes.join()).toContain('Cannot find module nodegit');
  });

  it('git2 绑定可用 → 走原生；原生失败 → 记原因并回退 CLI（不静默）', async () => {
    const { runner } = recordingRunner({ stdout: '' });
    const cli = createCliGitBackend({ runner });
    const git2 = createGit2Backend({
      fallback: cli,
      load: async () => ({
        binding: {
          name: 'fake-binding',
          async init() {
            throw new Error('原生 init 未实现');
          },
          async isRepo() {
            return true;
          },
          async currentBranch() {
            return 'main';
          },
          async headSha() {
            return null;
          },
          async status() {
            return [{ path: 'a.ts', oldPath: null, index: '?', worktree: '?', status: 'untracked' as const, staged: false }];
          },
          async add() {},
          async commit() {
            return 'deadbeef';
          },
          async log() {
            return [];
          },
          async diff() {
            return '';
          },
        },
        detail: '已加载假绑定（测试用）',
      }),
    });
    const backend: GitBackend = git2;
    expect(await backend.probe()).toBe(true);

    // 原生成功路径
    const status = await backend.status('C:/tmp');
    expect(status).toHaveLength(1);
    expect(git2.nativeCallCount).toBe(1);

    // 原生失败路径：抛错 → 回退 CLI（此处 CLI 的 runner 返回空输出，视为成功）
    await backend.init('C:/tmp', { branch: 'main' });
    expect(git2.fallbackCallCount).toBeGreaterThan(0);
    expect(git2.drainNotes().join()).toContain('原生 init 未实现');
  });
});
