# 扩展图片消费者（2026-10-18）

本片有限OpenRouter图片消费者的实现与完整九门验证已完成，独立技术核对未发现剩余阻塞；本次实际结果补录已通过最后限定记录复核，Standards／Spec／CodeQuality三项均PASS、无本片阻塞。Root单写main，保既有修复与全部未提交改动；不提交、推送或发布。完整SDK与产品仍未完成。

按开发任务路径的原工具／typed准入／费用和暂停恢复要求，接入原受管OpenRouter `google/gemini-2.5-flash-image`／`openrouter-images`消费者；SDK原协议和认证，受控loopback仅提供远端响应，Worker、Durable、存储与图片解码均为真实路径。PNG/JPEG/WebP/GIF/BMP与动画容器的解码资产和线程取消另有定向证据，不冒称真实账户或全部图片API。规范和所有者时序见[开发任务路径](../../../spec/开发任务路径.md)与[架构约定](../../架构约定.md#扩展图片消费者响应核验与停机对账)。

首次窄路径success真实通过。随后组合定向25条中23绿、2红：两条换认证测试漏同步受控服务的新预期key，原图片HTTP0成立，但后续chat被fixture拒绝；已补受控服务setKey，不改产品准入或断言。后续11条中9绿、2红：真实响应已回、验证Worker online后暂停或直接关闭，停机对账先append再读owner，违反Durable表事务顺序；已改为先核全部owner与正式工具事实、最后统一append，两条原反例修后均通过。旧raw与隔离失败目录保留，不加timeout、不叫环境失败。

响应receipt先于图片核验保存，原SDKstopReason不可被本地取消改写。验证中断时只发布无图有限aborted、原费用按child恰一次；不能将未核图放入details或正式历史。只有真实SDKstop／usage／原responseId支持已确认typed事实，缺用量不补0。本地选项／类型／认证拒绝无图片HTTP。核验预算不是native内存沙箱，未持久提交前进程崩溃不保证内存回执恢复。

早期阶段取得24项真实runtime定向绿，含五格式／三个动画容器的公开解码、完整坏IDAT、MIME／容量与实际Worker退出，以及真实SDK成功／带费错误／空图／坏像素／无usage／认证变更／HTTP与核验资源在途生命周期。这批早期定向结果当时不能替代新边界、普通桌面及全门槛；后续完整结果见本页末，以上原始事实不升级为首次全量通过。


WIP独立预审指出两处P2；后续固定源限定复核已确认修复依据，且本次完整门槛均通过，历史反例继续保留。其一是原8MiB总JSON封套小于合法8MiB图片base64加1MiB文本；现区分raw容量、16MiB结果／工具封套与64MiB只读entries/context快照封套。近上限真实PNG加1MiB转义文本已真实到原SDK结果／Worker，原图进入正式工具、下一HTTP和只读历史，费用一次；原Durable过长工具文本的明确截断规则保留，不能将它误称丢图或为测试绕过。受控恢复旧8MiB结果封套的目标变异真实exit1，命中原SDK结果被改为error；第一轮修后资源state仍受16MiB封套、多处同图投影而在后续请求失败，改为正式64MiB后再核。该容量合同不改变原图数、raw或新请求输入边界。

第二处是验证线程真实exit、验证Promise已兑现后，pause／close可能在最终发布事务前先认领。旧固定WIP的两条精确post-exit交错均真实红，命中publishedToOwner仍为true；现在原事务内最后核worker／resource epoch／caller／owner和取消状态，doc读取／append前后均保较新停机优先，原两条修后绿。immutable原SDK stop回执不改写为服务取消；只发布无图aborted并恰一次保费。另有资源故障模型将固定Worker替为真实不响应线程，仅核原10秒预算和真实exit，不能当实际SDK解码或CPU/WASM性能证明。

首轮桌面8条中6通过、2条custom后续图片失败；当前custom元数据只核text，不能为图片消费者放宽它的能力。补完整前置为：同一原custom会话先完成一次普通输入，保持全局custom配置，认证保存／冷重开后在原会话由真实picker显式选已核image-input的preset，再发未来新输入；不重放原输入、不改全局custom配置。该路径也验证已打开client的认证同步和typed来源。旧六绿与两红继续保留；新路径随后已在定向及本次完整门槛通过，未放宽custom能力或产品准入。


新源定向r4（canonical206／e9a2f79c9b1a72818a530037d019364a4fc0aa3a4abb5ff2d3d28d5977b3b473）九个所选命令真实exit0，05:55:04–05:58:19 UTC，前后同源：架构正反32、源码检查、全类型／Lint／构建、定向runtime79／79、contracts14、图片普通隐藏桌面9／9、桌面入口检查。Lint保既有Timeline第233行warning，零error。该轮runtime与E2E均为定向范围，不能称全量九门。两条post-exit关闭反例、近容量上限及真正10秒资源故障模型均由本轮覆盖；普通custom冷重开与已开client新增认证两条也已实际通过。图像原像素8×6及当次nonce匹配、原始字节／下一HTTP／只读重开核对、任务用量112／15／缓存7／2／3次和custom前置后114／16／缓存7／2／4次均有公开facts与截图；Root实际查看了成功工具块、容量用量和两条custom只读或关闭用量截图。真实服务账户、人工接受和完整产品仍未验证。其后已在下述新固定源完成全范围runtime／完整E2E；定向79／9本身仍不是全量证据。


完整r1 runtime556／555通过／1失败、真实exit1，无skip／cancel，后续完整E2E及入口门未运行。唯一红是既有typed目录测试仍仅try/catch等待generateImages抛错；原资源事件无工具owner时，新消费者按有限error合同拒绝且未读model。只改测试为stopReason:error、output空、usage缺失、api/provider/model均空，额外核两类provider执行计数0和Harness模型任务0，未改产品准入或期限。第一次资产修订误要求尚未读取的model身份而继续红，随后按实际所有权边界修订并定向1／1真exit0；两轮原始raw保留。其后r2已在新固定源重跑全9门，不沿用失败r1为最终全量通过。


## 最终完整验证与独立范围

2026-10-18 06:13:25–06:34:08 UTC，固定canonical206／`02bb4e00ad35eb82fc9c30b7f00cc52c5156ce357a0d441e391669dd51fe30b0`完成完整九门，各子命令真实exit0、逐门及总前后同源：架构正反32、源码88、全类型／Lint／构建、runtime556／556、contracts14／14、完整隐藏E2E148／148、主目录desktop入口检查；所有测试无fail／skip／cancel。Lint仍为零error、一条既有Timeline警告。台账为 `/Users/diwu/.codex/visualizations/2026/10/03/01a1029e-4403-7333-b95f-7e54a70cb6e1/images-full-verify-20261018-r2/ledger.json`。

正式审查固定候选511项目文件与352份公开证据均逐hash保存于 `main-images-final-review-candidate-20261018-r3/manifest.json`，候选全门槛真实运行结果后附，不补造冻结前声明。Root实际查看了本轮成功图片／当次nonce工具块、带费malformed失败无图块、custom冷重开与动态认证的任务用量截图；七组普通before／只读after状态一致。独立审查已确认两P2、有限结果契约修订及完整门槛的技术依据；最后记录复核已完成，报告为 `/Users/diwu/.codex/visualizations/2026/10/03/01a1029e-4403-7333-b95f-7e54a70cb6e1/images-final-record-independent-review-20261018-r4.md`，SHA256 `05682d9e4594fd00fa777b2c7218a1027367bcda0165bd0910b8a7f2b9354bdf`。

本片范围仅原configured OpenRouter image消费者、同一Durable owner与真实SDK配受控HTTP、普通隐藏UI生命周期。正常桌面Home／设置／原生退出及重开可见证据承接[原生流记录](../扩展原生流-2026-10-18/README.md)，不冒称新真实账户请求或507人工接受。其他图片API／未接选项、所有动画帧全像素保证、native／WASM／操作系统内存沙箱、未持久提交前崩溃恢复、完整Pi SDK与整个产品继续未验；下一消费者为上下文用量和原Durable压缩相关公开接缝，不另建循环或升级SDK。


限定已验完整恢复点：`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-after-extension-images-accepted-20261018/manifest.json`。最后事实登记仅改文档，不改变206项canonical或声称新跑门槛；原full-r2绑定关系保持。完整SDK、真实账户及整个产品仍未接受。
