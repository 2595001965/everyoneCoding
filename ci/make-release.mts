/**
 * 发布产物编排（T10-04 / FR-SET-05 / D-01 / NFR-P-09）。
 *
 * 双形态安装包产出后，本脚本把它们**收敛成同一个扁平的发布目录**——既可原样作为
 * GitHub Release 的附件上传，也可原样挂到任意静态服务器（`ci/update-feed-server.mts` 本地演练同理）：
 *
 *   EveryoneCoding_<v>_x64-setup.exe(.sig)       Tauri 安装包 = 更新包（minisign 签名）
 *   EveryoneCoding-<v>-x64-setup.exe(.blockmap)  Electron 安装包 = 更新包（sha512 + blockmap 差分）
 *   latest.json            Tauri Updater 静态端点响应（客户端自己比较版本）
 *   latest.yml             electron-updater 清单
 *   release-manifest.json  双形态统一清单（版本、体积、sha512、签名校验结论、URL、告警）
 *   distribution.html      分发页
 *
 * 门禁（任一不过退出码 1，发版中止）：
 * - 体积（NFR-P-09）：Tauri ≤60MB、Electron ≤200MB；
 * - `--strict`（CI 发版必开）：两种安装包、`.sig`、`.blockmap` 缺一不可，且 `.sig` 必须能用
 *   `tauri.conf.json` 里的公钥验过——签错了在这里拦下，而不是等全部用户"永远检查不到更新"。
 *
 * 用法：
 *   node --experimental-strip-types ci/make-release.mts --dir release-artifacts --strict \
 *     [--base-url <附件所在目录 URL>] [--version 0.2.0] [--channel stable] [--notes "..."]
 *   --base-url 缺省为本仓库 GitHub Release：https://github.com/2595001965/everyoneCoding/releases/download/v<版本>
 *
 * 本仓库以 Apache-2.0 开源：源码公开发布，安装产物通过更新服务分发。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePublicKey, verifyMinisign } from './minisign.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const GITHUB_REPO = '2595001965/everyoneCoding';

/** NFR-P-09 体积预算（字节） */
export const BUDGET_BYTES = {
  tauri: 60 * 1024 * 1024,
  electron: 200 * 1024 * 1024,
} as const;

export interface Artifact {
  file: string;
  bytes: number;
  sha512Base64: string;
}

export interface ReleaseOptions {
  dir: string;
  outDir?: string;
  version?: string;
  baseUrl?: string;
  notes?: string;
  channel?: 'stable' | 'beta';
  strict?: boolean;
  enforceBudget?: boolean;
  /** Tauri 公钥（tauri.conf.json 里的 base64 文本）；缺省读仓库配置 */
  pubkey?: string;
  budgets?: { tauri: number; electron: number };
  now?: () => Date;
}

export interface ReleaseResult {
  version: string;
  problems: string[];
  warnings: string[];
  manifest: Record<string, unknown>;
}

function readRootVersion(): string {
  const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  const version = (JSON.parse(raw) as { version?: string }).version;
  if (typeof version !== 'string' || version === '')
    throw new Error('根 package.json 缺少 version');
  return version;
}

function readRepoPubkey(): string {
  const conf = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'apps/desktop-tauri/src-tauri/tauri.conf.json'), 'utf8'),
  ) as { plugins?: { updater?: { pubkey?: string } } };
  return conf.plugins?.updater?.pubkey ?? '';
}

