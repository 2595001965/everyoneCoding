/**
 * Windows OCR 真机集成测试（opt-in 语义：非 Windows 或引擎不可用时跳过，并打印原因）。
 *
 * 不用夹具：现场用 System.Drawing 渲染一张带英文文字的 PNG，交给真实的
 * `createWindowsOcrPort()`（WinRT Windows.Media.Ocr 子进程）识别，
 * 再经 DocService 入库并检索——验证"图片导入 → 可检索文本"在本机真的成立。
 *
 * 引擎不可用（未装任何 OCR 语言包 / 组策略禁用）时 `ctx.skip()`：这属于环境前置条件，
 * 而非代码缺陷；可用性判断本身另有单测覆盖（domain-docs 的 ocrStatus）。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DocService } from '../doc-service';
import type { DocStore, DocMemoryPort, DocumentRowSnapshot } from '../doc-types';
import { createDefaultParserRegistry } from '../parsers/node-registry';
import { createWindowsOcrPort, probeWindowsOcr } from '../parsers/windows-ocr';

function renderTextPng(text: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'ec-ocr-it-'));
  try {
    const png = join(dir, 'text.png');
    const script = join(dir, 'render.ps1');
    // UTF-8 BOM：PS 5.1 对无 BOM 脚本按 ANSI 读，中文样例会乱码
    writeFileSync(
      script,
      '﻿' +
        [
          'Add-Type -AssemblyName System.Drawing',
          '$bmp = New-Object System.Drawing.Bitmap 900, 160',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$g.Clear([System.Drawing.Color]::White)',
          "$font = New-Object System.Drawing.Font 'Arial', 40",
          `$g.DrawString('${text.replace(/'/g, "''")}', $font, [System.Drawing.Brushes]::Black, 20, 40)`,
          `$bmp.Save('${png.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
        ].join('\n'),
      'utf8',
    );
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, timeout: 30_000 },
    );
    if (result.status !== 0) throw new Error(`渲染测试图片失败：${String(result.stderr)}`);
    return new Uint8Array(readFileSync(png));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function memoryStore(): DocStore {
  const rows = new Map<string, DocumentRowSnapshot>();
  return {
    loadAll: async (projectId) => [...rows.values()].filter((r) => r.project_id === projectId),
    loadById: async (id) => rows.get(id) ?? null,
    insert: async (row) => void rows.set(row.id, row),
    update: async (id, patch) => void rows.set(id, { ...rows.get(id)!, ...patch }),
    deleteRow: async (id) => void rows.delete(id),
    saveVersion: async () => undefined,
    loadVersions: async () => [],
  };
}

const unusedMemory = new Proxy({} as DocMemoryPort, {
  get: () => () => Promise.reject(new Error('本测试不涉及记忆端口')),
});

describe.runIf(process.platform === 'win32')('Windows OCR 真机识别', () => {
  it('渲染的文字图片 → 真实 OCR（显式语言与缺省语言各一次）→ 入库后可检索', async (ctx) => {
    const status = await probeWindowsOcr(30_000);
    const language = status.languages[0];
    if (!status.available || !language) {
      console.warn(`[跳过] Windows OCR 不可用：${status.reason ?? '未装任何可识别语言'}`);
      ctx.skip();
      return;
    }
    // 按本机已装的识别语言出题：中文系统常只有 zh-Hans-CN
    const chinese = language.toLowerCase().startsWith('zh');
    const sample = chinese ? '发票编号 4821' : 'Invoice Number 4821';
    const keyword = chinese ? '发票' : 'invoice';

    const service = new DocService({
      store: memoryStore(),
      parsers: createDefaultParserRegistry({ ocr: createWindowsOcrPort({ timeoutMs: 60_000 }) }),
      memory: unusedMemory,
    });
    const png = renderTextPng(sample);
    const explicit = await service.importDocument({
      projectId: 'p1',
      format: 'image',
      raw: png,
      fileName: 'invoice.png',
      ocrLanguage: language,
    });
    expect(explicit.contentText.replace(/\s+/g, '').toLowerCase()).toContain(keyword);

    if (chinese) {
      // 缺省语言（zh-CN）必须能落到系统的 zh-Hans-CN 识别器上，否则中文用户"不选语言"就失败
      const byDefault = await service.importDocument({
        projectId: 'p1',
        format: 'image',
        raw: png,
        fileName: 'invoice-default.png',
      });
      expect(byDefault.contentText.replace(/\s+/g, '')).toContain(keyword);
    }

    const hits = await service.searchDocuments('p1', keyword);
    expect(hits.map((hit) => hit.docId)).toContain(explicit.id);
  }, 180_000);
});
