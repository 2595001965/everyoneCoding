# Wave 3 — 可视化设计器（T3-01 ~ T3-11）

> 目标：墨刀式拖拽体验，产出结构化页面 DSL 而非图片；支持 Web / Android / iOS / HarmonyOS / Windows / Linux / macOS 七端；500 元素页面拖拽 ≥50FPS。
> 依赖：Wave 0（组件库、内核）+ T2-06（结构精简器）。

---

## T3-01 PageDSL 领域模型与持久化

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-01/07/08；§M3 DSL 结构；NFR-R-02 |
| 优先级 | P0 |
| 前置任务 | T0-08、T0-11 |
| 可并行 | 无（全部设计器任务依赖它） |

**产出物**

- `packages/designer/src/dsl/{types.ts,schema.ts,factory.ts,traverse.ts,serialize.ts,version.ts}`
- `packages/designer/src/dsl/__tests__/*`

**实现要点**

1. 严格实现 PRD §M3 的 `PageDSL` 与 `ElementNode`（id、projectId、name、platform、route、viewport、state、tree、events、apiDeps、notes、anchors）。
2. `ElementNode`：id、type、props、style、bindings、children、noteId；元素名与标识符遵循 D-10（名可中文显示，导出标识符英文/拼音）。
3. 持久化：每页一个 `*.dsl.json`，原子写；文件内带 `dslVersion` 支持升级迁移。
4. traverse 提供：按 id 查找、祖先链、子树遍历、路径定位（供 T4-02 元素链与 T7 重命名索引使用）。

**验收标准**

- [ ] DSL 类型与 PRD 示意结构字段完全一致，zod schema 校验通过
- [ ] 序列化 / 反序列化往返无损（含嵌套 8 层）
- [ ] 祖先链与路径定位在有重复 id 场景不串味
- [ ] 原子写入中断不产生半截文件

**▶ AI 执行提示词**

```
任务 T3-01：实现 PageDSL 领域模型与持久化（packages/designer/src/dsl）。
要求：
1) types.ts 严格实现 docs/PRD-EveryoneCoding.md M3 中的 PageDSL 与 ElementNode：PageDSL 含 id/projectId/name/platform('web'|'android'|'ios'|'harmonyos'|'windows'|'linux'|'macos')/route/viewport/state/tree/events/apiDeps/notes/anchors；ElementNode 含 id/type/props/style/bindings/children/noteId。
2) 元素名可中文（显示），但提供 toIdentifier() 导出英文/拼音标识符（D-10），拼音转换用轻量实现并可配置保留原文或自定义映射表。
3) schema.ts：zod schema 校验 + 结构不变量（id 唯一、嵌套深度 ≤8、children 递归）。
4) serialize.ts：每页一个 <pageId>.dsl.json，带 dslVersion 字段；读写走 packages/core 的原子写；加载时做版本迁移（version.ts）。
5) traverse.ts：findById、ancestorChain、subtree、pathOf（返回 JSON path 表达式）、visit（前序/后序）。
6) 测试：往返无损（含 8 层嵌套）、id 唯一校验、祖先链正确性、版本迁移、原子写中断。
验收：测试通过；输出一份登录页 DSL 样例 JSON。
```

---

## T3-02 画布引擎（多端视口 / 缩放 / 栅格 / 安全区）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-01；FR-DSG-06；NFR-P-02；NFR-C-03 |
| 优先级 | P0 |
| 前置任务 | T3-01、T0-06 |
| 可并行 | T3-04 |

**产出物**

- `packages/designer/src/canvas/{Canvas.tsx,Viewport.tsx,Ruler.tsx,GridOverlay.tsx,SafeArea.tsx,SelectionBox.tsx,ZoomControl.tsx}`
- `packages/designer/src/canvas/{device-presets.ts,coordinate.ts}`
- 性能基准脚本

**实现要点**

