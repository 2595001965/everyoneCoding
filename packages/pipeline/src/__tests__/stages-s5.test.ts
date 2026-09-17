import { describe, expect, it } from 'vitest';

import { ContractInjector, buildContractBlock, containsImplementationDetail, summarizeContract } from '../stages/contract-injector';
import { GenerationQueue, describeQueueStats, deserializeProgress, serializeProgress, type QueueNode } from '../stages/generation-queue';
import { MultiPlatformGenerator, type ToolchainRunner } from '../stages/multi-platform-generator';
import { S5GenerateStage, type FileWriterPort, type GitPort } from '../stages/s5-generate';
import { createSampleSplit, SplitModel } from '../stages/s4-split';
import { defaultChoice } from '../stages/tech-choice-questionnaire';
import type { StageGenerationPort } from '../stages/s1-requirement';

/**
 * T5-06 测试：拓扑序执行 / 失败重试·跳过·回退 / 契约注入断言 /
 * 断点续生成 / 自动提交开关与格式 / 多端生成与单端失败隔离。
 */

/* ------------------------------ 契约注入 ------------------------------ */

describe('ContractInjector（FR-PIPE-10：只注入接口摘要）', () => {
  it('契约块只含接口签名摘要，不含实现细节', () => {
    const contracts = [
      {
        name: 'UserService',
        kind: 'service' as const,
        filePath: 'src/services/user.service.ts',
        summary: 'getUser(id: string): Promise<UserDto>',
        types: ['UserDto { id: string; name: string }'],
      },
      {
        name: 'OrderController',
        kind: 'controller' as const,
        filePath: 'src/controllers/order.controller.ts',
        summary: 'POST /api/orders (createOrder(body: CreateOrderDto))',
        types: ['CreateOrderDto { productId: string; qty: number }'],
      },
    ];
    const block = buildContractBlock(contracts);
    expect(block).toContain('UserService');
    expect(block).toContain('getUser(id: string): Promise<UserDto>');
    expect(block).toContain('POST /api/orders');
    // 关键断言：不含函数体 / 导入实现
    expect(containsImplementationDetail(block)).toBe(false);
    expect(block).not.toContain('return');
  });

  it('无契约时给出明确占位（不臆造接口）', () => {
    const block = buildContractBlock([]);
    expect(block).toContain('依赖接口契约');
    expect(block).toContain('无已生成依赖');
  });

  it('injectForNode 按节点依赖过滤并去重（节点 + 技术文档双源）', async () => {
    let nodeCalls = 0;
    const injector = new ContractInjector({
      port: {
        async listContracts(_projectId, nodeIds) {
          nodeCalls += 1;
          return nodeIds.map((id) => ({
            name: id,
            kind: 'service' as const,
            filePath: `src/${id}.ts`,
            summary: `${id}(): void`,
          }));
        },
        async listFromTechDoc() {
          return [{ name: 'UserService', kind: 'service' as const, filePath: 'x', summary: 'dup' }];
        },
      },
    });
    const { contracts, block } = await injector.injectForNode('P1', { id: 'n1', name: '节点1', dependsOn: ['UserService', 'OrderService'] });
    expect(nodeCalls).toBe(1);
    expect(contracts.map((contract) => contract.name)).toEqual(['UserService', 'OrderService']);
    expect(block).toContain('UserService');
  });

  it('未装配端口时返回空契约不阻断', async () => {
    const injector = new ContractInjector();
    const { contracts, block } = await injector.injectForNode('P1', { id: 'n1', name: '节点1', dependsOn: [] });
    expect(contracts).toEqual([]);
    expect(block).toContain('依赖接口契约');
  });

  it('summarizeContract 渲染单条', () => {
    const text = summarizeContract({ name: 'A', kind: 'repo', filePath: 'x', summary: 'findAll(): Promise<Row[]>', types: ['Row { id: string }'] });
    expect(text).toContain('repo A');
    expect(text).toContain('findAll');
    expect(text).toContain('Row { id: string }');
  });
});

/* ------------------------------ 生成队列 ------------------------------ */

interface NodeData {
  name: string;
}

function makeNodes(ids: string[], depends: Record<string, string[]> = {}): QueueNode<NodeData>[] {
  return ids.map((id) => ({
    id,
    name: `节点 ${id}`,
    kind: 'feature' as const,
    dependsOn: depends[id] ?? [],
    status: 'pending' as const,
    attempts: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    data: { name: id },
  }));
}

