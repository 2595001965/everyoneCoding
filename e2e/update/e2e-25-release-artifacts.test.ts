/**
 * E2E-25 发布产物与更新源（FR-SET-05 / NFR-P-09）。
 *
 * 覆盖 `ci/make-release.mts`（清单生成 + 体积 / 签名 / 完整性门禁）、`ci/minisign.mts`（与 Tauri 同格式的验签）、
 * `ci/update-feed-server.mts`（本地静态更新源：区间请求与故障注入）。
 * 真实安装包上的"旧版 → 新版 → 回滚"演练见同目录 `run-installed-update.mts`（需要先打包，见 docs/RELEASE.md §6）。
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildRelease } from '../../ci/make-release.mts';
import { parsePublicKey, verifyMinisign } from '../../ci/minisign.mts';
import { startFeedServer } from '../../ci/update-feed-server.mts';

/** 生成一把与 `tauri signer generate` 同格式的测试密钥（只在内存里）。 */
function createTestSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const keyId = randomBytes(8);
  const pubText = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`;
  return {
    pubkey: Buffer.from(pubText).toString('base64'),
    sign(data: Buffer): string {
      const signature = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
      const comment = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:test.exe`;
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
      const text = [
        'untrusted comment: signature from tauri secret key',
        Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64'),
        `trusted comment: ${comment}`,
        global.toString('base64'),
        '',
      ].join('\n');
      return Buffer.from(text).toString('base64');
    },
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-release-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function seedArtifacts(
  dir: string,
  version: string,
  signer: ReturnType<typeof createTestSigner> | null,
): { tauri: Buffer; electron: Buffer } {
  const tauri = randomBytes(64 * 1024);
  const electron = randomBytes(96 * 1024);
  fs.writeFileSync(path.join(dir, `EveryoneCoding_${version}_x64-setup.exe`), tauri);
  if (signer !== null) {
    fs.writeFileSync(
      path.join(dir, `EveryoneCoding_${version}_x64-setup.exe.sig`),
      signer.sign(tauri),
    );
  }
  fs.writeFileSync(path.join(dir, `EveryoneCoding-${version}-x64-setup.exe`), electron);
  fs.writeFileSync(path.join(dir, `EveryoneCoding-${version}-x64-setup.exe.blockmap`), 'blockmap');
  return { tauri, electron };
}

const quiet = { now: () => new Date('2026-09-30T00:00:00.000Z') };

