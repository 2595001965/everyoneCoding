/**
 * 导航跳转渲染层端口（T6-07）。
 *
 * 与 `GitApi` / `PreviewApi` 同一套做法：渲染层只认这些接口，真实实现由外壳经
 * `globalThis.__EC_NAV__` 注入（见 `readInjectedNavApi`）。领域层在
 * `@ec/ai`（`src/nav/`），是纯逻辑 + 端口注入，浏览器入口可安全引用。
 *
 * 硬约束：跳转只做「定位 + 高亮」，不修改任何文件；AI 仍是代码唯一写入口（D-04）。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  JumpOutcome,
  JumpResolution,
  NavElementRef,
  NavTarget,
  RelationGraph,
  ReverseJumpResult,
} from '@ec/ai';

/** 悬停 / Ctrl+点击的请求载荷（渲染层中立模型） */
export interface NavJumpRequest {
  pageId: string;
  elementId: string;
  elementName: string;
  currentFile?: string | null | undefined;
}

/** 数据流链路的单个环节（FR-PRV-07） */
export interface DataFlowStep {
  id: string;
  kind: 'element' | 'event' | 'api' | 'backend' | 'writeback' | 'render';
  label: string;
  detail: string | null;
  at: number | null;
  ok: boolean;
}

/** 双向跳转成功率（验收 ≥95%） */
export interface JumpStats {
  forward: { total: number; success: number; rate: number };
  reverse: { total: number; success: number; rate: number };
}

export interface NavApi {
  readonly ready: boolean;
  readonly reason?: string | undefined;
  /** 悬停：该元素可跳转的目标（已按相关度排序） */
  hoverTargets(request: NavJumpRequest): Promise<readonly NavTarget[]>;
  /** Ctrl+点击：按层级分组的候选 + 首选目标 */
  resolveJump(request: NavJumpRequest): Promise<JumpResolution>;
  /** 执行跳转（渲染层据此滚动 / 高亮） */
  commitJump(target: NavTarget): Promise<JumpOutcome>;
  /** 跳转成功率统计（双向） */
  jumpStats(): Promise<JumpStats>;
  /** 关系图谱 */
  relationGraph(): Promise<RelationGraph>;
  /** 反向跳转：代码视图某一行 → 设计器元素 */
  reverseJump(input: { filePath: string; line: number }): Promise<ReverseJumpResult>;
  /** 数据流链路：来自预览请求日志 + 动作流执行记录 */
  dataFlow(elementId: string): Promise<readonly DataFlowStep[]>;
}

export const NAV_API_GLOBAL_KEY = '__EC_NAV__';

const NavContext = createContext<NavApi | null>(null);

export interface NavApiProviderProps {
  api: NavApi | null;
  children: ReactNode;
}

export function NavApiProvider({ api, children }: NavApiProviderProps): JSX.Element {
  return <NavContext.Provider value={api}>{children}</NavContext.Provider>;
}

/** 必须已注入端口，否则抛错 */
export function useNavApi(): NavApi {
  const api = useContext(NavContext);
  if (api === null) throw new Error('导航端口未初始化：请先注入 NavApi');
  return api;
}

/** 端口可能为空（面板级降级） */
export function useNavApiOptional(): NavApi | null {
  return useContext(NavContext);
}

const REQUIRED_METHODS: readonly (keyof NavApi)[] = [
  'hoverTargets',
  'resolveJump',
  'commitJump',
  'relationGraph',
  'reverseJump',
  'dataFlow',
];

/** 从全局读取外壳注入的实现（用 typeof 校验关键方法） */
export function readInjectedNavApi(): NavApi | null {
  const injected = (globalThis as unknown as { [NAV_API_GLOBAL_KEY]?: unknown })[NAV_API_GLOBAL_KEY];
  if (typeof injected !== 'object' || injected === null) return null;
  const candidate = injected as Record<string, unknown>;
  if (!REQUIRED_METHODS.every((method) => typeof candidate[method] === 'function')) return null;
  return candidate as unknown as NavApi;
}

export interface HoverJumpState {
  /** 悬停可跳转目标（已按相关度排序） */
  targets: NavTarget[];
  /** 悬停浮层是否展开 */
  open: boolean;
  onHoverStart(): void;
  onHoverEnd(): void;
  /** Ctrl + 点击入口；未按 Ctrl 时只展开悬停列表 */
  onCtrlClick(event: { ctrlKey: boolean; metaKey: boolean }): void;
  /** 层级下拉数据（needsChoice 为真时展示） */
  resolution: JumpResolution | null;
  /** 用户选定目标后落地跳转 */
  choose(target: NavTarget): void;
  close(): void;
}

/**
 * 悬停 + Ctrl 点击的核心交互 Hook。
 *
 * 必须监听 window 的 keydown / keyup 来跟踪 Ctrl 按下状态：仅靠 click 事件的
 * `ctrlKey` 在「按下 Ctrl 后移入元素再点击」等场景下拿不到，且测试也不好构造。
 */
export function useHoverJump(options: {
  element: NavElementRef;
  pageId: string;
  currentFile?: string | null | undefined;
}): HoverJumpState {
  const api = useNavApiOptional();
  const [targets, setTargets] = useState<NavTarget[]>([]);
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<JumpResolution | null>(null);
  // 用 ref 而不是 state：Ctrl 状态只在事件处理里读，
  // 走 state 会因 React 批处理让紧随其后的 click 读到旧闭包值。
  const ctrlDownRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Control' || event.ctrlKey || event.metaKey) ctrlDownRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Control' || event.key === 'Meta') ctrlDownRef.current = false;
    };
    const onBlur = (): void => {
      ctrlDownRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const { element, pageId } = options;
  const currentFile = options.currentFile ?? null;

  const buildRequest = useCallback(
    (): NavJumpRequest =>
      currentFile === null
        ? { pageId, elementId: element.elementId, elementName: element.name }
        : { pageId, elementId: element.elementId, elementName: element.name, currentFile },
    [pageId, element.elementId, element.name, currentFile],
  );

  const onHoverStart = useCallback((): void => {
    setOpen(true);
    if (api === null) return;
    void api.hoverTargets(buildRequest()).then((next) => setTargets([...next]));
  }, [api, buildRequest]);

  const onHoverEnd = useCallback((): void => setOpen(false), []);

  const onCtrlClick = useCallback(
    (event: { ctrlKey: boolean; metaKey: boolean }): void => {
      // 未按 Ctrl：只展开悬停列表，不执行跳转
      if (!event.ctrlKey && !event.metaKey && !ctrlDownRef.current) {
        onHoverStart();
        return;
      }
      if (api === null) return;
      setOpen(true);
      void api.resolveJump(buildRequest()).then((next) => {
        setResolution(next);
        // 只有一个明确首选时直接落地；需要选择则等用户在层级下拉里挑
        if (!next.needsChoice && next.preferred !== null) void api.commitJump(next.preferred);
      });
    },
    [api, buildRequest, onHoverStart],
  );

  const choose = useCallback(
    (target: NavTarget): void => {
      if (api !== null) void api.commitJump(target);
      setOpen(false);
      setResolution(null);
    },
    [api],
  );

  const close = useCallback((): void => {
    setOpen(false);
    setResolution(null);
  }, []);

  return { targets, open, onHoverStart, onHoverEnd, onCtrlClick, resolution, choose, close };
}
