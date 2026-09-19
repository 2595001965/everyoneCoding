/**
 * 逻辑结构扫描器（T7-02 要点 4）。
 *
 * 扫描 PageDSL 树中的三类承载点：
 * - **节点名**（`node.name`）：可能是中文显示名，也可能是英文标识符；
 * - **绑定路径**（`node.bindings`，如 `state.userLoginButton`、`form.user_login_button`）；
 * - **事件动作目标**（`node.actions`，如 `handleUserLoginButton`）。
 *
 * 逻辑结构命中属**自动区**（FR-UNI-04：逻辑结构可直接改），因为 DSL 是本产品自有格式，
 * 改名不涉及外部契约。
 *
 * 输入为**结构化镜像**（`LogicSourceNode`），由外壳从 `@ec/designer` 的 PageDSL 适配；
 * 注册表包不依赖 `@ec/designer`（那是浏览器 UI 包，含 React / dnd-kit）。
 */

import type { ProjectionKind } from '../naming/presets';
import { PROJECTION_KINDS } from '../naming/presets';
import { mentionConfidence } from './semantic';
import type { LogicSourceNode } from './types';

/** 一条逻辑结构命中 */
export interface LogicHit {
  /** 所属 DSL 文档 id（页面 / 功能） */
  refPath: string;
  /** DSL 节点 id（承载者，执行器据此定位节点） */
  carrierId: string;
  /** 承载字段（name / identifier / binding / action） */
  carrierField: 'name' | 'identifier' | 'binding' | 'action';
  /** 节点路径（`root/container-1/btn-2`） */
  locator: string;
  /** 承载位置 */
  field: 'name' | 'identifier' | 'binding' | 'action';
  symbol: string;
  matchedSymbol: ProjectionKind | null;
  confidence: number;
  /** 原始承载文本（如 `state.userLoginButton`） */
  carrier: string;
  detail: string;
}

const FIELD_LABELS: Readonly<Record<LogicHit['field'], string>> = {
  name: '节点名',
  identifier: '变量名 / 状态键',
  binding: '绑定路径',
  action: '事件动作目标',
};

/** 展平 DSL 树为（节点，路径）序列 */
export function flattenLogicNodes(
  nodes: readonly LogicSourceNode[],
  prefix = '',
): { node: LogicSourceNode; path: string }[] {
  const out: { node: LogicSourceNode; path: string }[] = [];
  for (const node of nodes) {
    const path = prefix === '' ? `${node.type}:${node.id}` : `${prefix}/${node.type}:${node.id}`;
    out.push({ node, path });
    if (node.children !== undefined && node.children.length > 0) {
      out.push(...flattenLogicNodes(node.children, path));
    }
  }
  return out;
}

function symbolIndex(
  canonicalName: string,
  projections: Partial<Record<ProjectionKind, string>>,
): Map<string, ProjectionKind | null> {
  const map = new Map<string, ProjectionKind | null>();
  if (canonicalName.length > 0) map.set(canonicalName, null);
  for (const kind of PROJECTION_KINDS) {
    const value = projections[kind];
    if (value !== undefined && value.length > 0) map.set(value, kind);
  }
  return map;
}

/**
 * 扫描逻辑结构树。
 *
 * - 节点名：与符号**全等** → 1.0；包含关系 / 语义 ≥0.8 → 0.9；其余语义候选 ≥0.5 → 原值
 * - `identifier`：与变量投影全等 → 1.0
 * - `bindings`：整串全等 → 1.0；路径末尾段全等（`state.<符号>`）→ 1.0
 * - `actions`：整串全等或末尾段全等 → 1.0
 */
export function scanLogic(
  nodes: readonly LogicSourceNode[],
  input: { canonicalName: string; projections: Partial<Record<ProjectionKind, string>> },
): LogicHit[] {
  const symbols = symbolIndex(input.canonicalName, input.projections);
  const hits: LogicHit[] = [];

  const push = (hit: LogicHit): void => {
    hits.push(hit);
  };

  for (const { node, path } of flattenLogicNodes(nodes)) {
    const nameKind = symbols.get(node.name);
    if (nameKind !== undefined || symbols.has(node.name)) {
      push({
        refPath: node.documentId,
        carrierId: node.id,
        locator: path,
        field: 'name',
        carrierField: 'name',
        symbol: node.name,
        matchedSymbol: nameKind ?? null,
        confidence: 1,
        carrier: node.name,
        detail: `逻辑结构 ${path} 的节点名「${node.name}」精确命中`,
      });
    } else {
      for (const [symbol, kind] of symbols) {
        const confidence = mentionConfidence(node.name, symbol);
        if (confidence >= 0.5) {
          push({
            refPath: node.documentId,
            carrierId: node.id,
            locator: path,
            field: 'name',
            carrierField: 'name',
            symbol,
            matchedSymbol: kind,
            confidence: Math.min(0.9, confidence),
            carrier: node.name,
            detail: `逻辑结构 ${path} 的节点名「${node.name}」疑似命中「${symbol}」（语义 ${confidence.toFixed(2)}）`,
          });
          break;
        }
      }
    }

    if (node.identifier !== undefined) {
      const kind = symbols.get(node.identifier);
      if (kind !== undefined || symbols.has(node.identifier)) {
        push({
          refPath: node.documentId,
          carrierId: node.id,
          locator: path,
          field: 'identifier',
          carrierField: 'identifier',
          symbol: node.identifier,
          matchedSymbol: kind ?? null,
          confidence: 1,
          carrier: node.identifier,
          detail: `逻辑结构 ${path} 的变量名「${node.identifier}」精确命中`,
        });
      }
    }

    for (const binding of node.bindings ?? []) {
      const tail =
        binding
          .split(/[.[\]]/)
          .filter((part) => part.length > 0)
          .pop() ?? binding;
      const kind = symbols.get(binding) ?? symbols.get(tail);
      if (kind !== undefined || symbols.has(binding) || symbols.has(tail)) {
        const symbol = symbols.has(binding) ? binding : tail;
        push({
          refPath: node.documentId,
          carrierId: node.id,
          locator: path,
          field: 'binding',
          carrierField: 'binding',
          symbol,
          matchedSymbol: kind ?? null,
          confidence: 1,
          carrier: binding,
          detail: `逻辑结构 ${path} 的绑定路径「${binding}」命中「${symbol}」`,
        });
      }
    }

    for (const action of node.actions ?? []) {
      const kind = symbols.get(action);
      if (kind !== undefined || symbols.has(action)) {
        push({
          refPath: node.documentId,
          carrierId: node.id,
          locator: path,
          field: 'action',
          carrierField: 'action',
          symbol: action,
          matchedSymbol: kind ?? null,
          confidence: 1,
          carrier: action,
          detail: `逻辑结构 ${path} 的事件动作「${action}」精确命中`,
        });
      }
    }
  }

  return hits;
}

/** 承载位置的中文标签（UI 展示） */
export function logicFieldLabel(field: LogicHit['field']): string {
  return FIELD_LABELS[field];
}