function describeArtifact(file: string): Artifact {
  const bytes = fs.readFileSync(file);
  return {
    file: path.basename(file),
    bytes: bytes.byteLength,
    sha512Base64: createHash('sha512').update(bytes).digest('base64'),
  };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function existing(dir: string, name: string): string | null {
  const full = path.join(dir, name);
  return fs.existsSync(full) ? full : null;
}

export function buildRelease(options: ReleaseOptions): ReleaseResult {
  const dir = path.resolve(options.dir);
  if (!fs.existsSync(dir)) {
    throw new Error(`产物目录不存在：${dir}（先跑 build:tauri / build:electron，或传 --dir）`);
  }
  const outDir = path.resolve(options.outDir ?? dir);
  fs.mkdirSync(outDir, { recursive: true });
  const version = options.version ?? readRootVersion();
  const channel = options.channel ?? 'stable';
  const baseUrl = (
    options.baseUrl ?? `https://github.com/${GITHUB_REPO}/releases/download/v${version}`
  ).replace(/\/+$/, '');
  const notes = options.notes ?? '';
  const strict = options.strict === true;
  const budgets = options.budgets ?? BUDGET_BYTES;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const problems: string[] = [];
  const warnings: string[] = [];
  /** strict 下缺项是阻断问题，否则是告警 */
  const missing = (message: string): void => {
    (strict ? problems : warnings).push(message);
  };

  // ---- 按版本精确取产物（发布目录会累积历史版本，不能"取第一个"）----
  const tauriInstaller = existing(dir, `EveryoneCoding_${version}_x64-setup.exe`);
  const electronInstaller = existing(dir, `EveryoneCoding-${version}-x64-setup.exe`);
  // Tauri 2 默认更新包 = 安装包本身（.exe.sig）；v1Compatible 模式才有 .nsis.zip
  const legacyZip = existing(dir, `EveryoneCoding_${version}_x64-setup.nsis.zip`);
  const tauriBundle = legacyZip ?? tauriInstaller;
  const tauriSigFile =
    tauriBundle === null ? null : existing(dir, `${path.basename(tauriBundle)}.sig`);
  const electronBlockmap =
    electronInstaller === null
      ? null
      : existing(dir, `${path.basename(electronInstaller)}.blockmap`);

  if (tauriInstaller === null)
    missing(`未找到 Tauri 安装包 EveryoneCoding_${version}_x64-setup.exe`);
  if (electronInstaller === null)
    missing(`未找到 Electron 安装包 EveryoneCoding-${version}-x64-setup.exe`);
  if (electronInstaller !== null && electronBlockmap === null) {
    missing('未找到 Electron .blockmap：客户端只能整包下载（差分下载不可用）');
  }

  // ---- 体积门禁（NFR-P-09）----
  const sizes: Array<['tauri' | 'electron', string | null]> = [
    ['tauri', tauriInstaller],
    ['electron', electronInstaller],
  ];
  for (const [kind, file] of sizes) {
    if (file === null) continue;
    const size = fs.statSync(file).size;
    const budget = budgets[kind];
    console.log(
      `  ${size <= budget ? 'PASS' : 'FAIL'}  ${kind} 安装包 ${mb(size)}（预算 ≤${mb(budget)}）`,
    );
    if (size > budget && options.enforceBudget !== false) {
      problems.push(`${kind} 安装包 ${mb(size)} 超出预算 ${mb(budget)}`);
    }
  }

  // ---- Tauri 签名：存在性 + 用仓库公钥验签 ----
  let signature = '';
  let signatureCheck: string;
  if (tauriBundle !== null && tauriSigFile === null) {
    missing(`未找到 ${path.basename(tauriBundle)}.sig：构建时没有注入 TAURI_SIGNING_PRIVATE_KEY`);
    signatureCheck = 'missing';
  } else if (tauriBundle !== null && tauriSigFile !== null) {
    signature = fs.readFileSync(tauriSigFile, 'utf8').trim();
    const pubkey = options.pubkey ?? readRepoPubkey();
    let result: ReturnType<typeof verifyMinisign>;
    try {
      result = verifyMinisign(fs.readFileSync(tauriBundle), signature, parsePublicKey(pubkey));
    } catch (error) {
      result = {
        ok: false,
        reason: `公钥无法解析：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (result.ok) {
      signatureCheck = `ok（key ${result.keyId}）`;
      console.log(`  PASS  Tauri 更新包签名与 tauri.conf.json 公钥匹配（key ${result.keyId}）`);
    } else {
      signatureCheck = `failed: ${result.reason}`;
      // 签名不对的包发出去，所有 Tauri 客户端都会拒装——无论是否 strict 都阻断
      problems.push(`Tauri 更新包验签失败：${result.reason}`);
    }
  } else {
    signatureCheck = 'no-bundle';
  }

  // ---- Tauri Updater 静态端点响应 ----
  const tauriUrl = tauriBundle === null ? '' : `${baseUrl}/${path.basename(tauriBundle)}`;
  const platform = { signature, url: tauriUrl };
  const latestJson = {
    version,
    notes,
    pub_date: now,
    // 插件先找 `<os>-<arch>-<installer>`，再退回 `<os>-<arch>`
    platforms: { 'windows-x86_64-nsis': platform, 'windows-x86_64': platform },
  };
  if (tauriBundle !== null) {
    fs.writeFileSync(
      path.join(outDir, 'latest.json'),
      `${JSON.stringify(latestJson, null, 2)}\n`,
      'utf8',
    );
  }

  // ---- electron-updater 清单（url 相对清单所在目录，与安装包同目录即可）----
  const electronArtifact = electronInstaller === null ? null : describeArtifact(electronInstaller);
  if (electronArtifact !== null) {
    const latestYml = [
      `version: ${version}`,
      'files:',
      `  - url: ${electronArtifact.file}`,
      `    sha512: ${electronArtifact.sha512Base64}`,
      `    size: ${electronArtifact.bytes}`,
      `path: ${electronArtifact.file}`,
      `sha512: ${electronArtifact.sha512Base64}`,
      `releaseDate: '${now}'`,
      ...(notes === '' ? [] : [`releaseNotes: ${JSON.stringify(notes)}`]),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(outDir, 'latest.yml'), latestYml, 'utf8');
  }

  const tauriInstallerArtifact = tauriInstaller === null ? null : describeArtifact(tauriInstaller);
  const manifest = {
    product: 'EveryoneCoding',
    version,
    channel,
    generatedAt: now,
    baseUrl,
    forms: {
      tauri: {
        installer: tauriInstallerArtifact,
        updateBundle:
          tauriBundle === null
            ? null
            : {
                ...(tauriBundle === tauriInstaller && tauriInstallerArtifact !== null
                  ? tauriInstallerArtifact
                  : describeArtifact(tauriBundle)),
                url: tauriUrl,
                signatureCheck,
              },
        budgetBytes: budgets.tauri,
      },
      electron: {
        installer:
          electronArtifact === null
            ? null
            : { ...electronArtifact, url: `${baseUrl}/${electronArtifact.file}` },
        blockmap: electronBlockmap === null ? null : path.basename(electronBlockmap),
        budgetBytes: budgets.electron,
      },
    },
    endpoints: {
      tauri: `${baseUrl}/latest.json`,
      electron: `${baseUrl}/`,
    },
    warnings,
    problems,
  };
  fs.writeFileSync(
    path.join(outDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'distribution.html'),
    renderDistributionPage({
      version,
      channel,
      baseUrl,
      tauri: tauriInstallerArtifact,
      electron: electronArtifact,
    }),
    'utf8',
  );

  return { version, problems, warnings, manifest };
}

/** 分发页：双形态并列下载 + 差异说明（静态 HTML，随产物上传）。 */
function renderDistributionPage(input: {
  version: string;
  channel: string;
  baseUrl: string;
  tauri: Artifact | null;
  electron: Artifact | null;
}): string {
  const sizeText = (artifact: Artifact | null): string =>
    artifact === null ? '尚未产出' : `${(artifact.bytes / 1024 / 1024).toFixed(2)} MB`;
  const href = (artifact: Artifact | null): string =>
    artifact === null ? '#' : `${input.baseUrl}/${artifact.file}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>EveryoneCoding ${input.version} 下载</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 48px 16px; line-height: 1.6; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  .ver { color: #888; margin-bottom: 32px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 24px; }
  .card h2 { margin: 0 0 4px; font-size: 20px; }
  .tag { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid #8886; margin-left: 8px; }
  .size { color: #888; font-size: 13px; }
  ul { padding-left: 20px; }
  .dl { display: inline-block; margin-top: 12px; padding: 10px 20px; border-radius: 8px; background: #2563eb; color: #fff; text-decoration: none; }
  .dl[href="#"] { background: #8886; pointer-events: none; }
  .table-wrap { overflow-x: auto; margin-top: 32px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #8884; padding: 8px 12px; text-align: left; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>EveryoneCoding 桌面端</h1>
  <p class="ver">版本 ${input.version} · ${input.channel} 通道 · 两种形态功能等价，任选其一</p>
  <div class="cards">
    <section class="card">
      <h2>Tauri 2 版<span class="tag">推荐</span></h2>
      <p class="size">安装包 ${sizeText(input.tauri)}（预算上限 60MB）</p>
      <ul>
        <li>包体小、启动快、内存占用低（基于系统 WebView2）</li>
        <li>需要系统已安装 WebView2 运行时（安装器会引导）</li>
        <li>更新包经 minisign 签名校验</li>
      </ul>
      <a class="dl" href="${href(input.tauri)}">下载 Windows 安装包</a>
    </section>
    <section class="card">
      <h2>Electron 版</h2>
      <p class="size">安装包 ${sizeText(input.electron)}（预算上限 200MB）</p>
      <ul>
        <li>自带 Chromium 与 Node 运行时，环境依赖少</li>
        <li>更新走差分下载（只拉变化的块），sha512 校验</li>
        <li>包体与内存占用高于 Tauri 版</li>
      </ul>
      <a class="dl" href="${href(input.electron)}">下载 Windows 安装包</a>
    </section>
  </div>
  <div class="table-wrap">
  <table>
    <tr><th>对比项</th><th>Tauri 2 版</th><th>Electron 版</th></tr>
    <tr><td>包体预算</td><td>≤60MB</td><td>≤200MB</td></tr>
    <tr><td>内存预算（空闲 / 大型项目）</td><td>≤300MB / ≤1.2GB</td><td>≤500MB / ≤2GB</td></tr>
    <tr><td>运行时依赖</td><td>系统 WebView2</td><td>内置 Chromium + Node</td></tr>
    <tr><td>更新机制</td><td>Tauri Updater（minisign 签名，整包）</td><td>electron-updater（sha512，blockmap 差分）</td></tr>
    <tr><td>功能范围</td><td colspan="2">完全等价（同一套渲染层与领域包，D-01）</td></tr>
  </table>
  </div>
</main>
</body>
</html>
`;
}

/* ------------------------------- 命令行 ------------------------------- */

function parseArgs(argv: string[]): ReleaseOptions {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} 缺少取值`);
    return value;
  };
  const dir = path.resolve(repoRoot, get('--dir') ?? 'release-artifacts');
  const outDir = get('--out-dir');
  const version = get('--version');
  const baseUrl = get('--base-url');
  const notes = get('--notes');
  return {
    dir,
    ...(outDir === undefined ? {} : { outDir: path.resolve(repoRoot, outDir) }),
    ...(version === undefined ? {} : { version }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(notes === undefined ? {} : { notes }),
    channel: get('--channel') === 'beta' ? 'beta' : 'stable',
    strict: argv.includes('--strict'),
    enforceBudget: !argv.includes('--no-budget'),
  };
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const result = buildRelease(options);
  console.log(
    `\n发布产物已生成于 ${path.relative(repoRoot, options.outDir ?? options.dir) || '.'}（v${result.version}）：`,
  );
  console.log('  latest.json / latest.yml / release-manifest.json / distribution.html');
  for (const warning of result.warnings) console.log(`  WARN  ${warning}`);
  if (result.problems.length > 0) {
    console.error(`\n发布门禁未通过：\n${result.problems.map((item) => `  - ${item}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\n发布门禁通过（体积 NFR-P-09 / 签名 / 产物完整性）');
}
