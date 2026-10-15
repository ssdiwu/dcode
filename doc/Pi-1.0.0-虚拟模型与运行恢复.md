# Pi 1.0.0：虚拟模型与运行恢复

源码核对起于 2026-10-03；实际运行证据更新至 2026-10-05。证据固定在 Pi `v1.0.0`，提交 `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`。本文件区分固定源码参考、已运行的切片证据及仍未验证的产品能力；具体交互以 spec 为准。

## 用户目标

507 已确定以 Pi SDK `1.0.0` 作为后端技术基石，希望融合虚拟模型和 Durable 的运行恢复能力。对恢复体验的原始描述是：“可以当前直接暂停，然后重开，不会让LLM中断”。后续第二轮已确定客户端为 Electron + React + Tailwind v4；该选型不改变以下 Pi 能力证据。

现行产品边界统一保存在 [任务暂停与恢复](../spec/任务暂停与恢复.md)。507 于 2026-10-04 对齐远端后确认：本地或远端至少一个有效工作界面可维持执行，最后界面离开后暂停保存，退出承载执行的 D Code 仍停止；已暂停工作重连须显式接续。原始描述不构成对供应商同一次模型推理可原样续接的能力承诺，本次产品边界修订也不改变下文静态源码证据的验证范围。

2026-10-05，507 确认首版仅提供暂停／继续入口，并进一步明确模型选择以工作需要和能力匹配为先，再依据适合候选是否有可用额度自动选择／切换，而非仅在请求失败后寻找备用。产品策略的唯一正文见 [模型选择与自动切换](../spec/模型选择与自动切换.md)。下文的 SDK 组合探针及路由 state 限制是实现证据与缺口，不能自动等同于该名单策略已经落地。

## 2026-10-05 实际运行证据

507 要求把运行接入实际落地后，主工作树新增 [PiExecutionSession](../src/adapters/pi/index.ts)、[共享合同](../src/contracts/index.ts) 和 [应用端口](../src/application/index.ts)。运行使用 npm 官方 `pi-durable`、`pi-ai`、`chord` 精确版本 1.0.0，均核到上文提交；真实异步 JSONL 持久化与 Pi 工具执行，只有模型服务边界使用本地受控 provider。没有真实账户查询或模型费用。

| 验证 | 运行结果 |
|---|---|
| 接收、去重和改文冲突 | 同次并发发送只有一份提交与一次模型调用；不同内容／模式复用编号被拒绝；另一编号的同文发送可以成立 |
| 完成后及重开后的回执 | 查询正式提交记录可取得终态，不以只查待执行列表或重新提交代查 |
| 暂停、重开、显式继续 | 正在进行的模型请求实际取消，未完成工作留存；重开、读取及回执查询不增加模型调用；显式恢复重新发起请求 |
| 独立会话与旧恢复防护 | 一个会话暂停时另一个仍完成；恢复已进入持久提交时，新暂停仍阻止旧恢复启动调度 |
| 所有权与真实进程崩溃 | 活子进程持有记录时第二实例被拒绝；SIGKILL 且确认退出后可以回收其认领，重开读取不自动运行 |
| 引导与稍后处理 | 经同一 Pi 持久接收通路；工具轮后纳入引导，最终回复后纳入 follow-up，不中止当前模型请求 |
| 实际文件工具 | Pi write/read 在隔离目录产生并读回真实文件，关闭后工具结果仍可从历史读取 |
| 保存拒绝与提交后回执丢失 | 前者未接收；后者保持未知并按原编号查回实际提交，没有盲目重投 |
| 暂停／关闭失败 | 不能伪报已保存；并发和后续关闭调用返回同一真实失败，失败期间保留所有权 |
| 中断工具与副作用 | safe 工具允许恢复后重放；unsafe 工具不重复执行，已有磁盘效果不回滚，中断事实进入模型上下文 |

主树集成用例当前为 13 项，命令 `npm run verify:runtime`，本轮[完整运行记录](验证记录/pi-runtime-2026-10-05.log)保留架构 28 项正反样例、4 份产品源码检查、全量类型、Lint 和运行测试的实际输出；可运行 `npm run demo:pi` 观察真实工具写入、暂停、重开及接续的回执。源码与测试说明见 [运行验证](../test/runtime/README.md)。独立 `507-review` 发现并关闭了关闭失败被吞掉的问题，另独立复跑了进程和关闭生命周期 3 项；主会话运行完整门槛。记录不等于 Electron／手机 UI 验收。

前置探针独立保留在 `/Users/diwu/.codex/worktrees/pi-runtime-probe/dcode/tools/pi-runtime-prototype/`，`NOTES.md`、`evidence-all.tap` 与 `version-evidence.json` 提供 6 项探针结果、命令及版本证据；运行数据已清理，探针壳保留至正式适配覆盖和虚拟模型复核归档完成，由主会话负责后续清理，不能直接当产品代码移植。

