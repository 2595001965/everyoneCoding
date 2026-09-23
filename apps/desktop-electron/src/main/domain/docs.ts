import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

import { newUlid } from '@ec/data';
import {
  DocDomainError,
  DocService,
  createDefaultParserRegistry,
  createWindowsOcrPort,
  type DocFormat,
  type DocKind,
  type DocLinkType,
  type DocMemoryScope,
  type DocSourceRef,
  type ImportDocumentInput,
  type MemoryExtractionPort,
  type OcrPort,
  type UpdateDocumentInput,
} from '@ec/core';
import { ShellError, type ShellErrorCode } from '@ec/shell-api';

import { LOCAL_USER_ID } from './db';
import { errorOfStreamChunk, textOfStreamChunk } from './ai-stream-text';
import type { AiStackHandle } from './domain-factories';
import type { DomainRouter } from './runtime';
import {
  countLinksForMemories,
  createSqliteDocMemoryPort,
  createSqliteDocStore,
} from './sqlite-doc-store';

/**
 * docs 域运行时（文档中心，21 个方法）。
 *
 * 组成全部复用 `@ec/core` 的文档域：
 * - `DocService` 负责解析、版本、更新提示、关联与转记忆的业务逻辑；
 * - `DocStore` / `DocMemoryPort` 由本目录的 SQLite 适配器提供（见 `sqlite-doc-store.ts`）；
 * - 解析器注册表用 `createDefaultParserRegistry({ ocr })`：
 *   markdown / txt / docx / pdf 全可用；**image 走 Windows.Media.Ocr**
 *   （系统内置引擎，语言包缺失时给安装引导，绝不伪造文本）。
 *
 * **AI 摘要端口（`MemoryExtractionPort`）真实接线**：
 * `previewConvertToMemory`（一键转记忆）经 AI 网关 `purpose: 'memory-extract'`
 * 生成结构化摘要，保留来源文档与段落锚点；AI 栈未装配时如实报
 * `extraction_unavailable`（带配置引导），**不内置模板顶替、不伪造摘要**。
 */

export interface DocsDomainOptions {
  db: Database.Database;
  userId?: string;
  /** AI 栈句柄（null = 未装配：转记忆如实报错并给配置引导） */
  aiStack?: AiStackHandle | null;
  /** OCR 端口（缺省用 Windows OCR；测试可注入假实现） */
  ocr?: OcrPort | null;
  /** 提取摘要时的模型用途绑定（默认 memory-extract） */
  extractionPurpose?: string | undefined;
}

/**
 * AI 摘要端口（经 AI 网关 memory-extract 用途）。
 *
 * 提示词要求模型输出「标题行 + 空行 + 摘要正文」；解析失败/空输出抛错，
 * 让 DocService 的 `extraction` 错误路径如实上报——**绝不拿模板文本顶替**。
 */
