# 扩展关闭事件原因与收束

## 范围

本片补齐 Pi 1.0.0 普通 ExtensionAPI `session_shutdown.reason` 和关闭回调的 Durable 收束顺序，不新增桌面操作、输入、历史所有者或执行器。D Code 的活动资源替换使用 `reload`；暂停会关闭旧 Worker，以便同一 Durable 会话之后明确继续，使用 `resume`；最终关闭会话／桌面 owner 使用 `quit`。SDK 原生 `new`／`fork` 会话切换由 D Code 明确不支持，不伪造相应事件。

关闭回调在唯一 Worker／Runner 中执行。专用关闭作用域只接受原 Durable owner 的 entry、message、name、label 记录；新的正式输入、模型调用、工具或 MCP 操作会被拒绝。Worker 先把 `session_shutdown` 回调和这些受限记录收束完，向 Host 返回 `shutdown-flushed`；Host 在同一暂停／关闭流程中先持久化暂停事实，再关闭 Harness，并同时让 Worker 继续取消／join 原在途工作和实际子进程。只读重开不会运行关闭事件；明确继续不重放已完成的输入、工具或关闭动作。

## 目标红灯与中间尝试

测试先加了资源重载、暂停与最终关闭三个实际生命周期断言，再运行项目登记的 Runtime 入口：

```sh
node --import tsx --test --test-name-pattern=session_shutdown test/runtime/ordinary-extension-mcp.test.mjs
```

修复前真实 exit 1；`B/Root-extension-session-shutdown-reason-project-entry-red-20261016/` 的两个目标用例分别读不到资源替换应写的 `reload` 和暂停应写的 `resume` 事件。修改前的 Worker 只发 `{ type: 'session_shutdown' }`，SDK 要求的原因字段缺失。该次测试只增加目标断言，产品源码前后不变；准确入口使用 `--import tsx`，另一次漏掉此项目 loader 的直接 Node 尝试只作为运行入口准备错误保留，不计产品红灯。

修复期间曾尝试等待资源 Worker 完全关闭后再关闭 Harness。全量 Runtime 当时 483 项中 479 pass、4 项因 30 秒既有期限取消，真实 exit 1；主动模型 complete 与 partial stream 的暂停／关闭用例仍需要 Harness 同时取消在途任务。该次失败在 `B/Root-extension-session-shutdown-reason-full-gates-r1-20261016/runtime/` 保留，未放宽期限或断言。最终实现改用关闭阶段回执：先确认扩展关闭回调写入已结束，再让 Harness 取消／join 在途任务，同时继续等待 Worker 的实际清理。

## 修复后的实际观察

新增 Runtime 场景经同一普通客户端、真实 Pi Worker、Durable 会话和本地受控 HTTP 端口执行：

1. 会话先由 v1 扩展启动；资源正文变化时，旧 Worker 收到 `session_shutdown(reload)`，受限扩展记录写入原历史，然后 v2 Worker 按既有 `session_start(reload)` 路径启动。
2. 用户暂停时，旧 Worker 收到 `session_shutdown(resume)`。D Code 写入原暂停事实后关闭 Harness；同一会话只读重开保持 paused，读取不会再触发扩展代码或模型请求。
3. 用户明确继续后原会话恢复，没有重放已完成输入。最终关闭时，当前 Worker 收到 `session_shutdown(quit)`，事件再次沿同一历史写入；关闭后的只读重开不重发 HTTP 或重复事件。

第一固定候选的独立审查发现：若 shutdown 回调排入一个被拒绝的新输入和一个允许的元数据写入，`Promise.all` 会提前拒绝；原 close 分支随后仍发 `shutdown-flushed`，并跳过 transport、活动调用／模型等待和自有子进程收束。该报告只把这是可达的控制流问题列为发现，没有把具体泄漏写成已观测事实；报告为 `B/Root-coding-session-shutdown-reason-r1-independent-review-20261016.md`，第一候选不予放行。

r2 独立复核确认另一条同范围竞态：普通工具请求的 `finally` 仍调用 `flush()`；它与关闭侧共用全局动作数组时，可能先取走 shutdown 动作。被拒绝的 user promise 让普通 `Promise.all` 短路，关闭侧随后看见空队列，可能在名称变化派生回调完成前交出 barrier。复核报告为 `B/Root-coding-session-shutdown-reason-r2-independent-review-20261016.md`，r2 同样不予放行。r2 固定副本实际包含此前 full-gates-r3 子目录 19 个文件（ledger、16 份 stdout/stderr、两份源码图）；与原始 B 逐文件 hash 一致。r2 报告中“候选只收 ledger”的证据范围描述不符实物，纠正回执见 `B/Root-extension-session-shutdown-reason-r2-review-evidence-and-path-correction-20261016.json`。