**虚拟模型组合的实测限制：** 公开 `ModelRuntime` 可注入 Durable，虚拟选择跨关闭保留，最终结果记录实际物理模型；恢复会重新路由。该组合中的 `route` 调用为 `reason=direct`，返回的自定义 `state` 没有往返持久化。不能把普通 SDK 的有状态路由说明直接当作 Durable 已具备同样保证。此路径独立探针通过 1 项，但未加入主树默认运行依赖；ZCode 在独立树继续核路由失败／重试边界。

**持久性边界：** 主树选用 JSONL `fsync:true`，已核其文件刷新使用异步 Node 接口；固定版本不会在每一次主提交标记追加后都立即刷新该文件。正常关闭与 SIGKILL 恢复已测，电源故障／系统崩溃无损不在保证内。所有权标记损坏、初始化中断留下空标记目录或进程身份无法核实时拒绝认领，不自动清除未知记录。

**依赖边界：** 主树核心包及开发工具本轮依赖审计为 0 项；虚拟模型探针额外加载 `pi-coding-agent@1.0.0`，其传递 `brace-expansion` 报 1 项 high，未因此升级 Pi 或加入主树。固定版本、路由状态策略及真实服务商验证需分别处理。

仍未完成：独立 UI 消费者已经进入受控 Pi 接线，但其故障修复、独立交付审查和主树集成尚未结束；有效界面与成员授权协调、多端网络与配对、真实服务商和全部能力包装配仍分别保留缺口。宿主必须先核对产品归属与授权再调用本端口；本切片不冒充一个完整应用，也不宣称任意不响应取消的工具都能立即暂停。

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
- 暂停、关闭和重开的产品范围已写入对应规格；“继续”时的模型请求、工具副作用和已有结果必须分别验证。上游 deferred 能力只是技术参考，不代表 D Code 当前采用所有有效工作界面都离开后的持续执行。
- 每会话独立暂停已有主树运行证据，虚拟模型与 Durable 组合已有独立受控探针；具体路由策略、有状态路由、UI 生命周期与真实服务商仍未完整接入或验证。

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

以下是由源码研究形成的职责划分；2026-10-05 无 UI 切片已采用 Pi Harness 与会话专属 JSONL，实现异步执行端口，具体结果见本文件实际运行证据。表中的完整产品组织及界面消费者仍需后续接入：

| 状态 | 建议的写入职责 | 其他部分如何使用 |
|---|---|---|
| 工作空间、文件夹绑定、任务层级、会话归属 | D Code 的产品管理部分 | 界面通过操作入口修改，运行接入读取当前工作位置与归属 |
| 已接收输入、回答、工具结果、执行进度与恢复记录 | 同一次运行所选用的 Pi 执行入口 | D Code 读取真实结果并派生任务展示状态，不维护第二套会自行推进的执行队列 |
| 尚未提交的输入、当前选择和展开状态 | D Code 的界面状态部分 | 按规格保存与恢复；已提交请求的实际结果仍读取执行端 |
| 开始、暂停、关闭和重开的协调 | D Code 的运行接入部分发出操作请求，Pi 记录执行结果 | 只有取得实际结果后才显示为已暂停或已恢复；等待状态与完成状态分开 |

职责分开不意味着必须分成多个数据库或进程。Durable 可承载自定义应用文档，当前切片使用每会话 JSONL，完整产品存储仍需结合任务管理、生命周期和跨空间移动设计；不能另建第二套执行历史。

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

## 2026-10-09：预设供应商与在线模型信息核对

507确认预设供应商、自定义入口与联网最新模型信息。此前检查只读pi-ai低层，漏掉coding-agent的ModelRuntime远程目录装配；本节更正这个能力判断，现行产品要求仍在[模型规格](../spec/模型选择与自动切换.md)，实现及验收读PROGRESS。