1. 视口预设：Web 响应式断点 1920/1440/768/375；Android 机型（360×800 等）；iOS 机型（390×844 等）；HarmonyOS 机型（直板 360×780、折叠展开态等，含三段态安全区）；桌面端 Windows / Linux / macOS 窗口预设（1440×900 / 1280×800 等，含标题栏与边框占位）；切换端/机型后画布尺寸与安全区正确渲染。
2. 渲染用 **DOM + CSS Transform**（与最终 Web 产物一致，零失真），缩放用 transform scale 而非重排。
3. 8px 栅格吸附默认开启可关闭；标尺、对齐参考线、智能间距提示。
4. 选中/框选/多选；坐标系统一（屏幕坐标 ↔ 画布坐标互转）。
5. 性能：500 元素页面拖拽 ≥50FPS，用 React.memo + 变换层隔离重渲染。

**验收标准**

- [ ] 七端预设切换后视口与安全区渲染正确（提供截图或 DOM 断言）
- [ ] 缩放 25%~400% 无错位；高分屏 150%/200% 无模糊
- [ ] 8px 栅格可开关，标尺与参考线正确
- [ ] 500 元素页面拖拽帧率 ≥50FPS（附基准数据）

**▶ AI 执行提示词**

```
任务 T3-02：实现设计器画布引擎（packages/designer/src/canvas）。
要求：
1) device-presets.ts：Web 断点 1920/1440/768/375，Android 机型预设（至少 360x800、412x915），iOS 机型预设（至少 390x844、430x932），HarmonyOS 机型预设（至少直板 360x780、折叠展开 840x940，含三段态安全区参数），桌面端预设（Windows/Linux/macOS 窗口 1440x900、1280x800，含标题栏高度与窗口边框占位）；移动端/鸿蒙预设含安全区参数（状态栏高度、刘海/挖孔占位、底部指示条）。
2) Canvas.tsx + Viewport.tsx：用 **DOM + CSS Transform** 渲染（不用 canvas 绘制），缩放走 transform: scale，保证与最终 Web 产物一致；支持 25%~400% 缩放、平移（空格拖拽/中键）、适应窗口、实际大小。
3) SafeArea.tsx：按预设渲染状态栏、刘海/挖孔、底部指示条的占位覆盖层（仅视觉，不进 DSL）。
4) Ruler.tsx + GridOverlay.tsx：标尺（px）、8px 栅格（默认开启，可在设置关闭）、对齐参考线与智能间距提示（在 T3-03 拖拽时消费）。
5) coordinate.ts：屏幕坐标 ↔ 画布坐标双向转换，处理缩放与滚动偏移。
6) SelectionBox.tsx：单选、框选、多选（Shift/Ctrl）、hover 高亮。
7) 性能：500 元素页面拖拽 ≥50FPS；用 React.memo + 拖拽期间只更新变换层（把拖拽中的元素提到独立层，避免整树重渲染）；编写 benchmark 脚本输出 fps 数据。
8) 测试：坐标转换、视口切换、安全区参数、栅格开关、多选行为。
验收：测试通过；给出 500 元素拖拽 fps 实测数据；七端视口渲染正确。
```

---

## T3-03 拖拽与布局（嵌套容器 / 吸附 / 指示线）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-02；FR-DSG-06 |
| 优先级 | P0 |
| 前置任务 | T3-02 |
| 可并行 | 无 |

**产出物**

- `packages/designer/src/dnd/{DndProvider.tsx,useDraggable.ts,useDroppable.ts,collision.ts,insertion-indicator.tsx,snapping.ts,layout-modes.ts}`
- 交互测试

**实现要点**

1. 基于 dnd-kit：从组件面板拖入画布、画布内移动、跨容器嵌套、拖出删除。
2. 插入位置指示线（水平/垂直/容器内），吸附参考线与 8px 栅格吸附；嵌套 ≤8 层不卡顿。
3. 布局模式：绝对定位 与 流式（flex）两种，可切换；流式下按容器方向插入。
4. 拖拽期间禁止触发点击/双击；Esc 取消当前拖拽。
5. 拖拽操作进 undo 栈（与 T0-09 打通）。

