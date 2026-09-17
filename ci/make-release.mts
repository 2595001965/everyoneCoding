/**
 * 发布产物编排（T10-04 / D-01 / NFR-P-09）。
 *
 * 双形态安装包产出后，本脚本负责把它们**收敛成同一条更新通道**：
 *   - `latest.json`            Tauri Updater 的响应体（含 minisign 签名）
 *   - `latest.yml`             electron-updater 的清单（sha512 / size）
 *   - `release-manifest.json`  双形态统一清单（版本、体积、校验和、下载 URL）
 *   - `distribution.html`      分发页（双形态并列下载 + 差异说明）
 *
 * 同时做**体积门禁**：Tauri ≤60MB、Electron ≤200MB（NFR-P-09），超限直接退出码 1。
 *
 * 用法：
 *   node --experimental-strip-types ci/make-release.mts --dir release-artifacts \
 *     --base-url https://update.everyonecoding.com --notes "首个正式版"
 *
 * 产物命名约定（与本仓 CI 一致）：
 *   Tauri    EveryoneCoding_<version>_x64-setup.exe        安装包
 *            EveryoneCoding_<version>_x64-setup.nsis.zip   更新包（含 .sig 签名）
 *   Electron EveryoneCoding-<version>-x64-setup.exe        安装包 + 更新包同文件
 *
 * 本仓库以 Apache-2.0 开源：源码公开发布，安装产物通过更新服务分发。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** NFR-P-09 体积预算（字节） */
const BUDGET_BYTES = {
  tauri: 60 * 1024 * 1024,
  electron: 200 * 1024 * 1024,
} as const;

interface Artifact {
  file: string;
  bytes: number;
  sha512Base64: string;
}