describe('GenerationQueue（拓扑序执行 + 失败隔离 + 重试/跳过/回退）', () => {
  it('按拓扑序串行执行，依赖先于被依赖者', async () => {
    const executed: string[] = [];
    const queue = new GenerationQueue<NodeData>({
      executor: async (node) => {
        executed.push(node.id);
      },
    });
    queue.load(makeNodes(['a', 'b', 'c'], { c: ['a', 'b'], b: ['a'] }));
    const state = await queue.run();
    expect(executed).toEqual(['a', 'b', 'c']);
    expect(state.stats).toMatchObject({ total: 3, success: 3, failed: 0 });
    expect(describeQueueStats(state.stats)).toContain('成功 3');
  });

  it('单节点失败默认不阻塞，其余节点继续', async () => {
    const executed: string[] = [];
    const queue = new GenerationQueue<NodeData>({
      executor: async (node) => {
        executed.push(node.id);
        if (node.id === 'b') throw new Error('B 生成失败');
      },
    });
    queue.load(makeNodes(['a', 'b', 'c']));
    const state = await queue.run();
    expect(executed).toEqual(['a', 'b', 'c']);
    expect(state.stats.failed).toBe(1);
    const failed = state.nodes.find((node) => node.id === 'b');
    expect(failed?.error).toContain('B 生成失败');
    expect(failed?.attempts).toBe(1);
  });

  it('failFast 时失败即暂停，resume 后重试失败节点并继续', async () => {
    const executed: string[] = [];
    const failures = new Set(['b']);
    const queue = new GenerationQueue<NodeData>({
      executor: async (node) => {
        executed.push(node.id);
        if (failures.has(node.id)) {
          failures.delete(node.id);
          throw new Error('失败');
        }
      },
      failFast: true,
    });
    queue.load(makeNodes(['a', 'b', 'c']));
    const state = await queue.run();
    expect(executed).toEqual(['a', 'b']);
    expect(state.paused).toBe(true);
    // 恢复后重试 b（这次成功），继续 c
    queue.resume();
    const resumed = await queue.run();
    expect(resumed.stats.success).toBe(3);
    expect(resumed.stats.failed).toBe(0);
  });

  it('retry 可重试失败节点；skip 可跳过；rollback 回到 pending', async () => {
    const failures = new Set(['b', 'c']);
    const executed: string[] = [];
    const queue = new GenerationQueue<NodeData>({
      executor: async (node) => {
        executed.push(node.id);
        if (failures.has(node.id)) {
          failures.delete(node.id);
          throw new Error('首次失败');
        }
      },
      rollbackNode: async () => {},
    });
    queue.load(makeNodes(['a', 'b', 'c']));
    await queue.run();
    expect(queue.state().stats.failed).toBe(2);

    // 跳过 c
    queue.skip('c');
    expect(queue.state().nodes.find((node) => node.id === 'c')?.status).toBe('skipped');

    // 重试 b（此时 b 会成功）
    await queue.retry('b');
    expect(queue.state().nodes.find((node) => node.id === 'b')?.status).toBe('success');

    // 回退 a 到 pending
    await queue.rollback('a');
    expect(queue.state().nodes.find((node) => node.id === 'a')?.status).toBe('pending');
  });

  it('断点续生成：序列化/反序列化后跳过已完成节点', async () => {
    const nodes = makeNodes(['a', 'b', 'c'], { c: ['a', 'b'] });
    const completed = nodes.map((node) => (node.id === 'c' ? { ...node, status: 'success' as const, finishedAt: 123 } : node));
    const snapshot = serializeProgress({
      nodes: completed,
      currentId: null,
      paused: false,
      finished: false,
      order: ['a', 'b', 'c'],
      stats: { total: 3, success: 1, failed: 0, skipped: 0, pending: 2, running: 0 },
    });
    const restored = deserializeProgress<NodeData>(JSON.stringify(snapshot), nodes);
    expect(restored.find((node) => node.id === 'c')?.status).toBe('success');
    expect(restored.find((node) => node.id === 'a')?.status).toBe('pending');
    // 从失败节点继续：断点执行只跑 a、b
    const queue = new GenerationQueue<NodeData>({ executor: async () => {} });
    queue.load(restored);
    const state = await queue.run();
    expect(state.nodes.find((node) => node.id === 'c')?.status).toBe('success');
  });
});

/* ------------------------------ 多端生成 ------------------------------ */

