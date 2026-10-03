# Pi 1.0.0：虚拟模型与运行恢复

核对日期：2026-10-03。证据固定在 Pi `v1.0.0`，提交 `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`。本文件保存技术参考与适用边界，不是已实现能力或定稿的交互规格。

## 用户目标

507 已确定以 Pi SDK `1.0.0` 作为后端技术基石，希望融合虚拟模型和 Durable 的运行恢复能力。对恢复体验的原始描述是：“可以当前直接暂停，然后重开，不会让LLM中断”。后续第二轮已确定客户端为 Electron + React + Tailwind v4；该选型不改变以下 Pi 能力证据。

507 随后确认方案 A，并排除当前无界面后台执行：暂停或关闭时保存，重开后能够接续。现行产品边界统一保存在 [任务暂停与恢复](../spec/任务暂停与恢复.md)；上面的原始描述不构成对供应商同一次模型推理可原样续接的能力承诺。

## 已核对的上游能力

### 虚拟模型

虚拟模型是用户可选择的路由入口，在每次请求前选择实际模型及思考强度。Pi 区分用户选择与实际执行，并可保存路由状态；SDK 可直接通过 ModelRuntime 注册。它提供路由机制，D Code 的具体策略和呈现方式仍需设计。[官方说明](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/docs/virtual-models.md)

### Durable

Pi Durable 将运行事实提交到存储，并在重新打开后接续未完成工作。只有标记为安全重放的在途工具调用才会自动重跑；其他中断调用以中断结果处理。它仍属于实验 API。[官方说明](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/README.md)

官方恢复测试明确覆盖两种模型请求：普通请求在重开后重新发送；已保存的部分回答转为中断记录。支持 deferred（后台延迟结果）的请求则可以保存句柄并继续查询结果，不能把后一种能力推广到所有模型。[恢复测试](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/test/harness-generation-recovery.test.ts)

生成实现也显示，恢复普通请求时先处理上次部分回答，再向模型发起请求。[生成实现](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/generation.ts)

### 接入参考

Pi 仓库提供一个基于 Durable 的实验编码智能体，复用 ModelRuntime 等能力，并通过重新打开 SQLite 会话继续工作。它证明存在可研究的组合接入示例，但该示例不等同于现有编码 SDK 的所有能力，也不证明 D Code 已能直接采用。[实验示例说明](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/experimental/durable/README.md)

## 对 D Code 的约束与未决问题

