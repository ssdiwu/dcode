# 扩展工具内单次主动模型

2026-10-15。本complete子片已完成最终独立Standards／Spec／CodeQuality三项接收；此前普通扩展/MCP、资源集合及同步chat目录已验恢复点保持。基准为`main-after-extension-model-catalog-accepted-20261015/manifest.json`，460项目/175-ad50，142证据及纯登记独立确认已收齐。

当前最小路径是原扩展ToolTask scope通过createTask创建同Harness owned单次任务，TaskRuntime.models.complete使用原canonical模型、signal、原provider准入。执行前保存execute检查点，完成时原task outcome及非模型投影的请求事实条目保存实际SDK结果；工具返回值进入原外层下一HTTP，不生成新Generation、输入或会话assistant。同步目录、安全投影与既有资源/暂停边界保持。

正常原工具结果承接其真实直接模型usage，SDK ToolTask按公开ToolExecutionResult.usage记工具桶。已完成响应的工具throw／畸形返回／畸形结果回调，也从原owner的确认事实保实际usage。SDK unsafe恢复与取消不走afterTool；原会话完全停止旧调度后，使用公开createSession在同一认领目录作一次费用收口，无scheduler、无资源代码、无模型请求。conversation回执仅记录哪些真实child已消费，累计数只有UsageDoc；回执与补计同事务。正常SDK结果usage须等于该owner全部直接确认响应，不是看非空就认账。task doc终态退役，恢复事实以原child outcome和正式条目为准。取消的原SDK工具条目未必带usage，不修改旧条目；已确认费用仍入其原工具桶。关闭到对账之间异常退出不伪称原子，明确继续先收口；只读重开不对账。DCode已有额外的独立内层ToolResult正式记录；嵌套工具实际模型消费归该内层工具，用同事务公有UsageDoc.tools只记一次，外层不重计。原Pi AgentSession只在外层recorder附usage而不另存内层正式ToolResult，桶位置不同不冒称透明等价。应用从真实响应事实投影provider/model/responseId/usage，按原responseId规则计量与去重，不靠计划或选模推算。未知结果仍未知，无terminal usage不证明真实服务商零费用。

所有模型请求、取消、关闭和恢复都由原任务所有权持有；资源线程的modelPending只索引当前RPC收束，不是第二执行队列。只在原execute返回处join原请求，provider回调不能等待它自己正准备的模型请求。完成的或已进入执行且结果未知的内层请求在只读重开/同输入回查/明确继续后不盲重发。

当前接通complete普通有限JSON/text路径。无真实tool owner、函数回调、认证/headers/env改写、非零provider重试等尚未接的选项明确拒绝，不静默忽略；streamSimple direct绑定、provider/virtual、typed、完整事件/消息/压缩/命令/exec/vision等仍属未完父目标，不因该API方法现能调用就称完整SDK兼容。

## 实际失败与复验

证据均在B=`/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd`，每个唯一目录都有原argv、完整raw、数值exit和所列源前后hash；组件只有耗时，无绝对起止不补造：

- Root-active-complete-target-red-r1-20261015：一条实际工具已经完成，但内层HTTP为0不等于预期1，真exit1，无超时或skip/cancel。
- Root-active-complete-target-r2-20261015：complete真实HTTP/130token用量和在途close两条2/2真0，原Task/child/submission/callId及重开/明确继续不重发保持。
- Root-active-usage-projection-red-r3-20261015：真实SDK结果事实projection缺responseId、应用任务用量请求2不等于3，两条明确业务红，真exit1。
- Root-active-usage-projection-green-r4-20261015：名称沿原准备但结果是真exit1、9条7pass2fail。Root把模型Promise误加入全局actions，provider回调flush等待自身，两个原8秒等待超时；不是环境或额度失败，不放宽timeout。
- Root-active-usage-projection-green-r5-20261015：改per-tool收束和sealed scope后，相同两份完整文件9/9真0，原body/用量/身份断言保持。
- Root-active-pause-close-green-r6-20261015：增加complete在途pause，相关两份完整文件10/10真0，未知结果不发成功正文/usage，原身份继续且内层HTTP仍一次。

未await／嵌套两资产已实际运行，r7为5条4pass1fail，真实内层HTTP已到但嵌套正式结果缺失；根因为Chord事务草稿不支持Object.defineProperty，改其支持的记录赋值后r8为5/5真0。r9在固定176/1cc2旧产品副本只换新测试资产，四条响应后throw／畸形返回／畸形回调／嵌套throw均真exit1；r10同资产修后4/4真0。r11在当时main命中四条已确认130但工具等待后pause/close的工具桶0≠130；r12原20条完整两文件全部真0，包含直接与嵌套及重开不加账。r13桌面实际执行后check_run的最终rename与证据输出目录冲突，临时raw被工具清理、独立childexit未保留，不能资格化结果，保独立事故记录；r14分开运行记录及动作证据重新验证。完整门槛、隐藏桌面新消费者和独立审查未完成；当前不作该片PASS。没有真实账户、用户项目、前台UI、Pi升级、Git提交推送发布或其他后续阶段。


