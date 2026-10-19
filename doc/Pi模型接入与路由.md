# Pi模型接入与路由

本页按目录装配、逐请求准入、路由选择及工具内消费者说明ModelRuntime合同；共享接收与对象边界在[架构页](架构约定.md)，Harness／资源的只读与关闭在[运行页](Pi运行与扩展.md)。各模型消费者沿同一会话canonical来源、正式owner和信号，不另建模型循环、历史或累计台账；具体消费者限制分别列明，不据有限接通声称全部API兼容。用户行为见[模型规格](../spec/模型选择与自动切换.md)及[用量规格](../spec/用量与账户额度.md)，版本／迁移与当前覆盖分别读[版本记录](Pi版本与升级.md)和[PROGRESS](../PROGRESS.md)。

## 预设、自定义与在线目录装配

目录装配沿现有[模型规格](../spec/模型选择与自动切换.md)，配置存在、认证有效、资料可用与真实请求成功分别判定；当前结果不在本页重复。职责分为：contracts有限请求／安全视图及接收校验；renderer明确动作；main装配safeStorage和受限认证浏览器；application拥有选择、接收／保存／关闭门控；Pi adapter分别唯一持有按Provider.id的CredentialStore与独立目录缓存；供应商SDK保原auth／stream。ProviderLoginController只管同一可取消登录身份、交互和收束，不接收工作或选模。

```mermaid
flowchart LR
    UI["模型设置：预设 / 自定义 / 来源与刷新 / 用户认证"] --> Bridge["有限契约与主进程接收校验"]
    Bridge --> App["application：选择和操作时序"]
    App --> Credential["Pi adapter：按Provider.id加密凭据，唯一提交者"]
    App --> Catalog["Pi adapter：异步目录/缓存，独立唯一写入者"]
    Catalog -->|"无用户凭据的公共GET"| Source["Pi官方模型信息源"]
    Source -->|"校验信息，缓存成功后发布"| Catalog
    Credential -->|"SDK正式CredentialStore"| Models["Pi Models：原供应商auth和stream，自定义仍独立"]
    Catalog -->|"安全资料，不改认证/未知端点"| Models
    App --> Exec["既有执行端口与Pi Durable"]
    Models --> Exec
    Exec -->|"执行事实与历史"| App
    Catalog -->|"只读目录与轻量修订"| UI
    Credential -->|"仅安全状态/交互，不返回凭据"| UI
```

在线接口优先沿Pi已发布的canonical provider目录，不在客户端重写models.dev全量供应商映射或直接import构建生成器。Builtin工厂与原auth/stream不变，目录只更新已验证的模型信息；请求API/目标由本地已接入实现和用户配置约束。不能直接给所有预设复用原single-custom credential reader。旧记录承接必须保留独立custom身份和加密内容；已保存的custom服务定义与当前选择分别维护，应用预设/重开仍可派生原custom安全表单与留用密钥条件。全部定义、凭据/选模的同一物理文件变更在唯一提交通路合并，防异步OAuth刷新丢其他供应商更新。影响执行中供应商的用户认证写入与选模使用相同的真实相位/接收/关闭门控；供应商认证代次必须在实际commit点拒绝旧流程，不仅在UI端忽略结果。未被使用的另一供应商可独立提交，SDK原请求自己的令牌刷新仍沿原有正式通路。

启动先异步恢复缓存并立即提供只读目录，网络检查随后进行；不在工作快照频繁复制全目录。目录来源/请求代次归目录服务持有，旧源的fetch、取消和关闭后结果不写新源缓存或发布。网络/接收/缓存错误保留有效资料及事实来源，不把目录异常映射成工作执行成功/失败。

