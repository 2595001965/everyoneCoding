/**
 * 版本检查路由：按 form=tauri|electron 分别下发版本与增量包清单。
 * 客户端离线可用，本接口仅用于「版本更新」场景（PRD §8）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

interface ReleaseManifest {
  form: 'tauri' | 'electron';
  version: string;
  channel: string;
  publishedAt: string;
  notes: string;
  installer: { url: string; size: number; signature?: string };
  patch?: { from: string; to: string; url: string; size: number };
}

// 静态发布信息（最小实现；生产应由构建流水线注入）。
const RELEASES: Record<'tauri' | 'electron', ReleaseManifest> = {
  tauri: {
    form: 'tauri',
    version: '1.3.0',
    channel: 'stable',
    publishedAt: '2026-09-01T00:00:00Z',
    notes: 'Tauri 版：体积优化与稳定性修复',
    installer: {
      url: 'https://update.everyonecoding.app/tauri/EveryoneCoding_1.3.0_x64.msi',
      size: 58_400_000,
      signature: 'tauri-v1:base64-sig-placeholder',
    },
    patch: {
      from: '1.2.0',
      to: '1.3.0',
      url: 'https://update.everyonecoding.app/tauri/patch/1.2.0-1.3.0.bin',
      size: 12_300_000,
    },
  },
  electron: {
    form: 'electron',
    version: '1.3.0',
    channel: 'stable',
    publishedAt: '2026-09-01T00:00:00Z',
    notes: 'Electron 版：运行时内置与兼容性提升',
    installer: {
      url: 'https://update.everyonecoding.app/electron/EveryoneCoding-1.3.0-win-x64.exe',
      size: 196_000_000,
    },
    patch: {
      from: '1.2.0',
      to: '1.3.0',
      url: 'https://update.everyonecoding.app/electron/patch/1.2.0-1.3.0.7z',
      size: 41_500_000,
    },
  },
};

export async function releaseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/release/check', async (req, reply) => {
    const schema = z.object({ form: z.enum(['tauri', 'electron']).default('tauri') });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BAD_REQUEST', message: 'form 参数非法', traceId: '' });
    }
    const manifest = RELEASES[parsed.data.form];
    return reply.send(manifest);
  });
}
