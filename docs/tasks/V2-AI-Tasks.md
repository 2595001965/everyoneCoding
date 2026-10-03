# EveryoneCoding — V1 遗留补缺与 V2 增量 AI 任务

> 重排日期：2026-10-02。需求依据：[第二版 PRD](../PRD-EveryoneCoding-V2.md)。
>
> **本文件替代原“25 项全部待办”的执行方式。现在共 17 项：1 项已实现基础的集成补缺、15 项增量/替换任务、1 项门禁收口与整体验收。** V1 的具体遗留分别并入相关任务，不重投第一版整卡；已经交付的 V2-T01/T02/T03 保留为基线，不从零重做。
>
> 新任务使用 `V2-D00`～`V2-D16`，避免覆盖旧 `V2-Txx` 的实现历史。旧编号到新编号见 §5。任务数量减少来自复用、按可交付闭环合并及将接线放回功能任务，不代表剩余工作只需 17 次模型调用。

## 1. 核查结论：哪些不用再做，哪些确实还有差额

### 1.1 核查依据与边界

本次读取旧任务、验收/能力/发布记录，并核对当前工作区关键实现，包括未提交的 V2 修改；补跑了代表性自动测试，**没有重跑全仓、真实模型、原生双壳 GUI 或全部发布流程**。

- [V1 遗留清单](12-未完成任务清单-可直接交给AI.md:60)已经明确：T12-01～T12-07 不再重复投递，T12-08 代码与集成测试已完成。旧 Wave 文档的历史勾选框不能作为重新开发的依据。
- [发布记录](../RELEASE.md:237)已有双形态安装包和更新演练证据，不能继续把“实现自动更新/首次产出安装包”列为全新任务。
- V1“领域已实现”“Electron 已验收”和“双形态所有页面/发布条件都已完成”不是同一个结论。下面仅列当前代码仍可证实的差额。
- Git 克隆、基本项目画像、后端托管、AI 网关、用量统计、写入事务和源码锚点都存在；V2 应扩展这些能力，不重写整个系统。

### 1.2 已完成或已有实现，直接复用

| 能力                                            | 当前证据/阅读入口                                                                                                                        | 后续处置                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Electron 生产域、项目上下文、流水线持久化       | 旧清单 T12-01～04；`apps/desktop-electron/src/main/domain/`                                                                              | 保留生产域和 checkpoint，不重新总装十一域、不重写 S1–S7                |
| Git 导入与管理                                  | [workspace.ts:675](../../apps/desktop-electron/src/main/domain/workspace.ts:675) 已克隆、扫描、建立项目并登记外置代码根；`packages/git/` | 克隆/Fetch/Pull/凭据直接复用；D01 只补文件夹/普通 ZIP 等接入差异       |
| 真实后端、静态/Mock 预览                        | [preview-domain.ts:161](../../apps/desktop-electron/src/main/domain/domains/preview-domain.ts:161)、`packages/preview/src/backend/`      | D02 补真实前端、多服务运行计划和实例隔离，不重写后端运行器             |
| 设计器、记忆、文档、OCR、账号、重命名、归档基础 | 旧清单 T12-02/04/05/07 的交付与验收块                                                                                                    | 不重新安排这些完整模块；只做新场景适配和回归                           |
| AI 生成与补丁应用                               | `packages/ai/src/generate/`、`packages/ai/src/write/write-pipeline.ts`                                                                   | D07 增加跨任务并发保护，D09 增加接口/运行元素目标，不重写生成引擎      |
| 基础 Token、成本和限流                          | [usage.ts:9](../../packages/ai/src/core/usage.ts:9)、`packages/ai/src/gateway/`、`repo/usage-repo.ts`                                    | D05/D14 扩展计量与展示；本地成本统计不是平台钱包                       |
| 自动更新与安装包                                | [RELEASE.md:237](../RELEASE.md:237)～265                                                                                                 | 保留；签名、发行侧车和正式环境条件单独复验，不重新实现更新器           |
| V2-T01 公共契约                                 | [契约基线](../V2-CONTRACT-BASELINE.md)、`packages/core/src/v2/`                                                                          | 已有 schema、计量/金额等纯函数；复用，不等于对应持久化/服务/界面已实现 |
| V2-T02 同模型多 Provider                        | `packages/ai/src/domain/model-route.ts`、`repo/model-repo.ts`、迁移 `0008_provider_model_route.sql`                                      | 核心隔离/迁移已有；仅 D00 修跨包契约和默认路由差额                     |
| V2-T03 本地 Provider                            | `ProviderSettings`、`LocalModePanel`、`ConnectionTest`、宿主本地模式测试                                                                 | 免平台、本地配置与连接测试收费提示已有；保留，真实外壳验收归 D16       |

### 1.3 V1 当前仍有证据的未完成部分

| 编号 | 已核实差额                                                                          | 证据及准确边界                                                                                                                                                                                  | 合并到任务                                      |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| L1   | ~~Tauri 记忆/流水线页面缺生产端口~~ D08 已改为 Promise 端口并在写后重读真实领域状态 | Tauri 原生页面待实机验；异步端口实现与 UI 测试已通过                                                                                                                                            | 已实现；原生验收待环境                          |
| L2   | 工作台最近提交与详情为空                                                            | [workspace.ts:447](../../apps/desktop-electron/src/main/domain/workspace.ts:447)及513：`git.recent`/详情恒空。Git 模块本身已有能力；V1 FR-WSP-06 原为 P2，不能把这个展示缺口说成核心 Git 未完成 | D14：接既有 Git 查询和下钻，不新增 Git 实现     |
| L3   | 项目缩略图未接线                                                                    | [workspace.ts:839](../../apps/desktop-electron/src/main/domain/workspace.ts:839)：`getThumbnailUrl` 恒返回 null；不能用占位卡片证明缩略图完成                                                   | D02：复用真实预览产出缩略图；空工程保留明确占位 |
| L4   | CI 覆盖率不是阻断门禁                                                               | [.github/workflows/ci.yml:81](../../.github/workflows/ci.yml:81)～84：覆盖率步骤 `continue-on-error: true`，失败被忽略                                                                          | D16：修实际门禁并校验证明；不重建现有 CI        |

**不能直接认定为编码缺口的事项：**

- Tauri 发行包中的 Node/侧车及 ABI、OAuth 协议回退桥：能力矩阵记录限制，但发行构建可能另行装配。D08/D16 先核验实际包和桥接链路，只有证实缺失才补对应接线；“安装包存在”不能证明侧车业务完整，“旧文档未做”也不能证明当前仍未做。
- 真实邮件送达、第三方 OAuth、真实模型质量、多端工具链/真机、官方 MSVC 环境、签名证书和线上更新：单列待验收/外部条件，不重新列邮箱、OAuth、AI 或更新器开发任务。
- Python/Java 外部 AST 适配：已有作用域解析和降级说明；本轮不凭旧待办重投整个解析器模块。D04 对新增接口适配器的能力单独验收。
- 旧验收/能力记录中“安装包未产出”与新发布记录冲突：D16 校正文档状态，保留历史日期，不能据过期标题重复造安装器。

### 1.4 V2 已交付基础的真实集成差额

这些是已执行 T01/T02/T03 后的收口，不是“再开发三项”。

1. **路由字段语义不一致**：公共层 [provider-model.ts:30](../../packages/core/src/v2/provider-model.ts:30)把 modelId 校验为本地 ULID，序列化为 `providerId/modelId`；AI 域 [model-route.ts:6](../../packages/ai/src/domain/model-route.ts:6)的 modelId 是上游名称，句柄为 `providerId:modelName`。两种表示可以分层存在，但必须有明确类型/转换，不能直接混用到 usage、价格和账务。
2. **同名模型切换 Provider 的默认配置变化被漏检**：[applier.ts:156](../../packages/ai/src/remote-config/applier.ts:156)只比较模型名。本次直接执行 `planApply`，以当前 A/same-model、传入 B/same-model 构造样例，`defaultModelChange` 为 null。需要比较完整路由，而非重写远程配置模块。
3. **验证边界**：现有本地模式测试使用受控上游和测试安全存储，不能代替实际 DPAPI、Tauri 页面及真实付费渠道验收；保留“已实现待验收”而不是全部改成待办或全部已验收。

以上归 **D00**。迁移 0008 已存在，后续迁移编号以实际目录为准；down 撤销结构不自动等于完整恢复去重前数据，验收须检查备份与数据保留，不要求重跑历史迁移。

### 1.5 本次实际复跑结果

2026-10-02，Node v24.21.0，仓库根目录，`--no-file-parallelism`：