**验收标准**

- [ ] 拖入 / 移动 / 嵌套 / 删除四类操作全部可用且有指示线
- [ ] 8 层嵌套下拖拽仍 ≥50FPS
- [ ] 吸附与参考线准确（提供几何断言测试）
- [ ] 拖拽可被 Esc 取消，且取消后结构不变
- [ ] 拖拽可撤销重做

**▶ AI 执行提示词**

```
任务 T3-03：实现拖拽与布局（packages/designer/src/dnd）。
要求：
1) 基于 dnd-kit 实现：从组件面板拖入画布、画布内移动、跨容器嵌套、拖出画布删除；提供自定义碰撞检测（指针位于容器内 40% 边距时判定为嵌套插入）。
2) insertion-indicator：水平/垂直/容器内三种插入指示线，实时显示插入位置；snapping.ts 实现 8px 栅格吸附与相邻元素对齐参考线（左/右/顶部/底部/水平中心/垂直中心），吸附阈值 4px。
3) layout-modes.ts：绝对定位（自由摆放，记录 x/y）与流式（flex 行列插入）两种容器布局模式，可切换且切换时给出位置换算策略。
4) 交互细节：拖拽期间屏蔽点击/双击事件；Esc 取消当前拖拽并还原预览；拖拽结束才提交状态变更（保证 undo 是单步）。
5) 与 T0-09 的 undo-manager 打通：一次拖拽 = 一步 undo。
6) 测试：四类拖拽操作的几何断言（插入位置、吸附偏移）、嵌套深度 ≤8 的帧率、Esc 取消不改变结构、undo/redo 单步。
验收：测试通过；8 层嵌套拖拽 ≥50FPS；吸附与指示线行为可复现。
```

---

## T3-04 组件库体系（基础 + 业务 + 自定义注册）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-03 |
| 优先级 | P0 |
| 前置任务 | T0-06 |
| 可并行 | T3-02 |

**产出物**

- `packages/designer/src/components/{Container,Text,Image,Button,Input,Select,Table,List,Form,Modal,Tabs,Navbar}.tsx`（12 类基础组件）
- `packages/designer/src/components/business/{LoginCard,DashboardTemplate,ListPageTemplate}.tsx`
- `packages/designer/src/registry/{component-registry.ts,prop-schema.ts,icon-set.ts}`
- 组件渲染与属性 schema 测试

**实现要点**

1. 12 类基础组件 + 3 类业务组件 + 图标库；每类组件声明：type、显示名（中文）、默认 props、默认 style、可嵌套规则、属性 JSON Schema。
2. 属性用 **JSON Schema 描述**，属性面板（T3-05）据此自动生成表单，支持自定义组件注册。
3. 组件渲染必须与 T0-06 UI 库视觉一致，但**不共享内部状态**（设计器组件为纯展示 + 受控 props）。
4. 可嵌套规则：如 Button 不接受 children（除文本）、Container/Form/Modal/Tabs 接受 children。

**验收标准**

- [ ] 12 基础 + 3 业务组件全部可拖入并渲染（快照测试）
- [ ] 每类组件的属性 JSON Schema 完整且可被 T3-05 消费生成表单
- [ ] 嵌套规则生效：不允许 children 的组件拒绝放入
- [ ] 自定义组件可通过 JSON Schema 注册并出现在面板

**▶ AI 执行提示词**

