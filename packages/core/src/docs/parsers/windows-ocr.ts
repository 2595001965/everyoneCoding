/**
 * Windows OCR 端口（FR-DOC-01 / T9-04）：Windows.Media.Ocr（WinRT）经 PowerShell 调用。
 *
 * 选型依据（Windows 可分发）：
 * - Windows 10 1607+ 自带 Windows.Media.Ocr，**无外部安装**、无第三方二进制，
 *   Apache-2.0 仓库不引入许可负担；
 * - 调用方式 = 受控子进程跑一段 PowerShell 脚本（脚本落临时文件 UTF-8 BOM——
 *   PS 5.1 对无 BOM 文件按 ANSI 读，中文会乱码），WinRT 异步经
 *   `WindowsRuntimeSystemExtensions.AsTask` 封装的 Await 等待；
 * - 支持语言 = 系统已装语言包（`Windows.Globalization.Language` 枚举），
 *   中文/英文在 zh-CN / en-US 系统上开箱即用；缺失语言包时给出**安装引导**文案；
 * - 识别结果按"行 → 段落"聚合（y 间隔大即分段），输出与 markdown 解析器同构的
 *   `DocSection[]`（level=0 正文块），可直接检索、转记忆。
 *
 * 失败语义（绝不静默降级、绝不伪造文本）：
 * - 引擎/语言不可用 → `availability()` 如实上报 + 安装引导；
 * - 子进程失败 / 输出不可解析 → `recognize` 抛错（由 makeImageParser 包成
 *   `DocDomainError('ocr_unsupported')`，域层映射 NOT_SUPPORTED + 中文原因）；
 * - 识别零文本 → 如实返回空 sections（由 DocService 报 empty_content）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocSection, OcrPort } from '../doc-types';

/** OCR 可用性（域方法 ocrStatus 的返回形状） */
export interface OcrAvailability {
  available: boolean;
  /** 引擎侧原因（不可用时给出） */
  reason: string | null;
  /** 系统已装的可识别语言（BCP-47 标签，如 zh-CN / en-US） */
  languages: string[];
  /** 引擎描述（含安装引导说明） */
  detail: string;
}

const DEFAULT_LANGUAGE = 'zh-CN';

const WINRT_HELPERS = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtOperation, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtOperation))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
`.trim();

/** 探测脚本：输出 JSON（可用性 + 语言清单） */
const PROBE_SCRIPT = `
${WINRT_HELPERS}
$langs = @()
foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $langs += $l.LanguageTag }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$avail = $null -ne $engine
$reason = $null
if (-not $avail) {
  $reason = '未从系统语言包创建出 OCR 引擎。请在 Windows 设置 → 时间和语言 → 语言和区域 → 添加语言（如中文简体 / English）后重试。'
}
Write-Output (@{ available = $avail; reason = $reason; languages = $langs } | ConvertTo-Json -Compress)
`.trim();

/** 识别脚本：读图片 → WinRT OCR → 输出行级 JSON */
function recognitionScript(imagePath: string, language: string): string {
  const safePath = imagePath.replace(/'/g, "''");
  const safeLang = language.replace(/'/g, "''");
  return `
