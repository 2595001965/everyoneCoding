/**
 * @ec/ui —— 设计令牌 + 自建基础组件库（29 个组件，单组件单文件）。
 *
 * 约束：
 * - 不引入第三方 UI 框架（与可视化设计器画布样式完全隔离）
 * - 浅色为默认主题（CSS 变量 + [data-theme='dark'] 覆盖）
 * - 全部组件支持键盘导航与 ARIA；显示文案中文、类名与标识符英文
 * - Tree / Table / List 虚拟化（1 万条数据只渲染窗口内节点）
 */

export * from './cx';
export * from './tokens';
export * from './hooks';

export { Badge } from './components/Badge';
export { Breadcrumb } from './components/Breadcrumb';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './components/Button';
export { Checkbox } from './components/Checkbox';
export { CommandPalette, type CommandItem } from './components/CommandPalette';
export { ContextMenu, type ContextMenuProps } from './components/ContextMenu';
export { Drawer } from './components/Drawer';
export { EmptyState } from './components/EmptyState';
export { IconButton } from './components/IconButton';
export { Input, type InputProps } from './components/Input';
export { List, type ListProps } from './components/List';
export { Menu, type MenuOption } from './components/Menu';
export { Modal } from './components/Modal';
export { Popover } from './components/Popover';
export { Progress } from './components/Progress';
export { Radio, RadioGroup } from './components/Radio';
export { Resizable } from './components/Resizable';
export { SearchInput } from './components/SearchInput';
export { Select } from './components/Select';
export { Spinner } from './components/Spinner';
export { SplitPane } from './components/SplitPane';
export { Switch } from './components/Switch';
export { Table, type Column } from './components/Table';
export { Tabs } from './components/Tabs';
export { Tag } from './components/Tag';
export { Textarea } from './components/Textarea';
export { ToastProvider, useToast, type ToastOptions, type ToastVariant } from './components/Toast';
export { Tooltip } from './components/Tooltip';
export { Tree, type TreeNode } from './components/Tree';

export { applyTheme, resolveTheme, useTheme, type ThemeMode } from './theme';
export { colorVariables } from './tokens';

import { tokensToCssVariables } from './tokens';

/** 供测试与文档站断言两套主题变量 */
export const lightThemeVariables = (): Record<string, string> => tokensToCssVariables('light');
export const darkThemeVariables = (): Record<string, string> => tokensToCssVariables('dark');
