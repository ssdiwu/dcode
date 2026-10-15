# 普通入口搜索工具（2026-10-14 · 已验）

沿已验提示模板基本片 440 项目文件／160-a351 继续，增加公开 SDK grep／find／ls 的实际工具执行；扩展／MCP 仍在后续范围。修后444文件／163-bd710候选已完成必要门槛和限定独立三项PASS，保存为新的完整已验恢复点；旧未放行候选与失败仍保留原资格，不表示完整SDK或产品完成。

## 正式执行与边界

工具只在有任务文件访问依据的主会话装配；未有正式文件范围的成员不装配。名称、参数、匹配、无匹配与截断语义复用固定 Pi 1.0.0 包根公开工具，不移植内部实现。Durable 仍为唯一正式调用、工具结果、历史及恢复所有者。线程内执行 SDK 的同步探测及搜索子进程，显式使用应用工具目录和 offline；缺失二进制不自动下载或读宿主 Pi 缓存。查询根的真实路径先核任务范围；不由此证明全部 SDK／工具已受操作系统隔离。

工具收到原 callId、正式 cwd 与同一取消信号。取消交给 SDK 搜索器，宿主等实际线程退出才交回工具结果；已完成搜索不在只读重开或明确继续时重放。正式行为与时序见 spec/开发任务路径.md 和 doc/架构约定.md。

## 实际请求反例及初步绿

B 为 `/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd`。`Root-ordinary-search-actual-request-target-red-20261014` 真 exit1、1 测试／0 pass／1 fail、源前后相同。旧四工具生产实现收到实际 SDK 的 ls 意图后正式 isError 为 true，命中“正式 ls 不能返回未安装工具错误”，不是元素定位或启动失败。

新增三工具后 `Root-ordinary-search-first-sdk-green-20261014` 真 exit0、3/3，实际目录、文件名与命中正文经正式工具结果进入后续 HTTP；与原四工具1→修复0、diff及暂停／重开／继续路径共同通过，原工具身份没有重放。`Root-ordinary-search-first-typecheck-20261014` 类型检查真 exit0；构建记录 `Root-ordinary-search-first-hidden-build-20261014` 真 exit0。这些局部结果不代替最终完整门槛。

## 测试资产失败资格

`Root-ordinary-search-scope-cancellation-focused-20261014` 真 exit1、11 测试／10 pass／1 fail。唯一失败在新的取消夹具：错误读取 ExecutionView.status（不存在），而公开字段是 phase；该断言尚未抵达 pause 调用，不归为产品取消失败。已按公开契约更正为 phase，保留搜索在途、实际取消标记、原进程 PID 退出及暂停状态断言；未增加 timeout 或以标记单独证明退出。重核记录使用新根，不覆盖旧失败。

`Root-ordinary-search-correct-phase-focused-20261014` 真 exit0、11/11、源前后相同。实际搜索结果及后续 HTTP、目录外链接拒绝、无匹配与输出上限、无文件范围成员的三种真实搜索意图拒绝成立；原编码／模板与历史路径保持。取消用例使用应用自有受控 rg 子进程，核其真实启动 PID、在途正式 phase 可读、取消收到、暂停返回前该 PID 已退出及 phase=paused，没有只凭取消标记推定退出。

`Root-ordinary-search-hidden-three-paths-20261014` 真 exit0、3/3、23.629s、源前后相同，外部 lease 包裹原命令。原文字和模板完整路径保留，第三条追加搜索→读取／修改／测试1→修复0→diff→关闭重开只读→明确继续。界面真实展开三种搜索结果并逐项与正式结果比较原正文，展开不发新请求；重开及继续保存原工具条目身份，无完成工具重放。没有添加或放宽原 timeout／断言。

## 新完整门槛与独立待接收

`Root-ordinary-search-final-qualified-gates-20261014/ledger.json`：2026-10-14T03:20:44.764494+08:00 至 2026-10-14T03:27:05.614206+08:00，canonical162/df1a7b595b42dd1b91ad672296ca65d4be412cd0eb83297ee842013d8fe36211，八个实际子命令出口全为0，各门及总轮前后源码表一致。架构32／76源码、全类型／Lint／构建、runtime275/275、contracts10/10、完整隐藏 E2E100/100，无 fail/skip/cancel，E2E由外部 lease 包裹原命令。完整 raw、数值出口、起止及各门前后 hash 保留，不拿外层状态代替子出口。