| 范围                 | 文件                                                                                                                                 | 结果                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| V2 已实现基础        | `ai-control-route.test.ts`、`provider-model-route-migration.test.ts`、`ai-local-mode.test.ts`                                        | 3 文件 / 13 项通过      |
| V1 生产域代表性回归  | `domain-production.test.ts`、`domain-docs.test.ts`、`pipeline-production.test.ts`、`domain-run-ports.test.ts`、`domain-auth.test.ts` | 5 文件 / 92 项通过      |
| 默认路由变化最小复现 | `planApply` 当前与传入模型名相同、Provider 不同                                                                                      | 确认返回 null，遗漏变化 |

共 **105 项自动测试通过**，不代表所有 V1/V2 需求已验收；上述路由反例也表明“现有测试通过”不等于无遗漏。可复跑命令：

```bash
node node_modules/vitest/vitest.mjs run packages/ai/src/service/__tests__/ai-control-route.test.ts packages/data/src/__tests__/provider-model-route-migration.test.ts apps/desktop-electron/src/main/__tests__/ai-local-mode.test.ts --no-file-parallelism
```

```bash
node node_modules/vitest/vitest.mjs run apps/desktop-electron/src/main/__tests__/domain-production.test.ts apps/desktop-electron/src/main/__tests__/domain-docs.test.ts apps/desktop-electron/src/main/__tests__/pipeline-production.test.ts apps/desktop-electron/src/main/__tests__/domain-run-ports.test.ts apps/desktop-electron/src/main/__tests__/domain-auth.test.ts --no-file-parallelism
```

## 2. 交给 AI 的通用规则

### 2.1 复制即用

```text
请在 EveryoneCoding 仓库执行 V2-D00。
先阅读 docs/tasks/V2-AI-Tasks.md 的核查结论、通用规则和目标任务卡，再阅读 docs/PRD-EveryoneCoding-V2.md 对应需求。
这是在 V1 和已交付 V2-T01/T02/T03 上做增量，不得重做已完成模块。检查当前 git status 和代码，保留所有已有修改。
只补本卡列出的差额，并完成生产端口/UI/测试；不要仅新增类型或假端口。其他任务不要自动执行。
完成后报告修改、实际测试命令、逐项验收结果及环境阻塞。不要自动提交、推送、上线或使用真实付费服务。
```

后续替换任务编号，或复制任务卡末尾提示词。旧编号不再直接作为新执行请求；先按 §5 查映射。

### 2.2 全部任务必须遵守

1. 已有源码、已完成任务和未提交修改均是基线。不得 reset/clean/覆盖来清场；不得将历史待办直接重新开发。
2. 读取当前源码与 `.workbuddy/memory/` 相关说明；记录中的旧盘符/用户名/环境版本不是固定要求。不能将过期注释当运行事实，例如 workspace 顶部曾写 Git 未接，实际 `importFromGit` 已实现。
3. 只补明确差额，复用既有类型、核心纯函数、生成、Git、账号、数据层。D00 先解决契约冲突，后续不要各自再定义另一套路由/计费口径。
4. **每项功能任务自带生产接线**：UI→shell-api→白名单/bridge→domain→资源→事件回传→测试。取消“先堆假 UI，最后另花一个大任务补全部接线”的做法。
5. 双外壳共享业务层，renderer 不引入 Node/SQLite/AST 运行依赖；Tauri 异步行为不能用同步假快照掩盖。
6. 源码是事实来源；客户端代码只读，AI 修改仍经计划、diff、确认、安全应用；陌生项目扫描不执行脚本，不自动迁移数据库。
7. 不读/打印真实 Key；平台与 BYOK 独立；未知 Token/价格/时间/余额显示未知，不伪造 0。真实模型调用、外部写请求、部署和支付需要单独授权。
8. UI 改动实际操作验证，原生窗口/进程/IPC 实际外壳验证；集成测试、浏览器 mock、真实桌面和真实付费服务分别说明，未运行不写通过。
9. 依赖满足且写集不重叠才并行；迁移编号、core 契约、shell-api、域装配、锁文件由一个集成人协调。同一目录不能任由多个 AI 同时改同一文件。
10. 对真实环境阻塞，只停止受影响验收，不把已完成代码重投；对真实业务决策（币种、售价、商户）向用户确认，不自行决定。
11. 粒度按独立交付划分，复杂卡片可分连续子步骤但保持同一完成定义；不要为了少报任务把未接线/未验证当完成，也不要为凑任务数拆通用骨架。
12. 当前任务完成后只更新自己的状态与证据；必要说明可改，其他历史完成记录保留。修改 CI 时单独说明影响并取得相应许可，不绕过保护。

验证按当前仓库脚本执行：针对性 Vitest、lint、typecheck、变更文件格式、相应构建；服务端测试单独使用其配置。最终 D16 运行整体验收。不全仓格式化、不因本次文档修改启动无关服务。

### 2.3 回报格式

```text
任务：V2-Dxx
状态：待办 / 进行中 / 已实现待验收 / 已验收 / 阻塞
复用：哪些已有能力未重做
本次增量：修改文件与具体差额
验收：通过/失败/未运行，给实际命令或界面证据
阻塞：缺代码、缺环境、缺业务决策分别列出
后续：可执行的依赖任务；不自动继续
```

## 3. 当前待执行清单

| ID     | 交付目标                              | 性质             | 前置                       | 状态                   |
| ------ | ------------------------------------- | ---------------- | -------------------------- | ---------------------- |
| V2-D00 | 路由契约统一与同名换 Provider 补缺    | 已做 V2 基础收口 | 复用 T01/T02/T03           | 已实现待验收           |
| V2-D01 | 打开文件夹/普通 ZIP 与统一工程识别    | 源码接入增量     | 无；复用契约               | 已实现待验收           |
| V2-D02 | 真实前端、多服务预览与项目缩略图      | 预览增量 + V1-L3 | D01                        | 已实现待验收           |
| V2-D03 | 运行 DOM 选取与可验证源码映射         | 新场景           | D02                        | 已实现待验收           |
| V2-D04 | 接口索引、分类、时间与浏览工作台      | 新场景           | D01                        | 已实现待验收           |
| V2-D05 | attempt、缓存分桶与上下文计量接线     | 计量增量         | D00                        | 已验收                 |
| V2-D06 | 持久化 Session/Task 与共享协调器      | 并发增量         | D05                        | 已验收                 |
| V2-D07 | Agent 工作副本与受控合入              | 写入增量         | D06                        | 已实现待验收           |
| V2-D08 | 原生多窗口及 Tauri 页面等价收口       | 并发增量 + V1-L1 | D06、D07；旧页面子项可先做 | 实现完成；原生验收待做 |
| V2-D09 | 指定位置增删接口、依接口新增功能/元素 | 定点开发增量     | D00、D03、D04、D07         | 已实现待验收           |
| V2-D10 | 平台目录与版本化 Provider 定价        | 平台增量         | D00                        | 已实现待验收           |
| V2-D11 | 平台钱包、预占、结算与对账            | 平台增量         | D05、D10                   | 已验收                 |
| V2-D12 | 平台网关与客户端托管模式              | 平台增量         | D11                        | 待办                   |
| V2-D13 | 网站、管理台与可部署交付              | 平台增量         | D10、D11、D12              | 待办                   |
| V2-D14 | 实时指标、账单余额与工作台下钻        | 展示增量 + V1-L2 | D05、D06、D12              | 待办                   |
| V2-D15 | 标准源码/数据备份与旧包迁移           | V1 格式替换      | D01、D02                   | 已实现待验收           |
| V2-D16 | 门禁修复、V1 遗留复验和 V2 全链路验收 | 验收 + V1-L4     | D08、D09、D13、D14、D15    | 待办                   |

建议先做 D00；D01 可与其并行但不可修改公共路由文件。之后源码线 D01→D02→D03、接口线 D01→D04、并发线 D05→D06→D07→D08、平台线 D10→D11→D12→D13 分别推进。D11 另依赖 D05。D09/D14 汇合后验收，所有共享写集仍需串行。

## 4. 详细任务卡

### V2-D00 — 修正已交付基础的两处路由集成差额

**复用**：旧 T01 的 v2 schema/纯函数、T02 的模型仓库及 0008 迁移、T03 的本地配置和连接测试；不是重写三项。

**只做这些差额**：

1. 对齐 `packages/core/src/v2/provider-model.ts` 与 `packages/ai/src/domain/model-route.ts` 的字段语义。明确本地 modelRowId、上游模型名、Provider ID、持久化路由键；保留已写入数据，优先通过清晰字段和单点转换衔接，不盲目重编所有 ID。
2. 修改 `packages/ai/src/remote-config/applier.ts`、服务层调用及差异提示，使默认配置比较完整路由：A/model-x→B/model-x 必须能提示和确认，歧义不能猜；拒绝后继续原配置。
3. 补跨包往返/迁移/路由变化测试，保留 A/B 同名隔离和本地不依赖平台的已有测试；同步契约基线说明。

