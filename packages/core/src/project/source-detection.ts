/**
 * 统一静态识别与运行计划（V2-D01 / PRD §4、V2-SRC-03/04/05）。
 *
 * ## 职责与边界
 *
 * 这是 Git 导入、打开文件夹、复制导入、ZIP 导入**共用**的唯一识别管线：
 * 输入一份源码快照（文件清单 + 关键清单文件文本），输出 v2 契约
 * （`@ec/core` 的 `v2/project-source`）定义的 `SubProjectDetection` / `RunPlan`。
 * 此前 core/git-import 的 `ProjectProfile`（导入画像）与 preview/project-detector
 * 的 `ProjectProfile`（运行画像）同名异义——本模块即 T05 的消歧落点：
 * 运行计划统一走 SourceDetection，两个旧名保留不动，D02 起 preview 消费本模块产出。
 *
 * ## 硬约束
 *
 * - **纯函数、不执行任何工程脚本**：只看清单/锁文件的静态文本（V2-SRC-05）。
 * - **支持边界如实**：只有 PRD §4.1 P0 矩阵内的组合给 `supported` 与运行计划
 *   （静态站 / React+Vite / Vue+Vite / Express / NestJS / FastAPI）；Next/Nuxt 等
 *   SSR 工程与已知但非 P0 的框架给 `partial`；没有任何可信信号的给 `unknown`，
 *   绝不把未知栈包装成"支持"（未知栈不误报支持）。
 * - **单仓多应用**：每个不被其他 package.json 嵌套的 package.json 都是候选子工程，
 *   多个可运行子工程时由 UI 让用户选择（V2-SRC-03），本模块只如实列出。
 * - **RunPlan 只携带环境变量名称**：值必须留在本地受保护配置（v2 契约 strict）。
 * - 输出 cwd/entryHints 为快照相对路径；落库前用 `anchorDraftToRoot` 锚定到代码根
 *   （core 浏览器可达，不引 node:path，拼接为 posix 语义）。
 */

import type {
  DetectionEvidence,
  RunPlan,
  SubProjectDetection,
  SupportLevel,
} from '../v2/project-source';

/** 源码快照：与 GitImportPort.inspect 的 RepoSnapshot 结构子集对齐（四路接入共用） */
export interface SourceSnapshot {
  /** 相对路径清单（posix 分隔；扫描端已跳过 node_modules / .git 等目录） */
  files: string[];
  /** 关键清单文件内容（路径 → 前 64KB 文本） */
  manifests: Record<string, string>;
}

/** 识别结果草稿：不含 projectId / detectionId / revision 等落库字段 */
export interface SourceDetectionDraft {
  scannerVersion: string;
  subProjects: SubProjectDetection[];
  /** 存在任何安装/运行命令时为 true（首次安装/运行前必须用户确认，V2-SRC-05） */
  requiresConfirmation: boolean;
  notes: string[];
}

/** 扫描器版本：识别口径演进后，旧落库结果据此判过期（重扫刷新） */
export const SOURCE_SCANNER_VERSION = 'ec-source-detect/1';

/** 快照文件上限（与 git-import-port 的 MAX_FILES 一致；仅用于提示扫描规模） */
const SNAPSHOT_FILE_LIMIT = 2000;

/* ----------------------------- 快照读取辅助 ----------------------------- */

/** posix 风格 join（core 浏览器可达，不用 node:path）；'.' 与 '' 视为根 */
function posixJoin(root: string, rel: string): string {
  if (rel === '.' || rel === '') return root.replace(/[\\/]+$/, '');
  const trimmedRoot = root.replace(/[\\/]+$/, '');
  if (trimmedRoot === '.' || trimmedRoot === '') return rel;
  return `${trimmedRoot}/${rel}`;
}

/** path 是否位于 dir 之下（dir='.' 匹配一切非根路径由调用方按需处理） */
function underDir(dir: string, path: string): boolean {
  if (dir === '.' || dir === '') return true;
  return path.startsWith(`${dir}/`);
}

/** 'apps/web/package.json' → 'apps/web'；'package.json' → '.' */
function dirOf(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '.' : filePath.slice(0, index);
}

/** 读清单文本（精确路径），容错：不存在返回 null */
function manifestAt(snapshot: SourceSnapshot, path: string): string | null {
  const text = snapshot.manifests[path];
  return text === undefined ? null : text;
}

