import type { History, Location } from 'history';

/**
 * 极简 history 抽象：避免为骨架引入 react-router 之外的耦合。
 * react-router 在后续 Wave 接管路由时沿用同一 history 实例。
 */

export interface RouterHistory extends History {}

/** 兼容包缺失时的兜底：基于 hash 的最小实现 */
export function createBrowserHistory(): RouterHistory {
  // history 包由 react-router-dom 依赖提供；这里直接实现以减少直接依赖面
  let listeners: Array<(update: { location: Location; action: string }) => void> = [];

  const locationOf = (): Location => {
    const { pathname, search, hash } = window.location;
    const url = `${pathname}${search}${hash}`;
    return {
      pathname,
      search,
      hash,
      state: window.history.state,
      key: `${Date.now()}`,
      createHref: (to: Partial<Location> & { pathname?: string }) => to.pathname ?? url,
    } as unknown as Location;
  };

  const notify = (action: string): void => {
    const location = locationOf();
    for (const listener of listeners) listener({ location, action });
  };

  window.addEventListener('popstate', () => notify('POP'));

  return {
    get location(): Location {
      return locationOf();
    },
    get action(): string {
      return 'POP';
    },
    listen(listener) {
      listeners.push(listener as never);
      return () => {
        listeners = listeners.filter((item) => item !== listener);
      };
    },
    push(to: string) {
      window.history.pushState(null, '', to);
      notify('PUSH');
    },
    replace(to: string) {
      window.history.replaceState(null, '', to);
      notify('REPLACE');
    },
    go(delta: number) {
      window.history.go(delta);
    },
    back() {
      window.history.back();
    },
    forward() {
      window.history.forward();
    },
    createHref(to: Partial<Location> & { pathname?: string }): string {
      return to.pathname ?? '/';
    },
  } as unknown as RouterHistory;
}