第一轮完整门槛固定176/3028：前五门真0，runtime最终363条360pass3fail/skipcancel0，真exit1、前后同源；后二门未跑。三条失败按终态raw准确为#149技能8s未到、#185串行输入close读到sidecar损坏、#230普通搜索用例8s未到。遗留TCP监听在该文件测试正文停止后经fresh driver→npm→runner→exact测试child链仅SIGTERM该owned PID收束；信号是独立清理事实，不归为第三条失败。早期WIP记录将第三fail归信号的分类已被独立复核更正，原版本保留回查；不把外层1当原每条出口或抹掉失败。原串行输入及另外在途诊断有直接打开live JSONL的既有工装写风险，公开open会recover/truncate，现统一只读自有副本；副本不是原子数据库快照，原断言保留。dispose无论session.close是否失败都关闭本fixture真实server，失败数据保留。串行夹具的目录watch回调还加一次settle及捕获原signal，防止排队readFile回调在ctx过期后继续取signal；这属于直接源码风险，不冒称已证明是旧错误唯一根因。r16两条1pass1fail，技能原路径2.6s通过但串行资源线程错误；r17临时monitor诊断单条通过、没有取得uncaught记录，不能叫原因已证，临时monitor已移除。两条旧8s失败原因仍未独立定案，原期限不加，最后新完整门槛必须真实通过。


第二轮176/28f6完整门槛前五门真0，runtime363/362pass1fail/skipcancel0，真exit1，后两门未跑；唯一失败是transform输入用例复制在途目录时，SDK的doc-2.jsonl.reclaim临时文件在lstat前已消失（ENOENT），不是模型业务断言失败。此次原技能8s、原串行输入及所有主动complete场景均通过，没有再人工终止进程；这不证明首轮技能超时唯一原因已定。只读测试副本改为读正式main/doc/task JSONL字节并核连续两读一致后落自有副本，再沿SDK公开open验证；只在文件集合/字节变化或暂时ENOENT时重新取样，副本确认损坏和全部业务断言仍直接失败，不重开原live目录。原8s等待函数、用例timeout及业务数字断言保持。


r18原ordinary-extension-mcp完整文件64/64真0、原业务断言／timeout不变，副本读取、串行输入与资源实际清理未见再失败。固定R2的限定复核另确认一个P2恢复遗漏：只读实例close也无条件作费用维护。r19沿真实SDK确认响应后toolhold的正式JSONL字节复制为恢复夹具（不编辑任何entry/task/用量、不宣称OS崩溃试验），命中RO close后官方工具桶130≠0的精确业务红。原目录认领先关闭，恢复副本用不同自有目录/正常凭据配置；只读没有新HTTP。修法仅限制本实例实际enabled后才作停机维护；pause在清enabled之前维护，纯RO关闭不消费，明确continue在原paused Harness继续消费。新反例还核连续两次只读关闭仍为待对账0，明确继续后真实130恰一次且内层HTTP不重发；不拿整个目录字节不变作断言，原Binding.paused等关闭事实独立保留。


r20修后两完整文件21/21真0，真实恢复夹具连续两次RO关闭工具桶保持未消费0，明确continue后130一次且同child/call/submission、不再发inner。独立源核同时提醒：pause维护失败不得先清enabled，否则后续close失去重试资格。r21公有PiSessionOptions接缝用实际请求取消／原Session停机并注入一次维护拒绝，命中close仅维护1次≠2的业务红；修法将清enabled移至暂停收口成功之后，原故障认领语义保持。此注入验证维护重试边界，不冒充另一笔真实模型费用反例；真实费用依据仍是r19/r20。


r22三份完整文件32/32真0：原会话保存/回查/暂停/恢复/故障及新维护重试、14条主动模型与7条任务用量相连验证。最终完整门槛和限定独立复核仍未完成。


最终R3完整门槛以176/0d6f4426b14b278404c1ae2bd09f81d689b5e0e6c57291de4fe8568250c503ba冻结源码运行：八个实际子命令均数值exit0，架构正反32、架构源码检查、全范围类型/Lint/构建、runtime365/365、contracts13/13、完整隐藏E2E108/108，fail/skip/cancel0；每门及总前后源码一致，完整raw和绝对起止/各真实出口见B/Root-active-full-gates-r3-20261015/ledger.json。桌面原扩展/MCP启用、在途pause/close、只读重开、明确继续及新增active complete正文与实际任务用量均包含本次完整E2E。R3限定独立源/定向复核确认只读close与维护失败重试两项已闭，首轮第三失败分类也已按原raw更正。该全量完成事实经固定R4最终独立三项资格确认；本complete子片已接收，完整SDK/整产品仍未完成。


最终独立报告：B/Root-active-complete-final-independent-review-20261015.md。完整已验恢复副本为`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-after-extension-active-complete-accepted-20261015/manifest.json`，保相同176/0d6f产品、测试和配置字节；只更新结论记录，没有再宣称重跑同字节检查。后续streamSimple、provider/virtual、typed等仍须逐片实现/必要验证及独立审查，父目标保持未完成。