- 恢复已保存的运行进度，不等于冻结后原样续接任何供应商的同一次推理；不能在界面中作超出真实能力的承诺。
- 上游的会话 abort 会终止当前工作并撤回排队输入，不能直接视为可恢复暂停。[停止语义](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/README.md#abort-and-subagents)
- 暂停、关闭和重开的产品范围已写入对应规格；“继续”时的模型请求、工具副作用和已有结果必须分别验证。上游 deferred 能力只是技术参考，不代表 D Code 当前采用关闭界面后的后台执行。
- 虚拟模型与 Durable 在 D Code 中的组合接入、暂停粒度、前后端生命周期及具体路由策略尚未实现或验证。

## 状态所有权核对

本节为 2026-10-03“实现与验证：状态归属与写入路径”的补充调查。固定版本与上文相同，工程规则见 [AGENTS](../AGENTS.md)；以下区分上游事实与 D Code 的设计建议。

### 已核实的两种执行入口

- 普通编码 SDK 的 `createAgentSession()` 创建 `AgentSession`，管理一次会话的模型、工具、队列、压缩和扩展运行；`SessionManager` 管持久记录树与当前分支，是最终模型上下文的依据。直接改运行时消息数组不会替换已保存的上下文。[SDK 会话与存储说明](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/docs/sdk.md#session-lifecycle)
- Durable 的 Harness（持久化执行器）管理提交、执行步骤与恢复，内置文档保存运行进度、已接收输入、模型设置和用量；界面可订阅由已保存记录产生的只读视图。它也允许定义应用自己的状态文档。[Durable 概念与状态](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/README.md#concepts)、[只读视图实现](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/view.ts)
- 官方实验编码智能体以 Durable Harness 作为执行器，复用模型、认证、设置及部分界面能力；它没有把普通 `AgentSession` 与 Harness 同时作为同一次运行的写入者。该示例未覆盖普通编码客户端的全部能力。[实验入口与边界](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/experimental/durable/README.md)、[组合实现](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/experimental/durable/runtime.ts)
- 同一 Durable 存储同时由一个进程拥有；存储层本身不提供跨进程锁。实验应用另有会话锁。这是后续进程设计必须落实的约束，尚未决定 D Code 的进程数或数据库布局。[存储说明](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/README.md#storage)

### 不能直接混同的对象

D Code 的长期／短期任务是产品组织对象；Durable 的 Task 是保存执行步骤的运行对象。Durable 的 Session 可容纳多个 Conversation（上下文记录单元），也不能仅凭同名就与普通 SDK 会话或 D Code 会话逐个等同。具体映射由接入设计核实，不改动已经确认的三层产品模型。

### D Code 的职责建议

以下是基于已确认产品目标与源码的工程建议，尚未绑定具体存储方案或接入接口：

| 状态 | 建议的写入职责 | 其他部分如何使用 |
|---|---|---|
| 工作空间、文件夹绑定、任务层级、会话归属 | D Code 的产品管理部分 | 界面通过操作入口修改，运行接入读取当前工作位置与归属 |
| 已接收输入、回答、工具结果、执行进度与恢复记录 | 同一次运行所选用的 Pi 执行入口 | D Code 读取真实结果并派生任务展示状态，不维护第二套会自行推进的执行队列 |
| 尚未提交的输入、当前选择和展开状态 | D Code 的界面状态部分 | 按规格保存与恢复；已提交请求的实际结果仍读取执行端 |
| 开始、暂停、关闭和重开的协调 | D Code 的运行接入部分发出操作请求，Pi 记录执行结果 | 只有取得实际结果后才显示为已暂停或已恢复；等待状态与完成状态分开 |

职责分开不意味着必须分成多个数据库或进程。Durable 可承载自定义应用文档，物理存储拓扑仍需结合运行隔离、生命周期和跨空间移动设计；本轮不创建第二套会话历史或规定具体数据库。

### 虚拟模型组合中的具体缺口

沿官方示例把 `ModelRuntime` 传入 Harness 时，Durable 生成代码经 `streamSimple()` 请求模型；该方法遇到虚拟模型会以 `reason: "direct"` 路由，没有传入普通编码会话的路由状态，也没有保存路由返回的状态。虚拟模型文档明确 direct（直接请求）不携带或保留这份状态。[Durable 请求路径](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/generation.ts)、[ModelRuntime 的直接路由](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/core/model-runtime.ts)、[路由状态约定](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/docs/virtual-models.md#keep-routing-state)

据此推断：照搬该组合示例不能自动获得普通编码 SDK 的完整有状态路由行为；这不等于虚拟模型无法使用。接入验证须检查用户选择、实际执行模型及所需路由状态分别由谁写入、何时保存、重开后如何读回。若需要额外适配，应沿同一执行与提交路径完成，不能增加第二个独立调度同一会话的执行器。具体适配尚未实现或运行验证，已确认的虚拟模型与恢复目标继续保留。

### ZCode 研究回流后的源码复核

2026-10-03 收到 ZCode 的只读研究报告后，整合侧逐项复核关键推断。direct 路由缺少普通会话状态往返的判断继续成立；但“公开 models 包装器已足够完成适配”仍是待验证候选，不能据此定案接口。

- **打开与启动调度分开。** `TaskScheduler` 初始 `enabled=false`；`open()` 加载并协调遗留状态，其注释明确不派发任务，`resume()` 才启用调度。Harness 的等待和提交入口也可能启用调度。因此不能把“打开 Harness”直接等同于“自动续跑”；读取现场路径应避免误用会启用调度的方法。打开过程会协调并写回部分遗留状态，也不能说它是完全零写入的数据库只读打开。[调度器实现](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/scheduler.ts)、[Harness 入口](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/harness.ts)
- **模型引用不等于已路由的物理模型。** `GenerationTask.prepare` 从 `agent.model` 取引用，并把该引用写入 request checkpoint；`getModel()` 的注册表查找不等同于 `ModelRuntime.resolveModel()` 的虚拟路由。沿当前 direct 组合使用虚拟模型时，不能断言 checkpoint 已冻结路由选出的物理模型；具体调用次数、路由结果和恢复绑定需要验证。[生成任务](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/generation.ts)、[实际路由发生处](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/core/model-runtime.ts)
- **重试会重新准备请求。** `retry` phase 将 checkpoint 置回 `prepare`，之后再次进入请求路径。使用虚拟模型时，不能推出“重试不重新路由”；进程重开后的请求重发，也须与同一进程内 retry 分开验证。[重试与请求实现](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/generation.ts)

ZCode 随后在同日纠正版中接受了上述三项更正；报告仍为源码研究，未运行实验。它新增的“每个产品会话单独配置一个 Harness”只是候选，尚不能作为 D Code 的运行或存储拓扑定案。

整合侧进一步核对公开接口：`HarnessOptions` 没有报告所称的公开 `agent` 配置回调；不能把内部 `runtime.agent` 当作外部注入入口。与此同时，`HookApi` 已提供 `taskId`、`conversationId` 与 `memo`，生成钩子 `beforeRequest` 和 `afterResponse` 会收到该接口。因此，“models 方法没有直接身份参数”不能推出整个公开扩展面都拿不到生成身份。钩子与实际模型调用、持久化结果之间能否可靠关联，以及 memo 的保存、重放和跨尝试语义，仍需沿调用路径核实并实验；这不是已经找到可用接入方案的证明。[公开选项与钩子类型](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/types.ts#L390-L406)、[生成钩子及身份](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/types.ts#L539-L561)

后续验证先使用假模型计数和隔离存储，分别观察仅打开并读取视图、显式恢复、普通请求重发、retry 和路由状态更新。还须核实模型包装器如何取得准确的会话／生成身份、如何绑定路由决定与持久化步骤；同库存放不自动等于同一次原子提交。不将仍未成立的接口或拓扑推断交给 Kimi 固化为真实 Pi 接入接口，也不以最近一次回调或进程内自增计数代替可验证的持久身份关联。

同日第三轮报告仍有接口描述与固定原文不符，因此只保留其调查线索，未将报告字段表转成产品合同。已重新核对：`HarnessOptions` 包含 `models`、`registry` 及可选设置等字段；`HookApi` 通过 `memo` 重载读写，没有报告所列的 `setMemo` 或 `session` 字段；`beforeRequest` 可返回消息，不是只返回 void；`CompactionHooks.beforeCompact` 同样接收 `HookApi`。这不证明压缩钩子能直接把身份传给 models，但不能说所有压缩钩子都没有身份。来源为上述固定 [公开类型](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/types.ts)。

官方实验示例明确区分 busy steer 与 follow-up，不能将忙时输入概括成全部等当前一轮结束；具体消费时机仍待源码链与运行验证。独立暂停、恢复粒度和模型调用身份绑定继续作为优先验证缺口，不能通过把 abort 改称暂停来满足规格。[实验示例操作说明](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/experimental/durable/README.md#commands)

## 能力包与扩展兼容的接入检查点

以下为新交接的定向复核，仍固定 Pi 1.0.0，不构成首版新增功能承诺。

- **已核对事实：** Pi Packages 将 extensions、skills、prompt templates 和 themes 一体分发，支持 npm、git 与本地来源，并有版本固定及资源筛选规则。D Code 若开展能力包设计，应先研究复用这条现有路径；当前不从零定义另一套包格式。[固定版本 Packages 文档](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/docs/packages.md)
- **明确的证据限制：** Durable 实验编码示例的未覆盖清单包含 extensions 与 prompt templates。普通编码 SDK 的扩展装配能力不能据此被宣称已直接接入 Durable；清单也不能证明未来永远无法适配。[实验边界](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/experimental/durable/README.md)
- **待核对：** 普通 ExtensionAPI、Codemode／MCP 装配与 Durable registry／hooks／tasks 的接口和生命周期对应；工具权限与副作用在哪条实际调用链生效；安装意图、资源被发现与实际加载成功如何分别返回。这些点由 ZCode 的第四轮只读证据表继续调查，不将 CLI 现成能力当作 SDK 自动装配完成。

相关职责在 [架构约定](架构约定.md#产品运行层与外部-harness-参考) 说明；不为研究候选先建立新模块或引入第二套会话历史。

本轮仅阅读固定版本的官方说明、源码和测试代码，未运行上游测试、调用真实模型或修改任何现有用户会话。部分源码下载遇到连接错误后改用网页读取；上述关键调用路径已取得原文，组合运行效果仍未验证。
