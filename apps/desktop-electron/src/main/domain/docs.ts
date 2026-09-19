import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

import { newUlid } from '@ec/data';
import {
  DocDomainError,
  DocService,
  createDefaultParserRegistry,
  type DocFormat,
  type DocKind,
  type DocLinkType,
  type DocMemoryScope,
  type DocSourceRef,
  type ImportDocumentInput,
  type UpdateDocumentInput,
} from '@ec/core';
import { ShellError, type ShellErrorCode } from '@ec/shell-api';

import { LOCAL_USER_ID } from './db';
import type { DomainRouter } from './runtime';
import {
  countLinksForMemories,
  createSqliteDocMemoryPort,
  createSqliteDocStore,
} from './sqlite-doc-store';

/**
 * docs 域运行时（文档中心，20 个方法）。
 *
 * 组成全部复用 `@ec/core` 的文档域：
 * - `DocService` 负责解析、版本、更新提示、关联与转记忆的业务逻辑；
 * - `DocStore` / `DocMemoryPort` 由本目录的 SQLite 适配器提供（见 `sqlite-doc-store.ts`）；
 * - 解析器注册表用 `createDefaultParserRegistry()`——即 Node 全集
 *   （markdown / txt / docx / pdf 可用；image 需 OCR 端口，缺省时如实报不支持）。
 *
 * **AI 摘要端口（`MemoryExtractionPort`）未注入**：
 * `previewConvertToMemory`（一键转记忆）需要 AI 生成摘要，`DocService` 会抛出
 * `extraction_unavailable`，其自带的中文引导语（"请在设置中配置 AI 中转…"）会原样回传。
 * `commitConvertToMemory`（提交已编辑的草稿）不依赖 AI，可用。
 */

export interface DocsDomainOptions {
  db: Database.Database;
  userId?: string;
}

export function createDocsDomain(options: DocsDomainOptions): { router: DomainRouter } {
  const { db } = options;
  const userId = options.userId ?? LOCAL_USER_ID;

  const parsers = createDefaultParserRegistry();
  const service = new DocService({
    store: createSqliteDocStore(db),
    parsers,
    memory: createSqliteDocMemoryPort({ db, userId, newId: newUlid, clock: Date.now }),
    // extraction 刻意不注入：见文件头说明
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