/** 尽力 JSON.parse（清单容错优先，解析失败回退到原始文本匹配） */
function parseJsonSafe(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function containsIgnoreCase(text: string | null, needle: string): boolean {
  return text !== null && text.toLowerCase().includes(needle.toLowerCase());
}

/* ----------------------------- 信号定义 ----------------------------- */

/** P0 支持矩阵（PRD §4.1）：framework 标签 → supported */
const SUPPORTED_FRAMEWORKS: ReadonlySet<string> = new Set([
  'static-html',
  'react-vite',
  'vue-vite',
  'express',
  'nestjs',
  'fastapi',
]);

/** 已知但非 P0 的框架：partial（不宣称 P0 支持，也不装作未知） */
const PARTIAL_FRAMEWORK_HINTS: ReadonlyArray<{ framework: string; needle: string; note: string }> =
  [
    { framework: 'next', needle: '"next"', note: 'Next.js 属 P1 专用适配，暂不宣称 P0 支持' },
    { framework: 'nuxt', needle: '"nuxt"', note: 'Nuxt 属 P1 专用适配，暂不宣称 P0 支持' },
    {
      framework: 'react-cra',
      needle: 'react-scripts',
      note: 'CRA（webpack）工程非 P0 矩阵，运行命令需人工确认',
    },
    {
      framework: 'vue-cli',
      needle: '@vue/cli-service',
      note: 'Vue CLI（webpack）工程非 P0 矩阵，运行命令需人工确认',
    },
  ];

const FRONTEND_HINTS = ['react', 'vue', 'svelte', 'vite'] as const;
const BACKEND_HINTS = ['express', 'fastify', 'koa', '@nestjs/core'] as const;

interface PkgScripts {
  dev: boolean;
  start: boolean;
  build: boolean;
}

function readScripts(packageJson: Record<string, unknown> | null): PkgScripts {
  const scripts = packageJson?.['scripts'];
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return { dev: false, start: false, build: false };
  }
  const keys = Object.keys(scripts as Record<string, unknown>);
  return {
    dev: keys.includes('dev'),
    start: keys.includes('start'),
    build: keys.includes('build'),
  };
}

function isRunnable(packageJson: Record<string, unknown> | null): boolean {
  if (packageJson === null) return false;
  const scripts = readScripts(packageJson);
  return scripts.dev || scripts.start;
}

/** 包管理器判定：锁文件优先（V2-SRC-04 要求输出包管理器） */
function detectPackageManager(
  snapshot: SourceSnapshot,
  dir: string,
  packageJson: Record<string, unknown> | null,
): { packageManager: string | null; evidence: DetectionEvidence[] } {
  const evidence: DetectionEvidence[] = [];
  const lockFiles: Array<{ name: string; manager: string }> = [
    { name: 'pnpm-lock.yaml', manager: 'pnpm' },
    { name: 'yarn.lock', manager: 'yarn' },
    { name: 'bun.lockb', manager: 'bun' },
    { name: 'package-lock.json', manager: 'npm' },
  ];
  for (const lock of lockFiles) {
    const lockPath = posixJoin(dir, lock.name);
    if (snapshot.files.includes(lockPath)) {
      evidence.push({
        kind: 'lock_file',
        path: lockPath,
        detail: `锁文件 ${lock.name} → ${lock.manager}`,
      });
      return { packageManager: lock.manager, evidence };
    }
  }
  const declared = packageJson?.['packageManager'];
  if (typeof declared === 'string' && declared.trim().length > 0) {
    const manager = declared.split('@')[0]?.trim();
    if (manager !== undefined && manager.length > 0) {
      const pkgPath = posixJoin(dir, 'package.json');
      evidence.push({
        kind: 'config_file',
        path: pkgPath,
        detail: `packageManager 字段 → ${manager}`,
      });
      return { packageManager: manager, evidence };
    }
  }
  return { packageManager: null, evidence };
}

/* ----------------------------- 子工程分析 ----------------------------- */

