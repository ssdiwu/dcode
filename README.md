# D Code

D Code 是面向 macOS 的智能体开发环境，目标是持续承接开发、沟通与项目工作。当前为 `package.json` 声明的 **0.1.0-dev** 开发版，尚未正式发布；当前实现、验收与未推送边界统一见 [PROGRESS](PROGRESS.md)。

## 打开当前开发版

- 双击根目录[启动 D Code.command](启动%20D%20Code.command)，或在本目录运行 `npm run desktop`。入口构建当前主目录，不从 Archives 或协作树挑版本，不注入演示模型、示例任务或测试环境开关。
- 数据固定保存在 `~/Library/Application Support/D Code Development/`，更新代码不清空它。同源实例已运行时不重复构建或启动；载入新代码前先正常退出原窗口。
- 首次使用在侧栏「新建工作空间」选真实文件夹、确认名称，保存后从空间草稿发送。Home与原运行目录保持；具体行为见[文件夹绑定](spec/工作台信息架构.md#普通客户端首次绑定工作文件夹)。
- 空间“＋”可开新工作草稿或命名长期任务；长期任务“＋”开所属短期草稿，任务名进入主会话，箭头展开成员／子任务。草稿首次发送与命名任务先保存的区别见[开发任务路径](spec/开发任务路径.md)。
- 在设置 → 模型填写协议、显示名、模型ID、Base URL及密钥，保存后回会话发送；配置保存不代表认证或实际请求成功。
- 已有项目扩展／MCP可在设置 →「项目扩展与 MCP」保存启用意图，下一次发送／明确继续才加载；只读重开不执行资源代码，启用也不是操作系统沙箱。行为与安全边界见[项目扩展与MCP规格](spec/开发任务路径.md#项目扩展与-mcp)。

## 阅读入口

技术栈为 Electron＋React＋Tailwind。Durable是智能体执行、输入、历史与恢复的唯一底座，pi-ai提供底层模型，coding-agent按需复用；首版按完整产品路径验收，不以全部非UI API兼容或零依赖为目标。

| 要做的事 | 入口 |
| --- | --- |
| 接续工作、查当前结果和具体缺口 | [PROGRESS](PROGRESS.md)、[CHANGELOG](CHANGELOG.md) |
| 开工、分工、交接和独立接收 | [AGENTS](AGENTS.md)、[协作约定](doc/协作约定.md) |
| 确定产品行为与验收 | [spec](spec/README.md)；暂停／模型／用量／成员／终端／远端等已确认要求不因未实现退出 |
| 修改界面、词义或品牌 | [DESIGN](DESIGN.md)、[GLOSSARY](GLOSSARY.md)、[品牌资源](resources/brand/README.md)；中英文共同设计和验证 |
| 查模块、公开接口及Pi职责 | [架构约定](doc/架构约定.md)、[Pi能力复用与演进](doc/Pi能力复用与演进.md) |
| 查固定版本、参考与实际验证 | [Pi版本与升级](doc/Pi版本与升级.md)、[文档导航](doc/README.md)；历史和候选不替当前验收 |

## 工程准备与检查入口

要求 Node.js **≥22.19.0** 和 npm，依赖由 `package-lock.json` 固定。首次运行 `npm ci --ignore-scripts`，再用 `node node_modules/electron/install.js` 安装锁定的 Electron 运行文件。以下命令从工作树根目录运行，以 [package.json](package.json) 和实际脚本为准。

| 用途 | 命令与范围 |
| --- | --- |
| 日常桌面入口 | `npm run desktop` 或 `启动 D Code.command`：构建后正常启动，固定数据目录 |
| 开发／构建／底层预览 | `npm run dev`／`npm run build`／`npm start`；日常打开优先用固定桌面入口 |
| 客户端完整门槛 | `npm run verify`：运行切片、契约、全部界面端到端 |
| 运行切片完整门槛 | `npm run verify:runtime`：架构正反／源码、全类型、Lint、全部运行测试 |
| 架构完整门槛 | `npm run verify:architecture`：检查器正反样例及当前源码 |
| 架构源码／检查器 | `npm run architecture:check`／`npm run architecture:test`，依据 [机器策略](architecture-policy.json)，[检查器](tools/architecture/check.mjs)不属于应用运行代码 |
| 全类型／Lint／运行测试 | `npm run typecheck`／`npm run lint`／`npm run test:runtime`；运行测试串行，范围见[运行验证](test/runtime/README.md) |
| 界面／契约 | `npm run test:e2e` 先构建并串行运行隔离Electron；`npm run test:contracts` 无窗口 |
| Pi运行演示 | `npm run demo:pi`：真实SDK、受控模型与隔离文件，观察暂停、重开查询和接续 |

界面测试默认隐藏、不进Dock、不可聚焦，保留绘制与计时并使用隔离状态；普通连续场景复用窗口，生命周期才重开。定位只跑相关场景，例如先构建，再运行 `node --test --test-name-pattern='滚动边界四组合' test/e2e/scroll.test.mjs`。只有507明确要求可见验收或约定时段，才用 `DCODE_E2E_VISIBLE=1 npm run test:e2e`；后台失败不能自动转前台，授权边界见[协作约定](doc/协作约定.md)。

证据默认写入被忽略的 `test/e2e/evidence/runs/<运行标识>/`；`DCODE_EVIDENCE_RUN` 固定标识，`DCODE_EVIDENCE_ROOT` 重定向根。测试拒绝直接写 `doc/验证记录/`，归档前先核当次结果和来源，再由交付者复制到带日期记录，不能覆盖旧截图或JSON。

受控链路只用于明确的隔离验证：显式设置 `DCODE_VALIDATION_ASSEMBLY=pi-controlled` 与独立 `DCODE_STATE_DIR`，按需加 `DCODE_VALIDATION_SAMPLE=1` 后运行 `npm start`。它不是普通入口或真实服务商，演示只写专用目录，工程装配信息不进入普通产品界面。

## 检查覆盖与证据

| 要核的内容 | 入口与能证明的范围 | 不能据此推定 |
| --- | --- | --- |
| 模块、公开入口、依赖与循环 | [机器策略](architecture-policy.json)、[架构检查合同](doc/架构约定.md#自动检查的合同) | 消息语义、授权、生命周期或界面可用 |
| 类型、Promise与异步IO | [类型配置](tsconfig.json)、[Lint配置](eslint.config.mjs)，另核源码及实际响应 | 所有文件／网络操作均非阻塞 |
| 接收、未知回执、暂停与恢复 | [运行验证](test/runtime/README.md)：真实SDK配受控模型 | 界面、真实服务商或远端已通过 |
| 输入、导航、键盘与结果展示 | `test/e2e/` 与[验证记录](doc/README.md#验证记录)，区分模拟与真实SDK | 手机、远端、真实账户或507人工接受 |
| 字号、颜色、焦点与窄窗 | [DESIGN](DESIGN.md)及[样式核对](doc/验证记录/共享样式核对-2026-10-06.md)；分声明值、布局、真实操作与视觉检查 | 局部结果等于完整矩阵；隐藏窗口等于原生焦点／拖选验收 |

## 历史与参考

新版沿用仓库，以 `0.1.0` 系列为编号起点；旧标签保持原指向，不代表新版继承其能力或验收。主线整合与旧树恢复见[历史摘要](doc/阶段记录/2026-10-09-新版主线整合.md)。

- [0.0.37封档](https://github.com/ssdiwu/dcode/tree/7c97a7526ba5bca4527c98db85375dc4403edd9c)：当时源码、证据及未完成。
- [ZCode固定参考](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)：UI／UX与开发规则；[Pi固定版本与来源](doc/Pi版本与升级.md)只承担对应版本依据。
- 原创内容遵循 [LICENSE](LICENSE)，外部代码／资产按[第三方声明](THIRD_PARTY_NOTICES.md)登记来源与许可。