describe('MultiPlatformGenerator（FR-AI-12：强制编译校验）', () => {
  const PROJECT_JSON = JSON.stringify({
    files: [
      { path: 'lib/main.dart', content: 'void main() { runApp(App()); }', action: 'create', language: 'dart' },
      { path: 'pubspec.yaml', content: 'name: shop', action: 'create', language: 'yaml' },
    ],
    summary: 'Flutter 工程',
    notes: '',
    decision: { referencedMemory: [], rationale: '', risks: [], uncovered: [] },
  });

  function createToolchain(runner: Partial<ToolchainRunner>): ToolchainRunner {
    return {
      async detect() {
        return true;
      },
      async run() {
        return { ok: true, output: 'BUILD SUCCESSFUL' };
      },
      ...runner,
    };
  }

  function createGenerator(content: string, degraded = false): StageGenerationPort {
    return {
      async generate() {
        return { content, degraded };
      },
    };
  }

  it('工具链存在且编译通过 → passed', async () => {
    const generator = new MultiPlatformGenerator({
      generate: createGenerator(`\`\`\`json\n${PROJECT_JSON}\n\`\`\``),
      toolchain: createToolchain({}),
    });
    const result = await generator.generateFor({
      platform: 'android',
      framework: 'flutter',
      projectName: '商城',
      stack: 'flutter',
      requirementDoc: '# 需求',
      techDoc: '# 技术文档',
      pages: [{ id: 'p1', name: '首页', route: '/' }],
    });
    expect(result.build.status).toBe('passed');
    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.path).toBe('lib/main.dart');
  });

  it('工具链缺失 → skipped_toolchain_missing + 安装引导（不静默跳过，NFR-C-05）', async () => {
    const generator = new MultiPlatformGenerator({
      generate: createGenerator(`\`\`\`json\n${PROJECT_JSON}\n\`\`\``),
      toolchain: createToolchain({
        async detect() {
          return false;
        },
      }),
    });
    const result = await generator.generateFor({
      platform: 'harmonyos',
      framework: 'arkts',
      projectName: '商城',
      stack: 'arkts',
      requirementDoc: '# 需求',
      techDoc: '# 技术文档',
      pages: [],
    });
    expect(result.build.status).toBe('skipped_toolchain_missing');
    expect(result.build.installGuide).toContain('DevEco Studio');
    expect(result.files.length).toBeGreaterThan(0); // 产物仍在（待人工校验）
  });

  it('编译失败回传 AI 重试 ≤2 次后 failed（单端失败不影响他端调度由调用方负责）', async () => {
    let calls = 0;
    const generator = new MultiPlatformGenerator({
      generate: {
        async generate() {
          calls += 1;
          return { content: `\`\`\`json\n${PROJECT_JSON}\n\`\`\``, degraded: false };
        },
      },
      toolchain: createToolchain({
        async run() {
          return { ok: false, output: 'Error: missing main.dart' };
        },
      }),
      maxRetries: 2,
    });
    const result = await generator.generateFor({
      platform: 'windows',
      framework: 'tauri2',
      projectName: '商城',
      stack: 'tauri2',
      requirementDoc: '# 需求',
      techDoc: '# 技术文档',
      pages: [],
    });
    expect(result.build.status).toBe('failed');
    expect(result.build.retries).toBe(2);
    expect(calls).toBe(3); // 初始 1 次 + 重试 2 次
  });

  it('未知框架给出降级说明', async () => {
    const generator = new MultiPlatformGenerator({
      generate: createGenerator(PROJECT_JSON),
      toolchain: createToolchain({}),
    });
    const result = await generator.generateFor({
      platform: 'web',
      framework: 'svelte-unknown',
      projectName: '商城',
      stack: '',
      requirementDoc: '# 需求',
      techDoc: '# 技术文档',
      pages: [],
    });
    expect(result.build.status).toBe('skipped_toolchain_missing');
  });
});

/* ------------------------------ S5 编排 ------------------------------ */

describe('S5GenerateStage（编排 + 自动提交）', () => {
  it('自动提交开关生效，提交信息格式 <type>(<scope>): <subject>', async () => {
    const commits: string[] = [];
    const git: GitPort = {
      async commit(_projectId, message) {
        commits.push(message);
        return { sha: `sha-${commits.length}` };
      },
      async rollback() {},
    };
    const fs: FileWriterPort = {
      async writeFiles() {},
      async snapshot() {
        return 'snap-1';
      },
      async restore() {},
    };
    const generated = new Set<string>();

    const stage = new S5GenerateStage({
      generator: new MultiPlatformGenerator({
        generate: {
          async generate() {
            return {
              content: JSON.stringify({
                files: [{ path: `src/${generated.size}.ts`, content: 'export const x = 1;', action: 'create', language: 'ts' }],
                summary: '生成',
                notes: '',
                decision: { referencedMemory: [], rationale: '', risks: [], uncovered: [] },
              }),
              degraded: false,
            };
          },
        },
        toolchain: {
          async detect() {
            return true;
          },
          async run() {
            return { ok: true, output: 'ok' };
          },
        },
      }),
      contracts: new ContractInjector(),
      queue: new GenerationQueue({ executor: async () => {} }),
      fs,
      git,
      autoCommit: true,
      commitScope: 's5',
      bus: undefined,
    });

    const result = await stage.run({
      projectId: 'P1',
      userId: 'U-TEST',
      projectName: '商城',
      choice: defaultChoice(['web']),
      requirementDoc: '# 需求文档\n## 项目背景\n商城',
      techDoc: '# 技术文档\n## 接口设计\nopenapi: 3.0.0',
      split: SplitModel.fromResult(createSampleSplit()),
    });

    expect(commits.length).toBeGreaterThan(0);
    for (const message of commits) {
      expect(message).toMatch(/^[a-z]+\([a-z0-9_-]+\): .+$/);
    }
    expect(result.state).toBeTruthy();
  });

  it('buildCommitMessage 格式正确且清洗非法字符', () => {
    const stage = new S5GenerateStage({
      generator: undefined as never,
      contracts: undefined as never,
      queue: undefined as never,
    });
    expect(stage.buildCommitMessage('feat', 's5', '生成 登录模块')).toBe('feat(s5): 生成 登录模块');
    expect(stage.buildCommitMessage('fix', 'auth 模块', '修复 登录')).toBe('fix(auth): 修复 登录');
  });
});
