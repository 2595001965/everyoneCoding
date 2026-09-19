/**
 * 技术选型问卷（T5-04 / FR-PIPE-13 / FR-AI-13）。
 *
 * - 七端目标端组合（web/android/ios/harmonyos/windows/linux/macos，多选）；
 * - 按 FR-AI-13 矩阵动态出题：Web 选 React/Vue 3（默认 React）；移动双端选
 *   Flutter/React Native/原生（默认 Flutter，单代码库覆盖 Android/iOS）；
 *   鸿蒙 ArkTS + ArkUI（v1.0 唯一推荐）；桌面三端 Tauri 2/Electron/Qt（默认 Tauri 2）；
 * - 每项给推荐项与 2–3 个选项的权衡说明；矩阵中无可用方案的端禁用并说明；
 * - 选择结果可序列化为项目记忆 `structured.stack` 与 `structured.targetPlatforms`，
 *   由外壳写入 @ec/memory；未完成选择时状态机 guard 阻断进入 S3。
 *
 * 本文件纯数据 + 纯函数，浏览器安全。
 */

export const TARGET_PLATFORMS = [
  'web',
  'android',
  'ios',
  'harmonyos',
  'windows',
  'linux',
  'macos',
] as const;
export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];

export const TARGET_PLATFORM_LABELS: Record<TargetPlatform, string> = {
  web: 'Web',
  android: 'Android',
  ios: 'iOS',
  harmonyos: 'HarmonyOS（鸿蒙）',
  windows: 'Windows',
  linux: 'Linux',
  macos: 'macOS',
};

export const WEB_FRAMEWORKS = ['react', 'vue3'] as const;
export type WebFramework = (typeof WEB_FRAMEWORKS)[number];

export const MOBILE_FRAMEWORKS = ['flutter', 'react-native', 'native'] as const;
export type MobileFramework = (typeof MOBILE_FRAMEWORKS)[number];

export const DESKTOP_FRAMEWORKS = ['tauri2', 'electron', 'qt'] as const;
export type DesktopFramework = (typeof DESKTOP_FRAMEWORKS)[number];

/** 一次完整的技术选型结果（校验通过后写入项目记忆） */
export interface TechChoice {
  targets: TargetPlatform[];
  web: WebFramework;
  mobile: MobileFramework;
  harmony: 'arkts';
  desktop: DesktopFramework;
  frontend: string;
  backend: string;
  database: string;
  orm: string;
  deploy: string;
}

export interface ChoiceOption {
  value: string;
  label: string;
  /** 权衡说明（UI 展示：为什么推荐 / 什么场景换选） */
  tradeoffs: string;
  recommended?: boolean | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}

export interface ChoiceQuestion {
  id: string;
  label: string;
  /** 该题对应的目标端（公共题为 null） */
  platform?: TargetPlatform | undefined;
  options: ChoiceOption[];
}

/* ------------------------------ FR-AI-13 矩阵 ------------------------------ */

export interface PlatformMatrixEntry {
  platform: TargetPlatform;
  options: ChoiceOption[];
  default: string;
}

export const PLATFORM_MATRIX: readonly PlatformMatrixEntry[] = [
  {
    platform: 'web',
    options: [
      {
        value: 'react',
        label: 'React 18',
        recommended: true,
        tradeoffs:
          '生态最大、与渲染层 React 栈同构、SSR/静态生成方案成熟；若团队更熟 Vue 可换 Vue 3。',
      },
      {
        value: 'vue3',
        label: 'Vue 3',
        tradeoffs: '上手平缓、模板语法直观、性能与 React 同级；生态略小于 React。',
      },
    ],
    default: 'react',
  },
  {
    platform: 'android',
    options: [
      {
        value: 'flutter',
        label: 'Flutter',
        recommended: true,
        tradeoffs: '单代码库覆盖 Android+iOS，降低双端不一致风险（FR-AI-13 推荐）；打包体积较大。',
      },
      {
        value: 'react-native',
        label: 'React Native',
        tradeoffs: '与 Web 共享 React 心智模型；桥接层性能与调试成本需关注。',
      },
      {
        value: 'native',
        label: 'Android 原生（Kotlin）',
        tradeoffs: '平台能力最完整；双端需要两套代码。',
      },
    ],
    default: 'flutter',
  },
  {
    platform: 'ios',
    options: [
      {
        value: 'flutter',
        label: 'Flutter',
        recommended: true,
        tradeoffs: '与 Android 共用一套 Dart 代码（单代码库）；iOS 审核与原生能力差异需留意。',
      },
      {
        value: 'react-native',
        label: 'React Native',
        tradeoffs: '与 Android 共用 RN 代码；部分原生模块需分别适配。',
      },
      {
        value: 'native',
        label: 'iOS 原生（Swift）',
        tradeoffs: '平台能力最完整；双端需要两套代码。',
      },
    ],
    default: 'flutter',
  },
  {
    platform: 'harmonyos',
    options: [
      {
        value: 'arkts',
        label: 'ArkTS + ArkUI（Stage 模型）',
        recommended: true,
        tradeoffs: 'HarmonyOS 官方首选，Stage 模型 + ArkUI 声明式 UI；v1.0 唯一推荐，无等价替代。',
      },
    ],
    default: 'arkts',
  },
  {
    platform: 'windows',
    options: [
      {
        value: 'tauri2',
        label: 'Tauri 2',
        recommended: true,
        tradeoffs:
          '单代码库覆盖 Windows/Linux/macOS，安装包小（WebView + Rust 内核）；与本项目双形态外壳同技术路线。',
      },
      {
        value: 'electron',
        label: 'Electron',
        tradeoffs: '生态最成熟、Node 集成最顺；包体与内存占用大。',
      },
      {
        value: 'qt',
        label: 'Qt（C++/QML）',
        tradeoffs: '原生性能与控件质感最佳；开发效率低、许可成本高。',
      },
    ],
    default: 'tauri2',
  },
  {
    platform: 'linux',
    options: [
      {
        value: 'tauri2',
        label: 'Tauri 2',
        recommended: true,
        tradeoffs: '与 Windows/macOS 共用一套代码；Linux 发行版碎片化需额外适配。',
      },
      {
        value: 'electron',
        label: 'Electron',
        tradeoffs: '跨发行版行为一致；包体大。',
      },
      {
        value: 'qt',
        label: 'Qt',
        tradeoffs: '原生性能佳；开发效率低。',
      },
    ],
    default: 'tauri2',
  },
  {
    platform: 'macos',
    options: [
      {
        value: 'tauri2',
        label: 'Tauri 2',
        recommended: true,
        tradeoffs: '与 Windows/Linux 共用一套代码；需 macOS 签名与公证流程。',
      },
      {
        value: 'electron',
        label: 'Electron',
        tradeoffs: '生态成熟；包体大。',
      },
      {
        value: 'qt',
        label: 'Qt',
        tradeoffs: '原生性能佳；开发效率低。',
      },
    ],
    default: 'tauri2',
  },
];

