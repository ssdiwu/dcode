# D Code Web 客户端

`client/` 是 [PRD 0028](../doc/40-版本实施方案/0028-0.0.30-Web客户端初版产品需求.md) 的 Electron + React 客户端，通过版本化 IPC 消费 D Code Host。产品事实、草稿、阅读位置、通知偏好由 Host 写入 Product Store；React 只消费投影，zustand 只保存瞬时面板状态。技术边界见 [0003](../doc/10-架构与运行/0003-Web客户端技术栈.md)。

## 开发与验证

```bash
# 从仓库根目录安装依赖并构建 Host
npm --prefix host ci
npm --prefix host run build
npm --prefix client ci

# 从 client/ 执行
npm run dev         # 编译主进程，再启动 Vite 与 Electron
npm run build       # 主进程和整个 React 界面类型检查 + 构建
npm test            # 协议、呈现与真实 Host 的隔离交互回归
npm run test:layout # 构建后，用隔离 Chromium 检查真实布局几何
npm run test:inputs # 扫描所有输入控件，检查深浅色焦点、只读、禁用与禁止手动缩放
npm run test:canvas # 检查不同图片比例下的完整显示与节点自适应尺寸
npm run test:preview # 隔离 Electron 中验证 HTML 脚本、资源和网络边界
npm run smoke:host  # 不开窗口的 Host 启动、握手、查询、停机
npm run dist        # 本地未签名候选；不是正式发布
```

`npm test` 的 UI 回归在 jsdom 中运行真实 React 控制器与 App，接入真实 PiHost / Product Store，只有模型网络响应被隔离替换。覆盖创建、流式消息、停止、草稿隔离与重启恢复、搜索连续输入、创建入口和中文输入法确认。不接触真实账户、真实 `~/.dcode` 或供应商额度。候选摘要另有真实 Electron 子进程回归；字体、窗口行为与视觉验收仍另行成立。

隔离窗口和截图：

```bash
DCODE_VISUAL_ROOT=/tmp/dcode-web-acceptance npm run seed:visual
DCODE_DATA_ROOT=/tmp/dcode-web-acceptance/.dcode \
DCODE_AGENT_DIR=/tmp/dcode-web-acceptance/agent npm run start
```

已有构建截图可使用 `node scripts/dev.mjs --capture /tmp/dcode.png`，并传同样的隔离变量。所有图片 / 内容都来自实际隔离 Store；生产界面没有样式样例开关。`DCODE_WIDTH` 与 `DCODE_THEME` 用于检查宽度和深浅色。

## 当前修复范围

- 项目行可编辑名称与文件夹，可选择同时移动项目文件；原对话、任务和已保存结果保留。未保存文件按所属项目与实际移动路径共同保护，从独立任务打开的同一文件也不会被漏过；仅改项目关联不清理无关任务的编辑缓冲。提交后失效标签重新从登记来源读取。

- 主对话可提及本任务已创建成员，子对话可直接进入并返回主对话；持续输入、暂停、编辑和重排均连接耐久协作消息。成员创建权归协调者，界面不直接创建运行成员。
- 成员交办、用户原文、进展更新和流式回复按来源分开呈现；停止、空结果、保存失败不能借用旧回答当成本轮成果。协作收件箱呈现暂停更新，避免隐藏消息阻挡历史续接。
- 上下文选择和运行依据、档案的模型回退链、技能/命令选择、结构化扩展请求、后台进程停止以及历史路径重走接入真实 Host 合同。历史编辑保留原提交，并从指定来源生成新路径。