已改为按 invocation scope 跟踪待完成动作，不让一个工具请求的普通 `flush()` 取走另一个关闭作用域的动作。普通同 scope flush 即使先遇到拒绝，也在 shutdown scope 关闭期间保留该批，供专用 `Promise.allSettled` drain 收束；新批次／派生动作继续由同一 scope drain 纳入。它保留首个失败；关闭事件错误不再越过真实 transport 关闭、已有 execute／modelPending join、自有子进程终止／close 等待和 Runner 失效；资源清理完后仍把原关闭失败作为回执返回。正常事件继续保留既有 fail-fast `flush()`，关闭作用域仍拒绝新输入、模型、工具和 MCP 操作。

新测试把工作子进程从正常 `session_start` 创建并等到真实 ready，再在同一次 shutdown 回调中请求一次被拒绝的新输入和一条允许的 `appendEntry`。旧 r1 产品字节加此反例，在隔离副本中真实 exit 1，命中缺失的 SIGTERM 清理标记；修复后这个直接失败分支通过。

第二个并发测试让普通工具实际在执行时关闭原会话；shutdown 同批拒绝新输入并提交会触发 `session_info_changed` 的会话名称更新，派生元数据处理被测试 gate 挂起。r2 固定源码加该场景后，工具请求的普通 flush 抢走 shutdown scope 动作，close 在 gate 放行前 resolve，目标 exit 1。按 scope 追踪动作后，shutdown close 在 gate 前保持待定；放行后派生 `appendEntry` 写入原 Durable 会话，close 最终仍因被拒绝的新输入报告失败。两个失败都没有新增用户输入或额外 HTTP。该反例的旧源红灯见 `B/Root-extension-session-shutdown-reason-scope-red-r2/`；最终三个 shutdown 场景定向 3/3、exit 0 见 `B/Root-extension-session-shutdown-reason-scope-green-r3/`。

## 完整门槛

最终八门原始输出、逐门真实 exit 和完整前后 source map 在 `B/Root-extension-session-shutdown-reason-full-gates-r5-20261016/`。八门均为 exit 0：架构正反 32/32、源码架构检查 83 项、TypeScript、Lint、构建、Runtime 484/484、契约 14/14、隐藏桌面 E2E 125/125；无 fail／skip／cancel。189 项 canonical aggregate `189c5c21b2a3a8e99e183684002292ad35fde3a57a6da45cfdfed882ca3570e1` 在八门与全轮前后保持一致。Lint 为 0 error、1 项既有 `Timeline.tsx` warning。隐藏 E2E 通过 `dcode-e2e-lease.py` 对原始 `npm run test:e2e` 命令串行运行。r1 的 `evidence/desktop-launcher-check/` 只记录在主工作树调用 `python3 tools/launch-desktop.py --check`，未记录 `.command` 或 npm 包装入口。最终 r5 Runtime 的 `test/runtime/desktop-entry.test.mjs` 在临时假项目、假 HOME 和假 Electron 下，分别验证 Python launcher、复制的 `启动 D Code.command --check` 和 `npm run desktop -- --check` 的透传；同时断言不构建、不启动 Electron、不创建 `launch.lock` 应用状态锁。本轮没有改启动脚本，最终 Runtime 与完整隐藏 E2E 均在当前源码身份上重跑。r1/r2 的完整门槛和失败仍保留为历史，不用新结果覆盖。

507 附的主进程截图显示 `ERR_IMPORT_ATTRIBUTE_MISSING`，错误路径指向独立的 `Root-D1-ABA-by-text-target-mutation-20261013.json` 变异夹具。历史核对记录确认它是产品 bootstrap 前的受控变异载入错误，不是正常 `.command` 主应用导入；同名夹具后来改为 `-record.json` 保存。此记录也明确：启动早于测试 profile 隔离的边界未验证，默认 Application Support 目录没有被检查或删除。截图因此不能当作桌面入口正常启动的证据，也不改变本片固定入口 `--check` 与隐藏 E2E 的结果；边界回执见 `B/Root-D1-controlled-ABA-startup-containment-20261013.json`。

## 独立收口与边界

本片已独立收口。固定候选 `main-extension-session-shutdown-reason-candidate-20261016-r6/manifest.json`（491 个项目文件、82 份登记证据、189 项 canonical `189c5c21b2a3a8e99e183684002292ad35fde3a57a6da45cfdfed882ca3570e1`）经 `model_integration_review` 对 Standards／Spec／CodeQuality 三项限定复核均 PASS，无本片必要剩余；报告为 `B/Root-coding-session-shutdown-reason-r6-independent-review-20261016.md`，SHA-256 `d1a5a223bf6a252d0a4c5b910530b4a37143a7b6c4f06b58ad03704c4b6b0ba4`。最终产品门槛归属源码／测试身份 189 canonical `189c5c21...`：八门均真 exit 0，Runtime 484/484、contracts 14/14、隐藏 E2E 125/125；之后只改了本记录中桌面检查断言的文字边界，没有改产品、测试或配置字节，也没有重跑已绿门槛。r1／r2 的阻塞发现和命中旧实现的红灯继续作为历史证据保留，r2 报告的证据目录描述错误已另存纠正回执。

