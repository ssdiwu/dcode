# Pi 运行切片验证

本目录还包含 [组件片应用回归](compose-config-receipt.test.ts)：内存存储／受控端口／模拟后端与静态渲染分别验证真实设置保存（假标签配置路径已退出）、原回执自然刷新（含暂时 lookup unknown）、同身份找回及主按钮。它们不装配真实 Pi，不能与下列 SDK 证据混用。

[产品内容与装配回归](product-owned-content.test.mjs)验证正常初始化、旧记录／发送关联保全、无能力时不执行、隔离装配与双语错误。窗口完整路径及本片修因见 [清理交付记录](../../doc/阶段记录/2026-10-08-产品内容清理交付.md)。

Pi 专项直接加载 `src/adapters/pi`，当前依赖固定官方 Pi Durable / Pi AI / Chord `1.3.0`、真实异步 JSONL 与实际文件操作；迁移是否完成以[Pi版本与升级](../../doc/Pi版本与升级.md)和PROGRESS的完整门槛／独立结论为准。只有模型服务边界使用受控 provider，不读真实模型凭据或用户配置，不发真实服务商模型请求。运行数据由每例独立临时目录保存并在结束后清理，失败需保留的合成现场按各例诊断标明。

[1.3供应商兼容](pi130-provider-compatibility.test.mjs)核 D Code 原 Azure 来源／凭据键与新公共查询 ID 分离、旧资源 ETag 不复用、旧格式工具调用／结果进入同模型和跨模型真实 HTTP、Kimi 受管协议更新与同名 custom 不误迁。合成协议历史不等于旧盘；`test/compatibility/` 两个专项脚本另读实际旧1.0生成的隔离记录：`pi100-to-pi130.mjs` 接收旧native manifest、旧completing manifest、结果路径三个参数，`pi100-ordinary-to-pi130.mjs` 接收旧普通扩展 manifest、结果路径两个参数。两者都以 `node --import tsx` 启动，只在运行数据副本上核旧回执、正文、只读零请求和明确继续不重放，不包含在runtime默认通配。固定旧数据的生成脚本、生产SDK版本、来源与每次实际调用／出口在[迁移记录](../../doc/Pi版本与升级.md)的外部证据根保存；不能用新SDK捏造历史替代。

[1.3运输生命周期](pi130-worker-transport.test.mjs)以实际资源Worker、同一公开MCP constructor／production包装和真实loopback HTTP，分别核send options的已取消signal零POST、token尚未放门时实际DELETE与关闭返回、活Worker随后真放认证门仍零迟发，以及另一场景中生产资源关闭后自然线程exit。只添加有限探针，不替换被测wrapper／SDK；强制失败清理不计成功退出。它是合成认证的消费反例，不能扩大为真实OAuth账户或整个MCP服务端取消的证明。

[工作文件夹绑定](project-binding.test.mjs)使用拥有的真实临时目录与状态存储，核选择归属、目录失效、同次真实保存/重试、结果未知保护、查回只读与关闭/设置收束；mock后端只用来判别绑定没有启动工作。首次正常装配选择目录与实际SDK文件工具完整路径另见 `test/e2e/ordinary-coding-path.test.mjs`，界面/保存边界见 `test/e2e/project-binding.test.mjs`；原生可见选择器、真实用户项目和账户不在这些证据内。

[任务创建与草稿归属](task-creation.test.mjs)使用隔离的真实异步 JSON 存储与受控执行端口，核命名任务与唯一主会话的同次保存、原创建 ID 防重及只读查回、真实保存失败／应答丢失、并发排队及关闭等待、不可读启动不能误报未找到，以及空间和父任务首次输入的正式归属。它不证明 SDK 或窗口；三种界面入口另见 `test/e2e/local-task-ui.test.mjs`，同命名任务看差异后再次输入、真实工具／测试1→0／新差异、在途直接关闭和只读重开／明确继续另见 `test/e2e/ordinary-coding-path.test.mjs`。联合门槛与独立状态统一见[本地路径实施记录](../../doc/验证记录/本地开发路径核对-2026-10-19/实施与联合验证.md)。未保存且被强制终止的表单意图不承诺无损恢复，模型服务和原生文件夹选择器的受控部分不能外推为真实账户／用户项目接受。