```
任务 T3-04：实现设计器组件库体系（packages/designer/src/components）。
要求：
1) 12 类基础组件：Container、Text、Image、Button、Input、Select、Table、List、Form、Modal、Tabs、Navbar；3 类业务组件：LoginCard、DashboardTemplate、ListPageTemplate；并提供图标集（内联 SVG，不引外部图标库）。
2) 每个组件的元信息通过 registry 声明：{type, displayName(中文), defaultProps, defaultStyle, acceptsChildren, propSchema(JSON Schema), icon}。
3) prop-schema.ts 定义 JSON Schema 规范（类型、枚举、条件显隐、分组、单位），属性面板据此自动渲染表单；所有文案中文，字段名为英文。
4) component-registry.ts：注册/注销/查询/按分组列举；支持运行时注册自定义组件（传入 React 组件 + 元信息 + JSON Schema）。
5) 组件渲染为纯受控展示（设计器内不持有业务状态），视觉与 @ec/ui 保持一致。
6) 嵌套规则：Button/Text/Image/Input 不接受 children；Container/Form/Modal/Tabs 接受 children；违反时拖拽拒绝并提示。
7) 测试：每个组件的渲染快照、schema 完整性校验、嵌套规则断言、自定义组件注册后出现在面板。
验收：测试通过；组件面板能列出全部 15 类组件及图标。
```

---

## T3-05 属性面板（样式 / 内容 / 绑定 / 事件 / 条件渲染 / 权限）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-04 |
| 优先级 | P0 |
| 前置任务 | T3-04、T3-08（绑定部分可后置，先留接口） |
| 可并行 | 无 |

**产出物**

- `packages/designer/src/inspector/{Inspector.tsx,StylePanel.tsx,ContentPanel.tsx,BindingPanel.tsx,EventPanel.tsx,ConditionPanel.tsx,PermissionPanel.tsx,SchemaForm.tsx}`
- 测试

**实现要点**

1. 由 T3-04 的 JSON Schema 自动生成表单（SchemaForm），分组折叠；支持样式（尺寸/间距/颜色/字体/圆角/阴影/边框）。
2. 修改即时生效并可撤销（Ctrl+Z / Ctrl+Shift+Z）；输入类控件做防抖（200ms）避免 undo 栈被输入淹没。
3. 条件渲染与权限：表达式编辑器（简单 AND/OR 条件树，不起 eval）。
4. 多选时展示公共属性，批量修改。
5. 与图层树、画布三向联动（选中即高亮）。

**验收标准**

- [ ] 六类属性面板均可编辑并即时生效
- [ ] 文本输入 200ms 防抖，连续输入合并为一步 undo
- [ ] 多选时只显示公共属性，批量修改生效
- [ ] 修改后画布与图层树同步高亮

**▶ AI 执行提示词**

```
任务 T3-05：实现属性面板（packages/designer/src/inspector）。
要求：
1) SchemaForm.tsx：根据 T3-04 的 JSON Schema 自动渲染表单，支持 string/number/boolean/enum/color/size/spacing/shadow/border 等控件类型、分组折叠、条件显隐（schema 中的 visibleWhen）。
2) 六个分区：StylePanel（尺寸/间距/颜色/字体/圆角/阴影/边框）、ContentPanel（文本、图片源、表格列配置）、BindingPanel（属性 → 页面状态或接口字段，先留接口 getDataSources() 由 T3-08 提供）、EventPanel（事件 → 动作流，打开 T3-09 编辑器）、ConditionPanel（条件渲染，AND/OR 条件树，不使用 eval，走结构化表达式）、PermissionPanel（可见/可编辑角色条件）。
3) 即时生效 + 可撤销：数值/颜色用受控输入，文本类 200ms 防抖；连续输入在 undo 栈中合并为一步（用 T0-09 的合并能力）。
4) 多选：只展示公共属性，修改应用到全部选中元素，标题显示"已选 N 个元素"。
5) 三向联动：与画布选中、图层树选中共享同一 selection store。
6) 测试：表单渲染（覆盖全部控件类型）、防抖与 undo 合并、多选批量修改、条件表达式结构化输出。
验收：测试通过；手工验证改一个元素的圆角后画布即时更新且 Ctrl+Z 可撤销。
```

---

## T3-06 图层树（三向联动）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-05 |
| 优先级 | P0 |
| 前置任务 | T3-01、T3-02 |
| 可并行 | T3-05 |

**产出物**

- `packages/designer/src/layers/{LayerTree.tsx,LayerNode.tsx,useLayerDnd.ts}`
- 测试

**实现要点**