${WINRT_HELPERS}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::CreateLanguage('${safeLang}'))
if ($null -eq $engine) { Write-Output '{"error":"lang_unavailable"}'; exit 0 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${safePath}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $result.Lines) {
  $text = ($line.Words | ForEach-Object { $_.Text }) -join ' '
  $lines += @{ text = $text; y = $line.BoundingRect.Y; h = $line.BoundingRect.Height }
}
Write-Output (@{ lines = $lines } | ConvertTo-Json -Compress -Depth 4)
`.trim();
}

/** 受控跑 PowerShell：脚本落临时 .ps1（UTF-8 BOM），超时保护，stdout 取 JSON 行 */
function runPowerShellScript(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'ec-ocr-ps-'));
    const scriptPath = join(dir, 'script.ps1');
    // UTF-8 BOM：PowerShell 5.1 对无 BOM 文件按 ANSI 解码，中文会乱
    writeFileSync(
      scriptPath,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, 'utf8')]),
    );
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
      reject(new Error(`OCR 子进程超时（${timeoutMs}ms）`));
    }, timeoutMs);
    // Windows PowerShell 5.1 的默认输出编码是系统 ANSI（GBK/cp936）；
    // 脚本内已强制 [Console]::OutputEncoding = UTF8，但老系统可能被策略覆盖，
    // 这里做双保险：先按 UTF-8 解，含 U+FFFD（乱码指纹）再按 GBK 解一次
    // （Node 24 full-ICU 自带 gbk 解码表）。
    const gbkDecoder = new TextDecoder('gbk');
    const decode = (buffer: Buffer): string => {
      const utf8 = buffer.toString('utf8');
      return utf8.includes('\uFFFD') ? gbkDecoder.decode(buffer) : utf8;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += decode(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += decode(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      reject(new Error(`OCR 子进程启动失败：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      if (code !== 0 && stdout.trim().length === 0) {
        reject(new Error(`OCR 子进程退出码 ${code}：${stderr.slice(0, 300)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** 从 stdout 提取最后一个完整 JSON 行（PowerShell 可能前吐杂音） */
function parseJsonLine<T>(stdout: string): T {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  const last = lines[lines.length - 1];
  if (!last) throw new Error(`OCR 输出不可解析：${stdout.slice(0, 200)}`);
  return JSON.parse(last) as T;
}

/** 把 OCR 行聚合成段落（y 间隔 > 0.9×行高近似空行 → 分段；同段行拼接） */
export function aggregateLinesToSections(
  lines: Array<{ text: string; y: number; h: number }>,
): DocSection[] {
  if (lines.length === 0) return [];
  const sorted = [...lines]
    .map((line) => ({ ...line, text: line.text.replace(/\s+/g, ' ').trim() }))
    .filter((line) => line.text.length > 0)
    .sort((a, b) => a.y - b.y);
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  let prev: { y: number; h: number } | null = null;
  for (const line of sorted) {
    if (prev !== null && line.y - prev.y > Math.max(prev.h, line.h) * 0.9) {
      paragraphs.push(buffer.join(' '));
      buffer = [];
    }
    buffer.push(line.text);
    prev = { y: line.y, h: line.h };
  }
  if (buffer.length > 0) paragraphs.push(buffer.join(' '));

  return paragraphs.map((text, index) => ({
    index,
    level: 0,
    heading: '',
    anchor: `sec-${index}`,
    text,
  }));
}

/** 探测本机 OCR 可用性（域方法 ocrStatus 的实现基础） */
export async function probeWindowsOcr(timeoutMs = 15_000): Promise<OcrAvailability> {
  const notWindows: OcrAvailability = {
    available: false,
    reason: '当前系统不是 Windows，Windows.Media.Ocr 引擎不可用',
    languages: [],
    detail: 'Windows OCR 需要 Windows 10 1607 及以上系统',
  };
  if (process.platform !== 'win32') return notWindows;
  try {
    const stdout = await runPowerShellScript(PROBE_SCRIPT, timeoutMs);
    const parsed = parseJsonLine<{
      available: boolean;
      reason: string | null;
      languages: string[];
    }>(stdout);
    return {
      available: parsed.available === true,
      reason: parsed.available === true ? null : (parsed.reason ?? 'OCR 引擎不可用'),
      languages: Array.isArray(parsed.languages) ? parsed.languages : [],
      detail: 'Windows.Media.Ocr（系统内置引擎，无需安装第三方组件）；可识别语言跟随系统语言包',
    };
  } catch (error) {
    return {
      available: false,
      reason: `OCR 探测失败：${error instanceof Error ? error.message : String(error)}`,
      languages: [],
      detail: 'Windows.Media.Ocr（系统内置引擎，无需安装第三方组件）',
    };
  }
}

/** Windows OCR 端口（实现 core 的 OcrPort 契约） */
export function createWindowsOcrPort(
  options?:
    | {
        /** 识别语言（BCP-47）；默认 zh-CN，语言包缺失时按探测结果给安装引导 */
        language?: string | undefined;
        timeoutMs?: number | undefined;
      }
    | undefined,
): OcrPort & { availability: () => Promise<OcrAvailability> } {
  const language = options?.language ?? DEFAULT_LANGUAGE;
  const timeoutMs = options?.timeoutMs ?? 60_000;

  return {
    availability: () => probeWindowsOcr(options?.timeoutMs ?? 15_000),

    async recognize(input) {
      if (process.platform !== 'win32') {
        throw new Error(
          '当前系统不是 Windows：Windows OCR 引擎不可用。请在 Windows 10+ 上使用图片导入。',
        );
      }
      // 字节落临时文件（WinRT 需要路径）；扩展名从 fileName 取（BitmapDecoder 按内容嗅探）
      const ext =
        input.fileName && input.fileName.includes('.')
          ? input.fileName.slice(input.fileName.lastIndexOf('.'))
          : '.png';
      const dir = mkdtempSync(join(tmpdir(), 'ec-ocr-'));
      const imagePath = join(dir, `image${ext}`);
      try {
        writeFileSync(imagePath, input.raw);
        const stdout = await runPowerShellScript(recognitionScript(imagePath, language), timeoutMs);
        const parsed = parseJsonLine<{
          error?: string;
          lines?: Array<{ text: string; y: number; h: number }>;
        }>(stdout);
        if (parsed.error === 'lang_unavailable') {
          throw new Error(
            `系统未安装「${language}」语言包，无法识别该语言。请在 Windows 设置 → 时间和语言 → 语言和区域 → 添加语言（如中文简体 / English）后重试。`,
          );
        }
        const sections = aggregateLinesToSections(parsed.lines ?? []);
        return { title: input.fileName ?? '图片文档', sections };
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* 临时目录清理失败不影响识别结果 */
        }
      }
    },
  };
}