export function createGatewayExtractionPort(
  aiStack: AiStackHandle,
  userId: string,
  purpose = 'memory-extract',
): MemoryExtractionPort {
  return {
    async summarize(input: {
      title: string;
      text: string;
      scope: string;
      sourceRef?: { docId: string; anchor?: string | null; page?: number | null } | null;
    }) {
      const scopeLabel =
        input.scope === 'longterm'
          ? '长期记忆'
          : input.scope === 'project'
            ? '项目记忆'
            : input.scope === 'feature'
              ? '功能记忆'
              : input.scope === 'page'
                ? '页面记忆'
                : '问题记忆';
      let text = '';
      let model = '';
      for await (const chunk of aiStack.gateway.chat({
        userId,
        purpose,
        messages: [
          {
            role: 'system',
            content:
              `你是文档摘要助手。把给定文档/片段整理成一条${scopeLabel}。` +
              '输出格式：第一行是「标题：」开头的记忆标题；空一行；然后是结构化摘要正文' +
              '（要点用短横线列出，保留关键数字与结论）。不要输出其它解释。',
          },
          {
            role: 'user',
            content: `文档标题：${input.title}\n${input.sourceRef?.anchor ? `段落锚点：${input.sourceRef.anchor}\n` : ''}正文：\n${input.text}`,
          },
        ],
      })) {
        // 文本块判别值是 `delta`（见 ai-stream-text.ts 的说明：这里曾错写成 'chunk'，
        // 结果 AI 摘要恒为空串，报"输出为空"把排查方向带偏到模型配置上）
        const delta = textOfStreamChunk(chunk);
        text += delta.text;
        if (delta.model !== null) model = delta.model;
        const streamError = errorOfStreamChunk(chunk);
        if (streamError !== null) {
          throw new Error(`AI 摘要失败：${streamError}`);
        }
      }
      const parsed = parseSummaryOutput(text, input.title);
      if (parsed === null) {
        throw new Error(
          `AI 摘要输出为空${model ? `（模型：${model}）` : ''}：请检查设置页的模型服务与 API Key 配置后重试。`,
        );
      }
      return parsed;
    },
  };
}

/** 解析「标题：xxx\n\n正文」输出；不合规矩返回 null（由调用方如实报错） */
function parseSummaryOutput(
  raw: string,
  fallbackTitle: string,
): { title: string; content: string } | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const match = text.match(/^标题[:：]\s*(.+)\s*$/m);
  if (match) {
    const title = match[1]!.trim();
    const content = text
      .slice(text.indexOf(match[0]) + match[0].length)
      .replace(/^\s+/, '')
      .trim();
    return {
      title: title.length > 0 ? title : fallbackTitle,
      content: content.length > 0 ? content : text,
    };
  }
  // 模型没按格式给标题：整段作为正文，标题用文档标题
  return { title: fallbackTitle, content: text };
}

