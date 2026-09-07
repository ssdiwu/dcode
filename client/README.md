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
- 模型保留完整目录、认证态、启用范围及默认选择；旧供应商可显式接管非敏感配置并保留认证引用，新认证使用环境变量引用。凭据正文不进入客户端。旧 Swift 的界面偏好单向继承，已保存的新偏好优先。
- 本机资源保留来源清单，技能和提示词启停实际影响原生资源加载；外部可执行扩展继续服从现有禁用策略。
- 自进化提供隔离检查与构建、候选身份及数据版本校验、停机后重启恢复、人工确认和回滚回执。候选输出可用 `DCODE_PACKAGE_OUTPUT` 指定，不能覆盖正在运行的构建。

Swift 按面拆除尚未执行，作为独立迁移收尾保留；当前基础验收不等于这些源文件已经退役。

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
- `scripts/package.mjs`：临时目录中安装 Host 生产依赖，打包原图标与完整 Host；产物在 `release/mac-arm64/D Code.app`，临时目录自动清理。

## 验收边界

507 已于 2026-09-07 确认当前基础工作台与灵感流程验收通过。正式验证记录、候选路径与迁移遗留由 PRD 0028 维护。源码提交、推送与正式发布分别成立；`npm run dist` 生成本机未签名候选。
