# 扩展工具内的单次流式模型

当前状态：固定179/0791版本的完整门槛及Standards／Spec／CodeQuality独立三项均已通过，本片已接收。原complete基线和旧失败继续保留；本结论不声明完整SDK或整个产品通过。

## 范围与实现

同一普通项目扩展工具内的 `ctx.modelRegistry.streamSimple` 同步返回公开流；真实 SDK partial 在最终响应前进入原扩展。单次模型调用仍是原 Harness、原 ToolTask 的模型子任务；Routing 明确认领 task／conversation／owner／execute intent／canonical 模型及活跃 signal，不给未绑定调用直接请求的豁免。最终 done／error 在正式子任务结果与费用事务完成后才交给 Worker。

只取 `result()` 或提前 break 不额外请求或取消原 owner；合法预取消信号返回有限错误流，独立 model signal 取消不误取消原工具。暂停／关闭使原调用取消并 join；只读重开、原 operation 查回、明确继续不盲重放结果未知的 inner 请求。已有 complete 的确认费用、错误后费用与恢复对账路径保留。

桌面运行输出来自 SDK 公开 `LiveDoc.tools` 的有界已提交投影。适配器核同一 run 的活 ToolTask，应用只保留非持久临时显示；正式结果取代它，暂停／关闭／重开不复活“执行中”。它不成为另一份正式历史、输入队列或计量事实。

## 原失败与定向证据

证据根为 `/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd`，各轮独立目录保留完整 stdout／stderr／真实子出口及选定源前后 hash。

| 轮次 | 实际结果与资格 |
|---|---|
| `Root-stream-actual-partial-target-red-r1-20261015` | 原实现实际到工具后没有真实 text_delta，目标业务失败；不以 unsupported 或工具错误替代流消费者。 |
| `Root-stream-combined-owned-runtime-r5-20261015` | 32/32、真 exit0：13 条 owned 认领边界及原14 complete＋5 stream。包括真实 final-held、result-only、break、partial 后 pause／close 和不重放。只归属当轮源。 |
| `Root-stream-native-lease-identity-red-r6-20261015` | 保留的 MiniMax 原 R3 产码在同13条为6pass／7fail；实际 reasoning 丢失、登记身份与重入反例失败，非编译错误。Root另写正式认领实现；不把候选作者自检当独立验收。 |
| `Root-stream-existing-lifecycle-regression-r7-20261015` | Root遗漏外层时长参数，被默认60秒杀停，exit-9／timedOut；仅验证未完成，不叫产品失败或通过。产品timeout未改。 |
| `Root-stream-current-typecheck-r8-20261015` | 新测试的 TaskId 泛型过窄，typecheck2；按正式接口作类型修正，r10真0。 |
| `Root-stream-existing-lifecycle-regression-r9-20261015` | MCP／session／usage／原Durable routing组合96/96，真exit0，163.861秒，四实现前后同源；新桌面投影改动另验。 |
| `Root-stream-desktop-target-r12-20261015` | 三桌面场景实际3fail，真exit1：运行工具增量未投影。扩展已收到增量不等于桌面可见。 |
| `Root-stream-model-signal-r14-20261015` | 资产尚未冻结时SHA守卫拒绝应用，随后无匹配业务场景的文件壳退出0；不计为取消场景通过。最终资产后由r16实际运行两例。 |
| `Root-stream-model-signal-r16-20261015` | 合法pre-abort和独立model取消两条真0；HTTP分别0／同请求1且实际关闭，原工具仍running后正常结束；只读重开／继续不重发。 |
| `Root-stream-desktop-target-r17-20261015` | 修只读投影后3/3、真exit0、22.483秒：普通设置／绑定／启用零执行；final前真实nonce partial可见；成功120 input／15 output／3 requests；partial后pause或直接close、RO重开及Resume不重发inner。 |
| `Root-stream-progress-guards-red-r21-20261015` / `green-r22` | 公开受控ExecutionPort的原4例由2pass2fail到4/4真0：临时不入任何save／usage／正式历史、正式结果替换、暂停／ready清理、旧观测／已淘汰实例／低控制版本拒绝，以及坏项不吞同批合法项。它不是实际Pi实例轮转复现。 |
| `Root-stream-full-gates-r1-20261015` | 固定178/9bb6前五门真0，完整runtime389中388pass1fail／真exit1／无skipcancel，逐门与总前后同源；driver因此未跑contracts及全E2E。唯一红在原complete恢复夹具的非原子marker发布，读到空JSON，尚未到业务断言；r23改同目录tmp＋rename后原恢复用例真0，不吞坏JSON、不改断言或timeout。 |
| `Root-stream-session-observer-red-r24-20261015` / `green-r25` | 独立指出的真实Session观察等待窗：在原R1完整验证副本加同一新例，原源178项全hash吻合，真exit1命中“旧running携pause新revision1而非原0”；Root把相位取样移至最后await后并按新相位筛掉增量，同例真exit0，原等待工具由pause实际取消并join。 |
| `Root-stream-full-gates-r2-20261015` | 固定179/890772的架构／类型三门真0，Lint在新增观察测试cleanup的三处prefer-const报1，driver按真失败停止，未跑后四门；Root只改测试持有变量的声明／清理引用，原断言与15秒timeout不动，r27全Lint复验真0。 |

