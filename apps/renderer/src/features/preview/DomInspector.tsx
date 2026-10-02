import * as React from 'react';
import type {
  DomAttachment,
  DomEvent,
  DomMapping,
  DomNode,
  DomSelection,
  DomSession,
} from '@ec/preview';
import { PreviewFrame } from './PreviewFrame';
import { usePreviewApi } from './preview-api';
import './dom-inspector.css';

export function DomInspector({
  src,
  runtimeId,
}: {
  src: string;
  runtimeId: string | null;
}): JSX.Element {
  const api = usePreviewApi();
  const [session, setSession] = React.useState<DomSession | null>(null);
  const [ready, setReady] = React.useState(false);
  const [selecting, setSelecting] = React.useState(false);
  const [selection, setSelection] = React.useState<DomSelection | null>(null);
  const current = React.useRef<DomSelection | null>(null);
  const [hover, setHover] = React.useState<DomNode | null>(null);
  const [mapping, setMapping] = React.useState<DomMapping | null>(null);
  const [pick, setPick] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [placement, setPlacement] = React.useState<DomAttachment['placement']>('inside');
  const [targetPage, setTargetPage] = React.useState('/');
  const [confirmed, setConfirmed] = React.useState(false);
  const [status, setStatus] = React.useState('');
  const [notes, setNotes] = React.useState<readonly DomAttachment[]>([]);
  React.useEffect(() => {
    let alive = true;
    setSession(null);
    setReady(false);
    setSelection(null);
    current.current = null;
    setMapping(null);
    setSelecting(false);
    if (runtimeId && api.inspection) {
      void api.inspection
        .session(window.location.origin)
        .then((value) => {
          if (alive) setSession(value);
        })
        .catch((error: unknown) => {
          if (alive) setStatus(String(error));
        });
      void api.inspection
        .notes()
        .then((value) => {
          if (alive) setNotes(value);
        })
        .catch((error: unknown) => {
          if (alive) setStatus(String(error));
        });
    }
    return () => {
      alive = false;
    };
  }, [api, runtimeId]);
  const receive = React.useCallback(
    (event: DomEvent): void => {
      if (event.type === 'ready' || event.type === 'invalidated') {
        current.current = null;
        setSelection(null);
        setMapping(null);
        setHover(null);
        setConfirmed(false);
        if (event.type === 'ready') setReady(true);
        else setStatus(event.payload);
      } else if (event.type === 'mode') setSelecting(event.payload);
      else if (event.type === 'hover') setHover(event.payload);
      else if (event.type === 'selection') {
        current.current = event.payload;
        setSelection(event.payload);
        setMapping(null);
        setConfirmed(false);
        setNote('');
        setStatus('');
        setTargetPage(event.payload.route);
        setPick(null);
        if (session && api.inspection)
          void api.inspection
            .resolve(session, event.payload)
            .then((value) => {
              if (current.current === event.payload) setMapping(value);
            })
            .catch((error: unknown) => {
              if (current.current === event.payload) setStatus(String(error));
            });
      }
    },
    [api, session],
  );
  React.useEffect(() => {
    if (!selection || !session || !api.inspection) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void api.inspection
        ?.resolve(session, selection)
        .then((value) => {
          if (alive && current.current === selection) setMapping(value);
        })
        .catch((error: unknown) => {
          if (alive) {
            setMapping(null);
            setStatus(String(error));
          }
        });
    }, 700);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [api, session, selection]);
  const save = async (attach: boolean): Promise<void> => {
    if (!selection || !session || !api.inspection) return;
    try {
      await api.inspection.save(
        { session, selection, note, placement, targetPage, sharedConfirmed: confirmed },
        attach,
      );
      setNotes(await api.inspection.notes());
      setStatus(attach ? '已附加到本项目 AI 上下文；源码修改仍经计划、diff 和确认' : '备注已保存');
    } catch (error) {
      setStatus(String(error));
    }
  };
  const locate = async (): Promise<void> => {
    if (!selection || !session || !api.inspection) return;
    try {
      setMapping(await api.inspection.locate(session, selection));
    } catch (error) {
      setStatus(String(error));
    }
  };
  const exact = mapping?.anchor.confidence === 'exact';
  return (
    <section className="ec-dom-inspector" aria-label="运行 DOM 选取">
      <div className="ec-dom-toolbar" role="toolbar" aria-label="页面交互模式">
        <button type="button" aria-pressed={!selecting} onClick={() => setSelecting(false)}>
          交互
        </button>
        <button
          type="button"
          aria-pressed={selecting}
          disabled={!ready}
          onClick={() => setSelecting(true)}
        >
          选取
        </button>
        <span>{selecting ? '点击选取，Esc 退出' : '交互模式'}</span>
      </div>
      {runtimeId && api.inspection && !session ? (
        <p>正在建立选取会话…</p>
      ) : (
        <PreviewFrame
          key={src}
          src={src}
          session={session}
          selecting={selecting}
          pickNodeId={pick}
          onEvent={receive}
        />
      )}
      {!api.inspection && <p>当前外壳未装配 DOM 选取端口</p>}
      {hover && selecting && (
        <p>
          悬停：{hover.tag} · {hover.name}
        </p>
      )}
      {selection && (
        <div className="ec-dom-card" aria-label="选中元素卡片">
          <p>
            {selection.node.tag} · {selection.node.name}{' '}
            {selection.node.id ? `#${selection.node.id}` : ''} {selection.node.classes.join(' ')}
          </p>
          <p>
            路由 {selection.route}；实例 {selection.instanceIndex + 1}/{selection.instanceCount}
            ；选取时矩形 {Math.round(selection.node.rect.x)}, {Math.round(selection.node.rect.y)},{' '}
            {Math.round(selection.node.rect.width)}×{Math.round(selection.node.rect.height)}
          </p>
          <div className="ec-dom-ancestors" aria-label="DOM 祖先链">
            {selection.ancestors.map((node) => (
              <button
                type="button"
                key={node.nodeId}
                disabled={!selecting}
                onClick={() => setPick(node.nodeId)}
              >
                {node.tag} {node.name}
              </button>
            ))}
          </div>
          <p>
            映射可信度：{mapping?.anchor.confidence ?? '核验中'}；组件：
            {mapping?.anchor.componentSymbol ?? '未知'}
          </p>
          <p>
            {mapping?.anchor.sourceRef
              ? `${mapping.anchor.sourceRef.filePath}:${mapping.anchor.sourceRef.startLine}:${mapping.startColumn}`
              : (mapping?.anchor.invalidReason ?? '尚未定位')}
          </p>
          <p>源码修订：{mapping?.anchor.sourceRevision?.contentHash ?? '未知'}</p>
          <p>
            关联接口：
            {mapping?.relatedApis.length ? mapping.relatedApis.join('、') : '暂无经核验关联'}
          </p>
          <p>{mapping?.shared.scope}</p>
          {mapping?.shared.requiresConfirmation && (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我已确认共享组件影响范围
            </label>
          )}
          <button
            type="button"
            disabled={!exact}
            onClick={() => {
              void locate();
            }}
          >
            定位前端源码
          </button>
          <label>
            备注
            <textarea
              value={note}
              maxLength={4000}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <label>
            插入位置
            <select
              value={placement}
              onChange={(event) => setPlacement(event.target.value as DomAttachment['placement'])}
            >
              <option value="before">之前</option>
              <option value="after">之后</option>
              <option value="inside">内部</option>
            </select>
          </label>
          <label>
            目标页面
            <input value={targetPage} onChange={(event) => setTargetPage(event.target.value)} />
          </label>
          <button
            type="button"
            onClick={() => {
              void save(false);
            }}
          >
            保存备注
          </button>
          <button
            type="button"
            disabled={!exact || (mapping?.shared.requiresConfirmation === true && !confirmed)}
            onClick={() => {
              void save(true);
            }}
          >
            附加到 AI 上下文
          </button>
        </div>
      )}
      <p className="ec-dom-boundary">
        输入值和密码不采集。iframe、Shadow
        DOM、canvas/原生控件仅定位宿主边界；第三方和构建产物无可信映射时需人工定位。
      </p>
      {status && <p role="status">{status}</p>}
      {notes.length > 0 && (
        <details>
          <summary>已保存备注（{notes.length}）</summary>
          {notes.map((item) => (
            <p key={item.mapping.anchor.anchorId}>
              {item.targetPage} ·{' '}
              {item.mapping.anchor.sourceRef?.filePath ?? item.selection.node.tag} · {item.note}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