/** 公共选项（与端矩阵无关的 5 项：前端框架 / 后端框架 / 数据库 / ORM / 部署方式） */
export const COMMON_QUESTIONS: readonly ChoiceQuestion[] = [
  {
    id: 'frontend',
    label: '前端框架（Web 产物）',
    options: [
      {
        value: 'react',
        label: 'React 18 + Vite',
        recommended: true,
        tradeoffs: '生态最大，与本项目渲染层同构；SSR 可选 Next.js。',
      },
      { value: 'vue3', label: 'Vue 3 + Vite', tradeoffs: '模板直观、上手快。' },
      { value: 'svelte', label: 'Svelte', tradeoffs: '运行时最小、编译期优化；生态规模有限。' },
    ],
  },
  {
    id: 'backend',
    label: '后端框架',
    options: [
      {
        value: 'node-nest',
        label: 'NestJS（Node）',
        recommended: true,
        tradeoffs: 'TS 全栈一致、模块化与依赖注入成熟；与前端共享语言。',
      },
      {
        value: 'node-express',
        label: 'Express / Fastify（Node）',
        tradeoffs: '轻量灵活；工程约束少，大项目需自律。',
      },
      {
        value: 'python-fastapi',
        label: 'FastAPI（Python）',
        tradeoffs: '类型化接口 + 自动 OpenAPI；多语言团队需维护两套栈。',
      },
    ],
  },
  {
    id: 'database',
    label: '数据库',
    options: [
      {
        value: 'sqlite',
        label: 'SQLite',
        recommended: true,
        tradeoffs: '零运维、本地优先契合本项目数据策略（D-02）；多写并发受限。',
      },
      { value: 'postgres', label: 'PostgreSQL', tradeoffs: '功能最强、并发优秀；需要部署与运维。' },
      { value: 'mysql', label: 'MySQL', tradeoffs: '生态普及、运维资料多；功能略逊于 PG。' },
    ],
  },
  {
    id: 'orm',
    label: 'ORM',
    options: [
      {
        value: 'prisma',
        label: 'Prisma',
        recommended: true,
        tradeoffs: '类型安全、迁移体验好；重度查询需原生 SQL 兜底。',
      },
      { value: 'drizzle', label: 'Drizzle ORM', tradeoffs: '轻量、贴近 SQL、无魔法；生态较新。' },
      { value: 'raw', label: '原生 SQL / 查询器', tradeoffs: '完全可控；无类型安全与迁移便利。' },
    ],
  },
  {
    id: 'deploy',
    label: '部署方式',
    options: [
      {
        value: 'desktop',
        label: '桌面安装包分发（NSIS/dmg）',
        recommended: true,
        tradeoffs: '契合桌面工作台形态；更新走自带更新器。',
      },
      { value: 'static', label: '静态托管（Web）', tradeoffs: '简单低成本；需要域名与托管服务。' },
      {
        value: 'container',
        label: '容器部署（Docker）',
        tradeoffs: '环境一致、可伸缩；运维成本高。',
      },
    ],
  },
];

/* ------------------------------ 出题与校验 ------------------------------ */

