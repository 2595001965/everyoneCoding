# @ec/ui 组件自检文档

> 自建组件库（不依赖任何第三方 UI 框架）。所有样式走 CSS 变量（`tokens.css`），类名前缀 `ec-`。
> 组件统一支持受控 / 非受控；浮层组件走 `ReactDOM.createPortal`，并提供焦点陷阱与 Esc 关闭。

## 目录

Button · IconButton · Input · Textarea · Select · Checkbox · Radio · Switch · Badge · Tag · Breadcrumb · SearchInput · Progress · Spinner · EmptyState · Modal · Drawer · Tooltip · Popover · Menu · ContextMenu · CommandPalette · Toast · Tabs · Tree · Table · List · SplitPane · Resizable

---

## Button
- 用途：触发操作的基础按钮。
- Props：`variant?: 'primary'|'secondary'|'ghost'|'danger'`、`size?: 'sm'|'md'|'lg'`、`loading?: boolean`、`fullWidth?: boolean`、`leftIcon?/rightIcon?`。
- 用法：`<Button variant="primary" onClick={fn}>确定</Button>`
- 键盘：原生 `<button>`，Enter / Space 触发；`loading` 时禁用并 `aria-busy`。

## IconButton
- 用途：纯图标方形按钮。
- Props：必填 `aria-label`；其余同 Button。
- 用法：`<IconButton aria-label="关闭" onClick={fn}>×</IconButton>`
- 键盘：Enter / Space；必须 `aria-label` 保证读屏可达。

## Input
- 用途：单行文本输入，支持前后缀 / 清空 / 错误态。
- Props：`value?/defaultValue?/onChange?`、`invalid?`、`prefix?/suffix?`、`clearable?/onClear?`。
- 用法：`<Input clearable value={v} onChange={setV} />`
- 键盘：原生输入；清空按钮可聚焦回车。

## Textarea
- 用途：多行文本，`autoSize` 自动增高。
- Props：同 Input，加 `autoSize?`。
- 用法：`<Textarea autoSize defaultValue="" />`
- 键盘：Shift+Enter 换行；Enter 不提交（由外层表单决定）。

## Select
- 用途：自建下拉（combobox + listbox）。
- Props：`options: {label,value,disabled?}[]`、`value?/defaultValue?/onChange?`、`placeholder?`、`invalid?`、`clearable?`。
- 用法：`<Select options={opts} onChange={setV} />`
- 键盘：↓ / Enter / Space 展开；↑↓ 移动；Enter 选择；Esc 关闭；Home/End 跳首尾。

## Checkbox
- 用途：复选框，支持 `indeterminate` 半选。
- Props：`checked?/defaultChecked?/onChange?`、`indeterminate?`、`label?`。
- 用法：`<Checkbox label="启用" checked={v} onChange={setV} />`
- 键盘：Space 切换；`aria-checked` 反映三态。

## Radio / RadioGroup
- 用途：单选组。
- Props：RadioGroup `name/value?/defaultValue?/onChange?`；Radio `value/label/checked?`。
- 用法：`<RadioGroup name="g" onChange={fn}><Radio value="a" label="A"/></RadioGroup>`
- 键盘：方向键在组内移动选择；`role=radiogroup`。

## Switch
- 用途：开关，`role=switch`。
- Props：`checked?/defaultChecked?/onChange?`、`label?`。
- 用法：`<Switch aria-label="通知" checked={v} onChange={setV} />`
- 键盘：Enter / Space 切换；`aria-checked`。

## Badge
- 用途：状态徽标。`color?: neutral|primary|success|warning|danger|info`、`dot?`。

## Tag
- 用途：标签，`closable?/onClose?`。
- 键盘：关闭按钮可聚焦，Enter 移除。

## Breadcrumb
- 用途：`nav>ol` 面包屑，末项 `aria-current=page`。
- 键盘：链接为 `<button>`，可聚焦回车。

## SearchInput
- 用途：带搜索图标与清空的输入；`value?/onChange?`。

## Progress
- 用途：`role=progressbar`，`value?/max?/indeterminate?`；`aria-valuenow` 反映进度。

