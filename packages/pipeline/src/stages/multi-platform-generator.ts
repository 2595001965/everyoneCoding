import type { StageGenerationPort } from './s1-requirement';
import type { TargetPlatform } from './tech-choice-questionnaire';

/**
 * S5 多端真实代码生成（T5-06 要点 3 / FR-AI-12 / FR-AI-13 / D-03 / NFR-C-05）。
 *
 * - 按 S3 问卷确认的各端方案生成**可编译工程代码**：移动端默认 Flutter（单代码库覆盖
 *   Android/iOS）、鸿蒙 ArkTS + ArkUI（Stage 模型）、桌面端默认 Tauri 2（可改 Electron）；
 * - 生成后**强制编译校验**：探测本机工具链（flutter / hvigor / cargo-tauri 等），
 *   存在则执行构建；失败把编译错误回传给 AI 重新生成（≤2 次）；
 *   **工具链缺失时输出安装引导与待验清单，绝不静默跳过**（NFR-C-05）；
 * - 单端失败只阻断该端节点，不阻塞其他端（由调用方按端分别调度）。
 */

export interface PlatformToolchain {
  platform: TargetPlatform;
  framework: string;
  /** 探测命令（如 flutter --version） */
  detectCommand: string;
  /** 构建命令（参数数组） */
  buildCommand: string[];
  /** 工具链缺失时的安装引导 */
  installGuide: string;
  /** 语言与工程形态说明（供提示词约束工程结构） */
  projectShape: string;
}

/** 工具链矩阵：framework → 探测 / 构建 / 引导 */
export const TOOLCHAIN_BY_FRAMEWORK: Readonly<Record<string, PlatformToolchain>> = {
  flutter: {
    platform: 'android',
    framework: 'flutter',
    detectCommand: 'flutter --version',
    buildCommand: ['flutter', 'build', 'apk', '--debug'],
    installGuide:
      '未检测到 Flutter SDK。安装引导：https://docs.flutter.dev/get-started/install/windows（配置 PATH 后重试）。',
    projectShape:
      'Flutter 工程：lib/main.dart 入口、pubspec.yaml 依赖清单、路由在 lib/app.dart、状态管理用 Provider/Riverpod、接口调用在 lib/services/。',
  },
  'react-native': {
    platform: 'android',
    framework: 'react-native',
    detectCommand: 'npx react-native --version',
    buildCommand: ['npx', 'react-native', 'run-android', '--no-packager'],
    installGuide:
      '未检测到 React Native CLI。安装引导：https://reactnative.dev/docs/environment-setup（配置 Android SDK 后重试）。',
    projectShape:
      'React Native 工程：App.tsx 入口、路由 react-navigation、状态管理 zustand、接口调用 src/services/。',
  },
  native: {
    platform: 'android',
    framework: 'native',
    detectCommand: 'gradle --version',
    buildCommand: ['gradle', 'assembleDebug'],
    installGuide:
      '未检测到 Gradle / Android SDK。安装引导：https://developer.android.com/studio（安装 Android Studio 后重试）。',
    projectShape:
      'Android 原生工程（Kotlin）：MainActivity.kt 入口、Jetpack Compose 或 View 体系、Retrofit 接口层。',
  },
  arkts: {
    platform: 'harmonyos',
    framework: 'arkts',
    detectCommand: 'hvigorw --version',
    buildCommand: ['hvigorw', 'assembleHap'],
    installGuide:
      '未检测到 hvigor 构建工具链。安装引导：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-software-overview（DevEco Studio 自带 hvigor，需配置 PATH）。',
    projectShape:
      'HarmonyOS Stage 模型工程（ArkTS + ArkUI）：entry/src/main/ets/entryability/EntryAbility.ets 入口、pages/ 页面、ets 声明式 UI、模块化 Stage 结构。',
  },
  tauri2: {
    platform: 'windows',
    framework: 'tauri2',
    detectCommand: 'cargo tauri --version',
    buildCommand: ['cargo', 'tauri', 'build', '--no-bundle'],
    installGuide:
      '未检测到 Tauri CLI / Rust 工具链。安装引导：https://v2.tauri.app/start/prerequisites/（安装 Rust 与 tauri-cli 后重试）。',
    projectShape:
      'Tauri 2 工程：src-tauri/ Rust 内核、src/ Web 前端（React+Vite）、tauri.conf.json 配置、窗口与系统能力在 Rust 侧实现。',
  },
  electron: {
    platform: 'windows',
    framework: 'electron',
    detectCommand: 'npx electron --version',
    buildCommand: ['npx', 'electron-builder', '--dir'],
    installGuide:
      '未检测到 Electron 工具链。安装引导：https://www.electronjs.org/docs/latest/tutorial/installation（npm 全局或 npx 安装 electron-builder 后重试）。',
    projectShape:
      'Electron 工程：main.js 主进程、preload.js 预加载、src/ 渲染层（React+Vite）、electron-builder.yml 打包配置。',
  },
  qt: {
    platform: 'windows',
    framework: 'qt',
    detectCommand: 'qmake --version',
    buildCommand: ['qmake', '&&', 'make'],
    installGuide:
      '未检测到 Qt 工具链。安装引导：https://doc.qt.io/qt-6/gettingstarted.html（安装 Qt 与 CMake 后重试）。',
    projectShape: 'Qt 工程（C++/QML）：main.cpp 入口、QML 界面、信号槽业务层、CMake 构建。',
  },
};