本片验证只用本地受控协议服务器与隔离项目；桌面入口通过 launcher 检查与假项目中的 wrapper 透传验证，不是可见前台启动或人工视觉接受，也没有实际运行不带 `--check` 的完整启动路径，故不证明真实 Electron 主进程成功引导。截图指向受控 ABA mutation 夹具的 bootstrap 导入错误，不是正常 launcher 失败证据；同样也不证明普通启动成功。测试 profile 启动前隔离未验证，默认 Application Support 未检查或删除。真实服务商账户、用户工作目录、远端／手机路径、完整 Pi SDK 及整体产品仍未验收。

## 后续修复：隔离 Electron userData 在启动前传入（2026-10-16）

对普通 `启动 D Code.command` 做首次不带 `--check` 的 launcher smoke 时，使用临时 `HOME` 和 launcher 的临时 `DCODE_STATE_DIR`。launcher exit 0、主进程存活 5 秒，但 GPU／network helper 的实际命令行仍带系统默认 `userData` 路径；另有两条 Chromium cache 目录创建错误。Renderer 已使用临时 `userdata`。这组差异证明只在 `createWindow()` 内切换 profile 为时已晚。证据在 `B/Root-extension-desktop-normal-launch-20261016-r1/`。Root 仅结束了本次 launcher 创建的精确进程组并移除本次临时 HOME／沙箱；系统默认用户目录的内容未查看、未删除，不能依据该次启动宣称未触及该目录。

R1 将 `app.setPath("userData", ...)` 移到 `app.whenReady()` 前，独立审查仍指出 Electron 要求目标目录先存在，且该 E2E 没断言 Renderer。R2 修复为固定 launcher 在启动 Electron 时传入 `--user-data-dir`，然后主进程用异步 `mkdir` 确保目标目录存在，再调用 `app.setPath`。Playwright E2E 启动时禁用 helper 的目录预建，从不存在的 `userdata` 冷启动；比较主进程路径，并逐一解析 GPU、Network、Renderer 实际命令行中的路径，因此 `/var` 与 `/private/var` 的 macOS 路径别名不会造成误判。Runtime 假 Electron 还核固定 launcher 启动前准备目录并传入参数，`--check` 仍不创建 profile。R2 完整门槛中的冷启动场景与 Runtime 入口场景分别见 `B/Root-extension-desktop-userdata-isolation-full-verify-20261016-r2/08-hidden-e2e.stdout.log` 与 `B/Root-extension-desktop-userdata-isolation-full-verify-20261016-r2/06-runtime.stdout.log`；R1 旧定向日志不是 R2 证据。

R1 的普通 `.command` R3 smoke 记录作历史；R2 后又以不带 `--check` 的普通 `.command` 和临时 HOME 做 R5 smoke。launcher exit 0，主进程采样时存活，GPU／Network／Renderer 的完整参数各解析到同一临时 profile，实际启动日志无 import／cache 错误；仅结束了此次启动的精确 Electron 进程组并移除临时 HOME。R4 记录器按空白拆参数，截断 `Application Support` 路径，故 R4 不作隔离路径结论；修正记录器后的 R5 证据在 `B/Root-extension-desktop-normal-launch-20261016-r5/`。R5 没检查可见性／焦点，可能以普通窗口配置运行，不冒称后台隐藏或人工视觉接受。默认用户目录未检查或清理。

R1 的完整门槛与不放行结论均保留在历史证据中。R2 当前源码 canonical191／`beecc637c48de3aeb20924b0264eb70bd22a9e3a756419c3cb2eae2fd14f8659` 的完整八门真实 exit 0：架构正反32/32、源码83、runtime486/486、contracts14/14、隐藏E2E126/126，无 fail／skip／cancel；Lint 0 error、1 项既有 Timeline warning。逐门 raw、exit 和前后身份见 `B/Root-extension-desktop-userdata-isolation-full-verify-20261016-r2/ledger.json`。固定 R3 记录更正候选经 `model_integration_review` 独立 Standards／Spec／CodeQuality 三项 PASS，无本片必要剩余；报告 `B/Root-extension-desktop-userdata-isolation-r2-independent-review-20261016.md`（最终结论归属 R3，SHA-256 `7833e49ebc3fb9769527ea9ee3cf6d07eef5b71def767b2d2ac60129cfd7d305`）。本片限定接收桌面启动隔离修复及旧普通扩展／MCP生命周期保持，完整恢复点为`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-after-extension-desktop-userdata-isolation-accepted-20261016/manifest.json`。截图 `ERR_IMPORT_ATTRIBUTE_MISSING` 仍属于受控 ABA mutation bootstrap；R5 普通启动未复现该错误，但不代表窗口可见性／焦点或人工视觉已验。