1. 层级化展示（虚拟化，支持 500+ 节点）；拖拽调整层级与父子关系；重命名（双击，走 T7 重命名流程，此处先触发事件）。
2. 锁定 / 隐藏 / 批量选择（Shift/Ctrl 多选）；锁定元素画布不可选、隐藏元素画布不渲染（半透明占位由编辑器内保留）。
3. 与画布、属性面板三向联动高亮：hover 同步、选中同步。
4. 搜索过滤节点（按名称/类型）。

**验收标准**

- [ ] 500 节点下树滚动流畅（虚拟化生效）
- [ ] 拖拽调整层级与父子关系正确，越界（拖入自身子树）被拒绝
- [ ] 锁定/隐藏行为正确，锁定元素画布不可选中
- [ ] 三向 hover/选中高亮同步

**▶ AI 执行提示词**

```
任务 T3-06：实现图层树（packages/designer/src/layers）。
要求：
1) LayerTree.tsx：基于 @ec/ui 的虚拟化 Tree 渲染元素层级；支持展开折叠、按名称/类型搜索过滤、Shift/Ctrl 多选、右键菜单（重命名/锁定/隐藏/删除/复制）。
2) useLayerDnd.ts：拖拽调整顺序与父子关系，禁止拖入自身子树（循环检测），拖到容器上时高亮目标容器；变更一步进 undo 栈。
3) 锁定与隐藏：locked 元素在画布不可选中（命中测试跳过）但在树中显示锁标；hidden 元素在画布不渲染、树中显示眼睛关闭标，且导出 DSL 时保留节点（标记 hidden 属性）。
4) 重命名：双击触发 onRenameRequest(elementId, newName) 事件，由后续 T7-03 统一重命名流程接管（本次只发事件并乐观更新显示名）。
5) 三向联动：与画布、属性面板共享 selection store，支持 hover 联动高亮（hover 时画布描边 + 树节点高亮）。
6) 测试：500 节点虚拟化渲染、拖拽层级变更、循环拖拽拒绝、锁定/隐藏行为、三向联动同步。
验收：测试通过；手工验证拖一个按钮进另一个容器后结构正确。
```

---

## T3-07 多页面与路由

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-07；FR-MEM-02（路由总表写入项目记忆） |
| 优先级 | P0 |
| 前置任务 | T3-01 |
| 可并行 | 无 |

**产出物**

- `packages/designer/src/pages/{PageTree.tsx,PageNode.tsx,RouteGraph.tsx,RouteEditor.tsx,route-table.ts}`
- 测试

**实现要点**

1. 页面树 + 页面跳转关系连线（RouteGraph，节点为页面、边为跳转事件），支持路由参数配置。
2. 页面模板复用（从模板创建页面、复制页面）。
3. 自动生成路由表并写入项目记忆（调用 packages/memory 的项目记忆更新）。
4. 页面 CRUD：新建/重命名/复制/删除（删除二次确认 + 撤销）；页面级 platform 归属。

**验收标准**

- [ ] 页面树 CRUD 可用，删除二次确认且可撤销
- [ ] 跳转连线正确反映 DSL 中的事件跳转动作，点击边可编辑参数
- [ ] 路由表自动生成并写入项目记忆（断言项目记忆 structured.routes 更新）
- [ ] 页面模板复用可用

**▶ AI 执行提示词**

```
任务 T3-07：实现多页面与路由（packages/designer/src/pages）。
要求：
1) PageTree.tsx：页面列表树（按端分组 web/android/ios），支持新建/重命名/复制/删除；删除二次确认且可撤销（软删除 + 回收）。
2) RouteGraph.tsx：可视化跳转关系图，节点为页面、边为跳转事件（从 DSL events 中 action.type='navigate' 提取），支持点击边编辑目标与路由参数（params 列表：name/type/required/默认值）。
3) route-table.ts：生成路由总表 {path, pageId, platform, params[]}，去重与冲突检测（同一 platform 下路径重复时报错并给出建议）。
4) 路由表变更时调用 packages/memory 更新项目记忆的 structured.routes（写前读、合并、写回，带乐观锁）。
5) 页面模板复用：内置模板（空白/登录页/列表页/详情页/仪表盘）创建页面，以及复制现有页面为模板。
6) 测试：页面 CRUD、路由表生成与冲突检测、跳转边提取、项目记忆写入断言、模板创建。
验收：测试通过；手工建 3 个页面并连线跳转，检查项目记忆中的路由总表已更新。
```