/** 编译校验结果 */
export type BuildStatus = 'passed' | 'skipped_toolchain_missing' | 'failed';

export interface BuildVerification {
  status: BuildStatus;
  /** 编译输出（失败时含错误摘要） */
  output: string;
  /** 实际重试次数（≤2） */
  retries: number;
  /** 工具链缺失时的安装引导 */
  installGuide: string | null;
}

export interface PlatformGenerationInput {
  platform: TargetPlatform;
  framework: string;
  projectName: string;
  /** 技术选型栈文本（structured.stack） */
  stack: string;
  /** 需求文档摘要（或全文） */
  requirementDoc: string;
  /** 技术文档全文 */
  techDoc: string;
  /** 页面清单（当前节点的页面；移动/鸿蒙/桌面端生成整端工程） */
  pages: ReadonlyArray<{ id: string; name: string; route: string | null }>;
  /** 用户补充指令 */
  instruction?: string | undefined;
}

export interface PlatformGenerationResult {
  platform: TargetPlatform;
  framework: string;
  /** 生成的工程文件（相对项目工作区） */
  files: Array<{ path: string; content: string }>;
  build: BuildVerification;
  /** 生成是否降级 */
  degraded: boolean;
}

/** 工具链运行端口（外壳装配到 node 子进程；测试注入假实现） */
export interface ToolchainRunner {
  detect(command: string): Promise<boolean>;
  run(command: string[]): Promise<{ ok: boolean; output: string }>;
}

export interface MultiPlatformGeneratorDeps {
  generate: StageGenerationPort;
  toolchain: ToolchainRunner;
  /** 编译失败回传 AI 重试次数（默认 2） */
  maxRetries?: number | undefined;
  clock?: (() => number) | undefined;
}

export class MultiPlatformGenerator {
  private readonly deps: MultiPlatformGeneratorDeps;
  private readonly maxRetries: number;

  constructor(deps: MultiPlatformGeneratorDeps) {
    this.deps = deps;
    this.maxRetries = deps.maxRetries ?? 2;
  }

  /** 工具链信息；未知框架返回 null */
  toolchainFor(framework: string): PlatformToolchain | null {
    return TOOLCHAIN_BY_FRAMEWORK[framework] ?? null;
  }

  /**
   * 生成 + 强制编译校验（失败回传 AI 重试 ≤maxRetries；工具链缺失给安装引导不静默跳过）。
   */
  async generateFor(input: PlatformGenerationInput): Promise<PlatformGenerationResult> {
    const toolchain = this.toolchainFor(input.framework);
    let files: Array<{ path: string; content: string }> = [];
    let degraded = false;

    // 1) 生成工程代码（工具链信息进提示词，约束工程结构）
    const prompt = this.buildPlatformPrompt(input, toolchain);
    const first = await this.deps.generate.generate(prompt);
    files = this.parseFiles(first.content);
    degraded = first.degraded;

    // 2) 强制编译校验
    const verification = await this.verifyAndFix(input, files);

    return {
      platform: input.platform,
      framework: input.framework,
      files,
      build: verification,
      degraded,
    };
  }