export function createDocsDomain(options: DocsDomainOptions): { router: DomainRouter } {
  const { db } = options;
  const userId = options.userId ?? LOCAL_USER_ID;
  const aiStack = options.aiStack ?? null;

  const ocr = options.ocr !== undefined ? options.ocr : createWindowsOcrPort();
  const parsers = createDefaultParserRegistry({ ocr });
  const service = new DocService({
    store: createSqliteDocStore(db),
    parsers,
    memory: createSqliteDocMemoryPort({ db, userId, newId: newUlid, clock: Date.now }),
    // AI 摘要端口：AI 栈装配才注入；未装配时 DocService 报 extraction_unavailable（带引导）
    ...(aiStack !== null
      ? {
          extraction: createGatewayExtractionPort(
            aiStack,
            userId,
            options.extractionPurpose ?? 'memory-extract',
          ),
        }
      : {}),
    newId: newUlid,
  });

  /** 需要按文本解析的格式：其余（docx/pdf/image）按字节读，交给各自的解析器 */
  const TEXT_FORMATS: readonly DocFormat[] = ['markdown', 'txt'];

  const router: DomainRouter = async (method, params) => {
    try {
      switch (method) {
        case 'listDocuments':
          return await service.listDocuments(
            String(params['projectId']),
            (params['opts'] ?? {}) as {
              includeDeleted?: boolean | undefined;
            },
          );

        case 'getDocument':
          return await service.getDocument(String(params['id']));

        case 'importDocument': {
          const input = params['input'] as {
            projectId: string;
            format: DocFormat;
            raw: string | Uint8Array;
            title?: string | undefined;
            kind?: DocKind | undefined;
            sourceRef?: string | null | undefined;
          };
          return await service.importDocument(input as ImportDocumentInput);
        }

        case 'importFromFile': {
          const input = params['input'] as {
            projectId: string;
            format: DocFormat;
            filePath: string;
            title?: string | undefined;
            kind?: DocKind | undefined;
            ocrLanguage?: string | undefined;
          };
          let raw: string | Uint8Array;
          try {
            raw = TEXT_FORMATS.includes(input.format)
              ? readFileSync(input.filePath, 'utf8')
              : readFileSync(input.filePath);
          } catch (error) {
            throw new ShellError(
              'NOT_FOUND',
              `读取待导入文件失败：${input.filePath}（${error instanceof Error ? error.message : String(error)}）`,
            );
          }
          return await service.importDocument({
            projectId: input.projectId,
            format: input.format,
            raw,
            title: input.title,
            kind: input.kind,
            // 记下来源文件路径，便于"文档已更新"的溯源展示
            sourceRef: input.filePath,
          });
        }

        case 'updateDocument':
          return await service.updateDocument(params['input'] as UpdateDocumentInput);

        case 'deleteDocument':
          await service.deleteDocument(String(params['id']));
          return undefined;

        case 'restoreDocument':
          await service.restoreDocument(String(params['id']));
          return undefined;

        case 'purgeDocument':
          await service.purgeDocument(String(params['id']));
          return undefined;

        case 'listVersions':
          return await service.listVersions(String(params['id']));

        case 'ignoreVersion':
          await service.ignoreVersion(String(params['id']), Number(params['version']));
          return undefined;

        case 'evaluateUpdateStatus':
          return await service.evaluateDocUpdateStatus(String(params['id']));

        case 'listMemoryNodes': {
          const projectId = params['projectId'];
          return await service.listMemoryNodes(typeof projectId === 'string' ? projectId : null);
        }

        case 'listDocLinks':
          return await service.listDocLinks(String(params['documentId']));

        case 'listMemoryRefs':
          return await service.listMemoryRefs(String(params['memoryId']));

        case 'linkToMemory': {
          const input = params['input'] as {
            memoryId: string;
            documentId: string;
            linkType: DocLinkType;
          };
          return await service.linkToMemory(input);
        }

        case 'removeLink':
          await service.removeLink(String(params['id']));
          return undefined;

        case 'countLinksForMemories': {
          const memoryIds = params['memoryIds'];
          return countLinksForMemories(db, Array.isArray(memoryIds) ? (memoryIds as string[]) : []);
        }

        case 'previewConvertToMemory': {
          const input = params['input'] as {
            docId: string;
            scope: DocMemoryScope;
            anchor?: string | undefined;
          };
          return await service.previewConvertToMemory(input);
        }

        case 'commitConvertToMemory': {
          const input = params['input'] as {
            projectId: string;
            draft: {
              docId: string;
              scope: DocMemoryScope;
              title: string;
              content: string;
              sourceRef: DocSourceRef;
            };
            scope?: DocMemoryScope | undefined;
          };
          return await service.commitConvertToMemory(input);
        }

        case 'supportedFormats':
          return parsers.supported();

        case 'ocrStatus': {
          const availability = await (
            ocr as OcrPort & { availability?: () => Promise<unknown> }
          ).availability?.();
          return (
            availability ?? {
              available: false,
              reason: '当前 OCR 端口不支持可用性探测',
              languages: [],
              detail: 'OCR 能力由外壳注入',
            }
          );
        }

        default:
          throw new ShellError('INVALID_ARGUMENT', `docs 域不支持的方法：${method}`);
      }
    } catch (error) {
      if (error instanceof DocDomainError) {
        const map: Record<DocDomainError['code'], ShellErrorCode> = {
          not_found: 'NOT_FOUND',
          empty_content: 'INVALID_ARGUMENT',
          unsupported_format: 'NOT_SUPPORTED',
          parser_missing: 'NOT_SUPPORTED',
          ocr_unsupported: 'NOT_SUPPORTED',
          extraction_unavailable: 'NOT_SUPPORTED',
        };
        // 保留 DocService 的中文原因（它写的就是给用户看的话术）
        throw new ShellError(map[error.code], error.message);
      }
      throw error;
    }
  };

  return { router };
}