/** 由依赖与脚本推断角色（frontend / backend / fullstack / library / unknown） */
function inferRole(
  packageJson: Record<string, unknown> | null,
  deps: string,
): { role: SubProjectDetection['role']; note: string | null } {
  if (packageJson === null) return { role: 'unknown', note: null };
  const lower = deps.toLowerCase();
  const hasFrontend = FRONTEND_HINTS.some((hint) => lower.includes(hint));
  const hasBackend = BACKEND_HINTS.some((hint) => lower.includes(hint));
  if (hasFrontend && hasBackend) return { role: 'fullstack', note: null };
  if (hasFrontend) return { role: 'frontend', note: null };
  if (hasBackend) return { role: 'backend', note: null };
  if (isRunnable(packageJson)) {
    return { role: 'unknown', note: '存在可运行脚本但未识别到前后端框架' };
  }
  return { role: 'library', note: null };
}

/** vite 前端运行计划（P0：React+Vite / Vue+Vite） */
function viteRunPlan(dir: string, packageManager: string | null, portHint: number): RunPlan {
  const manager = packageManager ?? 'npm';
  const slug = dir === '.' ? 'root' : dir.replace(/\//g, '-');
  return {
    cwd: dir,
    services: [
      {
        serviceId: `${slug}-install`,
        role: 'install',
        command: manager,
        args: ['install'],
        portHint: null,
      },
      {
        serviceId: `${slug}-dev`,
        role: 'frontend',
        command: manager,
        args: ['run', 'dev'],
        portHint,
      },
    ],
    startupOrder: [`${slug}-install`, `${slug}-dev`],
    envVarNames: [],
  };
}

/** Node 后端运行计划（P0：Express / NestJS，走既有 dev/start 脚本，不编造命令） */
function nodeBackendRunPlan(
  dir: string,
  packageManager: string | null,
  scripts: PkgScripts,
): RunPlan | null {
  const manager = packageManager ?? 'npm';
  const slug = dir === '.' ? 'root' : dir.replace(/\//g, '-');
  const make = (args: string[]): RunPlan => ({
    cwd: dir,
    services: [
      {
        serviceId: `${slug}-install`,
        role: 'install',
        command: manager,
        args: ['install'],
        portHint: null,
      },
      { serviceId: `${slug}-serve`, role: 'backend', command: manager, args, portHint: 3000 },
    ],
    startupOrder: [`${slug}-install`, `${slug}-serve`],
    envVarNames: ['PORT', 'NODE_ENV'],
  });
  if (scripts.dev) return make(['run', 'dev']);
  if (scripts.start) return make(['start']);
  return null;
}

/** FastAPI 运行计划（P0；命令为建议值，执行前仍需用户确认） */
function fastApiRunPlan(entryModule: string): RunPlan {
  return {
    cwd: '.',
    services: [
      {
        serviceId: 'root-serve',
        role: 'backend',
        command: 'python',
        args: ['-m', 'uvicorn', `${entryModule}:app`, '--port', '8000'],
        portHint: 8000,
      },
    ],
    startupOrder: ['root-serve'],
    envVarNames: ['PORT'],
  };
}

/** 单个 Node 子工程的框架判定（返回 framework 标签 + 证据） */
function detectNodeFramework(deps: string): {
  framework: string | null;
  supportLevel: SupportLevel;
  evidence: DetectionEvidence[];
  note: string | null;
} {
  const evidence: DetectionEvidence[] = [];
  const lower = deps.toLowerCase();
  if (lower.includes('"vite"') && lower.includes('"vue"')) {
    evidence.push({ kind: 'config_file', path: 'package.json', detail: '依赖含 vue + vite' });
    return { framework: 'vue-vite', supportLevel: 'supported', evidence, note: null };
  }
  if (lower.includes('"vite"') && lower.includes('"react"')) {
    evidence.push({ kind: 'config_file', path: 'package.json', detail: '依赖含 react + vite' });
    return { framework: 'react-vite', supportLevel: 'supported', evidence, note: null };
  }
  for (const hint of PARTIAL_FRAMEWORK_HINTS) {
    if (lower.includes(hint.needle)) {
      evidence.push({
        kind: 'config_file',
        path: 'package.json',
        detail: `依赖命中 ${hint.framework}（非 P0 矩阵）`,
      });
      return { framework: hint.framework, supportLevel: 'partial', evidence, note: hint.note };
    }
  }
  if (lower.includes('"express"')) {
    evidence.push({ kind: 'config_file', path: 'package.json', detail: '依赖含 express' });
    return { framework: 'express', supportLevel: 'supported', evidence, note: null };
  }
  if (lower.includes('"@nestjs/core"')) {
    evidence.push({ kind: 'config_file', path: 'package.json', detail: '依赖含 @nestjs/core' });
    return { framework: 'nestjs', supportLevel: 'supported', evidence, note: null };
  }
  if (lower.includes('"fastify"') || lower.includes('"koa"')) {
    evidence.push({
      kind: 'config_file',
      path: 'package.json',
      detail: '依赖含 Fastify/Koa（非 P0 后端矩阵）',
    });
    return {
      framework: 'node-backend',
      supportLevel: 'partial',
      evidence,
      note: 'Fastify/Koa 非 P0 后端矩阵，运行命令需人工确认',
    };
  }
  return { framework: null, supportLevel: 'unknown', evidence, note: null };
}

/** 置信度：证据数量的确定性函数（可解释、可测试，不假装精确概率） */
function confidenceOf(evidenceCount: number): number {
  if (evidenceCount === 0) return 0;
  return Math.min(0.95, 0.4 + 0.2 * (evidenceCount - 1));
}

/** dir 是否为某个 workspace 根的成员（严格在根目录之下） */
function isWorkspaceMember(dir: string, workspaceRoots: ReadonlySet<string>): boolean {
  for (const root of workspaceRoots) {
    if (root !== dir && underDir(root, dir)) return true;
  }
  return false;
}

/** 收集 Node workspace 声明（pnpm-workspace.yaml / package.json workspaces 字段）→ 根目录集合 */
function collectWorkspaceRoots(
  snapshot: SourceSnapshot,
  packageJsonPaths: string[],
): { dirs: Set<string>; evidence: DetectionEvidence[] } {
  const dirs = new Set<string>();
  const evidence: DetectionEvidence[] = [];
  if (snapshot.files.includes('pnpm-workspace.yaml')) {
    dirs.add('.');
    evidence.push({
      kind: 'config_file',
      path: 'pnpm-workspace.yaml',
      detail: '发现 pnpm-workspace.yaml（Node workspace 单仓多包）',
    });
  }
  for (const pkgPath of packageJsonPaths) {
    const packageJson = parseJsonSafe(manifestAt(snapshot, pkgPath));
    const workspaces = packageJson?.['workspaces'];
    if (Array.isArray(workspaces) && workspaces.length > 0) {
      dirs.add(dirOf(pkgPath));
      evidence.push({
        kind: 'config_file',
        path: pkgPath,
        detail: 'package.json 声明 workspaces（Node workspace 单仓多包）',
      });
    }
  }
  return { dirs, evidence };
}

/* ----------------------------- 主入口 ----------------------------- */

/**
 * 统一识别入口。产出 v2 SourceDetection 的内容草稿（不含落库字段）。
 * cwd/entryHints 为快照相对路径；落库前调用 `anchorDraftToRoot` 锚定代码根。
 */
export function detectSource(snapshot: SourceSnapshot): SourceDetectionDraft {
  const notes: string[] = [];
  const subProjects: SubProjectDetection[] = [];

  const packageJsonPaths = snapshot.files
    .filter((path) => path === 'package.json' || path.endsWith('/package.json'))
    .filter((path) => !path.split('/').some((segment) => segment === 'node_modules'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  const workspaceInfo = collectWorkspaceRoots(snapshot, packageJsonPaths);
  notes.push(...workspaceInfo.evidence.map((item) => item.detail ?? ''));

  // 候选子工程 = 不被其他 package.json 目录嵌套的 package.json；
  // workspace 声明的成员除外（成员即使嵌在根工程目录下也是独立应用）。
  // 根工程存在时，examples/ 下的嵌套清单不误报为独立应用；
  // 无根工程的多应用仓（apps/web + apps/api）两个都保留——由用户选择，不自动挑第一个。
  const pkgDirs = packageJsonPaths.map(dirOf);
  const candidateDirs = pkgDirs.filter(
    (dir, selfIndex) =>
      dir === '.' ||
      isWorkspaceMember(dir, workspaceInfo.dirs) ||
      !pkgDirs.some((other, otherIndex) => otherIndex !== selfIndex && underDir(other, dir)),
  );

  let index = 0;
  for (const dir of candidateDirs) {
    index += 1;
    const pkgPath = posixJoin(dir, 'package.json');
    const rawManifest = manifestAt(snapshot, pkgPath);
    const packageJson = parseJsonSafe(rawManifest);
    const evidence: DetectionEvidence[] = [
      { kind: 'config_file', path: pkgPath, detail: '存在 package.json' },
    ];

    const deps = packageJson !== null ? JSON.stringify(packageJson) : (rawManifest ?? '');
    const { packageManager, evidence: pmEvidence } = detectPackageManager(
      snapshot,
      dir,
      packageJson,
    );
    evidence.push(...pmEvidence);
    if (packageManager === null && packageJson !== null) {
      evidence.push({
        kind: 'config_file',
        path: pkgPath,
        detail: '未发现锁文件，按 npm 处理（仅建议值）',
      });
    }

    const frameworkInfo = detectNodeFramework(deps);
    evidence.push(...frameworkInfo.evidence);
    const roleInfo = inferRole(packageJson, deps);
    if (roleInfo.note !== null) {
      evidence.push({ kind: 'script_field', path: pkgPath, detail: roleInfo.note });
    }
    const scripts = readScripts(packageJson);
    if (scripts.dev) {
      evidence.push({ kind: 'script_field', path: pkgPath, detail: 'package.json 有 dev 脚本' });
    } else if (scripts.start) {
      evidence.push({ kind: 'script_field', path: pkgPath, detail: 'package.json 有 start 脚本' });
    }

    // 运行计划：P0 组合才给建议值；partial/unknown 不编造命令
    let runPlan: RunPlan | null = null;
    if (frameworkInfo.framework === 'react-vite' || frameworkInfo.framework === 'vue-vite') {
      runPlan = viteRunPlan(dir, packageManager, 5173);
    } else if (
      (frameworkInfo.framework === 'express' || frameworkInfo.framework === 'nestjs') &&
      isRunnable(packageJson)
    ) {
      runPlan = nodeBackendRunPlan(dir, packageManager, scripts);
    } else if (roleInfo.role === 'library' && packageJson !== null) {
      evidence.push({
        kind: 'directory_layout',
        path: pkgPath,
        detail: '无可运行脚本，按库/支撑包处理',
      });
    }

    const supportLevel: SupportLevel =
      frameworkInfo.framework !== null && SUPPORTED_FRAMEWORKS.has(frameworkInfo.framework)
        ? 'supported'
        : frameworkInfo.supportLevel;
    if (frameworkInfo.note !== null) {
      notes.push(`${dir === '.' ? '根工程' : dir}：${frameworkInfo.note}`);
    }

    subProjects.push({
      subProjectId: `sp-${String(index).padStart(4, '0')}`,
      role: roleInfo.role,
      language: 'typescript-or-javascript',
      framework: frameworkInfo.framework,
      packageManager: packageManager ?? (packageJson !== null ? 'npm' : null),
      entryHints: [dir],
      supportLevel,
      confidence: confidenceOf(evidence.length),
      evidence,
      suggestedRunPlan: runPlan,
    });
  }

  // 纯静态站（无 package.json、根有 index.html）：P0 支持矩阵第一行
  if (packageJsonPaths.length === 0 && snapshot.files.includes('index.html')) {
    subProjects.push({
      subProjectId: 'sp-0001',
      role: 'frontend',
      language: 'html-css-js',
      framework: 'static-html',
      packageManager: null,
      entryHints: ['.'],
      supportLevel: 'supported',
      confidence: confidenceOf(2),
      evidence: [
        { kind: 'directory_layout', path: 'index.html', detail: '根目录存在 index.html（静态站）' },
      ],
      // 静态站由预览域直接托管：无安装/运行命令是有意为之（不编造 npx serve 之类命令）
      suggestedRunPlan: null,
    });
    notes.push('静态站无需安装依赖，由预览直接托管（运行计划为空是有意为之，不是缺失）。');
  }

  // Python 后端（requirements.txt / pyproject.toml + FastAPI 信号）
  if (
    packageJsonPaths.length === 0 &&
    (snapshot.files.includes('requirements.txt') || snapshot.files.includes('pyproject.toml'))
  ) {
    const reqPath = snapshot.files.includes('requirements.txt')
      ? 'requirements.txt'
      : 'pyproject.toml';
    const reqText = manifestAt(snapshot, reqPath);
    const pyEvidence: DetectionEvidence[] = [
      { kind: 'config_file', path: reqPath, detail: '发现 Python 依赖清单' },
    ];
    let framework: string | null = null;
    let supportLevel: SupportLevel = 'unknown';
    let runPlan: RunPlan | null = null;
    if (containsIgnoreCase(reqText, 'fastapi')) {
      framework = 'fastapi';
      supportLevel = 'supported';
      const entryFile = snapshot.files.find(
        (path) => path === 'main.py' || path === 'app.py' || path.endsWith('/main.py'),
      );
      const moduleFile = (entryFile ?? 'main.py').split('/').pop() ?? 'main.py';
      pyEvidence.push({ kind: 'config_file', path: reqPath, detail: '依赖含 fastapi' });
      pyEvidence.push({
        kind: 'directory_layout',
        path: entryFile ?? 'main.py',
        detail: 'FastAPI 入口候选（建议值，执行前需确认）',
      });
      runPlan = fastApiRunPlan(moduleFile.replace(/\.py$/, ''));
    } else if (containsIgnoreCase(reqText, 'flask')) {
      framework = 'flask';
      supportLevel = 'partial';
      notes.push('Flask 属 P1 适配范围，暂不宣称 P0 支持。');
    } else {
      notes.push('发现 Python 依赖清单但未识别到 P0 框架（FastAPI）；不虚构运行命令。');
    }
    subProjects.push({
      subProjectId: `sp-${String(subProjects.length + 1).padStart(4, '0')}`,
      role: 'backend',
      language: 'python',
      framework,
      packageManager: 'pip',
      entryHints: ['.'],
      supportLevel,
      confidence: confidenceOf(pyEvidence.length),
      evidence: pyEvidence,
      suggestedRunPlan: runPlan,
    });
  }

  // 完全未知：不误报支持（验收「未知栈不误报支持」）
  if (subProjects.length === 0) {
    subProjects.push({
      subProjectId: 'sp-0001',
      role: 'unknown',
      language: null,
      framework: null,
      packageManager: null,
      entryHints: ['.'],
      supportLevel: 'unknown',
      confidence: 0,
      evidence: [
        {
          kind: 'directory_layout',
          path: '.',
          detail: '未发现 package.json / index.html / Python 依赖清单等可信信号',
        },
      ],
      suggestedRunPlan: null,
    });
    notes.push('未识别到已知工程类型：不会自动给出运行命令，可人工提供运行配置后再运行。');
  }

  const runnableCount = subProjects.filter(
    (item) =>
      item.suggestedRunPlan !== null &&
      item.suggestedRunPlan.services.some((service) => service.role !== 'install'),
  ).length;
  if (runnableCount > 1) {
    notes.push(
      `存在 ${runnableCount} 个可运行子工程：运行前需在运行计划中选择其一（不会自动启动第一个）。`,
    );
  }

  const requiresConfirmation = subProjects.some((item) => item.suggestedRunPlan !== null);

  if (snapshot.files.length >= SNAPSHOT_FILE_LIMIT) {
    notes.push(`源码文件数达到扫描上限（${SNAPSHOT_FILE_LIMIT}）：识别可能不完整，可修正后重扫。`);
  }

  return {
    scannerVersion: SOURCE_SCANNER_VERSION,
    subProjects,
    requiresConfirmation,
    notes,
  };
}

/**
 * 把草稿中的 RunPlan cwd / entryHints 锚定到代码根（落库前的最后一步）。
 * 纯字符串拼接，不触碰文件系统；rootDir 尾部斜杠统一去掉。
 */
export function anchorDraftToRoot(
  draft: SourceDetectionDraft,
  rootDir: string,
): SourceDetectionDraft {
  const normalizedRoot = rootDir.replace(/[\\/]+$/, '');
  return {
    ...draft,
    subProjects: draft.subProjects.map((item) => ({
      ...item,
      entryHints: item.entryHints.map((hint) => posixJoin(normalizedRoot, hint)),
      suggestedRunPlan:
        item.suggestedRunPlan === null
          ? null
          : {
              ...item.suggestedRunPlan,
              cwd: posixJoin(normalizedRoot, item.suggestedRunPlan.cwd),
            },
    })),
  };
}
