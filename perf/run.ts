/**
 * 性能基准编排器（T10-02）：一键运行全部可复现基准并汇总结果。
 *
 * 用法（仓库根）：
 *   node perf/run.ts               # 跑全部基准，输出汇总表
 *   node perf/run.ts memory-search  # 只跑名字匹配的基准
 *
 * 各基准定义在 BENCHMARKS 表里：一条 = 一个可复现的测量 + 预算 + 出处。
 * 测量本身复用各包已有的基准用例（vitest -t 名字过滤），保证与 CI 同源。
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

/** 一条基准：目标测试 + 用例名过滤 + NFR 预算与编号 */
interface BenchDef {
  /** 汇总表里的指标名 */
  name: string;
  /** vitest 跑哪个测试文件（相对仓库根） */
  testFile: string;
  /** -t 过滤（用例标题的稳定前缀） */
  filter: string;
  /** NFR 预算（人类可读，报告用） */
  budget: string;
}

export const BENCHMARKS: BenchDef[] = [
  {
    name: 'NFR-P-03 记忆检索（1000 条双路召回）',
    testFile: 'packages/memory/src/search/__tests__/benchmark.test.ts',
    filter: '1000 条记忆下端到端检索',
    budget: '≤200ms（冷启动；热路径更低）',
  },
  {
    name: 'NFR-P-04 上下文组装（1000 条记忆场景）',
    testFile: 'packages/ai/src/context/__tests__/context-engine.test.ts',
    filter: '1000 条记忆场景组装',
    budget: '≤300ms（p95）',
  },
  {
    name: 'NFR-P-06 重命名索引 + 影响面（1 万行）',
    testFile: 'packages/registry/src/__tests__/occurrence.test.ts',
    filter: '1 万行工程索引构建',
    budget: '≤1.5s（按机器吞吐归一化）',
  },
  {
    name: 'NFR-P-07 重命名事务（200 处变更）',
    testFile: 'packages/registry/src/__tests__/rename-transaction.test.ts',
    filter: '200 处',
    budget: '≤5s',
  },
  {
    name: 'NFR-P-08 .ecpkg 导出（1 万文件 × 30KB）',
    testFile: 'packages/package-kit/src/__tests__/export-performance.test.ts',
    filter: '写入 10 000',
    budget: '≤60s',
  },
  {
    name: 'NFR-P-08 .ecpkg 容器读写 + 校验（1 万条目）',
    testFile: 'packages/package-kit/src/__tests__/performance.test.ts',
    filter: '1 万条目',
    budget: '容器层无界内存（RSS 增长 ≤350MB）',
  },
  {
    name: 'NFR-P-02 画布 500 元素（拖拽几何 + 重渲染节点数）',
    testFile: 'packages/designer/src/canvas/__tests__/benchmark.test.tsx',
    filter: '500 元素',
    budget: '单帧几何 ≤16.6ms；交互增量重渲染',
  },
];

interface BenchResult {
  def: BenchDef;
  ok: boolean;
  /** 毫秒（从 stdout 提取；无法提取时为 null） */
  ms: number | null;
  /** 基准用例自己的原始输出行 */
  evidence: string[];
  exitCode: number | null;
}

function runOne(def: BenchDef, extraFilter?: string): BenchResult {
  const args = ['run', def.testFile, '-t', extraFilter ?? def.filter, '--reporter=basic'];
  const proc = spawnSync(process.execPath, [vitestBin, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  const out = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
  const evidence: string[] = [];
  const msPattern = /\[([^\]]+)\][^\n]*?(\d+(?:\.\d+)?)\s*ms[^\n]*/g;
  let ms: number | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (/\[[^\]]*(实测|bench|性能|基准)[^\]]*\]|ms（|ms/.test(line) && line.trim().length > 0) {
      if (evidence.length < 8) evidence.push(line.trim());
    }
  }
  const matches = [...out.matchAll(msPattern)];
  if (matches.length > 0) {
    ms = Number(matches[0]![2]);
  }
  return { def, ok: proc.status === 0, ms, evidence, exitCode: proc.status };
}

function main(): void {
  const filterArg = process.argv[2];
  const selected = filterArg ? BENCHMARKS.filter((b) => b.name.includes(filterArg)) : BENCHMARKS;
  if (selected.length === 0) {
    console.error(`没有匹配 "${filterArg}" 的基准。可用：\n${BENCHMARKS.map((b) => `  - ${b.name}`).join('\n')}`);
    process.exit(1);
  }

  console.log(`EveryoneCoding 性能基准（${selected.length} 项）\n机器：${process.platform} ${process.arch} / Node ${process.version}\n`);
  const results: BenchResult[] = [];
  for (const def of selected) {
    console.log(`▶ ${def.name}（预算 ${def.budget}）`);
    const result = runOne(def);
    results.push(result);
    const msText = result.ms === null ? '—' : `${result.ms}ms`;
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  耗时 ${msText}  (exit=${result.exitCode})`);
    for (const line of result.evidence.slice(0, 3)) console.log(`    | ${line}`);
    console.log('');
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`汇总：${pass}/${results.length} 项基准用例全绿`);
  const machineInfo = `${process.platform}/${process.arch} Node ${process.version}`;
  const summary = [
    `<!-- PERF-DATA 自动生成（${new Date().toISOString()}，机器：${machineInfo}） -->`,
    ...results.map(
      (r) =>
        `| ${r.def.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.ms === null ? '—' : `${r.ms}ms`} | ${r.def.budget} |`,
    ),
  ].join('\n');
  fs.writeFileSync(path.join(repoRoot, 'perf', 'last-run.md'), `${summary}\n`);
  console.log('结果已写入 perf/last-run.md（供 docs/PERF-REPORT.md 引用）');
  process.exit(pass === results.length ? 0 : 1);
}

main();
