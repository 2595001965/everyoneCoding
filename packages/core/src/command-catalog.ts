/**
 * 应用命令目录（设置页「快捷键」类目的数据源）。
 *
 * 背景：`SettingsApi.listCommands()` 此前**没有任何数据源**——`CommandInfo` 只是渲染层端口类型，
 * `CommandRegistry` 也只在测试里被实例化过，于是快捷键面板拿不到可绑定命令。
 * 本文件把「应用真实存在的可触发动作」固化成一份纯常量，作为命令 id / 标题 / 默认键位的**单一事实源**：
 * 主进程（经 domain RPC 回答 `listCommands`）与渲染层都能 import，且不含任何 IO。
 *
 * 如实性约束：
 * - 只登记**应用里真实存在的动作**，不臆造功能；
 * - `defaultKey` 只登记**代码里真的绑定了**的键位。目前仅 `Ctrl+K`（命令面板，
 *   见 `apps/renderer/src/layout/TitleBar.tsx` 的 keydown 监听）是真绑定，其余为 `null`；
 * - 导航命令的 `route` 与 `apps/renderer/src/layout/navigation.ts` 一一对应，
 *   由 `apps/renderer/src/__tests__/command-catalog.test.ts` 做漂移守卫。
 *
 * 未完成说明：键位**派发**（读 keymap 后真正触发命令）尚未接线，
 * 目前 `saveKeymap` 只负责持久化与冲突检测。导航类命令的派发点应加在 `AppShell`。
 */

/** 命令分组（快捷键面板按此归类展示） */
export type AppCommandGroup = '导航' | '应用';

export interface AppCommandDescriptor {
  /** 稳定命令 id（keymap 以此为键，一经发布不可改名） */
  id: string;
  /** 中文标题（与 i18n 的 `nav.*` 文案一致） */
  title: string;
  group: AppCommandGroup;
  /** 导航类命令的目标路由；非导航类命令缺省 */
  route?: string;
  /** 默认键位；没有真实绑定时为 null */
  defaultKey: string | null;
}

/**
 * 命令面板的打开快捷键。
 * 这是全应用唯一已实现键盘绑定的命令，故也是唯一的非空 `defaultKey`。
 */
export const COMMAND_PALETTE_KEY = 'Ctrl+K';

export const APP_COMMANDS: readonly AppCommandDescriptor[] = [
  { id: 'nav.workspace', title: '工作台', group: '导航', route: '/', defaultKey: null },
  { id: 'nav.designer', title: '设计器', group: '导航', route: '/designer', defaultKey: null },
  { id: 'nav.pipeline', title: '流水线', group: '导航', route: '/pipeline', defaultKey: null },
  { id: 'nav.preview', title: '预览', group: '导航', route: '/preview', defaultKey: null },
  { id: 'nav.memory', title: '记忆中心', group: '导航', route: '/memory', defaultKey: null },
  { id: 'nav.docs', title: '文档', group: '导航', route: '/docs', defaultKey: null },
  { id: 'nav.git', title: '版本管理', group: '导航', route: '/git', defaultKey: null },
  { id: 'nav.rename', title: '统一重命名', group: '导航', route: '/rename', defaultKey: null },
  { id: 'nav.usage', title: '用量', group: '导航', route: '/usage', defaultKey: null },
  { id: 'nav.account', title: '账号', group: '导航', route: '/account', defaultKey: null },
  { id: 'nav.settings', title: '设置', group: '导航', route: '/settings', defaultKey: null },
  {
    id: 'app.commandPalette',
    title: '快速跳转',
    group: '应用',
    defaultKey: COMMAND_PALETTE_KEY,
  },
  { id: 'app.toggleTheme', title: '切换主题', group: '应用', defaultKey: null },
  { id: 'app.toggleRightPanel', title: '切换工作指南', group: '应用', defaultKey: null },
];

/** 命令 id → 命令（构建一次，供主进程 RPC 与渲染层派发共用） */
export function commandById(id: string): AppCommandDescriptor | null {
  return APP_COMMANDS.find((command) => command.id === id) ?? null;
}

/** 默认键位表（命令 id → 键位），仅含真有默认键位的命令 */
export function defaultKeymap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const command of APP_COMMANDS) {
    if (command.defaultKey) map[command.id] = command.defaultKey;
  }
  return map;
}