describe('E2E-25 发布清单生成与门禁（make-release）', () => {
  it('签名配套时生成四件产物：latest.json 带签名与下载地址、latest.yml 的 sha512 与安装包一致', () => {
    const dir = tempDir();
    const signer = createTestSigner();
    const { electron } = seedArtifacts(dir, '0.2.0', signer);

    const result = buildRelease({
      dir,
      version: '0.2.0',
      pubkey: signer.pubkey,
      strict: true,
      ...quiet,
    });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);

    const latestJson = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    expect(latestJson.version).toBe('0.2.0');
    const platform = latestJson.platforms['windows-x86_64-nsis'];
    expect(platform).toEqual(latestJson.platforms['windows-x86_64']);
    expect(platform.url).toBe(
      'https://github.com/2595001965/everyoneCoding/releases/download/v0.2.0/EveryoneCoding_0.2.0_x64-setup.exe',
    );
    expect(platform.signature).toBe(
      fs.readFileSync(path.join(dir, 'EveryoneCoding_0.2.0_x64-setup.exe.sig'), 'utf8'),
    );

    const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
    const sha = createHash('sha512').update(electron).digest('base64');
    expect(yml).toContain('version: 0.2.0');
    expect(yml).toContain(`sha512: ${sha}`);
    expect(yml).toContain('url: EveryoneCoding-0.2.0-x64-setup.exe');

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'release-manifest.json'), 'utf8'));
    expect(manifest.forms.tauri.updateBundle.signatureCheck).toMatch(/^ok/);
    expect(manifest.forms.electron.blockmap).toBe('EveryoneCoding-0.2.0-x64-setup.exe.blockmap');
    expect(fs.existsSync(path.join(dir, 'distribution.html'))).toBe(true);
  });

  it('签名错误：用另一把私钥签的包被拦下（客户端会拒装，发出去等于全员断更）', () => {
    const dir = tempDir();
    seedArtifacts(dir, '0.2.0', createTestSigner());
    const result = buildRelease({
      dir,
      version: '0.2.0',
      pubkey: createTestSigner().pubkey,
      ...quiet,
    });
    expect(result.problems.join('\n')).toMatch(/验签失败.*不配套/);
  });

  it('产物被二次改动（签名后又替换了安装包）→ 验签失败被拦下', () => {
    const dir = tempDir();
    const signer = createTestSigner();
    seedArtifacts(dir, '0.2.0', signer);
    const file = path.join(dir, 'EveryoneCoding_0.2.0_x64-setup.exe');
    const bytes = fs.readFileSync(file);
    bytes[100] = (bytes[100] ?? 0) ^ 0xff;
    fs.writeFileSync(file, bytes);
    const result = buildRelease({ dir, version: '0.2.0', pubkey: signer.pubkey, ...quiet });
    expect(result.problems.join('\n')).toMatch(/签名与文件内容不符/);
  });

  it('缺 .sig：本地模式只告警，--strict（CI 发版）直接阻断', () => {
    const dir = tempDir();
    seedArtifacts(dir, '0.2.0', null);
    const loose = buildRelease({ dir, version: '0.2.0', ...quiet });
    expect(loose.problems).toEqual([]);
    expect(loose.warnings.join('\n')).toMatch(/TAURI_SIGNING_PRIVATE_KEY/);
    const strict = buildRelease({ dir, version: '0.2.0', strict: true, ...quiet });
    expect(strict.problems.join('\n')).toMatch(/TAURI_SIGNING_PRIVATE_KEY/);
  });

  it('发布目录累积了历史版本：按版本号精确取产物，不会把旧包当新包发', () => {
    const dir = tempDir();
    const signer = createTestSigner();
    seedArtifacts(dir, '0.1.0', signer);
    seedArtifacts(dir, '0.2.0', signer);
    buildRelease({ dir, version: '0.2.0', pubkey: signer.pubkey, strict: true, ...quiet });
    const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
    expect(yml).toContain('path: EveryoneCoding-0.2.0-x64-setup.exe');
    expect(yml).not.toContain('0.1.0');
  });

  it('体积门禁（NFR-P-09）：超预算退出，并在清单里如实记录', () => {
    const dir = tempDir();
    const signer = createTestSigner();
    seedArtifacts(dir, '0.2.0', signer);
    const result = buildRelease({
      dir,
      version: '0.2.0',
      pubkey: signer.pubkey,
      budgets: { tauri: 1024, electron: 1024 * 1024 },
      ...quiet,
    });
    expect(result.problems).toEqual([expect.stringMatching(/^tauri 安装包 .* 超出预算/)]);
  });

  it('本地演练：--base-url 指向本机静态源，清单里的地址随之改写', () => {
    const dir = tempDir();
    const signer = createTestSigner();
    seedArtifacts(dir, '0.2.0', signer);
    buildRelease({
      dir,
      version: '0.2.0',
      pubkey: signer.pubkey,
      baseUrl: 'http://127.0.0.1:18480/',
      ...quiet,
    });
    const latestJson = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    expect(latestJson.platforms['windows-x86_64'].url).toBe(
      'http://127.0.0.1:18480/EveryoneCoding_0.2.0_x64-setup.exe',
    );
  });
});

