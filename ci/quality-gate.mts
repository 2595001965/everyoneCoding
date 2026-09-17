/**
 * 质量门禁编排器（T10-03 / §10.2）：逐核心模块跑覆盖率并按 ≥70% 阈值判定。
 *
 * 用法：node --experimental-strip-types ci/quality-gate.mts
 *
 * 判定机制：vitest 内建 coverage thresholds（--coverage.thresholds.lines=70），
 * 低于阈值 vitest 退出码非 0 —— 不依赖任何报告文件解析。
 * 本脚本只负责逐模块编排、从 stdout 抓取 "All files" 那一行的**行覆盖率列**（供报告展示）。
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const THRESHOLD = 70;

/**
 * 单个模块的超时（毫秒）。
 *
 * 为什么给到 30 分钟：插桩覆盖率会让重型模块显著变慢 —— `packages/memory`（含 1000 条检索基准）
 * 与 `packages/git`（含真实 git 子进程的集成测试）在本机（Windows + 实时杀毒扫描，
 * `git --version` ≈18s/次）单模块就可能超过 10 分钟。被超时砍掉时 vitest 不会打印汇总表，
 * 旧版脚本把"没解析到"误报成 `0.00%`（看起来像覆盖率崩塌，实为环境超时）。
 */
const MODULE_TIMEOUT_MS = 30 * 60 * 1000;

/** 六个核心模块（任务卡 T10-03） */
const MODULES: Array<{ name: string; testGlob: string; include: string }> = [
  { name: '记忆系统（packages/memory）', testGlob: 'packages/memory', include: 'packages/memory/src/**' },
  { name: '上下文引擎（packages/ai/src/context）', testGlob: 'packages/ai/src/context', include: 'packages/ai/src/context/**' },
  { name: 'Git 封装（packages/git）', testGlob: 'packages/git', include: 'packages/git/src/**' },
  { name: 'Provider 适配（packages/ai/src/adapters）', testGlob: 'packages/ai/src/adapters', include: 'packages/ai/src/adapters/**' },
  { name: '统一标识注册表与重命名引擎（packages/registry）', testGlob: 'packages/registry', include: 'packages/registry/src/**' },
  { name: '归档读写（packages/package-kit）', testGlob: 'packages/package-kit', include: 'packages/package-kit/src/**' },
];

interface ModuleResult {
  name: string;
  /** 行覆盖率（text reporter 第 4 列），未取到为 null */
  lines: number | null;
  /** 语句覆盖率（第 1 列） */
  stmts: number | null;
  ok: boolean;
  /** 子进程退出码（null = 被超时终止） */
  status: number | null;
  elapsedMs: number;
}

function runModule(module: (typeof MODULES)[number]): ModuleResult {
  const args = [
    'run',
    module.testGlob,
    '--coverage',
    `--coverage.include=${module.include}`,
    '--coverage.exclude=**/__tests__/**',
    '--coverage.exclude=**/*.test.*',
    '--coverage.exclude=**/index.ts',
    `--coverage.thresholds.lines=${THRESHOLD}`,
    '--coverage.thresholds.statements=0',
    '--coverage.thresholds.branches=0',
    '--coverage.thresholds.functions=0',
    '--coverage.reporter=text',
    '--reporter=basic',
  ];
  const started = Date.now();
  const proc = spawnSync(process.execPath, [vitestBin, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: MODULE_TIMEOUT_MS,
  });
  const elapsedMs = Date.now() - started;
  const out = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
  // text reporter 的汇总行形如：
  //   | All files | 90.78 | 82.55 | 84.61 | 90.78 |
  //   列序 = % Stmts, % Branch, % Funcs, % Lines
  // 早前版本只取了第 1 个数字（% Stmts）却当作"行覆盖率"展示，这里按列序取准。
  const row = [...out.matchAll(/All files\s*\|([^\n]*)/g)].pop();
  const cells = row ? [...(row[1] ?? '').matchAll(/([\d.]+)/g)].map((m) => Number(m[1])) : [];
  return {
    name: module.name,
    lines: cells[3] ?? null,
    stmts: cells[0] ?? null,
    ok: proc.status === 0,
    status: proc.status,
    elapsedMs,
  };
}

function main(): void {
  console.log('质量门禁：六核心模块行覆盖率 ≥' + THRESHOLD + '%\n');
  let allPassed = true;
  for (const module of MODULES) {
    const result = runModule(module);
    const verdict = result.ok ? 'PASS' : 'FAIL';
    if (!result.ok) allPassed = false;
    const seconds = (result.elapsedMs / 1000).toFixed(1);
    const text =
      result.lines === null
        ? `未取到覆盖率数据（${result.status === null ? '超时被终止' : `退出码 ${result.status}`}）`
        : `${result.lines.toFixed(2)}% 行 / ${(result.stmts ?? 0).toFixed(2)}% 语句`;
    console.log(`  ${verdict}  ${text}  ${result.name}  [${seconds}s]`);
  }
  console.log('');
  if (!allPassed) {
    console.error('质量门禁未通过：存在模块覆盖率低于阈值或测试失败');
    process.exit(1);
  }
  console.log('质量门禁通过：六核心模块全部达标');
}

main();