**验收**：真实 model 行能够无歧义转换到公共用量/价格路由；相同模型换 Provider 不漏报；旧绑定/历史仍指原渠道，未确认不切换；不重复迁移 0008，不触碰 Key。

**覆盖**：V2-MDL-01/02/03/06；V2-E2E-12，所有后续路由依赖。

```text
执行 V2-D00。先读 docs/tasks/V2-AI-Tasks.md 的核查结论、通用规则和本卡，以及 V2 PRD 的模型路由要求。
保留旧 T01/T02/T03，修正 core 的 ULID/slash 路由与 ai 的上游名/colon 路由之间的契约转换，并补齐 planApply 对同模型名换 Provider 的变化检测。
新增跨包与默认路由回归测试，实际执行已有13项基础测试；不重新实现 Provider、登录或数据库迁移系统，不自动提交。
```

### V2-D01 — 复用 Git 导入，补文件夹/ZIP 和统一识别

**入口/已有能力**：`workspace.ts:675`、`domain/code-root.ts`、`packages/core/src/project/git-import.ts`、`packages/preview/src/backend/project-detector.ts`；Git 克隆和外置代码根已存在。

**增量**：

- 工作台和源码导入中提供“打开文件夹”：原生选择器直接关联原目录，不复制、不要求 Git/manifest/DSL；保留可选复制模式。普通 ZIP 安全解压到新目录。
- 将已有 Git 导入产物接入同一识别管线，不另造第二套 clone/auth。扫描 manifest/锁文件而不执行配置脚本，识别 P0 静态站、React/Vue Vite、workspace 子工程及后端证据。
- 统一已存在的 ProjectProfile/SourceDetection 语义，输出用户可确认的 cwd、命令参数、包管理器、环境变量名称、子工程选择与支持边界；重扫不改源码。

**验收**：打开/复制/克隆/ZIP 四路径均通过；取消文件夹选择不写文件；已有未提交改动、非 Git/中文/空格路径保留；未知栈不误报支持；ZIP 防穿越、越界链接、大小写冲突、解压炸弹；Git 原能力不退化。

**覆盖**：V2-SRC-01～05/09/10；V2-E2E-02/04。不重复开发 Pull/Fetch。

```text
执行 V2-D01。阅读 docs/tasks/V2-AI-Tasks.md 的通用规则和本卡、PRD §4。
复用已经可用的 Git 导入/代码根指针，新增直接打开文件夹、普通 ZIP 和统一静态识别/运行计划；不重新写 clone、账号或项目数据库。
实际验证文件接入、安全反例、取消和未提交改动保护，补生产接线；不要提前运行未经确认的工程脚本。
```

### V2-D02 — 在现有运行器上补真实前端与多服务预览

**入口/已有能力**：`packages/preview/src/backend/runner.ts`、`preview-domain.ts`、`process-host.ts`、`PreviewWorkspace`；已能托管后端和静态资源。

**增量**：

- 执行 D01 的已确认计划，支持 React/Vue Vite 开发服务及前后端分离运行；保留静态页面路径。
- 用 runtimeId 区分实例，分配端口、正确配置代理/API 基址、等待实际就绪，提供精准停止/重启/日志；不把另一工程的监听端口当本项目启动成功。
- 按 V2 修改“真实后端失败自动回退 Mock”的规则，显式选择模拟数据；保留已有 Mock 功能。
- 收口 V1-L3：从真实预览生成可持久化的项目缩略图并接 `getThumbnailUrl`，没有可渲染页面时明确占位，不永远返回 null。

**验收**：P0 三类前端实际可见，表单请求到正确后端；HMR、冲突端口、缺依赖/环境、停止与崩溃可诊断；缩略图刷新后可读；确认前不安装依赖/升级锁文件。

**覆盖**：V2-SRC-05～08、V1 FR-WSP-01 缩略图、V2-E2E-03/04。D07 后接工作副本实例，不重写后端托管。

**2026-10-02 实现记录（待验收）**：

- **运行计划**：`packages/preview/src/backend/run-planner.ts`（纯函数，输出 V2 契约 SubProjectDetection/RunPlan，识别 React/Vue Vite、静态站、前后端分离 workspace、Node/Python 后端证据；env 只收集变量名）；preview 域新增 `runPlan → confirmRunPlan → startRun` 确认链（`runPlanSchema.safeParse` strict 校验，确认持久化在 `preview_run_plan:*`；未经确认 startRun 报 INVALID_ARGUMENT）。
- **运行实例（runtimeId）**：`packages/preview/src/backend/runtime-orchestrator.ts`——每服务复用一个 `BackendRunner`（新增可选 `label`/start env 增量参数），安装步骤顺序执行、失败即 failed 且不启动服务；端口 spawn 前真实探测、实例内互斥；前端命令追加 `--port <分配端口> --host 127.0.0.1`（配 `--strictPort`：被抢占可见失败，不静默漂移；显式绑 IPv4 回环，因 vite 默认绑 `localhost`→::1 会让就绪判定永超时）；后端注入 PORT env；就绪=端口可连（后端）/页面可加载 HTTP<500（前端，V2-SRC-06）；`stopRuntime` 精准停止，服务崩溃后实例 degraded、数据源/反代同步摘除。
- **预览代理**：预览服务反向代理前端 dev server（流式转发 + HMR WebSocket upgrade 原样转发，host/origin 由受控代理改写为目标 dev server，不关 webSecurity）；`/api` 仍走域内数据源门控。
- **显式 Mock**：默认 `real` 模式——真实后端不可用如实 502 富诊断（`真实后端不可用`+hint），不再自动回退 Mock（V2 FR-PRV-02 修改）；`setDataMode mock` 显式切换才用模拟数据（持久化 `preview_data_mode:*`，始终带 `X-EC-Data-Source: mock`）；mock 压过运行中的后端；工具栏新增显式开关（`datamode-toggle`）。
- **缩略图（V1-L3）**：`apps/desktop-electron/src/main/thumbnail.ts` 离屏窗口截图端口（仅 127.0.0.1、无 preload、超时兜底、即截即毁），经 `capturePage` 注入 preview 域（缺省如实不生成），持久化 `meta/thumbnail.png`；workspace `getThumbnailUrl` 返回 data URL（缺失/超限/读失败保持 null 占位）。
- **验证**：单测 14/14（run-planner+runtime-orchestrator）；域集成 9/9（`domain-preview-run.test.ts`，真实进程/SQLite/HTTP：识别→确认→startRun 双服务就绪、页面反代、/api 到真实后端、显式 Mock 三态、精准停止端口释放、缩略图落盘可读、新 runtimeId、安装失败诊断）；既有 `domain-run-ports.test.ts` 24/24（Mock 期望按新规则更新）、preview 包 103/103、渲染层 preview 29/29、workspace 25/25。**真实浏览器（Chrome headless+CDP）实测 7/7**：真实 Vite 页面可见、页面表单 POST 打到真实后端（source=backend）、改 `src/label.js` 后 HMR 经 WS 代理生效且不整页刷新（页面内存 marker 存活）、taskkill 后端后请求/health 如实 502 富诊断不回退、显式 Mock 后 `/health` 200+mock 标记、精准停止后前端 5180/后端 5181 端口释放且页面回退静态兜底。
- **边界**：真实 Electron 外壳（离屏截图/多窗口）与 Tauri 页面等价归 D16 复验；D01（文件夹/ZIP 接入）由并行会话在途，本增量只复用其确认计划契约（RunPlan），未实现源码接入路径。D03（DOM 选取）并行会话在同一批文件在途，`preview/index.ts`、`preview-domain.ts`、`PreviewWorkspace`、`fake-preview.ts` 等混合文件含双方改动，本提交只包含纯 D02 文件，混合文件随 D03 收口一并提交。

```text
执行 V2-D02。先读当前增量任务文档、D02卡和PRD预览要求，核验D01。
复用 BackendRunner/preview-domain，补真实前端、多服务端口/代理及runtimeId，改为显式Mock切换，并接上原先恒空的项目缩略图。
实际打开页面验证请求、热更新、失败与精准停止；仅提交本增量及测试，不重写已有预览/进程系统。
```

### V2-D03 — 安全选取运行 DOM 并定位已有源码

**入口/已有能力**：`PreviewFrame.tsx` 有 element-click 消息，`packages/ai/src/anchors/` 与 nav 有生成期锚点，不等于任意源码页面选择器。

**增量**：选取/交互模式、hover/click/祖先链、静态 HTML 与 React/Vue 开发期源码映射、源码修订/可信度、实例与组件区分、备注/上下文附加；同一闭环内交付选择和定位，不拆成两项假完成。