/** 按目标端组合动态出题（先端矩阵题，再公共 5 题） */
export function questionsForTargets(targets: readonly TargetPlatform[]): ChoiceQuestion[] {
  const platformQuestions: ChoiceQuestion[] = [];
  for (const platform of TARGET_PLATFORMS) {
    const entry = PLATFORM_MATRIX.find((candidate) => candidate.platform === platform);
    if (entry === undefined) continue;
    const selected = targets.includes(platform);
    if (!selected) continue;
    platformQuestions.push({
      id: `platform-${platform}`,
      label: `${TARGET_PLATFORM_LABELS[platform]}技术方案`,
      platform,
      options: entry.options,
    });
  }
  return [...platformQuestions, ...COMMON_QUESTIONS];
}

/** 全推荐默认选择（未选目标端时为空栈） */
export function defaultChoice(targets: readonly TargetPlatform[]): TechChoice {
  const web: WebFramework = 'react';
  const mobile: MobileFramework = 'flutter';
  const desktop: DesktopFramework = 'tauri2';
  return {
    targets: [...targets],
    web,
    mobile,
    harmony: 'arkts',
    desktop,
    frontend: 'react',
    backend: 'node-nest',
    database: 'sqlite',
    orm: 'prisma',
    deploy: 'desktop',
  };
}

/** 校验：目标端必须有对应的端选型；公共 5 项必须全部填写（未选择不得进入 S3） */
export function validateChoice(choice: TechChoice): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (choice.targets.length === 0) issues.push('未选择任何目标端');

  for (const platform of choice.targets) {
    const entry = PLATFORM_MATRIX.find((candidate) => candidate.platform === platform);
    if (entry === undefined) {
      issues.push(`目标端 ${platform} 不在支持矩阵中`);
      continue;
    }
    const value = valueForPlatform(choice, platform);
    if (value === null || value === '')
      issues.push(`${TARGET_PLATFORM_LABELS[platform]}：未选择技术方案`);
    else if (!entry.options.some((option) => option.value === value))
      issues.push(`${TARGET_PLATFORM_LABELS[platform]}：选型 ${value} 不在矩阵中`);
  }

  const requiredCommon: Array<[keyof TechChoice, string]> = [
    ['frontend', '前端框架'],
    ['backend', '后端框架'],
    ['database', '数据库'],
    ['orm', 'ORM'],
    ['deploy', '部署方式'],
  ];
  for (const [key, label] of requiredCommon) {
    const value = choice[key];
    if (typeof value !== 'string' || value.trim().length === 0) issues.push(`${label}：未选择`);
  }

  return { ok: issues.length === 0, issues };
}

/** 取某目标端当前的方案值 */
export function valueForPlatform(choice: TechChoice, platform: TargetPlatform): string | null {
  switch (platform) {
    case 'web':
      return choice.web;
    case 'android':
    case 'ios':
      return choice.mobile;
    case 'harmonyos':
      return choice.harmony;
    case 'windows':
    case 'linux':
    case 'macos':
      return choice.desktop;
    default:
      return null;
  }
}

/** 目标端是否启用（矩阵中是否有可选方案；当前全部启用） */
export function isPlatformEnabled(platform: TargetPlatform): {
  enabled: boolean;
  reason?: string | undefined;
} {
  void platform;
  return { enabled: true };
}

/* ------------------------------ 序列化到项目记忆 ------------------------------ */

/** 渲染成 structured.stack 的文本（供项目记忆与生成提示词消费） */
export function techChoiceToStack(choice: TechChoice): string {
  const lines: string[] = [];
  const platformLines = choice.targets.map((platform) => {
    const label = TARGET_PLATFORM_LABELS[platform];
    const value = valueForPlatform(choice, platform) ?? '';
    return `${label}: ${frameworkLabel(platform, value)}`;
  });
  lines.push(`目标端：${platformLines.join(' / ')}`);
  // 原始 value（机器可读，供 AI 生成时精确消费）；UI 展示用 label（frameworkLabel）
  lines.push(`移动方案：${choice.mobile}`);
  lines.push(`桌面方案：${choice.desktop}`);
  lines.push(`前端：${commonLabel('frontend', choice.frontend)}`);
  lines.push(`后端：${commonLabel('backend', choice.backend)}`);
  lines.push(`数据库：${commonLabel('database', choice.database)}`);
  lines.push(`ORM：${commonLabel('orm', choice.orm)}`);
  lines.push(`部署：${commonLabel('deploy', choice.deploy)}`);
  return lines.join('\n');
}

/** 写入项目记忆用的结构化对象（structured.stack / structured.targetPlatforms） */
export function toStackObject(choice: TechChoice): { stack: string; targetPlatforms: string[] } {
  return { stack: techChoiceToStack(choice), targetPlatforms: [...choice.targets] };
}

function frameworkLabel(platform: TargetPlatform, value: string): string {
  const entry = PLATFORM_MATRIX.find((candidate) => candidate.platform === platform);
  const option = entry?.options.find((candidate) => candidate.value === value);
  return option?.label ?? value;
}

function commonLabel(questionId: string, value: string): string {
  const question = COMMON_QUESTIONS.find((candidate) => candidate.id === questionId);
  const option = question?.options.find((candidate) => candidate.value === value);
  return option?.label ?? value;
}