```mermaid
sequenceDiagram
    participant UI as 设置界面
    participant App as 选择与接收协调
    participant Host as 宿主认证生命周期
    participant Cred as 加密配置/凭据唯一写入者
    participant Cat as 目录/缓存唯一写入者
    participant SDK as 已注册Pi供应商
    participant Port as 既有执行端口
    UI->>Cat: 读缓存/内置资料，随后检查线上
    Cat-->>UI: 可浏览目录，来源/时间可辨
    Cat->>Cat: 无凭据有界GET、完整校验、原子缓存、代次核对
    Cat-->>UI: 新目录或保留旧资料的失败反馈
    UI->>Host: 用户开始API密钥/账户授权
    Host->>Host: 首个await前登记唯一可取消登录身份
    Host->>App: 同步认领该供应商认证在途
    App->>Port: 核对接收/控制在途与真实相位
    alt 相位读取期间取消或关闭
        UI->>Host: 取消或离开认证界面
        Host->>Host: 中止该身份，等相位读取真正收束
        Host->>App: 释放认领，不启动SDK
    else 可继续认证
        Host->>SDK: 原供应商login与有限交互
        SDK->>Cred: modify提交点核对代次/目标/取消/关闭，再串行提交
        Cred-->>Host: 保存成立，秘密留在宿主
        Host-->>UI: 安全状态、下一交互或失败
        Host->>App: 真实收束后释放认领
    end
    UI->>App: 明确应用选择的模型
    App->>App: 登记保存在途，核对接收/控制/关闭
    App->>Port: 只读核对真实相位
    alt running / pausing 或读失败
        App-->>UI: 拒绝替换，不关端口/不改旧选择
    else 可安全提交
        App->>Port: 收束非活跃端口
        App->>App: 预构造候选接入
        App->>Cred: 原子提交选择/配置
        App-->>UI: 已应用，不伪称模型请求成功
    end
    Note over App,SDK: 提交前取消/关闭使旧流程失效；已提交后不伪报未保存
    Note over App,Cred: 未使用供应商可独立配置；同一文件提交仍全局串行
    Host->>App: 退出第一同步步认领关闭意图
    Host->>Host: 取消并等待所有登录阶段，目录同时关闭
    Host->>App: 最后保存并收束端口，不接受较晚的新操作
    alt 保存与收束成功
        App-->>Host: 真实完成
        Host->>Host: 正常退出
    else 保存或收束失败
        App-->>UI: 真实关闭错误，保留可读记录与关闭意图
        Host->>Host: 释放本次退出快门，不恢复新工作准入
        UI->>Host: 修复条件后再次明确退出
        Host->>App: 沿原flush重试并等待真实结果
    end
```

桌面退出与App收束分别持有本次在途结果：并发退出共等原flush，失败后App清掉失败promise，宿主也释放flushStarted，下一次明确退出才重试。关闭意图不回退，既有认证／目录收束不重复启动；修复权限后仍要求实际保存及进程正常出口，不把强杀或关闭错误确认算成功。

依赖／上游代码按实际使用登记，不为目录默认引入同步store、环境认证扫描或完整CLI。公开目录实时获取、受控HTTP、真实SDK、真实账户及用户视觉接受各有独立证据；仅页面或配置成立不代请求成功。

## 每次 SDK 请求的身份与采用目标

Generation计划及返回路由state由公开接口按原task／attempt／cutoff同事务保存；同准备点恢复只重读，不重新resolve或访问内部TaskRuntime。信号须绑同次请求，不能绑定的virtual请求拒绝、不退direct；hook签名按锁定版本及迁移核对。工具后继续取LiveDoc正式输入集合，不把工具结果或扩展user角色误认新外部输入；Compaction的completeSimple是独立direct消费者，不推进会话路由state。

请求／认证钩子不得改换已准入模型、输入历史、工具、思考参数或凭据；默认重试不增加。下文所有模型消费者共用本次采用与认证裁定，再核其类型／API特有条件，局部通过不代其他消费者验收。

每次物理请求按完整待发正文和本次模型已知的上下文／输出上限估算容量，沿 Pi `clampMaxTokensToContext` 收紧输出预算；不把模型最大输出量当作每次必须预留，也不用另一模型的旧 usage 缩小待发正文。容量不足走原 Durable overflow 失败通路，不发送超限探测，未知字段不补值。

请求发出前的虚拟失败不发布为物理来源或物理用量。Deferred 作业同存原调用身份和真正返回的物理句柄；await 期间改选后，poll／cancel 仍消费该次已存计划与实际句柄，不从旧 checkpoint 推断来源。各协议和来源是否支持该消费者，仍以其实际接入与运行证据为准。

```mermaid
sequenceDiagram
    participant User as 用户
    participant Durable as 同一 Durable Harness
    participant Hook as 本次 Generation hook
    participant Router as ModelRuntime 路由
    participant Store as 同一 Session 文档事务
    participant SDK as 物理 SDK 来源
    User->>Durable: 原正式输入（沿原 requestId 接收）
    Durable->>Hook: task / attempt / cutoff 与正式已放置输入
    Hook->>Router: user / continuation / retry＋已存 state
    Router-->>Hook: 物理目标、档位、新 state
    Hook->>Store: 重核选择与任务，同事务存 Plan＋State
    alt 未确认保存或目标已失效
        Store-->>Hook: 不采纳，不能发出模型请求
    else 保存已确认
        Hook-->>Durable: 同次调用信号绑定已存 Plan
        Durable->>SDK: 本次物理身份／认证／已核参数／容量
        SDK-->>Durable: 同次真实回复或工具调用
        Durable->>Durable: 正式工具结果与历史，仍由唯一循环推进
    end
    User->>Durable: 暂停／关闭
    Durable->>Durable: 取消并加入本地在途调用、保存准备点
    User->>Durable: 重开读取与查回执
    Durable-->>User: 只读现场，零路由／模型调用
    User->>Durable: 明确继续
    Durable->>Store: 读回同任务／attempt／cutoff 的 Plan
    Durable->>SDK: 复用已存计划，已完成工具不重做
```