**安全要求**：现有消息处理需补 source/origin/runtime/nonce/载荷校验；不向页面暴露宿主、Key 或任意 IPC。选取不得提交表单/导航/业务删除；密码/输入值默认不采集。

**验收**：真实页滚动/缩放/列表/动态节点可选；准确定位源码，HMR 失效不盲改；共享组件影响范围可见；生产构建无调试插桩；未知映射可选但禁止猜位置改写。闭合 Shadow DOM/跨源 iframe 等明确降级。

**覆盖**：V2-DOM-01～07、V2-E2E-05/06/23。

**2026-10-02 D03 执行记录（待验收）**：在既有预览、anchors、导航和上下文上接入真实选取与原文件编译登记，交付 UI→shell-api→IPC→生产域；严格校验消息身份/载荷，选取态拦截业务事件，未知/过期源码禁止猜位置。真实 Electron 原生输入覆盖静态页及通过 D02 startRun 启动的 React/Vue、共享组件、源码写入后的 HMR 和生产无插桩构建；相关 9 文件 / 97 项回归、原生 2 文件 / 2 项、侧车构建通过。Tauri GUI/真实模型调用未验收，整站构建和 desktop/E2E 目录类型检查仍有其他任务错误。命令、逐项结果、截图与限制见 [D03 验收记录](../V2-D03-REPORT.md)。

```text
执行 V2-D03。阅读增量任务通用规则、本卡与PRD §5，核验D02。
在既有预览消息与anchors上实现真实DOM选取和源码映射，补消息身份/载荷校验，不把生成期elementId当作任意源码映射。
实际验证选取不触发业务、定位/失效/共享组件和生产构建无插桩；运行时DOM修改不能冒充源码实现。
```

### V2-D04 — 接口索引与分类/创建时间工作台

**入口/已有能力**：`packages/registry/src/occurrence/ast/`、nav-domain 的 DSL apiDeps、OpenAPI 解析；已有 AST 与导航，不存在完整源码接口台账。

**增量**：

- 复用解析基础，索引 Express/Nest/FastAPI 显式 HTTP 路由、前端 JS/TS fetch/axios、本地 OpenAPI；处理服务身份、挂载前缀、参数路径、代理/baseURL 与多调用方。
- 增加接口台账/关系持久化、源码证据/置信度、失效重扫；Service 方法与 HTTP 接口、第三方服务分开。
- 直接交付接口页面、搜索/详情/导航、功能分组/人工覆盖、创建时间排序。createdAt 与 firstSeenAt 分离，Git 为可追溯首次出现推断，未知不得用 mtime 冒充。

**验收**：固定夹具正确关联；动态 URL 多候选标待确认；用户分类重扫不丢；浅克隆/无 Git/重命名时间来源可见；同路径不同服务不合并；不执行工程脚本或主动请求外部 API。

**覆盖**：V2-API-01～05、V2-E2E-07/08。AI 分类可选且需计费授权，规则分类离线可用。

**2026-10-02 执行记录**：新增源码 HTTP 索引、SQLite 台账/关系、异步生产导航端口和 `/apis` 工作台；复用现有 AST、OpenAPI 与导航，替换旧 DSL `apiDeps` 列表来源。D04 专项 3 文件 / 24 项、真实 Electron IPC/UI E2E 1 项通过，并实际操作原生窗口重扫/详情。扩展回归最新为 148/150 项通过，另两项涉及导入阶段和预览行为的并行变更；整站构建/跨包类型检查仍有非 D04 错误。D01 任务仍为待办，登记代码根可索引，但文件夹/ZIP 接入链路及 Tauri 原生 GUI 未验收，故不标全部完成。逐项证据、复跑命令和限制见 [D04 验收记录](../V2-D04-API-INDEX.md)。

```text
执行 V2-D04。读取当前任务文档、D04卡与PRD §6，确认D01。
复用AST/OpenAPI/导航，新增源码接口索引并交付分类、时间和详情工作台；不要只展示旧DSL apiDeps就宣称自动识别完成。
验证路由前缀、多服务、动态未解析、人工覆盖及未知创建时间；不猜时间，不扫描外部服务。
```

### V2-D05 — 把已有规范化纯函数接入真实计量链路

**入口/已有能力**：`packages/core/src/v2/usage.ts` 已有规范化纯函数，`billing.ts/money.ts` 已有精确计算；`packages/ai/src/core/usage.ts`、usage-tracker/repo、网关已有三字段统计与预算。

**只补运行时差额**：协议保留缓存读/写 TTL 和推理子集，logicalRequest/attempt 身份，全用途持久化，估算→最终更正，实际路由和上下文快照，聚合/事件接口。**不另写一套缓存公式或金额库**。

**验收**：流式累计/增量不混；缓存与推理不重复相加；chunk 数不当 Token；真正重试分别计量、事件重放不翻倍；连接测试/摘要/工具/后台用途覆盖；未知非0；上下文是有效输入不是历史消费累计。

**覆盖**：V2-USG-01～08 的数据基础、V2-BILL-09。本任务交付真实数据与订阅，展示由 D14，平台扣款由 D11/D12。

```text
执行 V2-D05。先读通用规则、本卡和PRD §9，确认D00。
复用已交付core/v2的usage/金额纯函数，接入现有协议、网关和UsageRepo，补attempt、缓存分桶、上下文快照与最终更正。
用流夹具和持久化测试覆盖取消/重复/重试/缺usage，不再造公式或钱包，也不把现有三字段统计当新需求全部完成。
```

**2026-10-02 执行记录**：复用 core/v2 usage 与金额纯函数接入 OpenAI/Anthropic usage、网关 attempt、SQLite 持久化/事件更正、UsageRepo 聚合和上下文预览；19 个测试文件 / 193 项通过。详见 [D05 验收记录](../V2-D05-METERING.md)。

**2026-10-03 验收复核**：23 个定向测试文件 / 226 项通过，包含此前记录的计量流失败项；core、ai、data、shell-api、renderer、desktop-electron、git 七个 TypeScript 工程检查通过。D05 已验收。

### V2-D06 — 在现有网关上增加持久化会话与协调器

**入口/已有能力**：code-domain 使用按 projectId 存储的 AbortController/中断 Map，新生成会取消同项目旧生成；网关已有预算、限流、取消和重试。

**增量**：持久化 Session/Task、独立执行所有者、全局/Provider 凭据/项目/会话共享队列与预算、跨进程租约/fencing、检查点、事件游标恢复；同会话多个观察者不重复发请求。

**验收**：两个进程争抢同数据域只有一个写协调器；过期 owner 不再写；任务取消/暂停相互隔离，关闭视图不等于取消任务；重连不重复执行/计量；未知上游执行状态先对账，不盲重试。

**覆盖**：V2-AGT-02/03/09/10/11，V2-USG-08。不要重写已有网关限流或用流水线 checkpoint 冒充独立 Agent 会话。

```text
执行 V2-D06。阅读增量任务通用规则、本卡和PRD §10，确认D05。
将code-domain的按项目内存生成控制扩为持久化Session/Task与单写协调器，复用网关预算/限流，增加跨进程租约和事件恢复。
必须真实多进程验证单owner、共享预算、取消隔离与不重复调用，不能只用一个Map的单元测试证明并发安全。
```

**2026-10-02 执行记录**：D06 已接入持久化 Session/Task、fencing 租约、共享网关队列/预算 permit、事件 cursor 与 task 命令；初始定向回归 4 个文件 / 18 项通过，其中 5 项使用真实 Node 子进程和共享 SQLite。D05 当时的计量失败已由后续复核解决。

**2026-10-03 验收复核**：D06 定向命令 4 个文件 / 20 项通过，其中真实子进程协调器覆盖 owner 竞争、预算、QPS、取消/暂停隔离、owner 崩溃接管和不重复派发；七个 TypeScript 工程检查通过。D06 已验收。细节见 [D06 验收记录](../V2-D06-COORDINATOR.md)。

### V2-D07 — 复用 WritePipeline，增加隔离工作副本和安全合入

**入口/已有能力**：WritePipeline 已做 plan/preview/apply、磁盘前值检查及快照回滚；Git/重命名/流水线写端口已存在。

**增量**：每写任务 Git worktree 或非 Git 隔离副本，明确未提交改动基线，持久化读写集/契约版本/租约/变更日志、合入队列，任务预览/端口/数据环境隔离；所有产品写入口共用协调。

**验收**：同文件冲突暂停；不同文件的接口语义冲突触发重新验证；合入前原目录新改动不能被覆盖；失败回滚不覆盖另一任务成果；非 Git 不擅自 init/commit；依赖锁/DDL/共享数据库排他处理。

**覆盖**：V2-AGT-04～08/12、V2-API-11。不 reset/clean/stash 清场，不自动远端 push。

