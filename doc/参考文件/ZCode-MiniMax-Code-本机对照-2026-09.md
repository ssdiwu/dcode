# ZCode、MiniMax Code 与 D Code 本机对照

核验日期：2026-09-06。对象是本机已安装的 ZCode 3.11.2、MiniMax Code 3.0.68，以及 D Code `main@1d4fd48` 上的未提交候选。只读解包及实际打开界面；未在参考应用中发送消息或修改连接配置。

## 可复验来源

- ZCode：`/Applications/ZCode.app/Contents/Resources/app.asar`。包入口 `out/main/index.js`，独立核心入口 `out/host/index.js`；manifest 包含 `@zcode/client`、`@zcode/rpc`、`@zcode/server`、`@zcode/services`、`@zcode/shared`。模型设置实际展示供应商、连接方式、模型列表、刷新、添加和测试动作。
- MiniMax Code：`/Applications/MiniMax Code.app/Contents/Resources/app.asar`。`dist/main/modules/local-runtime/utility/utility-process-manager.js` 调用 `electron.utilityProcess.fork`；`dist/main/ipc/utility-runtime.ipc.js` 提供连接与断开状态。模型设置的实际配置及空状态位于 `out/_next/static/chunks/3080.128329ed495029b8.js`，通过 `listUserModelProviders` 读取模型来源；本地化词条位于 `9360-54b70e9de197d335.js`。
- D Code：`client/src/renderer/src/App.tsx`、`components/Composer.tsx`、`components/SettingsWorkspace.tsx`、`host/src/pi-host.ts`。模型目录之前只在初始化时写入，刷新按钮只重读已有投影；未连接时仍展示没有选项的默认模型下拉。

解包能验证具体机制、依赖和部分调用路径，不能从压缩后的文件大小推断完整原始组件边界，也不能据此声称参考应用架构没有问题。

## 差异与采用范围

| 观察面 | MiniMax Code / ZCode 的实际行为 | D Code 的差异与本次处理 |
|---|---|---|
| 新建任务 | MiniMax 在标题附近直接放置输入区，文件夹选择为独立入口；ZCode 分开项目与任务分区 | D Code 新任务输入区与标题距离过大；调整为同一居中输入区域，保留原 Logo 和用户范围任务，不建立“未选项目”伪项目 |
| 模型设置 | MiniMax 先选择模型来源，空态给“添加模型”；ZCode 先选择供应商，再管理和测试具体模型 | D Code 陈列目录但缺少操作路径；优先展示已连接模型，无连接时给配置入口，保留完整目录与启用范围 |
| 模型更新 | Pi SDK 支持从 `pi.dev/api/models/providers/:provider` 刷新目录 | D Code 内置 SDK 原为 0.84.1，本机 Pi 为 0.84.4，且启动禁联网、目录已存在即跳过；对齐 0.84.4，核心刷新并同步产品目录，原生 Runtime 读取同一份 D Code 模型缓存 |
| 档案与文案 | MiniMax 设置使用本地化文案，但工作台也有 Explore/Worker 等名称；不等于所有参考文案都适合照搬 | D Code 将标准档案的内部英文原文直接当界面说明；新增标准档案的中文呈现，保留用户改过的名称和职责原文 |
| 消息与输入 | 参考产品把模型选择、附件、执行过程与最终回答分开；MiniMax 右侧集中进度、团队和交付物 | 保留 D Code 富消息、附件、复制引用、任务概览、团队、等待事项与证据；模型输入控件和设置共用呈现逻辑 |
| 壳与核心 | 两者均有独立运行进程；MiniMax 的直接 MessagePort 连接与 ZCode 的 RPC 包体现不同传输实现 | D Code 继续使用 Protocol v1 / JSONL。传输差异本身不能解释 UI 质量；本次沿展示、呈现逻辑、核心规则分工修模型路径 |

## 不照搬的部分

不复制参考产品的品牌、套餐体系、权限模式、伪项目语义或直接凭据输入路径。D Code 的 Product Store、用户范围任务、原始提交与生效输入区分、档案、任务概览、团队证据及自进化继续保留。

Pi 在线目录核验返回 `gpt-6-astra`，显示名称为 GPT-6 Astra，OpenAI 与 OpenAI Codex 两个来源均存在。该目录事实不等于账户已完成实际调用，真实发送结果由 PRD 0028 的验证记录另行记录。
