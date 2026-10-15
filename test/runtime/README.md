# Pi 运行切片验证

本目录还包含 [组件片应用回归](compose-config-receipt.test.ts)：内存存储／受控端口／模拟后端与静态渲染分别验证真实设置保存（假标签配置路径已退出）、原回执自然刷新（含暂时 lookup unknown）、同身份找回及主按钮。它们不装配真实 Pi，不能与下列 SDK 证据混用。

[产品内容与装配回归](product-owned-content.test.mjs)验证正常初始化、旧记录／发送关联保全、无能力时不执行、隔离装配与双语错误。窗口完整路径及本片修因见 [清理交付记录](../../doc/阶段记录/2026-10-08-产品内容清理交付.md)。

Pi 专项直接加载 `src/adapters/pi`，使用官方 Pi Durable / Pi AI / Chord `1.0.0`、真实异步 JSONL 与实际文件操作。只有模型服务边界使用受控 provider，不读模型凭据或用户配置，不发网络模型请求。运行数据由每例独立临时目录保存并在结束后清理。

[工作文件夹绑定](project-binding.test.mjs)使用拥有的真实临时目录与状态存储，核选择归属、目录失效、同次真实保存/重试、结果未知保护、查回只读与关闭/设置收束；mock后端只用来判别绑定没有启动工作。首次正常装配选择目录与实际SDK文件工具完整路径另见 `test/e2e/ordinary-coding-path.test.mjs`，界面/保存边界见 `test/e2e/project-binding.test.mjs`；原生可见选择器、真实用户项目和账户不在这些证据内。

[普通扩展与 MCP](ordinary-extension-mcp.test.mjs)使用实际 SDK、隔离项目／凭据与本地模型 HTTP 对端、真实 stdio／HTTP MCP，核注册工具／间接调用、错误与资源正文、输入处理／正式回执、配置刷新、暂停／直接关闭取消及不重放。桌面配置与真实渲染另见 `test/e2e/ordinary-extension-mcp.test.mjs`；本地协议服务不代表真实服务商、OAuth 或完整 SDK 兼容。

[扩展主动模型](ordinary-extension-model-active.test.mjs)核普通工具内的单次complete及streamSimple：真实增量在final前到消费者，result-only／break不另发，独立model取消和原owner暂停／关闭分开，原结果、费用与只读重开不重放；[owned认领边界](durable-owned-model-lease.test.ts)用真实Harness／ToolTask／HTTP核身份、signal、模型ref快照及重复scope拒绝。桌面stream的运行工具正文和生命周期仍由对应E2E实际操作验证，完整源与审查状态见[流式模型记录](../../doc/验证记录/扩展流式模型-2026-10-15/README.md)，不据单个命令绿灯外推全SDK。

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