- 使用 [C-A 黑白变色龙品牌资源](../app/Resources/README.md)，系统图标与导航、新任务/空对话、“关于”均由同一母版导出；界面标志随深浅主题变色。
- 新任务先进入草稿，首次提交创建 Task 与协调会话；新项目从项目分组 `+` 或 `⇧⌘N` 创建。任务/子会话切换不停止其他 Runtime。
- 会话及新任务文字草稿按身份保存；工作台选择、梗概分区、阅读位置与通知开关可恢复。图片和文件附件由 Host 复制到 `~/.dcode/tmp/attachments/`，随草稿恢复；未发送保留 24 小时，提交后保留 30 天。
- 真实 `message_update.assistantMessageEvent` 增量、运行失败、停止和实际模型选择接入；用户提交、执行过程与最终回答按轮次区分；过程默认一行实时预览，展开显示非空思考、中途说明和成对工具记录。复制、引用、图片与文件预览可用。
- 搜索等待索引就绪后重查，通过 Runtime 绑定返回 D Code Task；Pi 导入只走单向导入合同。
- 左侧“灵感”进入持久画布：文字、图片、链接、视频节点，搜索、拖动、连线、成组、归档恢复与编辑草稿。选定内容版本可引用到已有任务或新建独立任务；任务标题下方显示所引用的版本。
- 信息概览按需打开；成员、工作清单、等待事项、产物与报告消费 Store。对象详情展示已有记录，文件与 Git 工作台可查看任务目录及已登记产物，支持多标签、行定位、Markdown/HTML 编辑、冲突保存、图片查看和差异引用。HTML 预览独立隔离，默认不联网，本次放行在切换文件时重置。
- 系统菜单、目录选择、外链限制、退出前保存、Host 重启和打包资源路径接入。

- 恢复任务重命名、复制会话为新任务、归档及空任务移入废纸篓；均由 D Code 原生产品接口写入，可在已归档任务中恢复，不改 Pi 私有会话作为产品权威。
- 设置使用同一窗口内的完整分类：模型、自定义供应商、本机资源、智能体档案、外观、工作台、已归档任务、自进化、通知、Host 诊断、关于 D Code。分类连接实际读写与错误反馈，不以占位页替代。
- 模型保留完整目录、认证态、启用范围及默认选择；旧供应商可显式接管非敏感配置并保留认证引用，API密钥在供应商行内填写并连接，OpenAI Codex 可直接选择浏览器或设备码登录，其他 OAuth 沿用供应商流程，环境变量引用保留为高级选择。新输入仅短暂存在于遮蔽框和专用保密提交中，不回显已存凭据，不进入通用请求记录或页面持久化。旧 Swift 的界面偏好单向继承，已保存的新偏好优先。
- 本机资源保留来源清单，技能和提示词启停实际影响原生资源加载；外部可执行扩展继续服从现有禁用策略。
- 自进化提供隔离检查与构建、候选身份及数据版本校验、停机后重启恢复、人工确认和回滚回执。候选输出可用 `DCODE_PACKAGE_OUTPUT` 指定，不能覆盖正在运行的构建。

旧 Swift 界面、状态、桥接、SwiftPM 与打包入口已退役；保留 `app/Resources/` 品牌母版、旧偏好单向导入及 Host 原生文件辅助程序。历史源码可在退役前 Git 基线 `18e12df` 查阅。

## 结构

- `components/conversation/CollaborationFeed.tsx` / `workbench/conversation-origins.ts`：成员定向交流、队列操作、进展来源与输入边界。
- `components/TaskContext.tsx` / `ModelRouteEditor.tsx` / `ExtensionRequests.tsx` / `AuxiliaryActivities.tsx`：资料与运行依据、候选顺序、结构化决定和后台活动。

