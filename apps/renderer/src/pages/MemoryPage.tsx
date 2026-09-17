import { MemoryCenter, MemoryProvider, type MemoryApi } from '../features/memory';
import { useAppStore } from '../store/useAppStore';
import { PagePlaceholder } from './PagePlaceholder';

/**
 * 记忆中心页。
 *
 * 实现由外壳注入（`globalThis.__EC_MEMORY__`）：需要 SQLite 连接，
 * 只有外壳起来之后才可用；未注入时展示初始化引导，而不是崩溃或假数据。
 */

function readInjectedApi(): MemoryApi | null {
  const injected = (globalThis as unknown as { __EC_MEMORY__?: MemoryApi }).__EC_MEMORY__;
  if (typeof injected !== 'object' || injected === null) return null;
  return injected;
}

export function MemoryPage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  // shellReady 变化代表外壳可能刚注入实现，需要重新读取
  const api = (void shellReady, readInjectedApi());

  if (!api) {
    return (
      <PagePlaceholder
        title="记忆中心"
        description="五层记忆的浏览、检索与编辑入口。记忆保存在本机 SQLite，需等待本地数据层初始化。"
      />
    );
  }

  return (
    <section className="ec-page" aria-label="记忆中心页">
      <h1 className="ec-page__title">记忆中心</h1>
      <p className="ec-page__desc">
        五层记忆（长期 / 项目 / 功能 / 页面 / 元素）与问题记忆统一管理；下层自动携带上层，冲突时下层优先并标注来源。
      </p>
      <MemoryProvider api={api}>
        <MemoryCenter userId={currentUserId()} />
      </MemoryProvider>
    </section>
  );
}

/** 当前用户 id：外壳会注入 `__EC_USER_ID__`；未注入时用占位值由外壳做兜底查询 */
function currentUserId(): string {
  const injected = (globalThis as unknown as { __EC_USER_ID__?: string }).__EC_USER_ID__;
  return typeof injected === 'string' && injected.length > 0 ? injected : 'local-user';
}