应用层持有能力／认证／额度／暂停的准入裁定；适配器为每条真实端口装配独立模型客户端。后开的S2不改变S1，配置／认证／目录刷新同步已开和后续客户端的同一有效来源集合。

SDK 到达供应商包装时，原模型 A 的认证已解析。裁定采用 B 时，不能只替换模型对象后调用捕获的 A 方法，也不能把 A 的 `apiKey`／认证头／环境覆盖再次传给 SDK。适配器去掉这份已解析认证，保留原上下文、取消信号与一般参数，经同条会话 SDK 客户端重新解析 B 的供应商与认证；B 包装重新核完整准入并记录自己的真实响应。B 未登记、认证失败或条件已变时，本轮明确收束，不能回退 A、重投输入或重复工具。相同采用身份直接消费当前正式供应商请求。

采用目标同时携带该模型逐档核实的 `thinkingLevel`。Auto 重新采用 B 时，只有 B 本次能力资料仍支持的旧档位才保留；缺键或明确 `null` 都清除为来源默认，不把 SDK 的缺键默认或自行降档当产品核实。端口配置与本次 SDK 裁定消费同一值。请求包装覆盖已捕获的旧 `reasoning`，`null/off` 清除旧值，并在普通Generation／simple路径经SDK `streamSimple`的正式逐协议映射；受支持native stream保真正原生分派并另核参数等价；无准入装配时保留 SDK 原调用语义。不存在应用层手拼供应商思考字段或新增探针。

```mermaid
sequenceDiagram
    participant Run as 原会话执行循环
    participant SDK as 本会话 Pi 模型客户端
    participant Wrap as 供应商请求包装
    participant App as 应用准入唯一所有者
    participant Reg as 已登记模型集合
    participant Service as 受控或真实服务
    Run->>SDK: 下一请求 A（同一上下文与取消信号）
    SDK->>Wrap: 已解析 A 认证的请求
    Wrap->>App: 核本条会话／本次来源模型及全部条件
    App-->>Wrap: 拒绝或正式采用身份＋该模型已核档位
    alt 条件不成立
        Wrap-->>Run: 明确未发出，不重投输入
    else 仍采用 A
        Wrap->>Service: A 正式供应商请求（消费当次已核档位）
    else 改用 B
        Wrap->>Reg: 解析 B 精确模型
        Reg-->>Wrap: B 模型或不可解析
        Wrap->>SDK: 原上下文／信号，移除 A 认证并覆盖旧档位
        SDK->>Wrap: B 供应商与 B 认证重新解析
        Wrap->>App: 发起前复核当前 B 完整条件
        Wrap->>Service: 本次 B 实际请求（无 A 探针或补发）
    end
    Service-->>Run: 同次真实回复／错误，历史与身份保持
```

候选范围的“用户已保存过范围”标记与设置同份状态原子保存，清空后重开仍为空范围；保存失败保持旧正式事实。初始旧单模型可保兼容路径，但能力／额度／认证／相位均仍核实。设置和新会话默认值在首个异步校验前分别登记在途认领，真实关闭拒绝新动作并等待已认领的校验及写盘收束，不用较早保存的释放清掉后来者。各次已校验请求在应用层同一队列按顺序保存：前次结果真实收束后，用已成功提交的状态加本次字段生成完整快照。A 失败时，仅改主题的 B 不承接 A 的名单或默认；默认注册表与设置均在同次保存成功后发布。

## 模型选择与自动路由：所有者与事件顺序