- `src/protocol/`：传输无关 Protocol v1 编解码和请求关联。
- `src/host/`：Electron Node 模式启动、握手、停机、退出事件。
- `src/main/html-preview.ts` / `preview-network.ts`：HTML 缓冲区预览、独立浏览器会话与临时网络策略；不开放 App API。
- `src/main/`：平台窗口、可信 IPC、菜单、通知、目录选择与生命周期。
- `src/preload/`：渲染层允许使用的系统和 Host 通道。
- `src/renderer/src/useWorkbench.ts`：投影查询、目标身份、草稿保存、提交和运行事件协调。
- `src/renderer/src/workbench.ts`：可单独测试的消息投影、增量事件和 Store 写入排序。
- `src/renderer/src/workbench/useWorkspaceFiles.ts` / `components/WorkspaceFiles.tsx`：文件标签、编辑缓冲、保存冲突、退出保护、文件/产物来源与差异引用。
- `src/renderer/src/workbench/useModels.ts`：模型目录、连接与选择的呈现逻辑；模型设置及输入区共用，展示组件不直接调用模型协议。
- `src/renderer/src/workbench/useComposerAttachments.ts`：附件选择、粘贴、拖入、缩略图查询和提交期间的草稿归属；上传期间退出会等待保存完成。
- `src/renderer/src/workbench/useInspiration.ts`：灵感投影、耐久草稿与画布布局写入、任务引用；`components/InspirationWorkspace.tsx` 只处理展示与指针/键盘交互。
- `src/renderer/src/components/conversation/`：消息流、执行过程、旧图片放大与对话导航条；`workbench/conversation-navigation.ts` 和 `useConversationNavigation.ts` 管理轮次投影、锚点与阅读跟随。
- `src/renderer/src/components/`：输入区、Markdown、导入、完整设置及选择菜单。
- `src/renderer/src/style.css`：Web 共享几何、角色层级、响应式和减少动态效果。
- `scripts/package.mjs`：临时目录中安装 Host 生产依赖，打包原图标、完整 Host 和 Legal 许可证资料；Host 与客户端生产依赖分别登记版本并归档许可证正文，未知声明或缺少未审计正文会阻止打包。产物在 `release/mac-arm64/D Code.app`，临时目录自动清理。

## 验收边界

507 已于 2026-09-07 确认当前基础工作台与灵感流程验收通过。正式验证记录、候选路径与迁移遗留由 PRD 0028 维护。源码提交、推送与正式发布分别成立；`npm run dist` 生成本机未签名候选。

## 0.0.32 UI/UX 候选

[0030](../doc/40-版本实施方案/0030-工作台-UI-UX-并行候选.md) 按 507 于 2026-09-08 确认的 `0.0.32` 在独立工作树推进，与固定 0.0.31 人工验收基线分开。第一批包含真实新任务草稿的创造页、原版 ThreeUI 场景、静态降级及从主题按钮展开的配色切换。`NewTaskScene` 拥有场景作用域和生命周期，`vendor/threeui` 保存原始源码与身份，`workbench/theme-transition.ts` 协调渲染快照；外观仍由 Product Store/Electron 拥有。

`npm run verify:threeui` 核对五个原文哈希；`npm run test:new-task` 在独立数据根与隐藏 Electron 窗口验证真实新草稿、已有任务/灵感排除、项目草稿文件、草稿返回、外观持久化、减少动态效果和 WebGL 降级，不操作正在运行的验收应用。

候选的第二、三批已补充真实技能列表读取、项目归属 chip、复制与加载反馈；`workbench/motion.ts` 为 React/CSS 的共享动效值，执行状态投影区分中断/未知与成功，历史内容不随当前流式回复重播。文件页签的编辑与安全合同保留，容器关系按下方项目文件查看批次修正。`test:new-task -- --without-webgl` 的底层检查入口 `node test/main/new-task-ui.mjs --without-webgl` 可在隔离 Chromium 模拟 WebGL 上下文被拒绝；该参数不改变产品配置。

新任务归属选择在输入卡内部底部“＋”旁；“＋”菜单提供图片、文件和技能/命令，文本 `/` 入口保持。切换归属读取各自草稿，原文字和附件可在切回时恢复；已有任务不显示归属迁移入口。模型、思考和发送控件在同一工具栏内有界换行。

0.0.32 技能菜单使用 `CommandMenu.tsx` 与 `workbench/command-menu.ts`：前者只拥有浮层、焦点和可见区域，后者把可读名称与调用名分开。Floating UI 2.1.9 从原有传递依赖提升为显式依赖，没有新增另一套菜单/命令事实源。`npm run test:command-menu` 用真实 Composer 与 181 条受控候选检查布局、长列表、搜索和键盘；菜单的 HTML 预览叠层关系继续由 `test:new-task` 在隔离原生窗口验证。

