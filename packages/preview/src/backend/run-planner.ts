/**
 * V2-D02 运行计划识别：把工程证据（package.json / 锁文件 / 目录形态）转成
 * 公共契约（@ec/core v2）的 SubProjectDetection + RunPlan 建议。
 *
 * 边界（与 D01 的分工）：
 * - D01 负责"源码怎么进来"（文件夹 / ZIP / Git 接入与完整识别管线）；
 * - 本模块只负责"确认后的计划怎么跑"里识别这一半：React/Vue Vite、静态站、
 *   前后端分离与 workspace 子工程的 P0 识别，供预览域生成可确认的运行计划。
 * - 探测是纯函数：只读调用方传入的证据，不触碰文件系统、不执行任何脚本（V2-SRC-05）。
 *
 * envVarNames 只收集变量**名称**（契约 strict 拒绝值）；候选入口用目录相对路径。
 */

import type {
  DetectionEvidence,
  RunPlan,
  SubProjectDetection,
} from '@ec/core';

/** 识别器版本：识别口径演进后旧确认计划可据此判过期 */
export const RUN_PLANNER_VERSION = 'v2-d02.1';

export type PmName = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface PlanningEvidence {
  /** 目录（相对工程根）→ 文件名清单（非递归一层） */
  readonly files: Readonly<Record<string, readonly string[]>>;
  /** 目录相对路径 → package.json 解析结果（读取失败/不存在不放进表） */
  readonly packages: Readonly<Record<string, ParsedPackage>>;
  /** 目录相对路径 → .env.example / .env.local 里的变量名清单 */
  readonly envNames: Readonly<Record<string, readonly string[]>>;
}

