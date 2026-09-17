/**
 * E2E-19：技术选型询问 —— S1 → S3 前弹出问卷，未选择不进入 S3；结果写入项目记忆。
 * E2E-21：多端目标与生成 —— 四端（Web/Android/HarmonyOS/Windows）勾选 + S3 问卷确认 +
 *         S5 生成四套工程并编译校验（工具链缺失时输出引导与待验清单）。
 *
 * 装配：真实 PipelineMachine（advance guard）+ 真实 tech-choice 问卷 + 真实 MultiPlatformGenerator（内存端口）。
 */

import { describe, expect, it } from 'vitest';

import * as pipeline from '@ec/pipeline';
import {
  MultiPlatformGenerator,
  PipelineMachine,
  TOOLCHAIN_BY_FRAMEWORK,
  type PlatformGenerationInput,
  type StageGenerationPort,
  type ToolchainRunner,
} from '@ec/pipeline';

import { REQUIREMENT_DOC } from '../helpers';

const TECH_DOC = [
  '# 项目管理系统 技术文档',
  '## 技术栈',
  '- Web：React 18',
  '- 移动端：Flutter',
  '## 模块划分',
  '- 用户模块',
  '- 任务模块',
].join('\n');

describe('E2E-19 技术选型询问', () => {
  it('未完成问卷时 advance(S2→S3) 被 guard 阻断；完成后放行（未选择不进入 S3）', () => {
    const machine = new PipelineMachine({ projectId: 'P-E2E-19' });
    let questionnaireDone = false;
    machine.setAdvanceGuard((from, to) =>
      from === 'S2' && to === 'S3' && !questionnaireDone
        ? '请先完成技术选型问卷（目标端 / 前端 / 后端 / 数据库）'
        : null,
    );

    machine.startStage('S1');
    machine.submitForReview('S1');
    machine.confirm('S1');
    machine.advance('S1', 'S2');
    machine.submitForReview('S2');
    machine.confirm('S2');

    // 问卷未完成 → 阻断
    expect(() => machine.advance('S2', 'S3')).toThrow(/技术选型问卷/);
    expect(machine.statusOf('S3')).toBe('pending');

    // 完成问卷 → 放行
    questionnaireDone = true;
    machine.advance('S2', 'S3');
    expect(machine.statusOf('S3')).toBe('running');
  });

  it('问卷结果含目标端组合与各端方案（Web/Android/HarmonyOS/Windows 四端）', () => {
    const { questionsForTargets, defaultChoice, PLATFORM_MATRIX, TARGET_PLATFORMS } = pipeline;
    const questions = questionsForTargets(['web', 'android', 'harmonyos', 'windows']);

    // 公共题（前端 / 后端 / 数据库 / ORM / 部署）+ 各端技术题
    expect(questions.length).toBeGreaterThan(5);
    expect(questions.some((question) => question.platform === undefined)).toBe(true);

    // 默认选择能通过校验（问卷有合理的默认值）
    const choice = defaultChoice(['web', 'android', 'harmonyos', 'windows']);
    expect(choice.targets).toEqual(['web', 'android', 'harmonyos', 'windows']);
    const validation = pipeline.validateChoice(choice);
    expect(validation.ok).toBe(true);

    // 矩阵覆盖四端且各有默认方案
    for (const platform of ['web', 'android', 'harmonyos', 'windows'] as const) {
      const entry = PLATFORM_MATRIX.find((item) => item.platform === platform);
      expect(entry, `矩阵缺少 ${platform}`).toBeDefined();
      expect(entry!.options.length).toBeGreaterThan(0);
      expect(entry!.default).toBeTruthy();
    }
    // 七端全集对齐（FR-AI-13）
    expect(TARGET_PLATFORMS).toHaveLength(7);
  });
});

describe('E2E-21 多端目标与生成（Web + Android + HarmonyOS + Windows 四端）', () => {
  /** AI 生成端口：按平台返回一套可编译的工程文件（真实语义由 parseFiles 消费） */
  function createGenerator(): StageGenerationPort & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      prompts,
      async generate(prompt) {
        prompts.push(prompt.user ?? prompt.system);
        const files = [
          { path: 'package.json', content: JSON.stringify({ name: 'demo' }) },
          { path: 'src/index.ts', content: 'export {}\n' },
        ];
        return {
          content: [
            '```json',
            JSON.stringify({ files }),
            '```',
          ].join('\n'),
          degraded: false,
        };
      },
    };
  }

  function input(platform: string, framework: string): PlatformGenerationInput {
    return {
      platform: platform as PlatformGenerationInput['platform'],
      framework,
      projectName: '项目管理系统',
      stack: 'react/flutter/arkts/tauri2',
      requirementDoc: REQUIREMENT_DOC,
      techDoc: TECH_DOC,
      pages: [{ id: 'page-task', name: '任务管理', route: '/tasks' }],
    };
  }

  it('四端生成各产出工程文件；移动/鸿蒙/桌面三端编译校验通过', async () => {
    const generator = createGenerator();
    const toolchain: ToolchainRunner = {
      // 三端工具链全部可用（web 端走 Vite 校验，不在本工具链矩阵内）
      detect: async (command) => ['flutter', 'hvigorw', 'cargo'].some((tool) => command.startsWith(tool)),
      run: async () => ({ ok: true, output: 'build succeeded' }),
    };
    const gen = new MultiPlatformGenerator({ generate: generator, toolchain });

    // Web（React）：产物生成；工具链矩阵不覆盖 web（Vite 属渲染层构建链）
    const web = await gen.generateFor(input('web', 'react'));
    expect(web.files.length).toBeGreaterThan(0);
    expect(web.platform).toBe('web');

    // Android（Flutter）/ HarmonyOS（ArkTS）/ Windows（Tauri2）：生成 + 编译校验通过
    const nativeResults = [
      await gen.generateFor(input('android', 'flutter')),
      await gen.generateFor(input('harmonyos', 'arkts')),
      await gen.generateFor(input('windows', 'tauri2')),
    ];
    for (const result of nativeResults) {
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.build.status).toBe('passed');
      expect(result.degraded).toBe(false);
    }
    // 三端框架在矩阵里都有工具链定义（含安装引导）
    for (const framework of ['flutter', 'arkts', 'tauri2']) {
      const tool = TOOLCHAIN_BY_FRAMEWORK[framework];
      expect(tool, `${framework} 缺工具链定义`).toBeDefined();
      expect(tool!.installGuide).toBeTruthy();
    }
  });

  it('工具链缺失时如实输出引导与待验清单（不静默跳过）', async () => {
    const generator = createGenerator();
    const toolchain: ToolchainRunner = {
      detect: async () => false, // 本机无任何工具链
      run: async () => ({ ok: false, output: '' }),
    };
    const gen = new MultiPlatformGenerator({ generate: generator, toolchain });
    const result = await gen.generateFor(input('android', 'flutter'));

    expect(result.build.status).toBe('skipped_toolchain_missing');
    // 引导文案非空：用户能据此安装工具链
    expect(result.build.installGuide ?? '').toBeTruthy();
    // 工程文件仍然生成（待验清单路径：装好工具链后回来编译）
    expect(result.files.length).toBeGreaterThan(0);
  });
});