用户行为见[模型选择与自动切换](../spec/模型选择与自动切换.md)及[工作输入区](../spec/页面与交互组件.md#工作输入区)，以下持有选择、能力、额度与裁定的独立归属。

四份事实各有唯一所有者，互不重叠：**设置里的新会话默认**与**每条会话自己的选择**是两份（`settings.newSessionModelChoice` 与 `SessionModelRegistry`）；**已核实的能力资料**归 Pi 内置目录（`PiCapabilityPort` 读 `Model.thinkingLevelMap`）；**额度事实**归 `QuotaPort`；**路由判定**是无状态的纯函数（`decideModelRouting`），不碰端口、不发请求、不写状态。`state.sessionModels` 只是持久化与快照的投影，每次使用前从注册表重取。

```mermaid
sequenceDiagram
    participant 用户
    participant 入口 as ModelEntry（两层入口）
    participant 桥 as preload 隔离桥
    participant 应用 as DCodeApplication
    participant 注册表 as SessionModelRegistry（唯一写入者）
    participant 目录 as ProviderCatalogService（既有目录）
    participant 能力 as PiCapabilityPort（逐档核实）
    participant 额度 as PiQuotaPort（额度事实）
    participant 判定 as decideModelRouting（纯函数）

    用户->>入口: 打开入口（只读，不执行工作）
    入口->>桥: listModelSources({ sessionId })
    桥->>应用: 经 dcode:op 正式通路（validateOperationInput 逐项核对）
    应用->>注册表: sourcesView()
    注册表->>目录: list()（复用既有目录，不新建第二份）
    目录-->>注册表: 来源[]（含凭据存在性，不读凭据正文）
    注册表->>能力: 逐个 read({sourceId, modelId})
    能力-->>注册表: 已核实档位 / 上下文 / 模态（未核实为 null）
    注册表-->>应用: 来源与模型条目（额度仍为 null = 未读）
    应用-->>入口: ModelSourcesView（过 isValidOpResponse）
    入口->>入口: 第一层：选择方式与实际采用分别呈现

    用户->>入口: 点名一个模型
    入口->>注册表: setChoice(sessionId, choice)
    注册表->>注册表: 选择版本 +1（改选不中断当前请求、不重投）
    注册表-->>入口: SessionModelState（actual 仍是上一个，未假装已切换）

    用户->>入口: 设定条件参数档位
    入口->>注册表: setThinkingLevel(sessionId, level)
    注册表->>能力: read（作用对象 = 本次会话要用的模型）
    能力-->>注册表: 逐档核实为支持的档位
    注册表->>注册表: 未核实的档位不写入，并如实给出原因

    用户->>入口: 读取额度（只读）
    入口->>额度: read({sourceId, modelId})
    额度-->>入口: unsupported / unknown / exhausted / available（无来源即 unsupported）

    Note over 注册表,判定: 判定顺序不可颠倒
    注册表->>判定: ① 按已核实能力筛适合候选
    注册表->>额度: ② 读有效额度（共享池与窗口分别识别）
    额度-->>注册表: 额度事实
    注册表->>判定: decideModelRouting(choice, requires, candidates, quota, workRunnable)
    判定-->>注册表: adopt / bounded-attempt / hold-*（附每次尝试的真实原因）
    注册表->>注册表: 改选或暂停期间发起的结果直接作废（选择版本比对）
    注册表-->>应用: 实际采用与最后请求结果**分别**可辨
```

判定边界：

- **能力先于额度**：先按VerifiedModelCapabilities.supports逐项筛已核适合者，再读有效额度；必需资料未核实的不进入候选。
- **耗尽与未知**：已知全部耗尽保工作等待明确继续，额度恢复、查询失败或转未知均不自动续跑。适合候选的额度未知才可有界尝试同一原工作请求，不探针、不重复输入／已完成工具；任一适合候选有有效耗尽依据时，未知候选不能把判定拉回有界尝试。
- **池与窗口**：按poolId识别共享池、窗口分别标识；池内一个窗口耗尽，不能采信另窗“可用”。available必须带updatedAt且reason为null，接收侧强制核来源。
- **事实与估算**：无可靠额度读取来源为unsupported，不伪报0或可用；字段缺失unknown、失败不补零，token／价格估算不推余额或冒充账单。认证、区域、池／窗口、单位及时效逐源核；不跨区试凭据，不把研究端点写成稳定接口。
- **逐档参数**：thinkingLevelMap字符串为已核支持、null为已核不支持、缺键为未核实并用来源默认；不能按名字猜档数，一档都未核出也须附真实说明。
- **失效重核**：能力读取后、额度读取后分别比选择版本；改选、暂停、目标／配置失效使旧结果作废，不能写状态或发请求。
- **指定范围**：只含点名模型，未知仅对它有界尝试；能力不足或耗尽保真实原因，不擅换备用或退Auto。
- **只读裁定**：readModelQuota和resolveSessionRouting不发送、不启执行、不解除暂停，读取事实不推进原工作。

### 真实请求怎么消费每会话选择、事实怎么回来

选择只影响**后续**请求：每次真实提交前按此刻的目标重新应用一次；chat实际采用与chat用量只由执行端观察到的真实chat助手事实发布；分类／图片用量按原child／action事实派生，不造responseId、不改chat actual，判定层永远不写 `actual`。

```mermaid
sequenceDiagram
    participant 用户
    participant 应用 as DCodeApplication
    participant 注册表 as SessionModelRegistry
    participant 端口 as ExecutionPort（Pi Durable）
    participant 会话 as PiExecutionSession
    participant 模型 as Pi Conversation（configure 正式通路）
    participant 提供方 as 受控/真实服务商

    用户->>应用: 发送输入（回执只说明是否被接收）
    应用->>端口: ensurePort({ model: effectiveTarget(sessionId) })
    端口->>会话: open（初始档位随会话选择）
    应用->>端口: read（只读；顺带投影真实条目）
    应用->>注册表: noteRequests(本批可核对请求 + 观测量)
    注册表->>注册表: 按 responseId 恰好一次入账；实际采用单调推进
    应用->>端口: applySessionModel(effectiveTarget) ← 此刻的选择
    端口->>会话: Conversation.configure({ model, thinkingLevel })
    会话->>模型: 正式换模型与条件参数（不 abort、不重投）
    模型->>提供方: 真实请求
    提供方-->>模型: 响应（含真实 provider/model/responseId/usage）
    提供方-->>模型: 响应头（额度观察，只读不另发请求）
    模型-->>会话: 助手条目（Pi 持久化）
    会话-->>端口: ExecutionView.entries（带真实归属与用量）
    端口-->>应用: applyView → publishRequestFacts
    应用->>注册表: noteRequests（新 responseId 入账，实际采用推进）
    应用->>应用: 置脏 → commit → 推送快照（用量必须推到界面）
    应用-->>用户: 实际采用、响应标识、用量、任务汇总分别可辨
```

观测发布边界：

- **提交回执不构成归属证据。** `accepted` 只说明输入被接收；用了哪个模型由助手条目里的 `provider`/`model`/`responseId` 决定。
- **条件参数走 configure 正式通路。** 应用层不拼 provider 原生参数；正在输出的那次请求不被改档，它自己的 `thinkingLevel` 记在该次条目上。
- **实际采用单调推进。** 取「已入账序列的最后一条」，不取「本次观测批次的最后一条」：重开或执行端换实例后视图可能只含更早的条目，按批次取会把归属回退成旧请求。
- **观测发布必须置脏重渲染。** 真实请求事实是界面要显示的事实；不置脏时界面会停在发布前那份快照上（用量已记录、入口仍显示「尚无记录」）。

## 工具内模型目录与请求

### 安全目录帧

CodingExtensions从本会话ModelRuntime发布安全chat／image／classifier描述、provider ID与显示名，Worker不使用未配置的默认Runtime，canonical模型及执行headers留宿主、不接受线程投影回写。

| 消费者 | 来源与边界 |
| --- | --- |
| 同步getAll/getAvailable/find、getModelsOfType/getModelOfType/findOfType及getProviderDisplayName/getRegisteredProviderIds | 读原请求帧并返回独立副本，provider只投影字符串，不含Provider对象、认证状态、配置或凭据。未接Provider／认证操作及Worker本地refresh明确拒绝。 |
| 异步getAvailableOfType | 在原事件／工具scope按actionId查原Runtime的认证与类型过滤；AbortSignal关联查询，owner关闭或取消则中止。不发模型请求、不建Durable任务或写入。 |
| classify／generateImages | 目录可读不开放执行，只支持下文已确认的有限消费者。下一原事件／工具重取帧，等待受原signal及资源代次约束。 |

```mermaid
sequenceDiagram
  participant Directory as 原客户端目录／认证发布
  participant Models as 会话ModelRuntime
  participant Bridge as 原CodingExtensions请求
  participant Extension as 资源线程ModelRegistry
  Directory->>Models: 登记模型／异步发布认证可用性
  Note over Models: 完整chat／typed目录与认证可用集合分别持有
  Bridge->>Models: getModels / getAvailableSnapshot / getModelsOfType / getProviders / getRegisteredProviderIds
  Models-->>Bridge: 原公开chat与typed描述、chat可用集合、provider ID与显示名
  Bridge->>Extension: 本次有限安全帧（不含Provider对象、凭据／执行headers）
  Extension->>Extension: getAll / getAvailable / find / *OfType / provider metadata同步副本
  Extension->>Bridge: getAvailableOfType(type, provider, actionId, signal)
  Bridge->>Models: 原Runtime认证与类型过滤（不发模型请求）
  Models-->>Bridge: typed available descriptors
  Bridge-->>Extension: 同scope、同actionId的可用结果
  opt signal取消／会话暂停或关闭
    Extension->>Bridge: cancel(actionId) 或 owner abort
    Bridge->>Models: 取消认证可用性查询
    Bridge-->>Extension: 取消收束；不写执行事实
  end
  opt 暂停或关闭取代等待
    Bridge->>Bridge: 按原signal／资源代次拒绝迟到发送
  end
```

### owned单次调用与共同费用事务

以下适用于complete、stream、classifier与image；各节只补协议、流或发布例外。

1. 原活动工具通过公开ToolExecutionApi.createTask建立`dcode.extension-model`子任务。Models／signal取该TaskRuntime，Worker只传有限身份／正文／选项，不持模型凭据或直连请求；资源／只读路由scope不能启动模型调用。
2. 请求前保存execute检查点；恢复到已进入请求处只保原结果未知、不重发。真实结果同事务保存task outcome与非模型投影请求事实，模型可见返回及工具usage归原工具，不造Generation／assistant或另一历史。
3. unsafe恢复／取消不调用SDK afterTool。旧Harness及资源全join后，目录claim内只用公开createSession对原存储作有限费用事务，不建scheduler／执行资源；明确继续前也可在原paused Harness对账，只读不维护。事务核真实child的owner／call及全部直接确认响应：SDK结果已同事务计账只记消费回执，否则向唯一UsageDoc.tools加未消费费用，以child ID记conversation回执。task终态会退役，不能靠task.accounted恢复。
4. 内层工具settle消费同回执，结果保完整usage，外层不重复累计。旧SDK取消／unsafe结果可缺usage，不能篡改旧entry或伪造结果补齐；请求事实与官方工具桶保真实费用。关闭到对账间意外退出窗口仍存在，下一次明确继续先对账，不声称与旧SDK结果原子；图像先响应后核验的额外认领／发布条件见图片节。

采用binding.ownedModel的streamSimple／native stream、classifier／image另核短命Routing认领：同Harness的task／conversation／owner、execute检查点、canonical ref及活跃signal。普通complete沿子任务runtime.models.complete与原signal直接调用并保存结果，不经过此认领；普通Generation已提交计划分支仍不变。

```mermaid
sequenceDiagram
  participant Extension as 实际扩展工具
  participant Owner as 原ToolTask
  participant Child as 同Harness单次模型任务
  participant SDK as 原Models与请求准入
  participant Host as 原会话停机收口
  Extension->>Owner: 有限身份／正文／选项
  Owner->>Child: createTask（原工具ownership）
  Child->>Child: 提交已进入请求检查点
  Child->>SDK: complete + 原子任务signal
  SDK-->>Child: 实际结果／失败
  Child->>Child: 同事务保存结果与请求事实
  Child-->>Owner: 原task outcome
  Owner-->>Extension: 实际返回值
  Extension-->>Owner: 原工具结果（真实usage）
  opt 暂停／关闭
    Owner->>Child: 原所有权取消与join
    Child->>SDK: 原signal取消
    Host->>Owner: 等待旧Harness与资源完全join
    Host->>Host: 原存储事务核已确认响应
    Host->>Host: 唯一UsageDoc + child消费回执
  end
```

### 流、Provider声明与virtual direct

Host按worker／scope／action／child及递增序号交真实非终态SDK事件，最终done／error随原task outcome提交后才交Worker公共流；partial不计正式累计。提前break不另启取消，result-only由同一Host调用drain。关闭先使scope失效、让本地流有限失败，再join原Host调用与execute；旧Worker／旧序号不得进入新流。

Worker 明确传 stream／streamSimple 模式，Host 校验后沿同一个模型子任务分派。原生流只由可信 Host 在短命认领内附带内部 Symbol 标记，Worker 的 JSON 不能伪造；标记在最终 provider 调用前移除。同一完整准入先裁定模型，再核原生协议与权威思考参数是否一致；当前支持的 openai-completions 选项原样交 SDK stream，不能用 simple 改写。跨 API、不等价思考、任意 samplingParams 覆盖及未接选项明确拒绝。same-API 改选保标记重分派并重新解析最终来源认证。未发出错误复用完整的未发出消息／零 Usage，原工具、费用对账和关闭不因错误消息缺字段失去收束。其余原生API单列未支持状态，按已确认产品消费者及本页能力复用基准选择后续适配，不由上游枚举自动派工。

```mermaid
sequenceDiagram
  participant E as 原扩展工具
  participant W as Worker公共流
  participant T as 原owned模型任务
  participant R as 同Harness Models
  E->>W: streamSimple／stream同步取流
  W->>T: 原scope/action单次请求
  T->>T: 保存execute intent
  T->>R: 明确task/ref/signal作用域
  R-->>T: 真实SDK partial
  T-->>W: 同child递增事件
  R-->>T: 真实终态消息
  T->>T: 同事务结果与费用事实
  T-->>W: 已提交outcome终态
  W-->>E: iterator与result收束
```

声明式Provider headers只适配现有受管来源，保原Runtime、身份、协议、端点、能力及stream／filter／认证策略；裸config登记不替准入或认证包装，也不表示任意config／native API兼容。

| 环节 | 必须保留的约束 |
| --- | --- |
| 登记与实际消费 | Runner交有限config及当前Worker句柄；Host核本会话原受管provider，再投影公开非凭据头到chat Model.headers。只写Provider.headers不足以让SDK请求消费。 |
| 认证撞名 | 原auth.resolve／toAuth返回值在SDK合入Model.headers前，与公开声明作大小写无关核对；动态私有头撞名即拒绝，不能从合并后值反猜认证头。 |
| 刷新与撤销 | 每会话捕获原provider及本代声明；可信来源同步后重投影。撤销／失败／close仅在Runtime仍是本代对象时恢复原值，外部替换令旧声明失效，旧清理不碰新对象。 |
| 请求与其他会话 | guard复核声明归属，失效明确失败；采用改选仍核registered身份／能力，从本会话getPhysicalModel取canonical投影并重解析最终认证。已开client逐个刷新，某会话撞名不截断其余会话目录同步，循环后再返回失败。 |

```mermaid
sequenceDiagram
  participant W as 原Worker工厂
  participant H as 本会话资源Host
  participant M as 原ModelRuntime
  participant P as 受管物理provider
  W->>H: registerProvider(id,有限headers,句柄)
  H->>M: 原受管对象的有限chat头投影
  H-->>W: 原目录安全快照
  M->>P: 首次/owned/后续请求沿原认证和完整准入
  opt 宿主可信来源刷新
    H->>M: 新受管源与本代公开头重新一致
  end
  W->>H: 撤销或关闭
  H->>M: 核本代对象后恢复原受管源
```

普通扩展virtual direct继续复用原Runner与ModelRuntime：`bindCore`第三参数接收真实定义，函数留在原Worker，只向Host发送有限定义和不透明句柄；Host在原资源事件scope确认登记，再发布公开目录帧。物理登记冲突由原ModelRuntime拒绝，不替换原provider包装。当前资源只持有自己的登记和原canonical对象引用；撤销、失败回滚与close均核本代身份，不能由旧同名清理删除新登记。

原owned模型child先保存execute intent，再经同一Routing短命认领进入ModelRuntime。direct resolve调用Host包装的原Worker回调，RPC只投影本次request（含真实messages、direct与思考档位），原signal映射本地controller；认证材料不进入线程。Host按原model child／signal、当前Worker和登记句柄在await前后核身份，再依provider/id从原Runtime解析physical对象；回调返回的Model端点、headers不参与物理执行。direct返回state不另写文档或推进既有Generation Plan/State。

route请求在原signal或资源关闭时发送abort、删除该pending并有限拒绝，迟到reply自然丢弃；它不加入工具execute的join集合。Worker的非协作route函数可被原资源最终关闭淘汰，不使原模型child与关闭互等；这不改变已有任意非协作工具execute的证据边界。此回调不拥有scheduler、输入队列、超时强杀策略或默认模型重试。route的ctx只读目录／cwd／session／signal继续走原Runner公开检查；route作用域不开放captured pi facade，在公开ExtensionRuntimeState.assertActive叠加本scope拒绝且先保留原stale检查。这样setActiveTools和registerTool都在写入前失败，不依赖事后refresh或手工回滚SDK map；正常工具scope不受影响；项目JS自行文件／网络不在[资源读取边界](Pi运行与扩展.md#项目扩展mcp-与原-durable-的接缝)的隔离承诺内，有限direct不等于完整virtual回调API。

```mermaid
sequenceDiagram
  participant W as 原Worker Runner
  participant H as 原资源Host
  participant T as 原owned模型child
  participant M as 原ModelRuntime
  participant P as canonical物理provider
  W->>H: 原资源scope登记定义与句柄
  H->>M: registerVirtualModel
  H-->>W: 已确认目录帧
  W->>T: 原工具streamSimple(virtual)
  T->>T: 保存execute intent
  T->>M: 原task/ref/signal认领
  M->>H: resolve direct回调
  H->>W: 本次request/局部signal
  W-->>H: 候选physical引用
  H-->>M: 重新解析canonical目标
  M->>P: 原认证与完整准入后HTTP
  opt route等待期间取消
    T->>H: 原signal取消
    H-->>T: 清pending并有限退出
    H->>W: abort；迟到reply失效
  end
```

## 分类与图片消费者

两类沿上述owned单次调用、检查点及费用事务；本节持有typed特有条件：

- 已配置来源的getAllModels保classifier／image；chat远端目录、picker与Auto只收chat。配置／认证刷新使用同一已配置来源集合，typed不另起凭据或通知链。
- 请求按当次typed身份、来源、相位、认证在途和额度准入，再只读派生认证、比本次prepared身份及来源代次／取消；不刷新OAuth或改旧key。它覆盖已识别的异步读取窗口，不是跨文件写入与网络dispatch的全局原子锁。
- 费用进原ToolExecutionResult及唯一UsageDoc；逐次事实按operation与原childTaskId／actionId request关联去重，不伪造responseId或写chat actual。子任务存在、本地拒绝都不能证明HTTP或计费；缺usage保持unknown。

### 扩展分类消费者的所有者与费用

classify的原state／questions不可被扩展Provider回调改写。只发布成功分类或带实际usage的错误／取消；工具结果仍可保原SDK usage缺席形状，不以发布事实补造调用。

```mermaid
sequenceDiagram
  participant Tool as 原扩展工具
  participant Host as CodingExtensions / Durable
  participant App as 应用准入
  participant SDK as 原预设分类SDK
  participant Store as 自管凭据与正式存储
  Tool->>Host: classify(canonical 引用, state/questions, signal)
  Host->>Store: 同一工具下保存模型子任务与执行检查点
  Host->>SDK: 原认证准备、原分类协议
  SDK->>App: 当次typed身份/来源/相位/认证在途/额度核对
  App-->>SDK: 精确身份放行或拒绝
  SDK->>Store: 只读重新派生认证并比对本次prepared身份
  Note over SDK,Store: 核对不刷新OAuth、不改写旧key；来源代次/取消再核
  SDK-->>Host: ClassifierResult（usage可缺席或在错误时存在）
  Host->>Store: 结果与原owner开销同事务保存
  Host-->>Tool: 原typed结果；无chat或伪responseId
  Store-->>App: 只读结果事实（原子任务身份）与普通任务用量
```

分类的RPC／child／HTTP随原owner取消并join；恢复遵守共同execute检查点，不能因查回结果而重发。

### 扩展图片消费者：响应、核验与停机对账

generateImages复用typed基线；`images-bridge`核原输入／有限结果与选项；`image-validation`在原调用拥有的固定外层Worker中使用SDK公开`resizeImage`真实解码，MIME容器和尺寸门在解码前成立，原字节／base64不变，SDK同步fallback不在主事件循环。容器检查对动画计画布及累计帧预算；公开helper的可解码结果不声称完整native内存隔离或已验证所有动画帧的像素。资源取消／预算到期只请求terminate，实际exit才兑现Promise；较新abort优先于已排队success。

费用的原child消费回执`ModelSpendAccounted`可选扩充有限`response`，只存原child／owner／conversation／action身份和原SDK metadata／usage，不存未验图。响应一到就在同进程Map认领并通过原Harness的公有Session.commit保存；`publishedToOwner`仅表示结果／usage已进入原工具消费来源，不等于官方累计已消费，`done`仍是唯一去重位。最终运行事务才发布可用图片及原ExtensionModelSpend；停机维护在原Harness和全部资源join后、释放目录认领前，保存旧Session无法提交的同进程回执并按原child一次消费UsageDoc。已记ToolResult只与published部分核和，response-only费用另按done消费；不覆盖旧工具结果或伪造child completed。事务先读完tasks／entries，再统一append，不能写表后读取表。

```mermaid
sequenceDiagram
  participant Tool as 原活动工具
  participant Child as 原Durable模型child
  participant SDK as 原图片SDK／HTTP
  participant Host as 同一CodingExtensions
  participant Store as 同一存储／UsageDoc
  participant Decode as 固定验证Worker
  Tool->>Child: generateImages原输入与signal
  Child->>Store: execute检查点
  Child->>SDK: 原认证／完整当次准入／单次HTTP
  SDK-->>Host: 原AssistantImages及可选usage
  Host->>Store: 先存无图response回执
  Host->>Decode: 固定代码、原bytes与有限容量
  alt 核验完成且原owner有效
    Decode-->>Host: 结果及真实exit
    Host->>Store: 安全typed结果／原工具spend／published
    Host-->>Tool: 原图片／文本与有限结果
    Tool->>Store: 原ToolResult及UsageDoc恰一次
  else 模型取消／原owner暂停或关闭
    Host->>Decode: 吊销结果、terminate并join真实exit
    Host->>Store: 原停机维护保存并消费response-only
    Note over Host,Store: 只读重开不维护；明确继续不重发未知请求
  end
```

原Session已封住或存储失败时，有限回执在同进程原调用持有；停机维护失败须阻止正常关闭与认领释放。崩溃前尚未持久提交的内存回执不承诺无损。坏图仍保真实费用，原responseId仅作核对材料；其余事实发布遵守本节typed去重规则。