## Spinner
- 用途：`role=status` + `aria-live=polite`，默认中文 `aria-label="加载中"`。

## EmptyState
- 用途：空状态占位，`role=status`；`title/description/icon/action?`。

## Modal
- 用途：模态对话框，`Portal` + 焦点陷阱 + Esc / 遮罩关闭。
- Props：`open?/defaultOpen?/onOpenChange?`、`title?`、`footer?`、`size?`。
- 键盘：Tab 在面板内循环；Esc 关闭；`aria-modal`。

## Drawer
- 用途：抽屉，`placement?: left|right|top|bottom`。键盘同 Modal。

## Tooltip
- 用途：悬浮提示，`role=tooltip` + `aria-describedby`；hover / focus 显示，Esc 关闭（不拦截焦点）。
- 键盘：聚焦触发元素显示；Esc 隐藏。

## Popover
- 用途：气泡卡片，`Portal` 定位 + 焦点陷阱 + 外部点击 / Esc 关闭。

## Menu
- 用途：`role=menu` 菜单列表。
- Props：`items: {key,label,icon?,disabled?,danger?,separator?}[]`、`onSelect?/onClose?`。
- 键盘：↑↓ 移动；Enter/Space 选择；Esc 关闭；Home/End。

## ContextMenu
- 用途：右键菜单（`onContextMenu` 在光标处弹出），包裹 Menu。
- 键盘：打开后同 Menu；Esc / 外部点击关闭。

## CommandPalette
- 用途：命令面板，模糊检索 + ↑↓ 选择 + Enter 执行。
- Props：`commands: {id,title,subtitle?,icon?,group?,keywords?}[]`、`onSelect`、`open?`。
- 键盘：↑↓ 移动；Enter 执行；Esc 关闭。

## Toast
- 用途：全局轻提示，`<ToastProvider>` + `useToast()`；`role=region aria-live=polite`。
- 用法：`const { toast } = useToast(); toast({ title, description, variant, duration });`
- 键盘：关闭按钮可聚焦回车。

## Tabs
- 用途：`role=tablist/tab/tabpanel`。
- 键盘：←→ 移动并切换；Home/End 跳首尾。

## Tree
- 用途：虚拟化树（固定行高），基于可见节点扁平化。
- Props：`data: TreeNode[]`、`itemHeight?`、`height`、`expanded?/defaultExpanded?`、`onSelect?`。
- 键盘：↑↓ 移动；→ 展开（已展开进子级）；← 收起（已收起回父级）；Enter/Space 切换；Home/End。

## Table
- 用途：虚拟化表格，表头吸顶（`role=grid`）。
- Props：`columns`、`rows`、`rowKey`、`rowHeight?`、`height`、`renderCell?`、`onRowSelect?`。
- 键盘：↑↓ 移动；Enter 选择；Home/End。

## List
- 用途：虚拟化列表（`role=list`）。
- Props：`items`、`itemHeight`、`height`、`renderItem`、`getItemKey?`。
- 键盘：行内容可聚焦元素（如按钮）回车可达。

## SplitPane
- 用途：可拖拽双栏，`role=separator` + `aria-orientation`/`aria-valuenow`。
- 键盘：聚焦分隔条后 ←→（横向）/ ↑↓（纵向）以步长微调。

## Resizable
- 用途：可拖拽调整尺寸的面板；右 / 下 / 角手柄（`role=separator`）。
- 键盘：聚焦手柄后方向键以步长微调；`onResize` 回调。

---

## 设计令牌
- 浅色为默认（`:root`），深色通过 `[data-theme='dark']` 覆盖；高分屏经 `@media (min-resolution)` 调整 `--ec-hairline-width`。
- 颜色语义色走 `--ec-color-*`；尺寸 `--ec-spacing-*` / `--ec-radius-*`；字体 `--ec-font-*`；阴影 `--ec-shadow-*`；层级 `--ec-z-*`。
- 运行时可用 `tokensToCssVariables(theme)` 生成变量声明串注入；`tokensToCssSheet()` 生成完整样式表。