---

## T3-08 页面状态与数据绑定

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-08（状态部分）；FR-PRV-02（数据绑定基础） |
| 优先级 | P0 |
| 前置任务 | T3-01、T3-05 |
| 可并行 | 无 |

**产出物**

- `packages/designer/src/state/{StatePanel.tsx,StateEditor.tsx,BindingPicker.tsx,data-source.ts,StateStore.ts}`
- 测试

**实现要点**

1. 页面级状态定义：变量（name/type/initial/source: local|api），供属性面板的 BindingPanel 消费（提供 `getDataSources()`）。
2. 数据绑定：元素属性 → 状态字段 / 接口响应字段；绑定选择器支持路径选择（如 `user.list[0].name`）。
3. 运行时状态容器：预览模式下驱动真实交互（T6-05 消费）。
4. 状态变更可撤销；删除被引用的状态时警告并列出引用位置。

**验收标准**

- [ ] 状态可增删改，类型覆盖 string/number/boolean/object/array
- [ ] 绑定选择器可选取状态与接口字段路径，绑定写入 DSL `bindings`
- [ ] 删除被引用状态前警告并列出引用元素
- [ ] 预览模式下状态变更能驱动元素渲染（与 T6-05 联调）

**▶ AI 执行提示词**

```
任务 T3-08：实现页面状态与数据绑定（packages/designer/src/state）。
要求：
1) 页面级状态定义：StatePanel 列出状态变量 {name, type(string|number|boolean|object|array), initial, source('local'|'api'), apiRef?}，可增删改，支持排序与分组。
2) data-source.ts 暴露 getDataSources(pageId)，返回 {states: StateDef[], apis: ApiDef[]}，供 T3-05 的 BindingPanel 消费。
3) BindingPicker.tsx：可视化选择绑定目标，支持对象/数组路径选择（如 user.list[0].name），生成路径表达式字符串写入元素 bindings（键为属性名）。
4) 引用检查：删除状态时扫描全部元素 bindings，若被引用则弹窗警告并列出引用元素（可点击跳转），确认后删除并清理绑定。
5) StateStore：运行时状态容器（get/set/subscribe/reset），预览模式下驱动真实交互（先实现与单元测试，T6-05 接入）。
6) 所有变更进 undo 栈。
7) 测试：状态 CRUD、绑定路径生成与解析、引用检查告警、StateStore 订阅与重置。
验收：测试通过；手工验证给一个文本元素绑定状态后预览可随状态变化。
```

---

## T3-09 动作流编辑器（可视化节点图）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-08（事件动作流部分） |
| 优先级 | P0 |
| 前置任务 | T3-08 |
| 可并行 | 无 |

**产出物**

- `packages/designer/src/flow/{FlowEditor.tsx,NodePalette.tsx,ActionNode.tsx,EdgeLayer.tsx,flow-schema.ts,flow-validator.ts,flow-runtime.ts}`
- 测试

**实现要点**

1. 可视化节点图编辑：动作类型 跳转（navigate）/ 请求（request）/ 赋值（setState）/ 提示（toast）/ 条件分支（branch）；支持同步/异步。
2. 节点图序列化进 DSL `events[].actions`，结构化（非脚本），便于 AI 消费与代码生成。
3. 校验：必填参数、目标存在性（跳转页面是否存在、接口是否已定义）、环检测（条件分支回环允许但需标注）。
4. flow-runtime：预览时执行动作流（与 T3-08 StateStore、T6-05 预览打通）。
5. 自动连线布局 + 手动拖拽调整。

**验收标准**

