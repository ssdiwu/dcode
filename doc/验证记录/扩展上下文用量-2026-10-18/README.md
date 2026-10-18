# 普通扩展上下文用量

2026-10-18，Root在主目录保留图片已验修复后继续完整Pi SDK范围。本片已完成完整九门，runtime581／contracts14／完整隐藏E2E149全部通过，固定源经Standards／Spec／CodeQuality三项独立PASS、无本片剩余阻塞，已限定接收。完整已验恢复点为`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-after-extension-context-usage-accepted-20261018/manifest.json`；图片已验基线继续保留，未用本片替代完整SDK或整个产品。

## 实现与要求

现行行为见[开发任务路径](../../../spec/开发任务路径.md)，状态所有者和时序见[架构约定](../../架构约定.md#扩展上下文用量原正式上下文与完整状态帧)。Host从原有效ContextView和同tail全部原条目派生SDK估算，绑定原物理chat模型；Worker同步返回最新完整接收帧的有限新对象。前后模型变化、窗口未知、无适用usage、压缩后null及真实0分别处理。unknown清旧数字，旧帧不能回滚新模型，也不丢原合法operation。暂停／关闭、只读重开和明确继续沿原Durable，不另建执行或接收队列。

## 当前定向证据与原失败

外部证据根`/Users/diwu/.codex/visualizations/2026/10/03/01a1029e-4403-7333-b95f-7e54a70cb6e1`简称B2；这些定向结果不替最终源码的完整门槛。

- `context-usage-old-placeholder-red-20261018-r1/receipt.json`：旧placeholder为undefined，普通2例均到同步返回目标断言真实失败，前后源码一致、实际exit1。
- 首轮新用量19而原断言2：Durable在未完成工具处合成17 token协议占位；实现曾错误计入。现只排除不在正式contributions中的合成对象，相同正文正式ToolResult仍计入；原2→3断言未改。
- 普通客户端后续1失败来自测试把newest-first存储扫描当作旧→新顺序，修夹具为按正式EntryId排序，不改生产规则；`/tmp/context-usage-ordinary-20261018-r3.log`真实2/2、exit0，包含pause/direct-close两条路径。
- `/tmp/context-usage-pure-20261018-r1.log`真实18/18、exit0；公开MemoryStorage／Harness始终paused，无task／submission／模型／认证调用，不证明压缩执行。
- Worker受控帧前几次失败分别为临时路径realpath前置和`.mjs`未显式登记；修测试前置，不升级为产品业务红。`/tmp/context-usage-worker-frames-20261018-r4.log`真实2/2、exit0。它使用实际Worker／Runner但合成wire帧，不冒称Durable实际请求。
- `context-usage-old-order-mutation-20261018-r2/receipt.json`恢复旧的无序覆盖谓词，实际2例目标红、exit1：模型B回滚A，以及新unknown回滚旧known；是受控谓词变异，不是字节相同的完整旧Worker。r1在项目外SDK包解析失败，保留且不算目标红。两轮主源码前后均未变。

- `context-usage-focused-ui-20261018-r1/ledger.json`：build和桌面一例（内部pause／close两条）真实exit0、211/5af0de逐门前后同源。实际设置／绑定／启用、两次工具正文和下一HTTP、正常退出／只读重开／继续不重放均到断言；Root已核真实工具正文截图。此后仅增加结构化UI事实保存与既有Worker夹具新关联字段，最终完整门槛须覆盖新身份。
- 预审提醒的模型引用风险由`context-usage-model-alias-red-20261018-r1/receipt.json`核成真实目标红：项目扩展突变`ctx.model`导致同帧模型和窗口污染。现Context getter返回有限模型metadata副本，保持统计帧私有；原断言不变。修后结果待下方完整门槛登记。
- `/tmp/context-usage-focused-runtime-20261018-r1.log`真实103/103、exit0（模型副本修复前）；包括原MCP／命令／会话名称／资源发现等回归。期间只增加后续模型副本反例的测试资产，不将该轮当最终源码资格，最终全量另核。

- 固定r1（517/211-959157）独立代码预审发现P2：旧context操作在丢弃其迟到state后，会把新帧全局messages当原请求正文。`context-usage-late-context-red-20261018-r1/receipt.json`已真实命中handler和Host回包同时用错nonce的目标红，模型B／usage11仍保持，不能靠回滚统计或丢操作过关。现Host把当次正文放operation value，Worker独立消费，保持原64MiB正文封套上限；getter仍读新帧。修后4项协议＋2项普通客户端真实exit0、211项源码前后同源（`context-usage-late-context-green-20261018-r1/receipt.json`）。随后仅移除已无消费者的state.messages副本；新完整门槛另核。
- 首轮完整台账`context-usage-full-verify-20261018-r1/ledger.json`前七门真实0（runtime579／contracts14），211/959157逐门同源；因独立必要P2，在进入旧候选UI前由Root持有外部lease，仅对尚无任何子进程、阻塞等锁的本轮wrapper发SIGTERM，真实出口-15。该轮没有启动E2E，launcher未跑，不是产品E2E失败，不冒称完整九门通过；精确父子PID与无子进程采样见`context-usage-stop-before-obsolete-ui-20261018-r2.json`。r1初次只读识别因解释器路径不同未认领、未发信号，同样保留。

- r2预审另提醒原scope按value摘要。已核原Durable request checkpoint会重入beforeRequest；`context-usage-legacy-event-scope-20261018-r1/receipt.json`在真实普通SDK／HTTP消费者通过后，实际Host请求scope兼容性断言真实exit1，确认传参迁移已改身份。重复副作用是该静态恢复风险，不冒称已跑出旧版本持久重放双写。现context摘要保持原`{}`，独立payload仍携正文，输入／轮次／attempt身份照旧；新普通测试观察生产者原scope，原生命周期覆盖继续保留。新增测试首轮误用不存在的view.status等待，实际回执已经完成但前置超时，保原日志；改用同文件已验lookupReceipt.processing判据后真实1/1、exit0，不将此夹具失败叫产品失败。
- r2前七门真实0（runtime580／contracts14），211/6540c3逐门同源；因上述兼容问题，同样在无子进程的等锁wrapper处收束、真实-15，无E2E启动或launcher检查。精确采样见`context-usage-stop-before-obsolete-ui-20261018-r3.json`。r3将按修后身份完成全门槛。

## 最终门槛与独立收口

`context-usage-full-verify-20261018-r3/ledger.json`记录九个实际子命令均exit0：架构正反32／源码89、全类型、Lint、构建、runtime581／contracts14／完整隐藏E2E149、正常launcher预检。2026-10-18T07:35:49.235815+00:00至2026-10-18T07:55:23.109755+00:00，canonical211／`12f1ee1412d39ebd82c7e7dfb1157ad3521a954fd376a3061f97699e1fbb0bc9`逐门及总前后同源；runtime／contracts／E2E均无fail／skip／cancel。Lint仍只有既有Timeline一条warning、0error。E2E沿外部lease包裹原命令，无前台焦点／真实用户profile／付费产品模型探针。

原runtime579／580两轮不冒称最终源绿；它们在旧候选待修时停于无子进程的UI wrapper，未启动UI。最终r3才完成全量UI和launcher，不覆盖原中断／失败台账。

最终桌面原配置／绑定／启用、工具两次用量2→3、安全副本与紧邻下一HTTP、暂停／直接关闭／正常退出、只读重开零加载零HTTP以及明确继续保原工具ID／正文均通过。`context-usage-final-ui-inspection-20261018-r3.json`记录Root实际读过的工具正文截图与两个nonce事实文件，正常ChildProcess exit0、每场景原工具执行2次／总HTTP4次；这些是受控SDK／HTTP与隐藏UI，不是服务商实测或507人工接受。

最后五份事实记录文档在全量之后按实际结果更新，源码／测试／配置canonical不变；不声称这些后改文字在原门槛前已存在。固定r4的517项目文件／382公开证据已由独立审查者逐hash全核；Standards／Spec／CodeQuality三项PASS、无本片剩余阻塞，报告为[最终独立审查](</Users/diwu/.codex/visualizations/2026/10/03/01a1029e-4403-7333-b95f-7e54a70cb6e1/context-usage-final-independent-review-20261018-r4.md>)，SHA-256 `9684ade748884b3cdce4a89736963624a9bf0d867a863951604ac217664203de`。审查只读固定副本／公开证据，未读活main或重跑测试。

## 父范围与未覆盖

执行压缩、`session_before_compact`／成功失败事件、真实placement回执与付费响应关闭窗口、threshold／overflow及其余SDK消费者仍待实施与验收。外部7项公开原语实验只证明MemoryStorage／原Harness与本地模拟Models的admission、decline／custom、busy placement及close／abort／Hook重入边界，没有HTTP／认证／桌面或产品实现，不替本片或压缩消费者通过。真实服务商账户与507人工接受另验；正常可见桌面入口已在原生流记录核验。参考卡片仅保外部材料，没有据示意数字添加分类、预留或产品UI。

独立通过后只把上述五份事实文档中的待复核状态改为实际限定接收，并登记报告／恢复点；产品、测试、配置和全部canonical仍为211/12f1ee，不伪称这些后改接收文字被早先检查重新执行。本片独立接收当时没有提交／推送／发布；随后已验范围按持续授权实际本地保存，见[2026-10-19本地提交](本地提交-2026-10-19.md)，仍未推送／tag／release。