模型连接验收：`node test/main/model-connections.mjs` 在独立隐藏 Electron 窗口运行实际设置页与 Host，仅注入私有假凭据适配器，覆盖取消、失败重试、保存、断开和深浅主题；不使用或改写用户的验收应用。API行内输入的失败重试、成功/取消/折叠/离开清理与Host退出重启由同一独立测试覆盖；OAuth原生交互与真实账号仍需人工另行验收。

自动配额门槛：设置→模型的整数百分比控件经现有设置接口由 Host 保存，回退编辑器消费同一生效值。`node test/main/model-quota-threshold.mjs` 使用独立隐藏 Electron 与真实 Host 验证范围、保存、事件更新、双主题及刷新恢复；控件选择通过 DOM change 驱动，焦点样式使用 Chromium 焦点模拟，原生下拉菜单的键盘选择另行人工验收。

OAuth 等待期间在供应商行提供“打开登录页面”和可选“输入授权结果”。自动打开失败与辅助输入故障可原处恢复，页面只发送 flowId，不接收授权URL/回调/token。`node test/main/oauth-login.mjs` 在client目录运行实际设置页、Host及SDK的受控登录回归；OS应用启动另由Host原生测试验证，两者均不冒充用户真实账号登录。

需要系统钥匙串权限的连接在供应商行显示“授权访问钥匙串”；用户主动发起后可“取消授权”，拒绝或超时不会自动再弹。授权后的目录同步与授权阶段分开，失败可重试更新。`node test/main/keychain-access.mjs` 验证实际设置页/Host与受控vault的后台无交互、重试、取消、其他模型及重启路径；不读取真实账号或密码。

OpenAI Codex 在供应商区域直接显示“浏览器登录”“设备码登录”，不再弹出方式选择窗；等待期间可以重新打开系统登录页面或取消，浏览器手动结果仍为用户按需打开。设备码以可选中文字显示在同一区域，值经可信主 frame 的 `dcode:readDeviceCode` 和 Host 独立 fd4 私有通道读取，只保留于可见控件；没有复制到 SWR 缓存、页面配置或草稿。折叠、离开、取消、完成、到期和 Host 退出时清空，迟到回执不能恢复旧值；返回页面仅重新读取仍有效流程。`src/host/device-code-channel.ts` 负责有界保密投影。实际设置页/SDK受控回归覆盖两个直接入口、设备码生命周期、其他 frame 拒绝和公开输出/持久化不泄露，不代替真实账号验收。

项目行第一批使用常显且固定占位的“更多”与新任务 SVG 按钮；主行独立展开/收起，更多只提供已接通的编辑项目。项目新任务复用 `new:project` 草稿与首次创建合同，`useWorkspaceFiles.hideForDraft` 只让目标草稿回到输入，不清标签或编辑缓冲。项目菜单按项目id控制，进入设置/隐藏导航时清理，系统新任务事件显式关闭菜单并保留输入焦点；关闭编辑表单回到稳定项目触发按钮。`node test/main/project-row.mjs` 使用独立Electron/Host和受控模型验证三份草稿、附件、文件编辑保留、首次发送、菜单/表单/设置焦点及深浅/三档字号/宽窄窗口；项目文件按钮和默认右侧内容由后续批次接入。

项目文件查看默认使用同一左侧导航与右侧信息检查器。`WorkspaceFileNavigation` 负责目录/Git列表，`WorkspaceFiles` 负责真实内容标签；中央Transcript及Composer不因打开文件被卸载。`useWorkspaceFiles` 保存独立的浏览来源和按来源标识的标签/缓冲，任务与其Project目录归一为同源；保存、差异及相对链接始终使用标签自己的来源。返回任务只切左栏，收起详情不丢缓冲，关闭脏标签仍确认。读取序号保护迟到引用及旧重载；显式文件导航请求会恢复隐藏左栏。`test/main/file-inspector.mjs` 使用隔离目录和真实本地SSE响应验证A运行时浏览/保存B、A写保护、正文/差异/HTML及原对话输入并存。主动展开由后续批次实现。