- [ ] 五类动作节点可拖拽编排并序列化进 DSL
- [ ] 校验器能报出：缺失必填、跳转目标不存在、接口未定义、孤立节点
- [ ] 条件分支可双向连线，环被检测到并标注
- [ ] 预览时点击按钮能真实执行动作流（与 T6-05 联调）

**▶ AI 执行提示词**

```
任务 T3-09：实现动作流编辑器（packages/designer/src/flow）。
要求：
1) FlowEditor.tsx：节点图编辑器（自绘 SVG 连线 + DOM 节点，不引 react-flow 之外的重依赖；若必须引第三方请说明理由），支持节点拖拽、连线、删除、复制、自动布局（简单分层布局）。
2) 五类动作节点：navigate（目标页面 + 参数）、request（接口 + 入参映射 + 成功/失败分支）、setState（状态名 + 值/表达式）、toast（类型 + 文案）、branch（条件表达式，走 T3-05 的结构化条件，不用 eval）；支持同步/异步标记（request 默认异步）。
3) flow-schema.ts：动作流的 JSON 结构定义（节点 id/type/params/next/branchTrue/branchFalse），序列化进 DSL 的 events[].actions。
4) flow-validator.ts：校验必填参数、跳转目标页面是否存在、request 引用的接口是否已在功能记忆/接口清单中定义、孤立节点、条件环检测（允许但标注 cyclic）。
5) flow-runtime.ts：执行引擎（execute(flow, context)），与 T3-08 的 StateStore 和后续预览服务打通；request 节点调用预览数据层（先注入 IRequester 接口，便于 mock）。
6) 测试：五类节点的序列化往返、四类校验告警、条件分支执行、环检测、运行时执行顺序（含异步等待）。
验收：测试通过；手工配置"点击按钮 → 请求 /api/login → 成功跳转 /dashboard → 失败 toast"并在预览中跑通。
```

---

## T3-10 撤销重做与设计稿快照历史

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-13；NFR-R-01 |
| 优先级 | P1 |
| 前置任务 | T3-03、T0-09 |
| 可并行 | 无 |

**产出物**

- `packages/designer/src/history/{snapshot.ts,timeline.tsx,diff-view.tsx,auto-snapshot.ts}`
- 测试

**实现要点**

1. 快照：每 5 分钟自动 + 关键操作（阶段确认、AI 生成、重命名）触发；快照存 DSL 全量（压缩）或 patch 链。
2. 时间轴回放：按时间列出快照，可预览任一版本，回滚到指定版本（回滚前自动存当前）。
3. 差异对比：结构化 diff（新增/移动/修改/删除元素），高亮显示。
4. 与流水线阶段产物版本（T5-01）区分：设计稿快照是设计器级，不走 StageArtifact。

**验收标准**

- [ ] 5 分钟自动快照与关键操作快照均生效
- [ ] 时间轴可预览历史版本，回滚后结构正确且可再次撤销回滚
- [ ] 差异视图正确显示四类变更
- [ ] 快照占用可控（给出 100 次快照的体积数据）

**▶ AI 执行提示词**

```
任务 T3-10：实现设计稿快照与历史（packages/designer/src/history）。
要求：
1) snapshot.ts：快照 = 页面 DSL 全量 + 元信息（时间、触发原因 auto|manual|milestone、关联 commit sha 可选）；存储用增量策略（首次全量，后续 patch 链，每 20 个 patch 落一次全量基线），控制体积。
2) auto-snapshot.ts：每 5 分钟定时快照（空闲时不执行）+ 关键操作触发（阶段确认、AI 生成完成、重命名事务、导入导出），走原子写。
3) timeline.tsx：时间轴 UI 展示快照列表（时间、原因、变更元素数），支持预览任一版本（只读模式渲染）与"回滚到此版本"（回滚前自动保存当前为快照）。
4) diff-view.tsx：结构化差异对比（新增/移动/修改/删除四类，移动需识别为移动而非删除+新增），树形展示并可点击定位。
5) 与流水线 StageArtifact 区分：设计稿快照独立存储，不写 pipeline 表。
6) 测试：定时与关键操作触发、patch 链与基线重建、回滚与再次回滚、diff 四类识别（含移动识别）、100 次快照体积统计。
验收：测试通过；给出 100 次快照的磁盘占用数据。
```