```text
执行 V2-D07。读取任务通用规则、本卡与PRD并发写入规范，确认D06。
扩展现有WritePipeline/Git事务为任务工作副本、版本/读写依赖校验及安全合入，不另建绕过既有写入口的实现。
用真实Git/非Git、同文件/接口冲突、外部修改和崩溃恢复测试证明不会互相覆盖；不得清场用户修改。
```

2026-10-02 执行记录：D06 作为前置按“已实现待验收”核验；D07 复用 WritePipeline 的 plan/preview/apply 与 CAS/快照补偿，新增 Git worktree / 非 Git 隔离副本、显式 HEAD/当前目录基线、持久化读写集/接口契约哈希/任务租约与 fencing、排他资源、受控合入队列和崩溃 journal 恢复。生产 `code` 域已把 Agent 任务的 plan/apply 接到 TaskWriteService，带 `taskId` 的计划禁止绕过协调器直接写共享目录；真实 CLI Git 与非 Git测试覆盖 dirty staged/untracked/删除现场保留、同文件先后合入冲突、接口契约变更重新验证、外部进程修改拒绝覆盖、验证失败补偿保留外部成果、依赖锁/DDL/共享数据库排他、非 Git 不 init/commit，以及强杀进程后的接管补偿和旧 owner fencing。D07 核心 3 个定向测试文件共 31 项通过，生产域集成再通过 17 项；Electron strict TypeScript、@ec/ai 和 @ec/git 检查通过。详见 D07 验收记录。

**2026-10-03 复核**：在事务准备后由独立 Node 子进程改写目标文件，D07 报告冲突且保留外部字节；被 WritePipeline 阻止的计划不再滞留在 queued。D07 核心 31 项、生产域集成 17 项、D06 协调器与 code-agent 6 项通过；三个 TypeScript 项目检查通过。D05 与 D06 前置验收现已通过，D07 保持“已实现待验收”。详见 [D07 验收记录](../V2-D07-WORKTREE-MERGE.md)。

### V2-D08 — 原生多窗口与 Tauri 旧页面补缺

**已有**：双外壳共用业务运行时；D06/D07 持久化协调器与隔离工作副本已就绪。此前 Memory/Pipeline 页面因消费同步签名端口而未注入。

**按两个子步骤实施**：

1. **V1-L1 可提前独立修复**：调整 memory/pipeline 页面消费与端口为真实异步命令/状态订阅，写成功后读取权威状态；双外壳都支持。不得给 Tauri 伪造 invokeSync 或把旧同步镜像当权威。
2. D06/D07 完成后增加原生窗口创建/会话绑定/任务中心、独立日志与状态、关闭继续/取消、重连。各窗口连接同协调器，双外壳并开不能各建写 owner。

**同时核验**：发行侧车/Node ABI 和 Tauri OAuth 协议桥的当前链路；确实缺失才补外壳配置/桥接，不把第三方资质或 MSVC 安装列作业务编码。

**执行记录（2026-10-03）**：Memory/Pipeline 改为真实异步端口并在写后读取权威状态；新增共享 code-domain Agent 会话页与 Electron/Tauri 原生窗口入口；Tauri OAuth Deep Link/单实例桥按 state 回投共享 auth 域；发行侧车 staged Node + SQLite ABI 检查通过。Renderer/Electron/Tauri TypeScript 检查通过；Memory/Pipeline UI 测试 49 项通过，Auth 协议测试通过。另在隔离 user-data 目录启动真实 Electron 33.4.11：两个页面截图见 [D08 Electron 实机证据](../evidence/V2-D08/README.md)，memory 页读出 SQLite 空态，pipeline 页显示“未打开项目”（不是“未初始化”）；从 Electron preload bridge 同时打开 3 个 BrowserWindow，3 个独立 session 都读到 code-domain 的共享协调器快照。该隔离配置 readiness 为 0 个 Provider，因此没有提交会触发模型的任务，**任务执行重叠未验**。本机没有 Cargo/Rust 命令，Tauri 原生页面、发行安装包、Tauri 3 窗口及双壳任务并发仍**未验**；没有用浏览器 mock 替代原生证据。

**验收**：Tauri 记忆/流水线页面真正能操作且重启一致；两种外壳各3个原生窗口产生时间重叠的独立任务；同会话双视图不重发、取消不串窗、关闭恢复正确。浏览器标签和 mock bridge 不替代原生证据。

**覆盖**：V1-L1、V2-AGT-01/02/09～12、V2-E2E-19/21/24。

```text
执行 V2-D08。读通用规则、本卡和PRD §10。先修已确认的Tauri memory/pipeline同步端口不注入问题，复用原领域，做真实异步消费。
D06/D07就绪后接原生多窗口与共享协调器；发行侧车和协议桥先核验再补缺，不重新写整个Tauri后端。
分别提供双壳页面和3原生窗口并发证据；环境缺失如实标未验，不用浏览器mock替代。
```

### V2-D09 — 复用 AI 修改链，接入接口/运行元素定点开发

**已有**：上下文、备注、AI 生成、diff、重命名和安全写入能力。

**增量闭环**：

- 指定 Controller/Router/父符号位置新增接口；选接口删除时列出调用方/契约/测试/文档影响；扩展原接口与新建接口明确区分。
- 选接口及页面容器/邻接元素，新增按钮/表单/列表或业务功能，复用工程请求封装和权限，处理 loading/空/错/无权限/重复提交。
- 将 D03 的源码目标、D04 的契约和 D07 的隔离合入送入原上下文/生成链；完成后更新索引/锚点/关联记忆。数据库迁移单独确认。

**验收**：接口真实调用、指定位置实际源码修改、刷新保留；删除在用接口无已知悬空引用；旧锚点被拒；共享组件范围先确认；安全撤销和失败保留 diff。

**覆盖**：V2-API-06～11、V2-DOM-06/07、V2-E2E-09～11。不增加第二套生成器，不以临时 DOM 注入替代代码。

**2026-10-03 执行记录（待验收）**：复核 D00/D03/D04/D07 当前均为“已实现待验收”；D00 路由/契约定向回归 45 项、D03 源码映射/生产检查 11 项、D04 索引/工作台 25 项，以及 D07 隔离合入核心 31 项通过，逐项命令和边界见 [D09 执行记录](../V2-D09-API-TARGETS.md)。新增接口和扩展/删除接口、已选 Router/Controller、已索引调用点及 D03 DOM 锚点都作为版本绑定目标进入现有 CodePage/CodeAgent/WritePipeline；主进程以当前索引、源码 hash、实际调用方、影响文件与补丁后索引扫描复核，阻止过期目标、重复路由和未同步已知调用方。预览实际经 Electron BrowserWindow→preload/IPC→生产域→D07 非 Git 隔离副本→受控合入验证；生成器使用确定性离线夹具，不调用真实模型或生产 HTTP/DELETE。FeatureMemory 仅同步已存在的关联项；接口索引在合入后重扫；迁移/DDL 需额外确认。定向测试、Electron 截图及尚未覆盖的真实模型/整站门禁见执行记录。

```text
执行 V2-D09。阅读本任务规则/卡片和PRD §6，核验D00/D03/D04/D07。
把接口/运行元素作为现有AI修改链的新目标，交付指定位置增删接口和依据接口新增功能/元素，带影响面、契约/调用方同步和安全合入。
实际预览验证成功与边界状态，不重写AI引擎、不整页重生成代替定点修改、不调用生产删除接口测试。
```

### V2-D10 — 在现有账号服务上增加目录和价格版本

**已有**：Fastify 账号服务、BYOK/远程配置、ProviderModel 存储、core/v2 PriceVersion/金额纯函数。

**增量**：平台 Provider/模型目录、管理员授权和 Key 引用、按渠道发布不可变价格/生效区间、官网价证据与本地快照读取。同模型不同渠道独立价格；明确免费0/缺价、缓存TTL/计费模式和币种。

**验收**：公开目录无 Key/内部采购成本；普通用户不能定价；调价不改历史；平台价优先且仅匹配该渠道，官网别名未知不猜；离线于平台的本地模式可读已核验快照。已有 BYOK/用户自配远程源不被覆盖。

**覆盖**：V2-WEB-02/03/06/07、V2-BILL-01～03、V2-MDL-06。真实售价由用户决定，测试只用标明虚构的价格。

```text
执行 V2-D10。读取增量任务规则、本卡和PRD §7～9，确认D00。
复用Fastify账号、已有ProviderModel和价格纯函数，新增平台目录/管理权限/不可变价格发布及官网证据，不重建账号或BYOK模块。
测试同模型异渠道价、无价/免费、调价和密钥隔离；不要擅自决定真实售价或把示例当官网定价。
```

### V2-D11 — 服务端钱包、预占、结算和对账

