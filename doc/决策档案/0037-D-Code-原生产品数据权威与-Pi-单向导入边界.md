# D Code 原生产品数据权威与 Pi 单向导入边界

状态：Accepted（已接受；取代 ADR 0001、0007 与 0018 的产品前提；`0.0.28` 已形成实现候选，原生人工验收与发布状态由版本 PRD 另行记录）

## 背景

D Code 已确定为基于 Pi SDK 的独立 ADE，而不是 Pi CLI 的原生界面。继续把 `~/.pi/agent` 的会话、模型设置、能力资源与认证合同当作产品权威，会迫使 D Code 的 Project、Task、提交原文、生效输入、Agent Run、能力模块和自进化继续围绕 Pi CLI 的数据模型生长，也无法稳定表达一个 Task 拥有多个 D Code Session 与多个 Agent Run。

此前“不建立第二套会话数据库”的决定服务于 D Code 与 Pi CLI 双向续写同一历史。现在明确放弃这项兼容承诺：旧 Pi 会话可以进入 D Code，但进入后由 D Code 自己拥有和演化。

## 决定

1. D Code Product Store 是 Project、Task、D Code Session、提交原文、生效输入、Session Path、Agent Run、能力配置、模型资源、Artifact、Evidence 与恢复事实的唯一产品权威。具体数据库、索引和事件格式由后续技术方案确定。
2. Pi SDK 是首个 Agent Runtime，通过 Runtime Adapter 消费 D Code 组装的输入并返回模型、工具和结构化运行事件；Pi SDK 不拥有 D Code 的耐久会话身份、产品配置或界面语义。
3. D Code 最终拥有模型目录、供应商设置、能力资源与认证状态合同。迁移期间可以读取或导入 Pi 配置，但不得把 `settings.json`、`models.json`、Pi Package 或认证文件永久保留为产品权威，也不得复制或展示凭据正文。
4. Pi JSONL 只作为一次性迁移来源。`0.0.28` 升级时，已经由 D Code 管理的可见 Pi Session 自动转换为 Legacy Task 及其首个 D Code Session：唯一既有 Project 归属保留，无明确 Project 时进入 User Scope，关联 D Code 本机状态同事务迁移；该例外不扫描整个 Pi agent-dir。其他 Pi Session 只有用户点击显式“导入为任务”按钮后才进入，创建新的 D Code Task 与首个 D Code Session。两种路径都保留来源、原 ID 与转换证据，不改写源文件；进入后使用 D Code 身份独立演化，不双写、不持续同步，也不承诺往返转换。
5. 完整导出以 D Code 自有格式为准。未来若提供 Pi JSONL 导出，只能是明确标注能力损失的可选适配，不构成 Pi CLI 可以继续使用的兼容合同。
6. 提交原文与生效输入是两个相互关联的 D Code 事实：用户真正提交的内容不可被技能展开、输入转换或压缩覆盖；运行时输入可以组装和压缩，但必须可追溯回原始来源。
7. Project Directory 中的源码、普通文件与一等项目文档继续以当前文件系统内容为正文权威。Product Store 只保存项目关系、文档类型、路径、revision、加载记录和必要索引，不复制正文建立竞争权威。
8. `0.0.28` 起，D Code Product Store 是产品 Task / Session / Run、模型选择、提示词回执与恢复事实的实现候选权威；Pi SessionManager / JSONL / 配置只保留为 Runtime Adapter 私有会话、只读发现或显式单向导入来源。原生人工验收与真实认证交接仍未成立，任何目标态文档不得冒充已经交付。
9. 当前 macOS 用户的 D Code Data Root 固定为 `~/.dcode/`。Product Store、D Code Session、设置、Agent Profile、能力 / 模型配置、受管 Artifact、索引、日志和恢复资料都归入该根；Project 源码与一等项目文档正文仍留在真实 Project Directory。凭据正文使用 Keychain 或外部安全来源，`~/.dcode/` 只保存安全引用与认证状态。
10. 每个 Task 必须恰好属于一个 Project Scope 或 User Scope，不允许 nullable Project 产生“无归属任务”。User Scope 由 User Home 呈现；未选择 Project 的 Task 默认执行目录映射为当前用户 Home Directory，但其产品数据仍写入 `~/.dcode/`，不会把主目录伪造成 Project 或把数据散落到普通文件。
11. `0.0.28` 必须把现有 D Code 本机状态与被采用的 Pi 资产从 `~/Library/Application Support/D Code`、配置所指 `agentDir/pi-dcode` 及明确导入源迁入 `~/.dcode/`，并为旧路径定义一次性迁移、只读退出与失败恢复；Lease / lock 与可重建缓存不迁移。完成后不得继续把 `~/.pi/agent`、旧 App Support 文件或 `agentDir/pi-dcode` 当作新增产品状态的可写权威。
12. `0.0.28` 的 Product Store schema promotion 是单向升级，不提供降级到 `0.0.27` 的产品能力。迁移事务提交前失败必须保持旧数据原样并拒绝启动新版本；提交成功并产生新 D Code 状态后，旧 Store 只作为只读来源 / 数据修复备份，禁止双写，也不承诺旧 App 可以继续工作。备份服务数据恢复，不构成版本回滚合同。

## 影响

- ADR 0001 与 0007 的会话权威、可见性和来源模型被整体取代；Pi Session 从产品对象降为外部导入来源。
- ADR 0018 的“打开即抢占 Pi JSONL”退出目标产品；单写入、冲突可辨认和结果未知不盲重试原则继续保留，并转由 D Code Product Store 与运行所有权实现。
- ADR 0015 的 Pi 模型与配置权威只保留为当前实现和迁移来源；D Code 原生模型资源成为目标产品权威。
- ADR 0035 的 User Scope / Project Scope → Task 主干继续成立，但其中 Session 必须统一为 D Code Session。
- ADR 0036 的能力分层继续成立；Pi SDK、Pi 扩展和模型供应商分别成为 Runtime Adapter、机制来源或 Capability Provider，不拥有产品分类。
- User Scope 使不属于具体 Project 的 Task 仍有明确所有者和默认执行目录；界面不得用“未选项目”伪装其身份。
- `0.0.28` 首次迁移是明确的一次性兼容断点：可以在提交前安全失败，但提交后不维持旧 schema 的降级兼容或双写窗口。

## 未选择的方案

- **继续与 Pi CLI 共用同一会话和配置目录**：迁移成本低，但 D Code 永远受 Pi 产品对象与兼容边界限制。
- **D Code 只拥有会话，模型与能力配置永久由 Pi 拥有**：形成两套长期权威，无法完成独立 ADE 的产品闭环。
- **双向同步 D Code 数据库与 Pi JSONL**：冲突、能力损失和身份映射没有稳定真相源，会把导入适配误做成长期分布式一致性问题。