新增调用线程、SDK实际参数／结果及自然退出、查询根范围、取消与成员拒绝、两个原桌面路径及新搜索路径交限定 Standards／Spec／CodeQuality 独立只读审查。复核接收前 main 停写；候选不替换上一已验恢复点。真实外部服务商、用户目录、人工接受、完整 SDK 与 Git 发布分别判定。

## 第一轮独立残余 R1 与当前修复

固定443文件／162-df1a 的第一轮报告 `Root-ordinary-search-final-independent-review-20261014.md`（13533字节，SHA-256 `27da1d74cb3dbb85ee05ee5d9366364a48edf9d1b8c96403aeff9889210914f1`）未放行，唯一必要残余是 SDK 的 pre-spawn await 期间取消窗。它仅确认该静态流程，原已启动后 PID 退出的正例保持，原八门绿不覆盖新的取消要求。

`search-pre-spawn.test.mjs` 复用实际生产调用线程及锁定 SDK，只有验证模块将 grep 的公开 isDirectory 操作、find 默认路径的精确 `.git` access 置于可观察等待；原 SDK 文件和参数不修改。原控制通道交付 abort，确认取消已到后再释放该等待，直接断言不得出现迟到子进程，最后等待自然线程出口。夹具的受控本地二进制将实际启动 PID 写入专用根；失败清理仅收回这份明确 PID，不留下验证活体。

前两根 `Root-ordinary-search-pre-spawn-window-target-red-20261014` 和 `Root-ordinary-search-pre-spawn-acknowledged-target-red-20261014` 各是1条 grep 目标红及1条 find 前置失败，均真exit1，不能写成两条业务红。find 前置闸比较了 macOS 临时路径别名，而生产先 realpath 成 `/private/…`，因此没命中实际 `.git` access；查过真实导出与路径消费者后按同一 canonical 根更正，没有放宽目标或 timeout。SDK cancelled 回复也可辨地证明取消已交付，不强等已经关闭的取证监听。

`Root-ordinary-search-pre-spawn-canonical-window-red-20261014` 真exit1、2条／0pass／2fail、无skip/cancel、源前后相同；两条都到达“取消已到、等待已释放却出现实际迟到进程”的目标断言。生产此时仅将原线程常量导出给验证，没有改变执行逻辑。修复在单次 Worker 的公开 Node spawn 端口核原信号，并从真正创建时认领取消；SDK 的 await 后不能再漏过，已创建者等待实际 close。主线程、SDK源码、权限及原执行循环未改，没有用 terminate、延时或删除等待阶段冒充收束。

`Root-ordinary-search-pre-spawn-and-started-pid-green-20261014` 真exit0、13/13、源前后相同，原两条反例的目标断言保持；同时包含原已启动 PID、范围／成员拒绝／匹配上限与普通编码、模板及恢复路径。第一轮报告和未批准候选保留原归属；新修复版本完整门槛与 R1 限定独立复核待接收。

首次修后门槛 `Root-ordinary-search-cancel-final-qualified-gates-20261014` 在163/494aa8ce…停止于 runtime：277条／276pass／1fail，原搜索修复路径第九次 HTTP 未在原8秒等待内到达；其余五门真0，但没有继续运行本轮契约／桌面门，不称新八门绿。该失败没有当作环境故障；先保留原等待与断言，并在失败分支补请求数、正式相位及有限工具身份诊断。

本调用线程仅运行固定SDK JavaScript，现在显式不继承父进程 execArgv 中不需要的 TypeScript／调试加载器；这只减少线程初始化，不改变SDK版本、账户／模型消费配置或业务等待。`Root-ordinary-search-native-worker-full-runtime-reverify-20261014` 全runtime277/277、真exit0、21.483s，原断言与8秒等待保留，源前后相同；它不回写成前一轮通过，也不单凭随后绿断言先前失败的唯一原因。最终新完整门槛与限定独立复核继续单独记录。

下一轮 `Root-ordinary-search-cancel-native-final-qualified-gates-20261014` 在163/a6f40c5d…取得前七门真0（runtime277/277、contracts10/10），但完整 E2E100条／99pass／1fail、真exit1：模板桌面路径在工具已完成帧直接断第六次请求，实际仍为5。正式工具结果提交先于下次 SDK 请求；这条用例原来只等工具数量，没有等实际 HTTP，不能用同帧元数据推定请求已到。现同一原 waitForSnapshot（30秒未改）同时等全部工具终态及实际完整请求计数，计数／正文／真实工具／diff／重开／继续断言保留。旧失败仍为失败，不提前归为整片通过；新完整复验另记。