describe('E2E-25 仓库更新配置不再是占位', () => {
  it('tauri.conf.json 的 pubkey 是可解析的 minisign 公钥、端点是 https 静态 latest.json', () => {
    const conf = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../apps/desktop-tauri/src-tauri/tauri.conf.json'),
        'utf8',
      ),
    );
    const updater = conf.plugins.updater;
    expect(updater.pubkey).not.toMatch(/REPLACE/);
    expect(parsePublicKey(updater.pubkey).keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(updater.endpoints).toEqual([
      'https://github.com/2595001965/everyoneCoding/releases/latest/download/latest.json',
    ]);
    // E2E 本地演练用的 http 放行只能在构建命令里临时合并，不能进正式配置
    expect(updater.dangerousInsecureTransportProtocol).toBeUndefined();
  });

  it('electron-builder 的 publish 指向本仓库 GitHub Releases，不再是 .invalid 占位', () => {
    const yml = fs.readFileSync(
      path.resolve(__dirname, '../../apps/desktop-electron/electron-builder.yml'),
      'utf8',
    );
    expect(yml).not.toMatch(/\.invalid/);
    expect(yml).toMatch(/provider: github\n\s+owner: '2595001965'\n\s+repo: everyoneCoding/);
  });

  it('仓库里没有私钥：只允许出现公钥', () => {
    const conf = fs.readFileSync(
      path.resolve(__dirname, '../../apps/desktop-tauri/src-tauri/tauri.conf.json'),
      'utf8',
    );
    const decoded = Buffer.from(JSON.parse(conf).plugins.updater.pubkey, 'base64').toString('utf8');
    expect(decoded).toMatch(/public key/);
    expect(decoded).not.toMatch(/secret key/i);
  });
});

describe('E2E-25 minisign 验签（与 Tauri 客户端同口径）', () => {
  it('正确签名通过；截断的半包、错钥、坏 base64 都被拒', () => {
    const signer = createTestSigner();
    const data = randomBytes(4096);
    const signature = signer.sign(data);
    const key = parsePublicKey(signer.pubkey);
    expect(verifyMinisign(data, signature, key)).toMatchObject({ ok: true });
    expect(verifyMinisign(data.subarray(0, 2048), signature, key)).toMatchObject({ ok: false });
    expect(
      verifyMinisign(data, signature, parsePublicKey(createTestSigner().pubkey)),
    ).toMatchObject({
      ok: false,
    });
    expect(verifyMinisign(data, '!!!', key)).toMatchObject({ ok: false });
  });
});

describe('E2E-25 本地静态更新源', () => {
  it('支持单区间 / 多区间请求，并能注入半包、篡改、5xx', async () => {
    const dir = tempDir();
    const payload = randomBytes(10_000);
    fs.writeFileSync(path.join(dir, 'a.bin'), payload);
    const server = await startFeedServer({ dir });
    try {
      const single = await fetch(`${server.url}/a.bin`, { headers: { Range: 'bytes=10-19' } });
      expect(single.status).toBe(206);
      expect(Buffer.from(await single.arrayBuffer())).toEqual(payload.subarray(10, 20));

      const multi = await fetch(`${server.url}/a.bin`, { headers: { Range: 'bytes=0-1,100-101' } });
      expect(multi.status).toBe(206);
      expect(multi.headers.get('content-type')).toMatch(/^multipart\/byteranges; boundary=/);

      server.setFault(/a\.bin$/, 'truncate');
      expect((await (await fetch(`${server.url}/a.bin`)).arrayBuffer()).byteLength).toBe(5000);
      server.setFault(/a\.bin$/, 'corrupt');
      const corrupt = Buffer.from(await (await fetch(`${server.url}/a.bin`)).arrayBuffer());
      expect(corrupt.length).toBe(payload.length);
      expect(corrupt.equals(payload)).toBe(false);
      server.setFault(/a\.bin$/, '500');
      expect((await fetch(`${server.url}/a.bin`)).status).toBe(500);

      server.clearFaults();
      expect((await fetch(`${server.url}/../package.json`)).status).toBe(404);
      expect(server.requests.length).toBeGreaterThanOrEqual(6);
    } finally {
      await server.close();
    }
  });
});
