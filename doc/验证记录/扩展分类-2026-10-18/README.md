# 扩展分类消费者（2026-10-18）

本片已完成修后完整九门，并经独立Standards／Spec／CodeQuality三项PASS、无必要阻塞问题，已接收为有限分类消费者基线；完整Pi SDK与整个产品均未完成。接续已接收的原生stream完整恢复点，保留此前全部修复与未提交改动；Root单写main，无提交、推送或发布。

## 需求与改动

按[开发任务路径](../../../spec/开发任务路径.md)与[架构约定](../../架构约定.md#扩展分类消费者的所有者与费用)，普通项目扩展在原活动工具内调用`ctx.modelRegistry.classify`，保持原`ClassifierResult`。原预设在普通装配中曾被chat集合裁掉typed条目，Worker也明确拒绝主动分类；现保已配置来源的原typed目录，并由原工具认领同一Durable模型子任务。远端chat目录、聊天picker与Auto仍只接chat，扩展不能选择另一个端点或认证。

当次SDK请求核原会话相位、typed模型、来源配置、认证在途与额度，再只读确认已准备认证在等待期间未变。核对用原SDK认证派生，拒绝刷新/写盘；同一API key和有效OpenRouter OAuth均支持，不做账户类型豁免。它只覆盖该异步窗口，不声称跨外部进程和网络dispatch的全局原子性。

成功及带真实usage的错误结果按原子任务身份保存和去重；ClassifierResult没有服务商responseId，不能造chat消息或假响应编号。费用仍由原工具与唯一UsageDoc持有，桌面从既有逐次请求事实派生用量；缺usage保持未知，不补零。分类不覆盖chat actual或当前选择，概率不作为行动授权。

## 已取得的定向证据

真实Pi 1.0.0 SDK、普通受管OpenRouter预设、隔离加密凭据、真实Worker/Durable/正式JSONL存储及loopback System One服务组成验证路径。服务端仅控制远端响应，非模拟SDK、工具或持久化。原问题与state逐字核HTTP，choice/score/bool由原SDK协议解析；不把TypeSafe API未发送的temperature称为已发参数。

定向runtime覆盖成功、带费用坏答案、无usage、独立模型signal取消而原owner仍活、真实HTTP在途暂停/关闭、只读重开零请求、明确继续原子任务收口不重发。API key/OAuth准入窗口换认证为零分类HTTP，回调改state/questions在HTTP前有限拒绝；额外TypeSafe来源只有classifier、chat集合为空时仍执行原`jev-latest`分类且不改变外层聊天模型。先前聊天消费者37/37保持绿。正式完整计数及源码资格以最终台账为准，以上定向绿不替整片验收。

普通Electron七条路径已在修后全量中通过：设置认证、真实目录选择、扩展开启零执行、工具正文与任务用量实际渲染、正常退出/只读重开、custom冷重开保预设typed来源、已打开客户端新增认证、以及暂停/关闭和明确继续。隐藏窗口不抢焦点；PNG只证实际渲染，不代507人工接受。

## 原失败与证据边界

首轮桌面在验证装配的临时目录守卫前失败：macOS真实目录是`/private/var`，工装边界写成`/var`。统一真实临时根后继续，未放宽产品守卫。次轮工装把现有“预设供应商”页签写成“预设”，未到模型业务断言；修正locator，原30秒断言保留。认证换key的首次测试仅更新store却未同步受控服务下一外层请求的预期key，原分类HTTP0成立但外层被fixture拒绝；已修fixture的期望，原失败保留。校验测试曾用错误SDK导出入口及漏给provider实现，均在请求前失败并按真实公共入口修复。

桌面r3中，custom路径还发现显式隔离端点覆盖未传到额外typed来源：实际原SDK向内建端点发出请求并得到401，该结果不算loopback或真实账户验收。请求仅携带本轮生成的隔离假key；没有使用真实账户凭据。已修custom后端端点覆盖透传，并在本片runtime/桌面fixture加入仅本地传输校验；正常产品端点规则未改。随后用实际本地请求重验。r3的错误结果/恢复断言还误用不存在的`error`状态和“继续”文案，按现有`failed`/“继续执行”修工装而不改产品。r4在真实正常退出后才重新调用Playwright的`app.process()`，句柄已失效；现于启动时保存原ChildProcess，退出后核其实际exitCode，不重认领已销毁句柄。以上原失败均保留。

原始定向日志保留`/tmp/classifier-*-20261018-*.log`，安全副本另存外部`classifier-focused-history-20261018`；缺失的历史逐子出口不补造。修后完整门槛见下节，独立Standards/Spec/CodeQuality及已验恢复点在实际收口后登记。

第一轮正式完整门槛的前七门均真实exit0（runtime524、contracts14），但完整隐藏E2E为139条中138通过、1失败：既有预设／目录／自定义协同路径的首次冷重开前，正常关闭在原15秒期限内没有真实退出。原raw、逐门台账和关闭阶段记录保留于外部`classifier-full-verify-20261018-r1`及对应隔离UI证据根，不把强制回收当正常关闭。后续仅对生成产物插入有限阶段事件的目标诊断1/1和完整诊断139/139均未再现；完整诊断实际捕获目录换源IPC尾与port.close交错且最终退出，不能据此断言原超时根因或称环境问题。插桩结束后已核生成产物逐字恢复；两轮诊断均不作为正式门槛绿，原超时仍记“未复现、根因未定”。

独立审查随后发现Worker在有限错误保护外读取模型对象属性。原代码在真实普通扩展工具中被accessor反例证伪为同步throw（真实exit1）；已把模型／选项限定为普通own-data，拒绝Proxy，并在错误元数据和signal清理中使用已核身份与原生信号接口。七组accessor／Proxy／伪造signal反例不调用其属性读取器、均返回有限错误、零分类HTTP和零Durable模型子任务；分类／认证／typed回归共17条真实通过。该源码修复后须用新冻结身份重新跑完整九门，不能复用旧源码的七门绿；最终独立三项仍待新证据。

第二次独立核对确认，前次own-data修复的普通对象逐键赋值会静默丢掉自有`__proto__`字符串选项，宿主就无法拒绝这个未知字段。新反例在该代码上实际发出分类HTTP并返回`stop`，与应为有限错误的断言相冲突（真实exit1）；现按宿主同一允许集在复制前拒绝未知键。八组边界反例均有限错误、零分类HTTP／零child，相关17条重新通过。`classifier-full-verify-20261018-r3`的前七门在该修复前同源通过（runtime525、contracts14），但候选因这个新发现已作废；其E2E lease wrapper在尚未派生测试子进程、UI尚未启动时由Root明确取消，实际信号出口-15和所有权核对另存，不能叫E2E产品失败、完整绿或新版本门槛。修后另起独立证据根重新完整验证，旧两处反例及全部修订过程保留。

## 修后完整门槛与候选

正式完整门槛在2026-10-18 04:40:42–04:56:52 UTC运行，准确cwd为本主目录，canonical为198项／`b75c0fbb61a19ec9855b2f40e71e392d966990d04273e38edbe7f68256f9a1a5`。九个子命令均真实exit0，各门及整轮前后源码同源；完整raw、每门argv／起止／数值出口与前后身份保存于外部`classifier-full-verify-20261018-r4/ledger.json`，E2E使用既定外部lease包裹原命令。

| 门槛 | 结果 |
| --- | --- |
| 架构正反／源码 | 32条通过／86源码文件通过 |
| 全类型／Lint／构建 | 均exit0；Lint无错误，保留既有Timeline effect的1个warning |
| 完整runtime／contracts | 525/525／14/14，无fail／skip／cancel |
| 完整隐藏Electron E2E | 139/139，无fail／skip／cancel；普通分类七场景包含其中 |
| 主目录桌面入口检查 | `tools/launch-desktop.py --check`真实exit0 |

原关闭失败场景在本轮无插桩全量中通过：首次关闭76ms真实退出，后续58／45／41ms正常退出，重复旧句柄0ms消费已有退出事实；没有强制回收。原首次15秒失败仍按“后续完整复验未再现、根因未定”保留，不把本轮绿称为已定位修复或环境问题。

原E2E的before-close/readonly-reopen截图目标误选了模型搜索框父节点，不能支撑用量像素证据；DOM数值断言本身成立。另以外部测试副本仅调整import路径与截图目标，原main代码／断言／期限不变，在同一198/b75c身份下补跑一个真实成功、关闭与只读重开场景，真实exit0、前后同源。Root目视两张实际用量段落PNG均清晰显示“输入121／输出15／3次请求”，原工具正文PNG与同请求nonce也可辨。补充回执为`classifier-usage-pixel-supplement-20261018-r1/receipt.json`；它是补充像素证据，不替代全量或人工接受。

正常可见桌面入口的Home／设置／原生退出／重开已在本次解锁续接的前片通过限定独立复核，沿[原生流记录](../扩展原生流-2026-10-18/README.md)回查。本片未改变窗口布局／桌面启动器；上述隐藏分类验证不冒称新的前台人工接受。最终固定r5候选为502项目文件／198-b75c，261份公开证据全hash独立吻合；独立Standards／Spec／CodeQuality三项均PASS、无剩余阻塞。报告见[最终独立审查](</Users/diwu/.codex/visualizations/2026/10/03/01a1029e-4403-7333-b95f-7e54a70cb6e1/B2/classifier-independent-review-20261018-r2.md>)。包含本次纯事实记录的完整恢复点为`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-after-extension-classifier-accepted-20261018/manifest.json`，与正式九门canonical源码完全相同；恢复点的新文档hash不冒称重跑。

## 未覆盖

本片先验同一`typesafe-system-one`协议：OpenRouter内建`typesafe/jev-1.13`普通桌面消费者，以及额外TypeSafe仅classifier来源`jev-latest`的真实SDK消费者。其他分类API、全部typed来源/模型、自定义协议、generateImages及其真实图片正文、完整provider/virtual、压缩/事件/命令UI等仍保父范围。真实外部服务商账户、用户项目、人工视觉接受、Git交付与整个产品各自成立，不由受控HTTP或单片通过替代。
