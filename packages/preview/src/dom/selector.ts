import type { DomNode, DomSelection, DomSession } from './contracts';

/** Serialized into the preview, with no closure over host APIs. Installed before business scripts. */
export function installDomSelector(session: DomSession): void {
  const documentId = crypto.randomUUID();
  let seq = 0;
  let ready = false;
  let selecting = false;
  let selected: Element | null = null;
  let selectedToken: string | null = null;
  const pageRoute = (): string =>
    (location.pathname + (location.hash.startsWith('#/') ? location.hash.split('?')[0] : '')).slice(
      0,
      512,
    );
  let route = pageRoute();
  let overlay: HTMLDivElement | null = null;
  const ids = new WeakMap<Element, string>();
  const ancestors = new Map<string, Element>();
  const post = (type: string, payload: unknown, handshake = false): void => {
    window.parent.postMessage(
      {
        channel: 'ec-dom-v1',
        projectId: session.projectId,
        runtimeId: session.runtimeId,
        nonce: session.nonce,
        documentId,
        seq: handshake ? 1 : ++seq,
        type,
        payload,
      },
      ['null', 'file://'].includes(session.parentOrigin) ? '*' : session.parentOrigin,
    );
  };
  const clean = (value: string): string =>
    value
      .replace(/(?:Bearer\s+\S+|\beyJ[\w.-]+|\b(?:sk-|token[=:])[\w-]+)/gi, '[redacted]')
      .slice(0, 200);
  const nodeId = (element: Element): string => {
    let id = ids.get(element);
    if (!id) {
      id = crypto.randomUUID();
      ids.set(element, id);
    }
    return id;
  };
  const describe = (element: Element): DomNode => {
    let name = '';
    if (!element.matches('input,textarea,select,[contenteditable],script,style')) {
      name = element.getAttribute('aria-label') ?? '';
      if (!name) {
        const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text: Node | null;
        while ((text = walk.nextNode()) && name.length < 200) {
          if (!text.parentElement?.closest('input,textarea,select,[contenteditable],script,style'))
            name += text.textContent ?? '';
        }
      }
    }
    const box = element.getBoundingClientRect();
    const sourceToken = element.getAttribute('data-ec-source');
    return {
      nodeId: nodeId(element),
      tag: element.localName.toLowerCase(),
      name: clean(name.trim()),
      id: element.id && /^[a-z][\w-]{0,79}$/i.test(element.id) ? clean(element.id) : null,
      classes: [...element.classList].filter((v) => /^[a-z][\w-]{0,79}$/i.test(v)).slice(0, 12),
      sourceToken: sourceToken && sourceToken.length <= 128 ? sourceToken : null,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  };
  const highlight = (element: Element | null): void => {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('data-ec-inspector', '');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #4f46e5;background:#6366f122;box-sizing:border-box;display:none';
      document.documentElement.appendChild(overlay);
    }
    if (!element || !element.isConnected) {
      overlay.style.display = 'none';
      return;
    }
    const box = element.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block',
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
  };
  const pick = (element: Element): void => {
    selected = element;
    selectedToken = element.getAttribute('data-ec-source');
    route = pageRoute();
    ancestors.clear();
    const chain: DomNode[] = [];
    let cursor: Element | null = element.parentElement;
    while (cursor && chain.length < 24) {
      ancestors.set(nodeId(cursor), cursor);
      chain.push(describe(cursor));
      cursor = cursor.parentElement;
    }
    const instances = selectedToken
      ? [...document.querySelectorAll('[data-ec-source]')].filter(
          (node) => node.getAttribute('data-ec-source') === selectedToken,
        )
      : [element];
    const snapshot: DomSelection = {
      node: describe(element),
      ancestors: chain,
      route,
      documentId,
      instanceIndex: Math.max(0, instances.indexOf(element)),
      instanceCount: Math.max(1, instances.length),
      boundary:
        element.localName === 'iframe'
          ? 'iframe'
          : element.localName === 'canvas'
            ? 'canvas'
            : element.shadowRoot
              ? 'shadow-host'
              : 'dom',
    };
    highlight(element);
    post('selection', snapshot);
  };
  const invalidate = (reason: string): void => {
    if (!selected) return;
    selected = null;
    ancestors.clear();
    highlight(null);
    post('invalidated', reason);
  };
  const validate = (): void => {
    if (
      selected &&
      (!selected.isConnected ||
        pageRoute() !== route ||
        selected.getAttribute('data-ec-source') !== selectedToken)
    )
      invalidate('页面路由、节点或源码标识已变化，请重新选取');
    else if (selected && selecting) highlight(selected);
  };
  window.addEventListener('message', (event: MessageEvent) => {
    const localOpaque =
      ['null', 'file://'].includes(session.parentOrigin) &&
      ['null', 'file://'].includes(event.origin);
    if (event.source !== window.parent || (event.origin !== session.parentOrigin && !localOpaque))
      return;
    const data = event.data as Record<string, unknown> | null;
    if (
      !data ||
      typeof data !== 'object' ||
      data['channel'] !== 'ec-dom-v1' ||
      data['runtimeId'] !== session.runtimeId ||
      data['projectId'] !== session.projectId ||
      data['nonce'] !== session.nonce
    )
      return;
    if (data['type'] === 'hello' && data['payload'] === null) {
      if (ready) post('ready', null, true);
      return;
    }
    if (data['documentId'] !== documentId || !ready) return;
    if (data['type'] === 'mode' && typeof data['payload'] === 'boolean') {
      selecting = data['payload'];
      highlight(selecting ? selected : null);
      post('mode', selecting);
    } else if (data['type'] === 'pick' && typeof data['payload'] === 'string' && selecting) {
      const element = ancestors.get(data['payload']);
      if (element?.isConnected) pick(element);
    }
  });
  const block = (event: Event): void => {
    if (!selecting) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'keydown' && (event as KeyboardEvent).key === 'Escape') {
      selecting = false;
      highlight(null);
      post('mode', false);
      return;
    }
    if (event.type === 'click') {
      const element = event.composedPath().find((item) => item instanceof Element) as
        Element | undefined;
      if (element && !element.closest('[data-ec-inspector]')) pick(element);
    }
  };
  for (const type of [
    'pointerdown',
    'pointerup',
    'pointerover',
    'pointerenter',
    'mousedown',
    'mouseup',
    'mouseover',
    'mouseenter',
    'mousemove',
    'focus',
    'focusin',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'submit',
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
    'change',
    'dragstart',
    'touchstart',
    'touchend',
  ])
    window.addEventListener(type, block, { capture: true, passive: false });
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!selecting) return;
      event.stopImmediatePropagation();
      const element = event.composedPath().find((item) => item instanceof Element) as
        Element | undefined;
      if (element && !element.closest('[data-ec-inspector]')) {
        highlight(element);
        post('hover', describe(element));
      }
    },
    true,
  );
  window.addEventListener('scroll', validate, true);
  window.addEventListener('resize', validate);
  window.addEventListener('popstate', validate);
  window.addEventListener('hashchange', () => invalidate('页面路由已变化，请重新选取'));
  const start = (): void => {
    new MutationObserver(validate).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-ec-source'],
    });
    window.setInterval(validate, 200);
    ready = true;
    seq = Math.max(seq, 1);
    post('ready', null, true);
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

export function domSelectorScript(session: DomSession): string {
  // esbuild's keepNames instrumentation (used by Vitest) may add this local helper.
  return `(()=>{const __name=(fn)=>fn;(${installDomSelector.toString()})(${JSON.stringify(session).replace(/</g, '\\u003c')});})()`;
}