**已有**：本地 usage_record 与 core/v2 计量/精确金额函数；**没有可据此认定为完成的平台账本**。

**增量**：服务端钱包、冻结预占、不可变流水、可信 attempt 结算、释放/冲正/幂等、管理员审计调整及待对账队列；原子校验余额/预算。

**验收**：真实数据库并发不透支，重放/取消竞态/崩溃不重扣；历史使用受理价格，分项之和等于总额；未知上游结果不凭空归0或永久无入口冻结；用户只查自己账单。不能信任客户端上报金额扣款。

**覆盖**：V2-BILL-03～06/08～10、V2-WEB-05。币种先显式测试配置；真实币种和充值规则需确认，不把历史估算变欠款。

```text
执行 V2-D11。读取通用规则、本卡和PRD计费流程，确认D05/D10。
在服务端新增真实钱包、原子预占、幂等结算/冲正与对账，复用已存在的精确金额函数，但不要把本地用量表冒充账本。
用真实数据库并发/恢复测试证明不透支不重扣；保留未知状态与审计，不接未经批准的真实支付。
```

**2026-10-03 验收记录**：D05 已验收并复跑计量流 5 项；D10 目录/定价 3 项复跑通过，状态仍为已实现待验收。D11 新增服务端独立账本与 0005 迁移、原子钱包/预算/attempt 服务、仅本人的只读端点、管理员人工额度与对账端点。服务端全套 5 文件 / 36 项、账号服务 TypeScript strict 与 core TypeScript 检查通过。两个独立 Worker 连接真实 SQLite 文件争抢同钱包，6,000 微单位预占只允许一笔成功；恢复、取消、价格快照、重放、冲正、预算与事务回滚由 7 项新用例覆盖。未接真实支付；D12 后续负责把网关流量接入内部账务方法。详见 [D11 验收记录](../V2-D11-WALLET.md)。

### V2-D12 — 平台请求网关与客户端托管模式

**已有**：本地 AI Gateway 的协议、流式、取消、重试能力；BYOK 仍直连，不受平台余额影响。

**增量**：平台鉴权和目录路由、受理时价格/预占、上游 Key 保管、流式转发和可信 usage、取消/查询/结算、客户端平台路由选择。共享协议代码只在适合的运行边界复用，不把本地凭据上传平台。

**验收**：客户端→平台→受控上游完整流，实际渠道/价格/attempt 可追溯；目录之外地址被拒；幂等内容冲突、断流、停用路由、取消竞态、未知成本可处理；不持久化请求正文，平台停服不影响 BYOK。

**覆盖**：V2-WEB-06、V2-BILL-05/06/09、V2-MDL-01/02/04、PRD §9.4/§11.3。未授权真实付费请求禁止。

```text
执行 V2-D12。读通用规则、本卡和PRD平台请求/结算规范，确认D11。
复用协议和流式能力实现平台可信网关及桌面托管模式，接价格预占/最终结算；BYOK仍在本地直连，不上传其Key。
用受控上游验证完整链路、取消/幂等/断流和平台停服隔离；未知执行状态先对账，不盲重发收费请求。
```

### V2-D13 — 网站、管理台与部署安全一并交付

**已有**：账号和服务端接口；没有完整的网站用户中心/平台管理台。不重写认证协议。

**增量**：公开产品/下载/目录/价格/状态，用户用量/账单/钱包，管理员渠道/价格发布/额度调整/审计；使用 D10～D12 的真实 API，附可重复本地部署、数据库升级/备份恢复、健康检查、日志脱敏与对账运行说明。

**验收**：普通用户/管理员实际浏览器操作；分页筛选、空/错/加载和移动宽度可用；越权请求被拒；密钥不回显；本地干净环境可部署并重启恢复；TLS/SSRF/CORS/CSRF按实际认证方式验证。

**覆盖**：V2-WEB-01～07、V2-NFR-02/03/04/10。P0 人工额度调整必须标记，不能显示虚假在线支付成功。商户、域名、隐私周期、正式部署另行授权。

```text
执行 V2-D13。阅读通用规则、本卡和PRD网站/安全范围，确认D10/D11/D12。
复用账号与真实平台API制作网站公开区、用户中心和管理台，同时交付本地部署、安全与备份恢复；不把桌面设置页冒充网站。
实际浏览器验证角色权限/价格/账单和错误状态，不伪造支付、不自动上线公网。
```

### V2-D14 — 实时指标、账单余额与 V1 工作台展示收口

**已有**：usage-domain、UsageRepo、基础用量 UI、工作台 metrics 和 Git 查询能力。

**增量**：当前速率/TTFT/缓存命中率、会话累计/上下文输入与输出预留、历史 Token/费用、平台实扣/冻结/可用余额与更新时间、BYOK 余额可查/未知状态；全部消费 D05/D06/D12 的数据，不在 UI 再算一套账。

**合并 V1-L2**：补 `workspace.ts` 最近提交和详情的真实 Git 查询与下钻；无 Git/无提交显示真实空态，不能对有提交工程也恒空。使用项目真实代码根，不重写 Git 模块。

**验收**：缓存率加权不平均百分比、未知非0、final替换估算、三窗口不重记；压缩/换模型重算上下文；平台失联标旧快照，BYOK 不扣平台余额；提交后列表更新且下钻到实际记录。

**覆盖**：V2-USG-01～08、V2-BILL-07/08/10、V1-L2。V1 P2 项在本卡明确补齐，不泛化为整个 V1 失败。

```text
执行 V2-D14。读通用规则、本卡和PRD §9，确认D05/D06/D12。
扩展既有用量界面为实时Token/上下文/缓存/平台账单余额，并补工作台恒空的最近Git提交及下钻；复用既有Git和账务服务。
实际验证缺usage/取消/换模型/多窗去重/平台断线和有提交工程，UI不能覆盖服务端账本或伪造余额。
```

### V2-D15 — 替换专有新归档，保留已有数据可恢复

**已有**：package-kit 的 ZIP、校验/脱敏、旧包 reader/writer、备份/恢复与 UI 已实现；不是再做一套归档系统。

**增量**：新导入以源码为准，新导出/定时备份用普通目录/ZIP及可读JSON/JSONL/Markdown；完整本地数据恢复与源码导入分开。停止新 `.ecpkg` 生产，旧包只读一次性迁出，保留原件及已有安全处理。

**验收**：标准工具可解压；无产品元数据也可打开源码；备份恢复备注/记忆且冲突默认不覆盖；旧明文/加密/坏包正确处理；错误密码不产半文件；既有定时备份显式迁移，不默默继续生成专有格式。

**覆盖**：V2-SRC-02/10、PRD §13、V2-E2E-22。不能仅换扩展名仍要求私有 manifest，也不能为取消格式直接删旧数据。

```text
执行 V2-D15。阅读通用规则、本卡和PRD迁移要求，确认D01/D02。
复用现有package-kit安全能力，将新导出/备份改标准目录或ZIP，源码接入不要求元数据；保留独立旧ecpkg只读迁移。
验证旧原件/错误密码/冲突与完整恢复，不重写归档库、不另造专有扩展名、不删除用户历史备份。
```

### V2-D16 — 修门禁，完成遗留复验和全链路验收

**不是再次总装**：D00～D15 都必须自带生产接线。本卡只处理门禁差额、跨功能回归及证据收口；发现业务缺口退回所属卡。

**V1-L4**：经相应许可修改当前 `.github/workflows/ci.yml`，覆盖率失败真正失败；核验阈值配置与实际执行的测试范围，不仅删一个开关就假称门禁成立。服务端/核心 E2E/双壳构建按发布要求补入适当门禁；用可控失败证明阻断，不能降低阈值或删失败用例。

**验收清单**：

- 逐项对照 PRD V2-E2E-01～24、V2-NFR-01～12及保留的 V1 功能；3 原生窗口、接口闭环、计费并发和普通源码/旧包迁移均有证据。
- 复验 Tauri 记忆/流水线、发行 Node/侧车/ABI、协议桥；环境确实缺失时列阻塞，不把包存在等同功能完整。
- 复验路由跨包转换、同名换渠道、本地 Key 安全/免平台、真实UI；105 项基线测试只是回归子集，不替代全部验收。
- 对旧报告的安装包/自动更新状态、同步端口限制、曾记录的 typecheck 问题按现状更新，不改历史证据为新的通过结果。
- 真实OAuth/邮件/模型、七端工具链、签名/生产价格/币种/支付/性能环境单列负责人和条件；未授权不执行。P1 在线支付未完成时明确不在交付范围。

**交付**：需求→旧实现/新任务→测试矩阵、实际命令、双壳/浏览器证据、性能原始结果、失败/未验清单和可发布范围。不自动提交/推送/上线。