interface Args {
  dir: string;
  outDir: string;
  baseUrl: string;
  notes: string;
  channel: 'stable' | 'beta';
  enforceBudget: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string => {
    const index = argv.indexOf(flag);
    if (index < 0) {
      if (fallback === undefined) throw new Error(`缺少参数 ${flag}`);
      return fallback;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} 缺少取值`);
    return value;
  };
  const dir = path.resolve(repoRoot, get('--dir', 'release-artifacts'));
  return {
    dir,
    outDir: path.resolve(repoRoot, get('--out-dir', path.relative(repoRoot, dir))),
    baseUrl: get('--base-url', 'https://update.everyonecoding.com').replace(/\/+$/, ''),
    notes: get('--notes', ''),
    channel: get('--channel', 'stable') === 'beta' ? 'beta' : 'stable',
    enforceBudget: !argv.includes('--no-budget'),
  };
}

function readRootVersion(): string {
  const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  const version = (JSON.parse(raw) as { version?: string }).version;
  if (typeof version !== 'string' || version === '') throw new Error('根 package.json 缺少 version');
  return version;
}

function describeArtifact(file: string): Artifact {
  const bytes = fs.readFileSync(file);
  return {
    file: path.basename(file),
    bytes: bytes.byteLength,
    sha512Base64: createHash('sha512').update(bytes).digest('base64'),
  };
}

function fileSizeOf(file: string): number {
  return fs.statSync(file).size;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function findFirst(dir: string, pattern: RegExp, exclude: RegExp[] = []): string | null {
  const names = fs.readdirSync(dir).filter((name) => pattern.test(name) && !exclude.some((re) => re.test(name)));
  names.sort();
  const first = names[0];
  return first === undefined ? null : path.join(dir, first);
}

const ZIP_RE = /\.nsis\.zip$/;
const SIG_RE = /\.nsis\.zip\.sig$/;
/** Tauri 版命名用下划线：`EveryoneCoding_<version>_x64-setup.exe` */
const TAURI_EXE_RE = /_x64-setup\.exe$/;
/** Electron 版命名用连字符：`EveryoneCoding-<version>-x64-setup.exe` */
const ELECTRON_EXE_RE = /-x64-setup\.exe$/;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dir)) {
    throw new Error(`产物目录不存在：${args.dir}（先跑 build:tauri / build:electron，或传 --dir）`);
  }
  fs.mkdirSync(args.outDir, { recursive: true });

  const version = readRootVersion();
  const tauriInstaller = findFirst(args.dir, TAURI_EXE_RE);
  const electronInstaller = findFirst(args.dir, ELECTRON_EXE_RE);
  const tauriUpdateBundle = findFirst(args.dir, ZIP_RE, [SIG_RE]);
  const tauriSignature = findFirst(args.dir, SIG_RE);

  const problems: string[] = [];
  const warnings: string[] = [];

  // ---- 体积门禁（NFR-P-09）----
  const sizes: Record<string, number> = {};
  if (tauriInstaller !== null) sizes['tauri'] = fileSizeOf(tauriInstaller);
  if (electronInstaller !== null) sizes['electron'] = fileSizeOf(electronInstaller);
  for (const [kind, size] of Object.entries(sizes)) {
    const budget = BUDGET_BYTES[kind as keyof typeof BUDGET_BYTES];
    const verdict = size <= budget ? 'PASS' : 'FAIL';
    console.log(`  ${verdict}  ${kind} 安装包 ${mb(size)}（预算 ≤${mb(budget)}）`);
    if (size > budget) problems.push(`${kind} 安装包 ${mb(size)} 超出预算 ${mb(budget)}`);
  }

  if (tauriInstaller === null) warnings.push('未找到 Tauri NSIS 安装包（EveryoneCoding_<v>_x64-setup.exe）');
  if (electronInstaller === null) warnings.push('未找到 Electron NSIS 安装包（EveryoneCoding-<v>-x64-setup.exe）');
  if (tauriUpdateBundle === null) warnings.push('未找到 Tauri 更新包（*.nsis.zip），latest.json 将缺少下载地址');

  // ---- Tauri Updater 响应体 ----
  const signature =
    tauriSignature !== null ? fs.readFileSync(tauriSignature, 'utf8').trim() : 'REPLACE_WITH_MINISIGN_SIGNATURE';
  if (tauriSignature === null) {
    warnings.push('未找到 .sig 签名文件：latest.json 的 signature 是占位符，正式发布前必须用私钥签名');
  }
  const updateBundleUrl =
    tauriUpdateBundle === null
      ? ''
      : `${args.baseUrl}/${args.channel}/windows-x86_64/${path.basename(tauriUpdateBundle)}`;

  const latestJson = {
    version,
    notes: args.notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature,
        url: updateBundleUrl,
      },
    },
  };
  fs.writeFileSync(path.join(args.outDir, 'latest.json'), `${JSON.stringify(latestJson, null, 2)}\n`, 'utf8');

  // ---- electron-updater 清单 ----
  let latestYml: string;
  if (electronInstaller === null) {
    latestYml = `# 未找到 Electron 安装包，清单为空占位（CI 中 electron-builder 会自行产出 latest.yml）\nversion: ${version}\nfiles: []\npath: ''\nsha512: ''\nreleaseDate: ${new Date().toISOString()}\n`;
  } else {
    const artifact = describeArtifact(electronInstaller);
    latestYml = [
      `version: ${version}`,
      'files:',
      `  - url: ${artifact.file}`,
      `    sha512: ${artifact.sha512Base64}`,
      `    size: ${artifact.bytes}`,
      `path: ${artifact.file}`,
      `sha512: ${artifact.sha512Base64}`,
      `releaseDate: ${new Date().toISOString()}`,
      ...(args.notes === '' ? [] : [`releaseNotes: ${JSON.stringify(args.notes)}`]),
      '',
    ].join('\n');
  }
  fs.writeFileSync(path.join(args.outDir, 'latest.yml'), latestYml, 'utf8');