- pi-ai `createModels()`是空集合；`builtinProviders/builtinModels`提供42个当前SDK供应商条目与其正式API/auth及目录资料。区域/计划身份分别保留，目录存在不代表账户认证或调用成功。
- [ModelRuntime v1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/model-runtime.ts)公开`catalogBaseUrl/allowModelNetwork/refreshOnCreate/modelsPath`等配置，先给预设装配远程目录再刷新。它属于coding-agent，不能把低层createModels的静态集合推广成整个Pi没有在线功能。
- [官方remote-catalog-provider](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/remote-catalog-provider.ts)默认源https://pi.dev，逐供应商`/api/models/providers/<id>`，采用ETag/Last-Modified、4小时检查窗口、有界GET、缓存和发布。实际无凭据GET可读OpenAI/Anthropic/ZAI/Kimi/Radius等目录；`types=chat`实测仍含其他类型，接收侧必须显式过滤。
- 在线阶段的pi-ai Models.refresh会先解析供应商凭据，未认证可能跳过fetch。首次使用的公共更新须与账号认证分开，不能以dummy key或默认环境密钥解锁；目录请求不发用户凭据。
- 当时模型目录切片暂不直接引入整套coding-agent：ModelRuntime没有authContext注入口，会采用默认环境来源，其FileModelsStore/AuthStorage含同步IO。该切片沿现有Durable，供应商与auth复用pi-ai公开入口，远端目录小部件按MIT来源适配DCode自己的异步存储与接收校验。这是该切片的装配边界，不是禁止后续完整SDK接入；507随后确认的复用方向及仍需核验的宿主边界见下节。
- 官方刷新器会采用远端api/baseUrl/headers，默认parse仅查对象/id/type，DCode须保留本地认证、已支持协议与端点权威，仅接受安全信息字段。新增但不能确认现版本路由的模型可展示限制，不能把目录当授权或自动换模型。
- 多供应商凭据按真实Provider.id保存；旧custom密钥仍是custom/user-defined身份，协议openai-completions不等于OpenAI账户。SDK CredentialStore跨同一文件的RMW需串行合并；login返回的秘密凭据只保存到宿主，不透传界面。

公共源和官方代码核对材料保存在 `/Users/diwu/Workspace/Archives/dcode-provider-catalog-2026-10-09/`。获取这些公开数据没有读取用户凭据、授权真实账户或发送模型推理；当前新实现尚未验收。

## 完整 coding-agent 接入方向与组合验证

507 于 2026-10-09 确认的职责与复用基准已进入 [架构约定](架构约定.md#pi-coding-agent-能力复用基准)，本节只维护接口证据与技术验证范围。普通执行路径在 main `5a5ea29` 使用 Durable 循环及自定义供应商，尚未传入 CodingTools 注册，`cwd` 仍为应用数据下的 `work-dir`；受控演示的工具证据不能转用为普通编码路径完成。后续实现状态只读根 PROGRESS。

| 官方固定版本事实 | 接入含义 |
|---|---|
| [coding-agent SDK](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/sdk.md)提供`createAgentSession`、会话存储与资源加载，可不启动CLI／TUI | 以完整SDK为能力对照基准，先验证其公开注入边界，避免从低层模型API重新拼装全部上层功能 |
| [Durable](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)内置生成与工具任务循环，提供CodingTools及恢复机制 | 它不是只负责落盘的外挂，不能放在普通AgentSession外面就假定没有双重执行所有者 |
| [实验组合](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/experimental/durable/README.md)复用模型、认证、设置、系统提示与CodingTools，尚未覆盖普通扩展、提示模板、图片等 | 可作Durable装配对照，但不能当作普通coding-agent的完整替代已成立 |
| SDK不自动启用CLI的Codemode、Tool Search与MCP，官方提供显式扩展装配入口 | 核对注册、激活、会话启动和生命周期；不能仅因依赖已安装或资源已发现就宣称功能可用 |

最小验证在隔离目录完成，不替换main、不读取用户真实凭据或改动正在收口的模型候选。优先使用真实SDK配受控模型与实际隔离文件／命令；真实服务商验证另记，不从受控结果推断已通过。按同一项目夹具比较两条公开入口，先复用既有暂停和身份反例，不机械重跑全部UI测试：

1. **完整编码路径：** 普通AgentSession SDK完成项目AGENTS／技能发现、读改文件、命令失败回到模型、修正与再次测试、正式历史及结果读取；Durable组合使用相同目标对照，记录必须适配和暂不兼容项。UI消费与diff展示仍按开发任务规格单独验收。
2. **恢复与副作用：** 分别在模型请求、工具调用、等待后续步骤时暂停／关闭；重开查询不执行，明确继续才推进；旧恢复不覆盖新暂停，已产生副作用不盲目重做。普通abort、会话历史重开与Durable恢复的真实差异分别记录。
3. **资源与宿主装配：** 列出工具、AGENTS、skills、提示模板、普通扩展、Codemode／Tool Search／MCP、Pi Packages、压缩与重试的官方入口、当前覆盖和缺口；核对工作目录、凭据发现范围、异步宿主响应与扩展UI调用如何映射到D Code。使用最小本地资源夹具，不安装无关能力包；不能让命令行提问或终端渲染成为桌面操作的隐性前提。
4. **模型与产品约束：** 核对虚拟模型实际路由身份及状态保存，复用现有配置／凭据合同；指定模型、用户暂停和原输入身份不能被自动路由或恢复绕过。运行入口改变时，提供已有历史、接收回执和暂停记录的承接方案，不为试验清空开发数据。

交付应包含固定版本、实际命令和原始结果、能力对照、失败根因及推荐入口；要求、已实现、已验证与未覆盖分别列明。若两条路径不能同时满足已确认能力，应带证据指出具体冲突与代价，由507判断产品取舍，不静默放弃恢复或基础编码能力。未经组合验证与独立审查，不把候选写成主线替代方案。