```text
执行 V2-D16。先读当前增量任务文档和PRD验收标准，核验前置任务。
修复已确认的CI覆盖率非阻断问题（修改前确认相应许可），核验真正阈值和测试范围，再做V1遗留与V2全链路回归。
不要重新总装已完成模块；分别记录真实/模拟、桌面/浏览器、通过/失败/未运行，校正过期文档，保留外部条件，不自动发布。
```

## 5. 原 25 项如何处置

此表保留已执行任务的身份，不把新任务的编号冒充旧实现历史。

| 原任务                | 处置                                         | 当前落点               |
| --------------------- | -------------------------------------------- | ---------------------- |
| V2-T01 公共契约       | 已交付，保留 schema/纯函数；仅修路由集成差额 | 基线 + D00             |
| V2-T02 模型路由       | 已交付核心仓库/迁移；仅修完整路由变化检测    | 基线 + D00             |
| V2-T03 本地 Provider  | 已交付本地闭环/提示/模拟集成；不重做         | 基线 + D16 实际验收    |
| V2-T04 导入           | 与识别合为可用接入闭环，Git 部分复用         | D01                    |
| V2-T05 识别           | 不单造探测器，扩展现有画像                   | D01                    |
| V2-T06 预览           | 保留真实后端/静态/Mock，增加前端与实例       | D02                    |
| V2-T07 DOM 选取       | 与源码定位合为一个可用目标选择闭环           | D03                    |
| V2-T08 源码映射       | 同上，复用既有 anchors                       | D03                    |
| V2-T09 接口索引       | 与浏览工作台一起交付                         | D04                    |
| V2-T10 分类/排序      | 同上，不先交假页面                           | D04                    |
| V2-T11 计量           | 复用新纯函数和旧仓库，只补运行时             | D05                    |
| V2-T12 协调器         | 仍需新增；现有网关/流水线不是独立 Session    | D06                    |
| V2-T13 工作副本       | 扩展已有写入/Git，不重做事务基础             | D07                    |
| V2-T14 原生多窗口     | 与相关 Tauri 页面遗留一并收口                | D08                    |
| V2-T15 接口增删改     | 与接口驱动页面功能共用一条定点开发链         | D09                    |
| V2-T16 接口→功能/元素 | 同上                                         | D09                    |
| V2-T17 目录价格       | 平台新增，BYOK/账号不重建                    | D10                    |
| V2-T18 钱包           | 平台新增，复用金额契约                       | D11                    |
| V2-T19 平台网关       | 平台新增，复用协议                           | D12                    |
| V2-T20 网站           | 合并可部署/安全交付，复用账号                | D13                    |
| V2-T21 指标/账单      | 扩展已有统计，补工作台提交下钻               | D14                    |
| V2-T22 格式迁移       | 替换产品格式策略，不重做容器库               | D15                    |
| V2-T23 通用生产接线   | 不再独立投递，回归每个功能任务的完成定义     | D00～D15；D16 整体验证 |
| V2-T24 部署安全       | 不再独立补网站尾巴，随平台交付               | D13；D16 门禁          |
| V2-T25 验收           | 保留但明确旧缺口、自动/人工及发布边界        | D16                    |

### 已执行记录保留

- **D00，2026-10-02**：已实现待验收。①契约转换单点落在 `packages/ai/src/domain/model-route.ts`（`coreRouteOfModelRoute`/`modelRouteOfCoreRoute`/`persistentRouteKeyOf`）：ai 生产路由 modelId=上游名、colon 句柄（DB `provider_model_id` 列），core 契约 modelId=本地 model 行 ULID、slash 键（usage/价格/账务持久化用），两键空间不互解、转换无损；`packages/core/src/v2/provider-model.ts` 只补分层说明，不反向依赖 ai。②`planApply` 默认配置改按完整路由（模型名+声明渠道）比较：同名换渠道（A/x→B/x）经 `providerSwitch` 提示确认；服务层三处调用改传 `currentDefaultProviderName`，指名渠道内未命中解析为 missing 不回退全局绑定；未确认绑定保持原渠道。③差异提示 `DiffPreview` 区分「换模型」与「仅换渠道」。测试：新增跨包转换 5 项（`domain/__tests__/model-route.test.ts`）、planApply 完整路由 4 项、服务层确认/拒绝/无处解析 1 项（`ai-control-route.test.ts` 6 项全过）、DiffPreview 渲染 3 项；remote-config 18 项、core v2 28 项复跑通过；13 项基线中 local-mode 5 项与 ai-control-route 6 项通过，迁移测试 1 项因并行会话在途新增 `0009_api_index.sql` 使 `down(1)` 只回滚 0009 而失败（非本卡回归，归属迁移集成人协调）。typecheck（core/ai/renderer）、eslint、prettier 通过。未验：真实 UI 手工操作与真实渠道（归 D16）。
- **D10，2026-10-03**：已实现待验收。新增账号服务迁移 `0004_platform_catalog` 与 Fastify `/api/catalog`、本地 JSON 快照读取契约、`/api/admin/catalog/*`：复用 `ProviderModelInfo`、`PriceVersion`、路由键和 `computeUsageCost`；Provider/Model 目录可管理状态、精确 canonical 身份、能力与上下文来源。管理员由服务端 `ACCOUNT_PLATFORM_ADMIN_IDS` allowlist 授权；上游地址只在管理 API 可见，凭据只接收 `env:`/`secret://` 引用名并仅回传存在/轮换状态。平台价格按渠道+模型路由追加版本，effectiveTo 从下一生效时间推导，DB trigger 拒绝更新/删除；官网价单独存精确 canonical 身份、HTTPS 来源、核验时间、版本、证据原文哈希和适用条件，仅完全匹配才作为本地估算。没有真实 Provider/模型定价种子；测试金额和 URL 是合成夹具。测试：账号服务 29 项、core 335 项、D00 AI 29 项及 DiffPreview 3 项通过；D10 范围 account/core-v2 TypeScript 检查、ESLint 与 Prettier 通过。全量 account/core typecheck 复跑被工作区中未提交的 `packages/shell-api/src/mock.ts` 改动挡住（缺 `WindowApi.openAgentWindow`，不属于 D10）。未验：真实厂商官网来源逐项人工核验、部署 allowlist/secret resolver 和 D13 网站管理 UI；不得把测试夹具当线上价格。
- **D01，2026-10-02**：已实现待验收。①统一识别管线落在 `packages/core/src/project/source-detection.ts`（`detectSource`/`anchorDraftToRoot`，纯函数、不执行工程脚本）：四路接入（Git/打开文件夹/复制/ZIP）共用同一扫描器（`git-import-port.ts` 导出 `scanSourceSnapshot`）与同一落盘口径（`<projectDir>/meta/source-detection.json`，v2 `sourceDetectionSchema` 校验，重扫 revision 递增）；P0 矩阵（静态站/React+Vite/Vue+Vite/Express/NestJS/FastAPI）给 `supported`+运行计划，Next/Nuxt/CRA/Flask 等给 `partial`，无信号给 `unknown` 且不出命令（未知栈不误报支持）；workspace 成员识别（pnpm-workspace.yaml/workspaces 字段）、多应用并列输出并由 UI 让用户选择。②打开文件夹（`importFromFolder`，link 默认/copy 可选）与 ZIP（`importFromZip`）新增到 workspace 域 + shell-api 白名单（previewSourceDetection/cancelSourceImport/detectSource/getSourceDetection 同批）；文件夹 link 模式只写代码根指针并只读扫描（未提交改动零触碰），ZIP 复用 package-kit `ZipReader` 流式解压 + `zip-safety.ts` 三层防御（落盘前条目校验：穿越/绝对路径/盘符/UNC/ADS/大小写与尾部字符碰撞/重复路径/条目数/声明大小/压缩比；逐条目复核+containment；实际字节预算），解压目标必须为空目录。③取消：选择器取消（渲染层 dialog 能力，返回 null 不发起调用）、预取消、复制/解压中途取消（`cancelSourceImport` 按令牌中止，复制循环每 64 文件让出事件循环使取消 RPC 可落地）；失败/取消补偿只清本次创建的项目行与工程目录。④UI：NewProjectDialog 新增「打开文件夹」「从 ZIP 导入」两页签（外壳 dialog 能力选路径，导入前只读预扫描展示识别结论与建议命令/环境变量名/支持边界），阶段常量扩为 clone/copy/extract/inspect/finalize。测试：core 新增 source-detection 14 项+zip-safety 15 项、域集成 21 项（`domain-workspace-source.test.ts`：四路径/中文空格路径/未提交改动保护（git status 前后一致）/穿越·盘符·UNC·ADS·大小写碰撞·解压炸弹反例/损坏 ZIP/非空目标拒绝/预取消+复制中途取消+解压中途取消/重扫 revision 递增/Git 导入接入同管线）、renderer 5 项（取消选择不写库/link·copy·zip 落库/取消导入令牌一致）；既有回归复跑全绿（domain-workspace 25 项、domain-workspace-git 9 项、project-service 24 项、git-import 18 项、shell-api domain-control 23 项）。eslint/prettier 通过；desktop-electron 与 renderer 的 tsc 有并行会话在途错误（preview-domain/run-planner/gateway-control 等，非本卡文件），本卡文件经临时 tsconfig 验证 0 错误。未验：Electron/Tauri 真实外壳手工操作（原生选择器实际行为、真实大 ZIP），归 D16 双壳验收。
- **D15，2026-10-03**：已实现待验收。确认 D01、D02 仍为「已实现待验收」，源码 ZIP 继续复用 D01 的普通 ZIP 接入与统一 `detectSource`，未向源码 ZIP 添加产品元数据。package-kit 用既有 ZipReader/ZipWriter、路径/条目/展开体积/压缩比校验、脱敏和导入冲突管线新增普通 ZIP 源码导出与带可读校验 sidecar 的本地数据备份；源码 ZIP 平铺源码根目录，完整备份独立恢复，冲突必须逐项决策且默认保留本地。Electron 设置导出、包域导出、增量兼容入口、手动/定时/回滚前快照均改写 `.zip`；旧 `.ecpkg` 独立只读迁移 UI 先校验旧包与密码，再写 ZIP，不改原件；快照 UI 标记旧包，保留份数清理只删新 ZIP、不删历史 `.ecpkg`。旧归档 writer/reader 留作兼容与回归，不再由生产新导出调用；未重写 ZIP 容器或引入新专有扩展名。
  - 验证：package-kit 全套测试通过（216 项）；D15 定向回归最终 14 个文件、132 项通过（标准 ZIP、备份/冲突与恢复、明文迁移、错密码/损坏包原件保护、旧快照保留、Electron 域与设置 UI）；`@ec/package-kit`、`@ec/desktop-electron`、`@ec/desktop-tauri`、`@ec/renderer` TypeScript 检查通过，D15 TypeScript 文件 Prettier 检查与 `git diff --check` 通过。
  - 未验：Electron/Tauri 原生窗口手工操作与用户真实历史 `.ecpkg` 样本迁移；目前旧包验收使用既有 writer 生成的明文/加密夹具与坏包。双壳发行/真实旧档案验证归 D16，不据此宣称最终验收完成。