R17普通Electron／IPC、真实SDK配loopback模型和实际stdio MCP，窗口全程隐藏、未聚焦、不可聚焦。截图已查看：partial正文含本次nonce及“执行中”；直接关闭后的只读窗口仅显示暂停／明确继续，没有旧运行工具块。自动截图不是507人工接受，也不证明真实外部服务商账户或用户目录。

R24／R25沿真实PiExecutionSession、原Harness、实际defineTool／api.output及JSONL。通过既有公开`attachExecution`有限包装原`Harness.snapshot(LiveDoc)`的返回Promise来扣住观察，不手造Task／LiveState，不用私有cache／unload；并经原Storage公开接口核真实记录。固定SDK会缓存LiveDoc，此证据不声称每次读取都发生磁盘冷读，也不声称已复现真实桌面相同负载。

关闭证据限于本片实际接入、响应取消的SDK／MCP／owned HTTP与Task。Worker先关闭真实运输再join原execute／模型调用，避免提前terminate丢消费者收尾；若任意项目execute完全忽略signal且永不返回，这个join可能一直等待，不能把普通协作路径通过写成全部扩展关闭有界。旧实现未join时该角落可能由随后terminate结束，两版在此不宣称等价；本片没有新增超时／强杀政策，承接原[非协作工具证据边界](../../Pi-1.0.0-虚拟模型与运行恢复.md)。

## 稳定门槛与独立审查

最终固定源码身份、八门真实出口／起止／前后同源、完整运行及隐藏动作端到端已登记于本页最终门槛段；最终Standards／Spec／CodeQuality独立三项已在[完整报告](独立审查.md)收口为限定PASS，无本片必要剩余。r11四文件固定WIP预审只核当时源，不能当最终正式PASS；桌面投影、合法取消及其后修复均属于最终受审范围。

## 剩余父范围

完整 coding-agent＋Durable 父目标继续：provider／virtual 注册、typed 模型、完整消息与压缩、sendUserMessage 组合、命令、SDK exec／renderer及实际vision全文消费者等按现行规格逐项接入。已有普通扩展／MCP、资源集合、目录和complete修复继续保留，不因本片成功削掉父范围。


最终完整门槛：固定179/0791a86b11ec7838483a3d1006e3f56afd27f59be227b22f85bf99bd14038bf9，八个子命令真exit0；架构正反32／源码82、全类型／Lint／构建、runtime390/390、contracts14/14、完整隐藏E2E111/111，无fail/skip/cancel。每门及总前后同源，绝对起止及每子出口见B/Root-stream-full-gates-r3-20261015/ledger.json。R21受控端口原4例2pass2fail命中旧实例复活和坏项丢合法项；R22同4例真0，兼核高observation不能倒退revision。公开快照及订阅可见partial，任一次save都不落pi-progress／临时正文，正式结果替换；这些是受控端口合同对抗，不冒称真实Pi轮转。最终记录只承接相同产品／测试／配置字节，Standards／Spec／CodeQuality独立三项限定PASS，不外推完整SDK或整个产品。

完整已验恢复点：`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-after-extension-streamSimple-accepted-20261015/manifest.json`。产品／测试／配置完整179项与最终R5及八门源逐字一致；验收登记、报告副本及导航为纯记录更新，没有冒称其后重新运行检查。本地提交及远端状态按实际Git回执另行记录。

本片已按既有授权本地提交为`b2d589a7ab1f463bbd3c2b20f0409f1bf6af6288`，24路径；实际身份、精确暂存及未推送边界见[本地提交记录](本地提交-2026-10-15.md)。验收登记另有[纯记录独立确认](记录确认.md)，没有因登记或Git操作重复已经通过的产品检查。