[普通扩展与 MCP](ordinary-extension-mcp.test.mjs)使用实际 SDK、隔离项目／凭据与本地模型 HTTP 对端、真实 stdio／HTTP MCP，核注册工具／间接调用、错误与资源正文、输入处理／正式回执、配置刷新、暂停／直接关闭取消及不重放；Pi `ExtensionAPI.exec` 另核原 argv／cwd／输出／退出码、活动 owner 收束、安静继承管道与 kill error。桌面配置与真实渲染另见 `test/e2e/ordinary-extension-mcp.test.mjs`；本地协议服务不代表真实服务商、OAuth 或完整 SDK 兼容。

[扩展类型化模型目录](ordinary-extension-typed-catalog.test.ts)使用真实 `CodingExtensions` Worker 与宿主 `ModelRuntime`，覆盖 chat/image/classifier 三类按类型读取、认证过滤的异步可用性与取消、provider 显示名／登记 ID 的宿主投影，以及 Provider／认证／refresh 操作的明确拒绝；不代表真实服务商、分类／图片请求或完整 SDK 已验收。

[扩展主动模型](ordinary-extension-model-active.test.mjs)核普通工具内的单次complete、streamSimple及有限openai-completions原生stream：原生分派、权威thinking与原生参数一致、同API改选及跨API／覆盖拒绝分别核真实HTTP和零请求；真实增量在final前到消费者，result-only／break不另发，独立model取消和原owner暂停／关闭分开，原结果、费用与只读重开不重放；[owned认领边界](durable-owned-model-lease.test.ts)用真实Harness／ToolTask／HTTP核身份、signal、模型ref快照及重复scope拒绝。桌面stream的运行工具正文和生命周期仍由对应E2E实际操作验证，streamSimple的完整源与审查状态见[流式模型记录](../../doc/验证记录/扩展流式模型-2026-10-15/README.md)，本轮原生stream另见[原生流记录](../../doc/验证记录/扩展原生流-2026-10-18/README.md)，不据单个命令绿灯外推全SDK。

从仓库根目录运行：

- `npm run demo:pi`：可直接观察真实工具写文件、暂停、关闭重开查询及显式继续；打印的是实际回执和磁盘读回结果。
- `npm run test:runtime`：运行本目录全部行为测试，包括专用子进程的 SIGKILL 与存储故障注入。
- `npm run verify:runtime`：架构正反样例及源码、全量类型、Lint、运行行为测试的交付门槛。

`fixtures.ts` 只属于验证：本地模型在真正被 Pi 请求后才产生消息或工具调用。`crash-child.ts` 只由进程恢复测试启动，不能作为应用入口。请勿复制这些假模型到正式服务商配置中。

公开端口见 [application](../../src/application/index.ts)，序列化请求和校验见 [contracts](../../src/contracts/index.ts)。宿主先完成任务／成员授权和有效界面检查，再调用 `PiExecutionSession.open`。读取 `control` 后用于新输入和显式恢复；同次重试保留 `operationId`、原文、模式及目标，重新取得控制令牌不改变发送身份。`lookupReceipt` 不执行工作，终态也可查；未知结果先查，不盲目发送。

适配器的实例、控制版本与观测序号供消费者拒绝旧视图或操作。暂停按真实 Pi `close` 收束，正常接续重新打开后使用显式 `resume`；不承诺原网络流继续。一次关闭失败会持续向所有关闭调用者返回同一个失败并保留认领，需宿主停止相关运行并诊断，不能以另开实例绕过。死亡进程才允许回收所有权标记；标记损坏或缺失、PID 无法核实等情况拒绝认领，禁止递归清除未知存储。

`read().entries` 中的助手条目通过 `assistantText` 提供已提交正文，按持久历史里的文本块原顺序拼接并保留原有换行；不包含思考或工具调用块，也不代表流式中间片段。Pi 的 `entry.model` 与 `entry.data` 分开保存，消费者不能仅从 `data` 寻找正文。接收与重开用例实际比较中英正文全文和同一条目身份，并验证读取、回查没有新增模型请求；只有 `pi.assistant` 条目存在不足以证明正文可展示。

2026-10-05 正文读取修复证据：[修前失败](../../doc/验证记录/pi-assistant-projection-red-2026-10-05.log)实际读回 `undefined`；[修后完整检查](../../doc/验证记录/pi-assistant-projection-verify-2026-10-05.log)覆盖架构 28 个正反样例与 4 个源码文件、全量类型／Lint 及 13 项运行测试，均通过。该记录没有启动 Electron 窗口，也不替代 UI 消费者验收。

测试通过不覆盖 Electron／手机 UI、配对及远端网络、真实服务商、自然语言派工授权、无协作取消行为的任意工具，或断电后的无损保证。虚拟模型的独立组合探针与已知路由状态限制见 [Pi 证据记录](../../doc/Pi-1.0.0-虚拟模型与运行恢复.md)。