- **T01，2026-10-01**：已交付 [V2-CONTRACT-BASELINE.md](../V2-CONTRACT-BASELINE.md) 与 `packages/core/src/v2/`；历史记录为 28 项新契约测试、core 子集通过。未做真实 UI/双壳验收；并行产生的路由差异现由 D00 收口，不删除已交付契约。
- **T02，2026-10-01**：已交付 0008 迁移、复合路由、幂等补齐、歧义拒绝与选择器 Provider/Model 显示；同 Provider 重复行处理不跨 Provider 合并。执行时 T01 并行在建，领域契约暂自足，这一历史原因保留；本次路由/迁移8项测试通过，不能据此忽略跨包差异和默认变更反例。
- **T03，2026-10-01**：已补连接测试收费确认/计量（purpose=connection-test）、本地模式说明、空域/禁平台/脱敏/登出保留/A-B 路由测试；上游为本机 OpenAI 协议模拟服务，无真实付费调用。原证据见 [ACCEPTANCE-REPORT.md §2.15](../ACCEPTANCE-REPORT.md)；本次5项复跑通过，真实DPAPI/双壳仍须验收。

## 6. 需求覆盖与不重复建设边界

| 需求                                                  | 复用/补缺/增量落点                 |
| ----------------------------------------------------- | ---------------------------------- |
| 打开文件夹、普通源码/Git/ZIP、自动运行                | 既有 clone + D01/D02               |
| 运行 HTML 选取与源码定位                              | 既有 anchors + D03                 |
| 接口识别、分类/创建时间、指定位置增删、依接口生成元素 | D04/D09，复用 AST/上下文/生成/写入 |
| 服务端网站、同模型多渠道、无平台BYOK、差异定价        | 已有 T02/T03 + D00/D10/D11/D12/D13 |
| 速率、缓存、会话/上下文、用量、金额、余额             | 已有统计/纯函数 + D05/D11/D12/D14  |
| 多原生窗口 Agent 并发                                 | 已有双壳/网关/Git + D06/D07/D08    |
| 取消专有新格式、保留历史数据                          | 已有package-kit + D15              |
| V1确认遗留                                            | L1→D08；L2→D14；L3→D02；L4→D16     |
| 质量、安全与最终完成判据                              | 各任务自测/生产接线 + D16          |

P1 扩展（更多框架、跨源/特殊 DOM、增强重放/容灾、在线支付）不为了本轮任务数强行加入；已有能力继续回归。用户指定新增某项后再追加具体增量卡，不把 P1 未做当本次 P0 验收失败，也不宣传为已实现。

**结论：不是重新做 V1，也不是原样执行 25 张卡；按已完成基线、明确补缺、真正增量与实际验收来执行这份重排清单。**

---

## 附：V2-T06（新编号 V2-D02）实现记录（2026-10-02，待验收）

对应新任务卡见并行重排后的 V2-AI-Tasks §4 V2-D02；本增量已实现并在真实浏览器验收：

- **运行计划**：`packages/preview/src/backend/run-planner.ts`（纯函数，输出 V2 契约 SubProjectDetection/RunPlan，识别 React/Vue Vite、静态站、前后端分离 workspace、Node/Python 后端证据；env 只收集变量名）；preview 域新增 `runPlan → confirmRunPlan → startRun` 确认链（`runPlanSchema.safeParse` strict 校验，确认持久化在 `preview_run_plan:*`；未经确认 startRun 报 INVALID_ARGUMENT，V2-SRC-05）。
- **运行实例（runtimeId）**：`packages/preview/src/backend/runtime-orchestrator.ts`——每服务复用一个 `BackendRunner`（新增可选 `label`/start env 增量参数），安装步骤顺序执行、失败即 failed 且不启动服务；端口 spawn 前真实探测、实例内互斥；前端命令追加 `--port <分配端口> --host 127.0.0.1`（配 `--strictPort`：被抢占可见失败，不静默漂移；显式绑 IPv4 回环，因 vite 默认绑 `localhost`→::1 会让就绪判定永超时）；后端注入 PORT env；就绪=端口可连（后端）/页面可加载 HTTP<500（前端，V2-SRC-06）；`stopRuntime` 精准停止，服务崩溃后实例 degraded、数据源/反代同步摘除。
- **预览代理**：预览服务反向代理前端 dev server（流式转发 + HMR WebSocket upgrade 原样转发，host/origin 由受控代理改写为目标 dev server，不关 webSecurity）；`/api` 仍走域内数据源门控。
- **显式 Mock**：默认 `real` 模式——真实后端不可用如实 502 富诊断（`真实后端不可用`+hint），不再自动回退 Mock（V2 FR-PRV-02 修改）；`setDataMode mock` 显式切换才用模拟数据（持久化 `preview_data_mode:*`，始终带 `X-EC-Data-Source: mock`）；mock 压过运行中的后端；工具栏新增显式开关（`datamode-toggle`）。
- **缩略图（V1-L3）**：`apps/desktop-electron/src/main/thumbnail.ts` 离屏窗口截图端口（仅 127.0.0.1、无 preload、超时兜底、即截即毁），经 `capturePage` 注入 preview 域（缺省如实不生成），持久化 `meta/thumbnail.png`；workspace `getThumbnailUrl` 返回 data URL（缺失/超限/读失败保持 null 占位）。
- **验证**：单测 14/14（run-planner+runtime-orchestrator）；域集成 9/9（`domain-preview-run.test.ts`，真实进程/SQLite/HTTP）；既有 `domain-run-ports.test.ts` 24/24（Mock 期望按新规则更新）、preview 包 103/103、渲染层 preview 29/29、workspace 25/25。真实浏览器（Chrome headless+CDP）实测 7/7：真实 Vite 页面可见、页面表单 POST 打到真实后端（source=backend）、改 `src/label.js` 后 HMR 经 WS 代理生效且不整页刷新、后端 taskkill 后请求如实 502 富诊断不回退、显式 Mock 后 `/health` 200+mock 标记、精准停止后双服务端口释放且页面回退静态兜底。
- **边界**：真实 Electron 外壳（离屏截图）与 Tauri 页面等价归 D16 复验；D01（文件夹/ZIP 接入）由并行会话在途，本增量只复用其确认计划契约（RunPlan）；D03（DOM 选取）并行会话与本文作在同一批混合文件在途，本提交只含纯 D02 文件。