  /** 编译校验 + 失败重试闭环 */
  private async verifyAndFix(
    input: PlatformGenerationInput,
    files: Array<{ path: string; content: string }>,
  ): Promise<BuildVerification> {
    const toolchain = this.toolchainFor(input.framework);
    if (toolchain === null) {
      return {
        status: 'skipped_toolchain_missing',
        output: `框架 ${input.framework} 无内置工具链定义，请人工校验`,
        retries: 0,
        installGuide: null,
      };
    }

    // 工具链缺失：输出安装引导 + 待验清单（NFR-C-05：绝不静默跳过）
    const available = await this.deps.toolchain.detect(toolchain.detectCommand);
    if (!available) {
      return {
        status: 'skipped_toolchain_missing',
        output: `工具链缺失（探测命令：${toolchain.detectCommand}）。产物已生成，待安装工具链后人工编译校验。`,
        retries: 0,
        installGuide: toolchain.installGuide,
      };
    }

    let currentFiles = files;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const result = await this.deps.toolchain.run(toolchain.buildCommand);
      if (result.ok) {
        return { status: 'passed', output: result.output, retries: attempt, installGuide: null };
      }
      // 已重试满：不再生成修复，返回 failed
      if (attempt >= this.maxRetries) break;
      // 失败：编译错误回传 AI，要求修复后重出完整工程
      const repairPrompt = this.buildRepairPrompt(input, toolchain, result.output);
      const repaired = await this.deps.generate.generate(repairPrompt);
      currentFiles = this.parseFiles(repaired.content);
    }
    return {
      status: 'failed',
      output: `编译失败（已重试 ${this.maxRetries} 次仍失败）。请人工检查：${currentFiles.map((file) => file.path).join('、')}`,
      retries: this.maxRetries,
      installGuide: null,
    };
  }

  /* ------------------------------ 提示词 ------------------------------ */

  private buildPlatformPrompt(
    input: PlatformGenerationInput,
    toolchain: PlatformToolchain | null,
  ): { system: string; user: string } {
    const shape =
      toolchain?.projectShape ?? '标准工程结构（入口文件 + 依赖清单 + 页面 + 服务层）。';
    const system = [
      `你是 EveryoneCoding 的${input.platform}端工程生成器。你的产物是一个**可直接编译的真实工程**，不是片段。`,
      '',
      '## 输出契约',
      '输出一个 JSON 对象：{ "files": [{ "path", "content", "action": "create", "language" }], "summary", "notes", "decision": {...} }。',
      'files 的 path 是相对项目工作区的路径，content 是**完整文件内容**（不写省略号、不写 TODO）。',
      '',
      '## 工程结构（必须遵守）',
      shape,
      '',
      '## 硬约束',
      '1. 必须产出可编译工程：入口文件、依赖清单（pubspec.yaml / package.json / build.gradle / oh-package.json5 / Cargo.toml）、页面、路由、状态管理、接口调用层、平台适配全部齐全。',
      '2. 依赖清单里的包必须真实存在且版本可用；不确定的写进 decision.risks。',
      '3. 接口调用只允许使用技术文档 OpenAPI 中出现的接口；不确定的写进 decision.uncovered。',
      '4. 不要输出 README/注释性文件；只输出构建所需的最小完整工程。',
      '5. 所有函数体必须完整可直接运行，禁止 TODO / 占位实现。',
    ].join('\n');

    const userLines = [
      `项目名：${input.projectName}`,
      `目标端：${input.platform}（${input.framework}）`,
      '',
      '## 技术选型（必须遵守）',
      input.stack,
      '',
      '## 页面清单',
      ...input.pages.map((page) => `- ${page.name}（route: ${page.route ?? '（无）'}）`),
      '',
      '## 技术文档（接口与数据模型以它为准）',
      input.techDoc.slice(0, 8000),
      '',
      '## 需求文档（业务背景）',
      input.requirementDoc.slice(0, 3000),
    ];
    if (input.instruction !== undefined && input.instruction.trim().length > 0) {
      userLines.push('', `## 用户补充指令（优先级最高）`, input.instruction.trim());
    }
    userLines.push('', '请输出完整可编译工程。');
    return { system, user: userLines.join('\n') };
  }

  private buildRepairPrompt(
    input: PlatformGenerationInput,
    toolchain: PlatformToolchain,
    compileOutput: string,
  ): { system: string; user: string } {
    const base = this.buildPlatformPrompt(input, toolchain);
    const errorTail = compileOutput.length > 2000 ? compileOutput.slice(-2000) : compileOutput;
    return {
      system: base.system,
      user: [
        base.user,
        '',
        '## 上次生成的工程编译失败，请修复',
        `构建命令：${toolchain.buildCommand.join(' ')}`,
        '编译错误（末尾节选）：',
        '```',
        errorTail,
        '```',
        '',
        '请修复上述错误后重新输出**完整工程**（所有文件，不省略）。',
      ].join('\n'),
    };
  }

  /** 从生成内容解析文件清单（JSON 优先，代码块降级） */
  private parseFiles(raw: string): Array<{ path: string; content: string }> {
    // 两种 JSON 形态都收：围栏块取组 1，裸 JSON 的整串就是第 0 组（此前只取组 1，
    // 导致"裸 JSON"这条兜底路径实际上从未生效）。
    const jsonMatch = /```json\s*\n([\s\S]*?)```/.exec(raw) ?? /^\s*\{[\s\S]*\}\s*$/m.exec(raw);
    const jsonText = jsonMatch === null ? null : (jsonMatch[1] ?? jsonMatch[0]);
    if (jsonText !== null) {
      try {
        const parsed = JSON.parse(jsonText) as {
          files?: Array<{ path: string; content: string }>;
        };
        if (Array.isArray(parsed.files))
          return parsed.files.filter(
            (file) => typeof file.path === 'string' && typeof file.content === 'string',
          );
      } catch {
        // 落入降级
      }
    }
    // 降级：以 Markdown 代码块（```lang\npath\ncontent```）解析
    const files: Array<{ path: string; content: string }> = [];
    const pattern = /```[a-z]+\s*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = pattern.exec(raw)) !== null) {
      const block = match[1] ?? '';
      const lines = block.split('\n');
      const first = lines[0]?.trim() ?? '';
      if (/^[\w./-]+\.[a-z0-9]+$/i.test(first)) {
        files.push({ path: first, content: lines.slice(1).join('\n') });
      }
      index += 1;
      if (index > 200) break;
    }
    return files;
  }
}