[普通virtual direct](ordinary-extension-virtual-direct.test.mjs)核真实工厂登记、原工具流、独立物理B的规范端点／认证／完整准入、原child／结果／费用，以及route等待中的暂停／关闭／只读恢复与不重放、原工具仍活时仅模型取消后的实际迟到回调丢弃、pure route写入前拒绝；[登记生命周期](coding-virtual-registration.test.ts)以真实Worker／ModelRuntime／Harness核物理冲突、注销、旧资源不删新同名项、失败回滚与非法定义。这里不把登记本身当执行成功；当前实际出口和独立状态见[virtual direct记录](../../doc/验证记录/扩展Virtual-Direct-2026-10-15/README.md)。

[普通provider公开头](ordinary-provider-config-header.test.mjs)核首次／owned／后续真实HTTP消费及原身份／费用／关闭RO与同backend新会话隔离；[注册与认证边界](coding-provider-headers.test.ts)核真实SDK的原认证派生与动态私有头碰撞、登记与清理；[Worker边界](coding-provider-header-worker-boundary.test.ts)核原始值失真拒绝、实际重登记／注销与跨资源认领；[活会话刷新](ordinary-provider-header-live-refresh.test.mjs)核原S1/S2的新模型实际请求、能力与关闭隔离以及单会话失败不截断其它客户端；[准入当次改选](ordinary-provider-header-admission-switch.test.mjs)核同源和跨源A→B最终物理请求的公开头、认证与原上下文；不是任意provider配置或完整native消费者。当前结果与失败资格见[本片记录](../../doc/验证记录/扩展Provider-Headers-2026-10-15/README.md)。

`ordinary-extension-classifier.test.mjs`使用真实受管预设/SDK/SystemOne HTTP/Worker/Durable/隔离加密存储验证分类结果、带费用错误、无usage、认证窗口变更及暂停/关闭/只读重开/明确继续不重发；`classifier-boundaries.test.ts`另核只读认证不会刷新或写档。普通桌面入口、正文和任务用量见`test/e2e/ordinary-extension-classifier.test.mjs`。完整SDK与真实外部账户仍另验。

`ordinary-extension-images.test.mjs`核普通原工具的真实图片SDK/HTTP、保真图片、坏图与已确认费用、无usage、认证变化及HTTP／验证线程在途暂停关闭、独立模型取消、只读重开和同输入继续不重发。验证线程online交错只观察实际Node Worker事件，不在产品中加门；它证明核验资源已启动后的关闭，不冒称CPU/WASM计算中断性能。`image-validation.test.ts`另核五格式与动画容器、完整坏IDAT、MIME／base64／容量及真实success消息与取消交错；固定资产来自隔离生成器，未用真实用户图片。桌面实际渲染与用量在`test/e2e/ordinary-extension-images.test.mjs`单独验证。

`image-validation-budget.test.mjs`是有限资源故障模型：实际不回消息Worker触发原10秒预算，必须真实exit才拒绝；它不替代真实SDK解码。近容量路径保原SDK的工具文本截断规则，同时核8MiB图片与1MiB文本的原结果、原图后续HTTP、费用和只读历史；内部JSON封套与raw图容量分别验证。


`context-usage.test.mjs`从公开MemoryStorage／Harness／ContextView核有效消息、chat usage与后置贡献、edit失效、fork／reset／压缩后未知、typed费用排除、数值有限及未完成工具占位；Harness保持暂停，无模型／认证请求。`context-usage-worker-frames.test.mjs`用真实Worker与SDK Runner接收受控协议帧，核同tail改选、await后新窗口、迟到帧不回滚／不丢原operation、unknown替旧数、null／0区别、模型对象突变不污染原帧、迟到context仍消费原请求正文及实际资源关联拒绝；受控帧不是业务HTTP证据。`ordinary-context-usage.test.mjs`另经普通ModelRuntime／Durable／Worker和真实SDK受控HTTP核同步返回、副本隔离、2→3锚点与原结果进入下一请求，以及暂停／关闭／只读重开与继续不重放，另观察实际Host请求保迁移前context Action身份；该观察不冒称旧版本持久场景已完整重放；桌面实际配置／渲染仍由对应E2E单独验证。当前门槛和独立收口见[上下文用量记录](../../doc/验证记录/扩展上下文用量-2026-10-18/README.md)，不代表压缩执行或整个SDK通过。