export interface ParsedPackage {
  readonly name?: string;
  readonly workspaces?: Readonly<unknown>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface PlanSuggestion {
  readonly plannerVersion: string;
  readonly subProjects: SubProjectDetection[];
  readonly plan: RunPlan | null;
  readonly requiresConfirmation: boolean;
  readonly notes: string[];
}

const BACKEND_SERVER_DEPS = [
  'express',
  'fastify',
  'koa',
  '@nestjs/core',
  'hono',
  '@hapi/hapi',
  'apollo-server',
  'graphql-yoga',
];

const BACKEND_PYTHON_HINTS = ['requirements.txt', 'pyproject.toml', 'Pipfile'];

const FRAMEWORK_OF_DEP: Readonly<Record<string, string>> = {
  react: 'react',
  'react-dom': 'react',
  vue: 'vue',
  svelte: 'svelte',
};

export function packageManagerOf(files: readonly string[]): PmName | null {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
  if (files.includes('package-lock.json')) return 'npm';
  return null;
}

function hasDep(pkg: ParsedPackage, name: string): boolean {
  return pkg.dependencies?.[name] !== undefined || pkg.devDependencies?.[name] !== undefined;
}

function scriptOf(pkg: ParsedPackage, names: readonly string[]): string | null {
  for (const name of names) {
    if (pkg.scripts?.[name] !== undefined && pkg.scripts[name].length > 0) return name;
  }
  return null;
}

function evidenceOf(kind: DetectionEvidence['kind'], path: string, detail: string | null): DetectionEvidence {
  return { kind, path, detail };
}

/** RunPlan 组装：startupOrder = install 先行，其余按传入顺序 */
function buildPlan(
  cwd: string,
  services: RunPlan['services'],
  envVarNames: readonly string[],
): RunPlan | null {
  if (services.length === 0) return null;
  const install = services.filter((s) => s.role === 'install');
  const rest = services.filter((s) => s.role !== 'install');
  return {
    cwd,
    services: [...install, ...rest],
    startupOrder: [...install.map((s) => s.serviceId), ...rest.map((s) => s.serviceId)],
    envVarNames: [...new Set(envVarNames)],
  };
}

/**
 * 对一个目录（'' = 工程根）做单工程识别。
 * 返回 null = 这个目录没有可运行的 Web 工程证据。
 */
function detectOne(
  dir: string,
  ev: PlanningEvidence,
  pm: PmName | null,
): SubProjectDetection | null {
  const files = ev.files[dir] ?? [];
  const pkg = ev.packages[dir];
  const relative = (name: string): string => (dir === '' ? name : `${dir}/${name}`);

  // 静态站：有 index.html 且没有任何 Node 证据 → 静态预览路径直接可跑
  if (pkg === undefined && files.includes('index.html')) {
    return {
      subProjectId: `sub-${dir || 'root'}-static`,
      role: 'frontend',
      language: 'html',
      framework: null,
      packageManager: null,
      entryHints: [relative('index.html')],
      supportLevel: 'supported',
      confidence: 0.9,
      evidence: [evidenceOf('directory_layout', relative('index.html'), '静态入口页面')],
      suggestedRunPlan: null,
    };
  }
  if (pkg === undefined) {
    // Python / Java / Go 后端的 P0 证据保持最小：仅 requirements.txt 类与可执行入口提示
    const python = BACKEND_PYTHON_HINTS.some((f) => files.includes(f));
    if (python) {
      return {
        subProjectId: `sub-${dir || 'root'}-py`,
        role: 'backend',
        language: 'python',
        framework: null,
        packageManager: null,
        entryHints: files.filter((f) => /^(app|main|server|wsgi|asgi)\.(py|py)$/.test(f)).map(relative),
        supportLevel: 'partial',
        confidence: 0.5,
        evidence: BACKEND_PYTHON_HINTS.filter((f) => files.includes(f)).map((f) =>
          evidenceOf('config_file', relative(f), 'Python 依赖清单（启动命令需人工确认）'),
        ),
        suggestedRunPlan: null,
      };
    }
    return null;
  }

  const deps = FRAMEWORK_OF_DEP;
  const framework = Object.keys(deps).find((d) => hasDep(pkg, d)) ?? null;
  const frameworkName = framework !== null ? deps[framework] : null;
  const hasVite = hasDep(pkg, 'vite');
  const hasBackendDep = BACKEND_SERVER_DEPS.some((d) => hasDep(pkg, d));
  const devScript = scriptOf(pkg, ['dev', 'serve']);
  const startScript = scriptOf(pkg, ['start']);

  // Vite 前端（React/Vue/Svelte 任一框架依赖 + vite）
  if (hasVite && (frameworkName !== null || devScript !== null)) {
    const isFrontendOnly = !hasBackendDep;
    const sub: SubProjectDetection = {
      subProjectId: `sub-${dir || 'root'}-vite`,
      role: isFrontendOnly ? 'frontend' : 'fullstack',
      language: 'typescript',
      framework: frameworkName !== null ? `${frameworkName}-vite` : 'vite',
      packageManager: pm,
      entryHints: devScript !== null ? [relative(`package.json#scripts.${devScript}`)] : [],
      supportLevel: 'supported',
      confidence: 0.9,
      evidence: [
        evidenceOf('config_file', relative('package.json'), `vite 依赖${frameworkName !== null ? `（${frameworkName}）` : ''}`),
        evidenceOf('script_field', relative('package.json'), `scripts.${devScript ?? 'dev'} 可启动开发服务`),
      ],
      suggestedRunPlan: null,
    };
    const installId = `install-${dir || 'root'}`;
    const devId = `frontend-${dir || 'root'}`;
    const services: RunPlan['services'] = [
      {
        serviceId: installId,
        role: 'install',
        command: pm === null ? 'npm install' : `${pm} install`,
        args: [],
        portHint: null,
      },
      {
        serviceId: devId,
        role: 'frontend',
        command: pm === null ? 'npm run dev' : `${pm} run dev`,
        // `--` 是 npm/yarn run-script 的转发分隔符（缺失时 npm 会把 --port 当自己的
        // 配置吃掉，Windows 上尤其如此）；--strictPort 保证端口被抢占时可见失败
        // 而不是静默漂移到别的端口（编排器会在运行时追加 --port <已分配端口>）。
        args: ['--', '--strictPort'],
        portHint: 5173,
      },
    ];
    const envs = ev.envNames[dir] ?? [];
    sub.suggestedRunPlan = buildPlan(dir === '' ? '.' : dir, services, envs);
    return sub;
  }

  // Node 后端 / 全栈：server 依赖或 server.js / start 脚本
  const nodeEntry = ['server.js', 'app.js', 'index.js'].find((f) => files.includes(f)) ?? null;
  if (hasBackendDep || nodeEntry !== null || startScript !== null) {
    const role: SubProjectDetection['role'] = hasBackendDep || nodeEntry !== null ? 'backend' : 'fullstack';
    const command =
      startScript !== null
        ? pm === null
          ? 'npm start'
          : `${pm} start`
        : nodeEntry !== null
          ? `node ${nodeEntry}`
          : null;
    const sub: SubProjectDetection = {
      subProjectId: `sub-${dir || 'root'}-node`,
      role,
      language: 'typescript',
      framework: hasBackendDep ? (BACKEND_SERVER_DEPS.find((d) => hasDep(pkg, d)) ?? null) : null,
      packageManager: pm,
      entryHints: [
        ...(startScript !== null ? [relative(`package.json#scripts.${startScript}`)] : []),
        ...(nodeEntry !== null ? [relative(nodeEntry)] : []),
      ],
      supportLevel: command === null ? 'partial' : 'supported',
      confidence: command === null ? 0.4 : 0.8,
      evidence: [
        ...(hasBackendDep
          ? [evidenceOf('config_file', relative('package.json'), '声明了服务端框架依赖')]
          : []),
        ...(nodeEntry !== null ? [evidenceOf('directory_layout', relative(nodeEntry), '服务入口文件')] : []),
        ...(startScript !== null
          ? [evidenceOf('script_field', relative('package.json'), `scripts.${startScript}`)]
          : []),
      ],
      suggestedRunPlan: null,
    };
    if (command !== null) {
      const installId = `install-${dir || 'root'}`;
      const runId = `backend-${dir || 'root'}`;
      const services: RunPlan['services'] = [
        {
          serviceId: installId,
          role: 'install',
          command: pm === null ? 'npm install' : `${pm} install`,
          args: [],
          portHint: null,
        },
        {
          serviceId: runId,
          role: 'backend',
          command,
          args: [],
          portHint: 3000,
        },
      ];
      sub.suggestedRunPlan = buildPlan(dir === '' ? '.' : dir, services, ev.envNames[dir] ?? []);
    }
    return sub;
  }

  return null;
}

/**
 * 生成运行计划建议。
 *
 * 规则：
 * - 根目录识别优先；pnpm-workspace.yaml 存在时扫描 `apps/*`、`packages/*` 子目录，
 *   每个可运行子工程各给一条识别（多可运行入口时 requiresConfirmation=true）。
 * - 计划里只包含 P0 可自动执行的服务（install / Vite 前端 / Node 后端）；
 *   识别出但无法自动启动的（如 Python）只作为证据与说明，不进计划。
 */
export function suggestRunPlan(ev: PlanningEvidence): PlanSuggestion {
  const rootFiles = ev.files[''] ?? [];
  const notes: string[] = [];
  const subProjects: SubProjectDetection[] = [];

  const rootPkg = ev.packages[''];
  const pm = packageManagerOf(rootFiles);

  // workspace：子工程逐个识别；根 package.json 仅在含服务端证据时参与
  const isWorkspace = rootFiles.includes('pnpm-workspace.yaml') || rootPkg?.workspaces !== undefined;

  if (isWorkspace) {
    const dirs = Object.keys(ev.files)
      .filter((d) => d !== '' && /^(apps|packages|services)\//.test(d) && (ev.packages[d] !== undefined || (ev.files[d] ?? []).includes('package.json')))
      .sort();
    for (const dir of dirs) {
      const sub = detectOne(dir, ev, pm);
      if (sub !== null) subProjects.push(sub);
    }
    const rootSub = rootPkg !== undefined ? detectOne('', ev, pm) : null;
    if (rootSub !== null && rootSub.suggestedRunPlan !== null) subProjects.unshift(rootSub);
    if (subProjects.length === 0) {
      notes.push('workspace 结构已识别，但没有发现可自动运行的子工程；请在计划中手动补充命令。');
    } else if (subProjects.filter((s) => s.suggestedRunPlan !== null).length > 1) {
      notes.push('发现多个可运行子工程：确认前请检查计划中的服务清单与启动顺序。');
    }
  } else {
    const sub = detectOne('', ev, pm);
    if (sub !== null) subProjects.push(sub);
  }

  // 无法自动启动的识别只留证据，不进计划
  const runnable = subProjects.filter((s) => s.suggestedRunPlan !== null);
  for (const sub of subProjects) {
    if (sub.suggestedRunPlan === null) {
      notes.push(`${sub.subProjectId}：识别到工程证据但无法给出自动启动命令，需要人工确认后手动运行。`);
    }
  }

  // 同一计划合并多子工程时 cwd 各自独立，服务 ID 全局唯一（已带目录前缀）
  const mergedServices: RunPlan['services'] = [];
  const envNames = new Set<string>();
  for (const sub of runnable) {
    const plan = sub.suggestedRunPlan;
    if (plan === null) continue;
    for (const svc of plan.services) {
      if (mergedServices.some((s) => s.serviceId === svc.serviceId)) continue;
      mergedServices.push(svc);
    }
    for (const name of plan.envVarNames) envNames.add(name);
  }
  for (const sub of subProjects) {
    for (const name of sub.suggestedRunPlan?.envVarNames ?? []) envNames.add(name);
  }

  const needsInstall = mergedServices.some((s) => s.role === 'install');
  const plan = buildPlan('.', mergedServices, [...envNames]);
  if (plan !== null && needsInstall) {
    notes.push('首次运行将执行依赖安装命令；已保留锁文件，不会升级包管理器或依赖版本。');
  }
  if (plan === null && rootFiles.includes('index.html')) {
    notes.push('静态站点：无需运行计划，直接使用静态预览。');
  }
  if (rootPkg === undefined && !rootFiles.includes('index.html') && plan === null) {
    notes.push('未识别到可运行的 Web 工程（缺 package.json 与 index.html），不能声称支持。');
  }

  return {
    plannerVersion: RUN_PLANNER_VERSION,
    subProjects,
    plan,
    requiresConfirmation: plan !== null,
    notes,
  };
}