`Root-ordinary-search-cancel-arrived-final-qualified-gates-20261014` 在163/c93c1876…取得前七门真0，完整E2E100条／98pass／2fail、真exit1。C01第三输入的正式快照已到，但一次rAF后界面仍显示“发送中”；普通文字路径的候选框实际点击后，Playwright check 立即核选中而正式保存尚未发布。两条失败均保留，不能算完整通过。测试现在等待三个原文与运行徽标实际渲染后直接断原按钮行为；候选框使用真实click，核正式保存及DOM选中，不改变产品、放宽原业务断言或增加原等待期限。

`Root-ordinary-search-rendered-preconditions-focused-20261014` 真exit0、6/6、38.710s，包含完整C01/T08与文字／模板／搜索桌面路径。取证输出因本次环境键写成 `DCODE_E2E_EVIDENCE_ROOT`，未使用外部动作根；这些用例没有动作文件输出，完整raw及源hash仍在专用检查根，不回写历史证据。`Root-search-ABA-current-precondition-target-red-20261014` 使用原隔离“按同文清除在途”变体的明确 `out/main/index.js` 启动入口，仅换为当前C01夹具前置；真exit1、1条目标红、1.401s，实际命中“第一次A迟到不得清第三次A守卫”（发送≠暂停），未在启动或新前置失败。原生产对象身份守卫未改，当前前置仍能判别原故障。

本次只改两个E2E资产。相应全范围Lint与完整隐藏E2E重跑；前一轮架构、类型、构建、runtime与contracts按实际消费者源码hash继承资格，分别保留原起止与出口，不声称它们在新全局SHA重跑。新门槛、固定完整候选及R1限定独立复核待接收。

`Root-ordinary-search-rendered-final-consumer-qualified-gates-20261014/ledger.json`：2026-10-14T04:34:25.027807+08:00 至04:40:54.821789+08:00，canonical163/bd71012f821c6e960103eb00ca6e9356e3f0910af4cdc63fc0c588aca8e5991a。新Lint真0，完整隐藏E2E100/100真0、fail/skip/cancel0（实际373584.758ms TAP／命令379.577s）；逐新门和总轮前后同源。六份前轮数值出口0记录按完全相同的消费者源码承接：架构正反32及源码76、类型、构建、runtime277/277、contracts10/10。台账逐项列原起止、未改hash与为何不消费本次两个E2E资产；它们仍属于原163/c93c1876…身份，没有补造新运行出口。未批准新固定副本位于 `main-search-tools-cancel-final-review-candidate-20261014`；先前未送审副本的起始时刻登记误写已在新副本更正，原报告与162/df1a候选继续保留，独立接收仍待完成。

## 最终限定接收及恢复点

独立报告 `Root-ordinary-search-cancel-final-independent-review-20261014.md` 为13288字节，SHA-256 `b84a2ba048e6a9ab95db62cc1dff5865e5569a52efa52d3adea8cfc750e4d5c9`。Standards／Spec／CodeQuality三项PASS，R1关闭，无本片必要剩余。独立核444项目文件、480公开证据、canonical163/bd710及九改四增零删全部吻合；两条实际SDK目标红／13绿、真实spawn与close／自然线程出口及两项桌面前置判别均接收。六旧门的消费者字节承接与新Lint／全E2E100绿资格已明确接收，未把它们伪写为同一全局SHA下八门重跑。

完整已验恢复副本：`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-after-ordinary-search-tools-accepted-20261014/manifest.json`，444项目文件／canonical163-bd710。受审后仅根README、PROGRESS和本记录登记接收结论；产品、测试与配置字节完全相同，没有重复已绿检查。旧模板恢复点、第一轮162/df1a报告、三份修后实际失败及误登记起始时刻的未送审副本均保留，未转为PASS或覆盖历史。

本次通过只覆盖公开grep/find/ls、任务查询根、取消真实收束、正式结果／下一HTTP及原编码／桌面／恢复路径。完整扩展／MCP生命周期、真实外部账户、用户真实项目、人工接受与整个产品仍分别待验，没有提交、推送或发布。