  // ---- 双形态统一清单 ----
  const manifest = {
    product: 'EveryoneCoding',
    version,
    channel: args.channel,
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    forms: {
      tauri: {
        installer: tauriInstaller === null ? null : describeArtifact(tauriInstaller),
        updateBundle:
          tauriUpdateBundle === null ? null : { ...describeArtifact(tauriUpdateBundle), signature },
        budgetBytes: BUDGET_BYTES.tauri,
      },
      electron: {
        installer: electronInstaller === null ? null : describeArtifact(electronInstaller),
        budgetBytes: BUDGET_BYTES.electron,
      },
    },
    // 更新服务路由约定：Tauri 端点带模板变量，服务按 current_version 决定返回 204 还是 latest.json
    endpoints: {
      tauri: `${args.baseUrl}/${args.channel}/{{target}}/{{arch}}/{{current_version}}`,
      electron: `${args.baseUrl}/${args.channel}/`,
    },
    warnings,
  };
  fs.writeFileSync(
    path.join(args.outDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  // ---- 分发页 ----
  fs.writeFileSync(path.join(args.outDir, 'distribution.html'), renderDistributionPage(manifest), 'utf8');

  console.log(`\n发布产物已生成于 ${path.relative(repoRoot, args.outDir)}：`);
  console.log('  latest.json             Tauri Updater 响应体');
  console.log('  latest.yml              electron-updater 清单');
  console.log('  release-manifest.json   双形态统一清单');
  console.log('  distribution.html       分发页');
  for (const warning of warnings) console.log(`  WARN  ${warning}`);

  if (problems.length > 0) {
    console.error(`\n体积门禁未通过：\n${problems.map((item) => `  - ${item}`).join('\n')}`);
    process.exit(1);
  }
  if (args.enforceBudget) console.log('\n体积门禁通过（NFR-P-09）');
}

/** 分发页：双形态并列下载 + 差异说明（静态 HTML，CI 产出后随产物上传）。 */
function renderDistributionPage(manifest: {
  version: string;
  channel: string;
  baseUrl: string;
  forms: {
    tauri: { installer: Artifact | null };
    electron: { installer: Artifact | null };
  };
}): string {
  const link = (file: string): string => `${manifest.baseUrl}/${manifest.channel}/${file}`;
  const sizeText = (artifact: Artifact | null): string =>
    artifact === null ? '尚未产出' : `${(artifact.bytes / 1024 / 1024).toFixed(2)} MB`;
  const href = (artifact: Artifact | null): string =>
    artifact === null ? '#' : link(artifact.file);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>EveryoneCoding ${manifest.version} 下载</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 48px 24px; line-height: 1.6; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  .ver { color: #888; margin-bottom: 32px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 24px; }
  .card h2 { margin: 0 0 4px; font-size: 20px; }
  .tag { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid #8886; margin-left: 8px; }
  .size { color: #888; font-size: 13px; }
  ul { padding-left: 20px; }
  .dl { display: inline-block; margin-top: 12px; padding: 10px 20px; border-radius: 8px; background: #2563eb; color: #fff; text-decoration: none; }
  .dl[href="#"] { background: #8886; pointer-events: none; }
  table { border-collapse: collapse; width: 100%; margin-top: 32px; }
  th, td { border: 1px solid #8884; padding: 8px 12px; text-align: left; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>EveryoneCoding 桌面端</h1>
  <p class="ver">版本 ${manifest.version} · ${manifest.channel} 通道 · 两种形态功能等价，任选其一</p>
  <div class="cards">
    <section class="card">
      <h2>Tauri 2 版<span class="tag">推荐</span></h2>
      <p class="size">安装包 ${sizeText(manifest.forms.tauri.installer)}（预算上限 60MB）</p>
      <ul>
        <li>包体小、启动快、内存占用低（基于系统 WebView2）</li>
        <li>需要系统已安装 WebView2 运行时（安装器会引导）</li>
        <li>适合日常开发与长时间常驻</li>
      </ul>
      <a class="dl" href="${href(manifest.forms.tauri.installer)}">下载 Windows 安装包</a>
    </section>
    <section class="card">
      <h2>Electron 版</h2>
      <p class="size">安装包 ${sizeText(manifest.forms.electron.installer)}（预算上限 200MB）</p>
      <ul>
        <li>自带 Chromium 与 Node 运行时，环境依赖少</li>
        <li>生态成熟，原生模块兼容性更好</li>
        <li>包体与内存占用高于 Tauri 版</li>
      </ul>
      <a class="dl" href="${href(manifest.forms.electron.installer)}">下载 Windows 安装包</a>
    </section>
  </div>
  <table>
    <tr><th>对比项</th><th>Tauri 2 版</th><th>Electron 版</th></tr>
    <tr><td>包体预算</td><td>≤60MB</td><td>≤200MB</td></tr>
    <tr><td>内存预算（空闲 / 大型项目）</td><td>≤300MB / ≤1.2GB</td><td>≤500MB / ≤2GB</td></tr>
    <tr><td>运行时依赖</td><td>系统 WebView2</td><td>内置 Chromium + Node</td></tr>
    <tr><td>更新机制</td><td>Tauri Updater（minisign 签名）</td><td>electron-updater（sha512 校验）</td></tr>
    <tr><td>功能范围</td><td colspan="2">完全等价（同一套渲染层与领域包，D-01）</td></tr>
  </table>
</main>
</body>
</html>
`;
}

main();