---

## T3-11 AI 生成界面 / 母版 / 响应式 / 多端一致性

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-DSG-11；FR-DSG-09；FR-DSG-10；FR-DSG-14 |
| 优先级 | P0（AI 生成）/ P1（其余） |
| 前置任务 | T3-03、T3-04、T1-05 |
| 可并行 | 无 |

**产出物**

- `packages/designer/src/ai/{GeneratePanel.tsx,sketch-import.ts,dsl-from-ai.ts}`
- `packages/designer/src/master/{MasterPanel.tsx,master-sync.ts}`
- `packages/designer/src/responsive/{BreakpointBar.tsx,responsive-rules.ts}`
- `packages/designer/src/consistency/{consistency-check.ts,ConsistencyPanel.tsx}`
- 测试

**实现要点**

1. AI 生成界面：自然语言描述或上传草图（图片）→ 生成可编辑 DSL；生成结果进入画布后仍可自由拖拽修改，并**自动写入页面记忆**（调用 T2-06）。
2. 母版（Master）：组件复用，修改母版后引用实例可选「同步更新」或「脱离」。
3. 响应式规则：断点切换时仅覆盖差异属性，不产生全量副本。
4. 多端一致性校验：同一功能在七端（Web/Android/iOS/HarmonyOS/Windows/Linux/macOS）所选目标端上的结构差异提示，缺失端/缺失页面在工作台提示。

**验收标准**

- [ ] 输入"做一个登录页"能生成可编辑 DSL，落地画布后仍可拖拽修改
- [ ] 生成后自动写入页面记忆（断言页面记忆更新）
- [ ] 母版修改后实例可同步更新或脱离，脱离后不再同步
- [ ] 响应式断点只存差异属性（断言 DSL 体积不随断点线性增长）
- [ ] 缺失端/页面在工作台给出提示

**▶ AI 执行提示词**

```
任务 T3-11：实现 AI 生成界面、母版复用、响应式规则与多端一致性校验。
要求：
1) ai/GeneratePanel.tsx：输入自然语言描述或上传草图图片（走 Provider 的视觉能力，Provider 不支持视觉时禁用上传并提示），通过 packages/ai 网关的 interface 用途生成 PageDSL；解析失败重试 1 次并降级为文本描述生成。
2) ai/dsl-from-ai.ts：把模型返回结构化结果校验为合法 DSL（zod + 组件白名单校验，未知组件类型降级为 Container 并提示），落地画布后**仍可自由编辑**，并调用 T2-06 精简器自动写入页面记忆。
3) master/MasterPanel.tsx + master-sync.ts：母版（可复用组件）定义与实例化；修改母版后，实例在 UI 中列出并可逐个选择「同步更新」或「脱离」；脱离后不再同步且标记 detached。
4) responsive/responsive-rules.ts：断点（1920/1440/768/375）差异化配置，仅存储与基线的差异属性（override map），切换断点时合并基线 + override；断言 DSL 不产生全量副本。
5) consistency/consistency-check.ts：按功能（featureRef）比对项目所选目标端（七端，从项目设置读取）的页面结构，输出差异清单（缺失端、缺失页面、结构差异、命名差异），在工作台与功能节点上提示。
6) 测试：AI 生成结果校验与降级、页面记忆自动写入、母版同步与脱离、响应式差异存储、一致性差异清单。
验收：测试通过；手工输入"做一个登录页"能生成、可编辑、且页面记忆被更新。
```

---

**Wave 3 出口检查**：能从组件面板拖出 20 元素的登录页（E2E-04），导出 DSL，结构精简后进页面记忆；Ctrl+Z 可撤销全部操作；七端视口切换正常；500 元素拖拽 ≥50FPS。
