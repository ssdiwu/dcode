# 预设供应商、保留自定义与联网模型目录接入（2026-10-10）

本片只做一件事：把已冻结核验的候选实现，按清单**选择性**接入主目录，形成「设置 → 模型」里预设供应商与自定义并存的完整路径。执行底座仍是 Pi SDK 1.0.0，未更换运行器。

- 接入来源（只读）：`/Users/diwu/.codex/worktrees/components-slice-20261007/dcode`
- 冻结清单：`/Users/diwu/Workspace/Archives/dcode-provider-catalog-2026-10-09/verified-candidate-manifest.json`
- 候选自身验证：`[预设协同](../预设协同-2026-10-09/README.md)`（候选树内 `npm run verify` exit 0 的归档）
- 接入前回退点：`/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-before-provider-integration-20261010-1917/manifest.json`

## 一、清单核对：32 项逐项接入，不是整树拷贝

接入前重算候选 32 项 `integrationDeltas` 的 SHA-256，**32/32 与冻结版一致**，候选树自冻结以来未漂移，才开始接入。

| 接入方式 | 数量 | 说明 |
|---|---|---|
| 基线未变，直接接入 | 23 | 复制后逐一回算哈希，全部与清单一致；含 9 个新文件（`src/adapters/pi/` 下 8 个 + `src/main/provider-login.ts`）与 3 个新用例 |
| 并轨／人工合并 | 9 | 4 个走 `git merge-file`（base = `HEAD`），5 份散文文档人工语义合并 |
| 排除 | 1 | 候选的 `test/e2e/streaming-sim/dbg-stick.mjs` 为无关调试文件，未接入；已确认主目录中不存在该文件 |

并轨的 9 处（清单原列 8 处人工合并，加上实际发生的第 9 处）：

| 文件 | 合并方式与要点 |
|---|---|
| `test/e2e/cold-start.test.mjs` | `git merge-file` 无冲突，但**并轨后残留一处不成立的断言**，见第三节 |
| `src/renderer/i18n.ts` | `git merge-file` 无冲突；保留主目录既有双语键 |
| `test/e2e/model-setup.test.mjs` | `git merge-file` 无冲突。**这是清单外的第 9 处**：候选版本未带本轮的证据隔离。已核对该文件仍走 `evidence-root.mjs` 的 `evidenceDir()`，且每个用例的 `try/finally` 都收束 `cleanup(stateDir)`，与首片 18 个工装文件同一入口 |
| `src/renderer/views/SettingsPage.tsx` | 1 处冲突。取候选的 `ModelSection`（预设／自定义双页签），并把其中 `bg-card`/`border-border` 共 23 处映射回主目录当前的 `bg-raised` + `ring-[var(--edge)]` 材质语言，不引入第二套较重的表面语言 |
| `doc/架构约定.md` | 人工合并：引入 `Host` 宿主认证生命周期、取消分支与 `ProviderLoginController`；**保留**主目录的「Pi coding-agent 能力复用基准」章节（候选版本在该章更旧，直接取用会删掉它） |
| `doc/README.md` | 人工合并：补预设协同验证记录行 |
| `doc/协作约定.md` | 人工合并：更新接入事实，保留 2026-10-10 的归属 |
| `CHANGELOG.md` | 人工合并：去掉候选的「尚未进入 main」标记 |
| `PROGRESS.md` | 人工合并：记录接入结果与未实现边界 |

## 二、实际接入的产品范围

新增适配层（`src/adapters/pi/`，均为新建文件）：

| 模块 | 行数 | 职责 |
|---|---|---|
| `preset-providers.ts` | 83 | 沿 Pi 1.0.0 正式身份注册预设供应商；`NO_AMBIENT_CONTEXT` 明确不扫描环境变量或其他应用目录里的凭据 |
| `remote-catalog.ts` | 184 | 公开目录抓取。默认 `https://pi.dev`，4s 超时，只发 `?types=chat`，**不带认证头**；`sanitizeCatalogModel` 只保留 chat 且逐字段过形状校验 |
| `catalog-service.ts` | 485 | 目录服务。异步原子缓存、离线与失效保留、刷新与取消关闭门控、换源即时吊销在途请求 |
| `provider-directory-store.ts` | 484 | `provider-directory.json`（格式 2）单写者原子提交：供应商目录、按 `providerId` 隔离的加密凭据、当前模型选择、公共目录缓存共一份文件；含旧 `model-setup.json` 格式 1 的无损承接 |
| `executable-models.ts` | 100 | 目录模型到可执行模型的解析：builtin 精确模型保留本地 `baseUrl`，同供应商／本地协议的新线上模型以 anchor endpoint 可执行 |
| `login-service.ts` / `login-client.ts` / `auth-flow-guard.ts` / `builtin-info.ts` | 124 / 16 / 67 / 25 | 认证走 SDK 正式通路：prompt 收集 → gated store 提交点写凭据；代次守卫使旧流程的提交失效；关闭先同步认领 |
| `src/main/provider-login.ts` | 75 | `ProviderLoginController`，main 侧宿主认证生命周期 |

契约与装配：`src/contracts/ui.ts` 增加 `listModelCatalog` / `refreshModelCatalog` / `loginProvider` / `cancelLogin` / `replyAuthPrompt` 与 `applyModel`，**静态类型与接收侧运行时校验同时提供**；认证事件接收侧逐字段核对 `loginId`／`kind`／`message`／`url`／`select options`／`device_code`／`progress`。

界面：`ModelSection` 提供「预设供应商／自定义」双页签，未配置时默认落在预设页签；目录来源、最近成功时间、正在更新、使用缓存、失败与手动刷新均可见；认证按供应商能力呈现，可取消。

边界按要求成立：目录查询不要求登录、不发模型探针、不带凭据；模型元数据不改认证、endpoint、执行或当前运行模型。

## 三、接入过程中发现并修掉的真实缺陷

### 1. `cold-start` 首场景在并轨后不成立（已被 E2E 抓到）

`cold-start.test.mjs` 的并轨把两件事叠在了一起：主目录的 **D02 入口**（缺配置时内联「去设置」，直接落到模型分区本身）与候选的**双页签模型分区**（默认预设，密钥输入只在自定义页签）。主目录那段在点击「去设置」后直接 `waitFor('input[type="password"]')`，而默认打开的预设页签本就没有密码框 → 30s 超时失败。

这不是产品回归：`spec/页面与交互组件.md` 的 D02 只要求「到相关配置位置，保留当前草稿」，`spec/模型选择与自动切换.md` 的「空配置正常打开」明确要求预设目录可浏览、自定义入口存在。修的是断言，不是产品：

- 落地判定改为验默认页签的真实表单（`供应商` 选择器）＋ 分区可判定（`aria-current="page"`）；
- 新增两条正向断言：预设页签**不出现**自定义密钥输入，且模型分区**确实保留**自定义入口；
- 密码框的空值断言保留在切换到自定义页签之后（该处原有）。

### 2. `product-owned-content` 的密钥断言因双页签静默失效

原文写的是 `if (await pw.count() > 0) assert.equal(await pw.inputValue(), "")`——并轨后模型分区默认在预设页签，密码框计数恒为 0，这条断言变成永不执行的空壳。已改为先切到自定义页签，再断言**有且仅有一个**密钥输入且为空。这条断言原本的意图是「hosted key 不回显」，失效即等于失去覆盖。

## 四、本次实际通过的检查

全部经 `run-check.py` 运行，原始 `output.log` 与 `status.json` 见 `test/e2e/evidence/runs/<运行标识>/_run/`（本机隔离目录，不进版本控制）。

| 检查 | 运行目录 | 时间 | 真实出口 |
|---|---|---|---|
| `npm run verify:runtime`：架构正反样例 ＋ 架构检查 ＋ 全范围类型 ＋ Lint ＋ 全部运行集成测试 | `provider-verify-runtime` | 19:35:01–19:35:18 | exit **0**；架构自测 32/32；Architecture **PASS，59 源文件**；运行 **75/75** |
| `npm run test:contracts` | `provider-contracts` | 19:26:10 | exit **0**；**5/5**（新增供应商专用契约 1 条） |
| `npm run build` | `provider-build` | 19:26:57–19:27:03 | exit **0**；main／preload／renderer 产物齐备 |
| 变动相关 E2E：`preset-catalog` / `model-setup` / `cold-start` / `i18n` | `provider-e2e-targeted` | 19:27:14–19:28:18 | **exit 1；15/16**——抓到第三节第 1 条缺陷，**已作废**，不作背书 |
| 修复后复跑：`cold-start` / `product-owned-content` | `coldstart-fix` | 19:30:25–19:30:37 | exit **0**；6/6 |
| `npm run test:e2e`：后台隐藏、隔离状态目录、界面用例串行 | `provider-e2e-full` | 19:31:38–19:34:38 | exit **0**；**70/70** |

界面对比：第一片为 69/69，本片新增 `preset-catalog` 1 条完整协同路径场景，故为 70/70。界面验证全程窗口隐藏、状态目录隔离，未打开正式用户窗口或真实 profile，未探测任何真实付费账户。

已作废运行：`provider-e2e-targeted`（exit 1，源码为修复前）。此前首片的作废运行另见各自记录。

上表是**接入完成、尚未处理第八节两处缺陷**时的源码状态；当前源码的门槛见第八节。

新增／变动的行为覆盖入口：

- `test/e2e/preset-catalog.test.mjs`——一条走完整用户路径：SDK login → 应用预设发请求 → 环境独立保留 → 目录换源。
- `test/runtime/catalog-service.test.mjs`（12 条）——只保留 chat 的形状校验、公开请求不带认证头、304 无正文不算成功、A→B 换源即时吊销在途、旧源结果在 commit 点被拒不写新源、跨源 404 保留旧目录而不伪报最后成功、写盘失败落 `lastError`、写前换源清理临时文件、多供应商一处失败不被另一处成功隐藏。
- `test/runtime/auth-flow.test.mjs`（6 条）——登录走 SDK 正式通路、同供应商二次 begin 使旧 guard 提交失效、读在途时 admission 不穿透、取消与关闭不悬挂、已提交后晚到的取消不能抹掉已保存凭据。
- `test/runtime/provider-directory-store.test.mjs`（8 条）——凭据严格按 `providerId` 隔离、双授权点之间被吊销的写入清理临时文件、`list` 不解密、空目录首次读写不死锁、旧格式承接、并发首读不重复迁移。
- `test/runtime/model-setup-concurrent.test.mjs`（5 条）——保存 flight 在途时的 flush／resume 拒绝、真实运行中拒绝保存、已打开的 paused 端口保留 pending 队列。
- `test/e2e/model-setup.test.mjs`（11 条，保留主目录既有覆盖）——含 401 反馈、keep 旧 key、跨 origin keep 必须拒绝、非 loopback／userinfo／查询片段拒绝、注入写盘失败后仍可用 A 配置、短凭据不回显、ECONNREFUSED 不渗出原文、720 窄窗可读可滚。

## 五、明确未实现（本片不假装完成的）

- **会话独立的来源／模型选择**：未实现。设置页的「应用模型」是**默认模型契约**，不等于会话内可各自指定来源与模型。会话选择所需的接口与状态归属按 `doc/架构约定.md` 在既有 app／port／SDK 通路上定义，不新造运行器、第二份历史或新的接收队列。
- **条件化思考强度**：未实现。不凭 `reasoning` boolean 或模型名硬编档位。
- **能力优先与额度自动路由、账户实际余量**：未实现，读取 spec 中相应章节。
- **执行底座切换**：未做，仍是 Pi SDK 1.0.0；这是下一片的既定方向。
- **C05 ＋引用入口、C07 来源模型入口、输入区几何与单主按钮**：均未实现，属后续切片。
- **真实服务商与真实账户**：未验证。本片全部使用本地协议服务器与隔离状态目录；真实账户按各自记录分别验收。

## 六、未覆盖与边界

- 首片已记录的规格／实现落差（C05 菜单内暂停已取消但 `Composer` 仍有该入口，`composer-run-states` 首个场景仍按旧规则断言）**在本片未被处理**，仍待后续切片收口。
- 目录抓取的真网络路径（`https://pi.dev`）在本片未被真实请求过：门槛运行时目录源指向隔离服务器。真实目录地址可达性、返回形状与限流表现需单独取证，不以本地服务器结果代替。
- 真实账户的 OAuth／设备码流程未运行；`login-service` 的取消与关闭分支只经本地模拟覆盖。
- 视觉接受、玻璃材质在软件合成下的降级、前台像素与系统拖选仍未做。
- 本片未经 `507-review` 独立收口。

## 七、F1／F2：两处实路缺陷的固化与收口（2026-10-10 晚）

独立复核指出两处实路缺陷。两者都先用公开接口写出**确定失败**的断言，再做最小修复；不改公开契约、不新增运行器或接收队列、不换执行底座。

### F1：认证在途按全局计数，误阻断无关供应商的工作

`src/application/app.ts` 的 `beginProviderAuth` 已经按 providerId 判定「是否当前供应商」（非当前供应商跳过端口相位核对），但它登记进的是一个**无归属的全局计数** `authFlowCount`；`sendMessage` 与 `resumeRun` 又按 `authFlowCount > 0` 一刀切。结果：当前用 A 工作、只给 B 登录时，A 的新发送与明确继续被无关阻断，违反 `spec/模型选择与自动切换.md` 「认证与自定义保留」——门控约束的是「影响该供应商」的发送/继续。

红反例（`test/runtime/auth-flow.test.mjs`）：当前选择 A，仅 `beginProviderAuth('another')`，断言 A 的 `sendMessage` 回执为 `accepted`、`resumeRun` 不抛；释放 B 后 A 的工作不变。修复前该用例失败于 `actual: 'not-accepted'`。

顺带修正了测试夹具的一个前提错误：`authFixture()` 原本总会 `pauseRun`，而 mock 端口自身就会以 `reason: 'paused'` 拒 steer——那样「发送被接受」根本不可能成立，会把执行端的拒绝与认证门控混为一谈。夹具改为可传 `{ paused: false }` 保持 idle，既有调用方行为不变。

修法（沿现有 provider 集合与单一所有者）：把 `authFlowCount` 与 `authAdmitProviders` 合并为唯一的 `authFlowProviders: Map<providerId, 在途计数>`——`beginProviderAuth` 登记该 provider、`enterAuthFlow` 真正使用它的 `providerId`（此前该参数被 `void providerId` 丢弃，本身就是潜在缺陷）、`release` 按计数递减。发送与继续改走 `authFlowBlocksCurrentWork()`：只比对**当前选择实际使用的供应商身份**，与 `beginProviderAuth` 的 `isCurrent` 同一依据（持久 selection 只有 preset/custom 两种，`preset-with-custom` 是快照视图，执行身份仍是 preset；纯自定义接入没有供应商身份）。全部会话共用 `currentBackend`（见 `ensurePort`），所以「当前选择的供应商」就是这些请求实际使用的凭据归属。

四个消费点逐一核对，结论不同，因此不是一律全局或一律按供应商：

| 消费点 | 判定 | 依据 |
|---|---|---|
| `sendMessage` | 改为**按当前供应商** | 只读凭据、不改选择；spec 明确在途门控只约束该供应商的发送 |
| `resumeRun` | 改为**按当前供应商** | 同上；且 spec 把「发送/继续」并列 |
| `configureModel` / `applyModel` | **保持全局** | 两者都会改写**当前选择的身份**并向 `provider-directory.json` 提交，与在途认证的凭据提交同一份物理文件。spec 允许另一供应商按身份独立提交凭据、要求文件串行合并，但没要求在提交期间改写当前选择。既有绿项「A 在途时 configureModel 被拒」因此继续成立，未被放宽 |

反向覆盖同时加固：A 自身认证在途时，其 `resumeRun` 必须抛 `auth-flow-in-flight`，已在既有用例中补上断言。

### F2：来源保存不在途登记内，关闭可早于换源落盘完成

`src/adapters/pi/catalog-service.ts` 的 `setSource` 只在**入口**核 `closed`。它吊销旧源并 `await priorFlight` 之后，就直接 `store.modify(...)` 写新来源——既没有传原子 `beforeCommit`，也不核代次；而 `close()` 只等 `#refreshFlight`，不登记来源保存。于是关闭可以落在两个窗口里完成，而 `setSource` 随后继续写 B 并发布。既有 guard 只覆盖缓存正文提交与入口判定，不覆盖来源定义本身的保存。

红反例（`test/runtime/catalog-service.test.mjs`，两个确定时间窗，用隔离真实 `ProviderDirectoryStore` 与公开 `setSource`/`close`）：

1. **等待旧 refresh 时 close**：先让 A 源有已落盘的有效目录，再启动一次被门控等待的 A 刷新，然后 `setSource('B')` + `close()`，放行门控。修复前 `store.read().catalogSource.baseUrl` 为 `http://source-b`（关闭收束后仍晚写）。
2. **来源提交已进入异步保存时 close**：用一次占用 store 单一写入队列的 `modify` 让来源保存排队，再 `setSource('B')` + `close()`。修复前同样是 `http://source-b`。

两条都断言：关闭收束后不得晚写新来源、不得晚发布、旧有效来源缓存保留、临时文件清理；并覆盖重复关闭。

修法：来源保存整段（等旧 refresh → 落盘 → 新源检查）登记为 `#sourceFlight`，`setSource` 在**首个 await 前**同步登记，`close()` 同步取两个在途句柄并逐一真实等待（close 之后的 `setSource` 会在入口被拒，不会有新 flight 漏等）。落盘本身经 `store.modify` 的原子 `beforeCommit` 复用同一代次与关闭判定：`generation` 变化、当前来源已被换掉、或已关闭，都在 temp 写完、紧邻 `rename` 之前拒绝，此时清理临时文件、保留旧 record 与旧有效缓存。另在 `await priorFlight` 之后补一次 `closed` 判定，覆盖入口判定被越过的那一步。两层缺一不可：只有 `await` 后再 `if` 会漏掉 temp-write→rename 窗口。

### 红→绿与最终源码身份

第一次修复的红→绿（接入冻结态 18/21 三红 → 修复后 21/21）见下；其后的第二轮见「F2 第二轮」。

红反例的确认不是「修复后才写」：先把两处源码临时还原为**接入时的冻结状态**（候选树副本，已核对其 SHA-256 与冻结清单的 `candidateSHA256` 逐字相同），跑出 18/21、三条按预期断言失败，再恢复修复版跑出 21/21。两次运行都有独立归档。

当前源码的一次完整集成门槛（`npm run verify`，22:55:10–22:58:18，exit **0**）：

| 阶段 | 结果 |
|---|---|
| 架构正反样例 | 32/32 |
| 架构检查 | **PASS，59 源文件** |
| 全范围类型 ＋ Lint | 通过 |
| 运行集成测试 | **78/78**（接入后为 75，本轮新增 F1 一条、F2 两条） |
| 契约 | 5/5 |
| 构建 ＋ 后台界面 | exit 0，**70/70** |

原始日志：`f1f2-red`（首版红）、`f1f2-redcheck`（修订后红）、`f1f2-green`（修复后定向绿）、`f1f2-verify`（最终集成门槛），均在 `test/e2e/evidence/runs/<id>/_run/`。前一次接入的 75/5/70 不为当前源码背书。

## 八、F2 第二轮：在途唯一性、提交后复核与不伪报未保存

第一轮修复后独立复核仍指出同范围内三处缺口，都在来源变更的在途模型上，本轮按最小范围补齐，未新增 harness、第二份事实或接收队列，也未改超时／重试策略。

### 复核指出的缺口与本轮修法

1. **`#sourceFlight` 每次被覆盖**。第一版每次 `setSource` 都无条件把新 flight 写进 `#sourceFlight`，两个来源请求重叠时后来者直接顶掉先来者；`close()` 只截当前句柄，旧的在途无人等待。而旧刷新公共 Promise 的续跑可能早于换源者等待 `priorFlight` 之后的续跑进入 store 队列，于是出现「C 先成功、B 随后被当作 stale 排队」的次序。
   修法：同时只允许一次来源变更在途，第二个请求在**首个 await 前**被显式拒绝（`catalog-source-busy`），既不覆盖句柄，也不让后来的请求等来别人的结果。相同来源的「仅刷新」同样不能绕过——它会落在本次变更的提交窗口里另起一代，把本次变更变成 stale，同时让一次针对旧源的检查结果被当成当前源。
2. **`close()` 只截最新句柄**。在 1 成立之后，同时最多只有一个来源 flight，`close()` 同步取两个在途句柄逐一等待即已覆盖，不存在悬空的旧 flight。
3. **提交之后仍会晚发布、晚启动新检查**。`rename` 已过门禁即已保存事实；本轮在 `modify` 之后、`bump` 与新检查之前复核 `closed` 与代次：已关闭或已被取代的流程不再发布、也不再另起一次检查。

### 不把「已保存」说成「未保存」

上一条复核里有一句是结果语义问题：来源定义已经原子提交，却被当作普通失败返回，界面会渲染成「来源保存未完成／Source not saved」——那是假的。本轮为此在契约里增加一个独立结果态 `committed-not-checked`，与 `refresh-failed` 分开：表示「来源定义已原子提交（事实保留），但本次收尾检查因关闭或被取代未执行」。设置页对它单独用 `settings.catalogSourceSavedNotChecked`「目录来源已保存，但本次检查未完成」呈现（`text-warning`），不再复用失败文案。契约的运行期校验本来就只要求 `issue` 是字符串，因此只改了类型联合，没有新增校验分支。

### 新增与更正的红反例

更正的两条（不降断言，补上独立判断）：

- 「等待旧 refresh 时 close」与「来源提交已进入异步保存时 close」都改为**独立记录关闭 Promise**：受控 gate 未释放前排空待决微任务，断言 `closed === false`——关闭尚未完成；释放后再断言 `closed === true`，并继续断言不晚写、不晚发布、旧缓存保留、临时文件清理、重复关闭幂等。排空的是待决微任务而不是按时间等待，受控 gate 未释放时任何真实 I/O 都不可能完成，所以与机器快慢无关。

新增的两条：

- **并发两来源请求**：用占用 store 写入队列的方式给第一个换源一个确定的阻塞窗口，随后登记第二个来源请求与一个相同来源请求。断言后来者被显式拒绝、被拒请求不回带在途的 revision、相同来源请求不得绕过、被拒请求没有写入任何来源也没有发起任何检查。注意这里**先登记后断言**（不中途 `await`）：否则在旧实现上会直接挂死、掩盖后续断言。
- **来源已提交后关闭**：用一层薄代理只延后 `modify` 的**返回**（真实 `ProviderDirectoryStore` 已完成 temp-write→rename），把流程确定性地停在「已提交、未收束」。断言关闭在该点仍未完成；释放后断言结果为 `committed-not-checked`、磁盘上保留新来源、内存视图仍是旧来源（未晚发布）、没有晚启动新检查、临时文件清理。这条用同一套断言同时证明了「事实保留」与「不晚发布」。

### 第二轮的红→绿

红的那一次同样不是修完才写：把 `catalog-service.ts` 临时还原为**独立复核所看到的那一版**（只去掉本轮的来源在途判定、`refresh` 忙判定与提交后复核），跑出 **14/16**，两条新用例以干净的 `testCodeFailure` 失败（不是挂死）；恢复新版后 **16/16**。

第二轮的红版是**机制还原对照**：从工作文件里移除本轮的来源在途判定、`refresh` 忙判定与提交后复核，再跑同一份用例。日志成立——两条既有的关闭窗口用例保持绿（它们在第一轮已修好，本轮不动它们），**新增的两条按预期转红**。

需要写明的边界：**没有对被复核源码留存 SHA 存档**，因此这不是「旧版本逐字重放」，只是把对应机制移除后的对照运行。第一轮那次（`f2b-redcheck` 之前）用的是接入时的冻结候选树副本，按清单 `candidateSHA256` 核对过，可称逐字还原；本轮不同。

一处需要说明的失败次序：在该对照运行上，并发那条先失败于「第一个来源变更应真实完成」——正是复核描述的次序问题（C 抢先、B 被判 stale）。后面的忙判定断言同样会失败，一并写在用例里。

第二轮原始日志：`f2b-run`（首次运行暴露用例自身的代理前提错误）、`f2b-green1`／`f2b-green2`（新版绿）、`f2b-redcheck2`（机制还原对照，14/16）、`f2b-targeted`（定向：类型检查 ＋ 目录服务／认证流程 23/23，exit 0）。**对照运行上挂死的那一版 `f2b-redcheck` 已作废**，不作背书。

### 新版门槛（与前版分开记）

前一轮的 `npm run verify`（exit 0，架构自测 32/32、架构 PASS 59 源文件、运行 78/78、契约 5/5、界面 70/70）对应的是**本轮之前**的源码，只作为该时点的记录保留，不为当前源码背书。期间又跑过一次 `f2b-verify`，其后 `retrySend` 的门控补上，该运行同样作废。当前源码的结果见第九节。

## 九、F1 补漏：retrySend 是被漏掉的一条发送入口

第二轮复核指出：F1 的修法改的是 `authFlowCount` 的读取点，但当时只核了「读了这个字段的消费者」，**没有核「哪些路径能真正导致 `port.submit`」**。以实际投递为边界重追一遍，结论是漏了一条：

`retrySend` 只核关闭认领与保存 flight，随后进入 `recoverOrSubmit` 的「只读回查 → 可靠 not-found 才重投」接缝；查回返回 `not-found` 时它直接 `port.submit`。于是 A 自身认证已经登记后，同身份重试仍能实际重投 A，绕过 `sendMessage` / `resumeRun` 上新增的门控。

修法沿既有接缝，不新造队列：在 `recoverOrSubmit` 里、**在可能 `port.submit` 的那一步之前**消费同一个 `authFlowBlocksCurrentWork()`。查回本身是只读的，因此已接收（`accepted`）与仍未知都按原样返回，不会因为认证在途被改报未接收；`operationId`、原文与模式都不改。

### 以「能否导致 port.submit」为边界的完整追查

全仓 `port.submit` 只有两处（`app.ts` 的 `submitToPort` 与 `recoverOrSubmit`；`adapters/pi/session.ts` 的 `#root.submit` 只在端口实现内部被调用）。它们由**两个公开入口**触达，对应**三条投递路径**：

| 入口 | 到达的投递点 | 门控 |
|---|---|---|
| `sendMessage` → `#sendMessageCore` | `submitToPort`（新身份）／`recoverOrSubmit`（复用身份） | 进入 `#sendMessageCore` 之前即按当前供应商判定（F1 已修） |
| `retrySend` | `recoverOrSubmit` | 本轮补：投递前消费同一判定 |

只读回查入口三处，**刻意不加**该门控（查询状态、核对回执与重连不得隐式启动执行）：`checkReceipt`、`refreshReceipts`，以及 `recoverOrSubmit` 里投递之前的那次查回。

### 红反例

公开 `retrySend` 的用例：用 mock 的「已提交但结果待核对且不留记录」注入制造一个可靠 not-found 的原 ID。断言顺序为——A 自身认证在途时重投返回 `not-accepted`；随后**只读** `checkReceipt` 仍是 `not-found`，证明确实没有投递（而不是投了又丢回执）；B-only 在途时同身份重试被接受且 `operationId` 不变；A 再次在途时重试靠只读回查返回 `accepted`，不被改报未接收。

红的那一次在补门控之前：`f1c-retry-red`，exit 1，失败于「A 自身认证在途时不得实际重投」；补门控后 `f1c-retry-green2`，exit 0。

用例中有一处需要说明：第三次 `beginProviderAuth('testco')` 一开始失败，原因是重投已让端口真实进入运行中，而供应商认证的相位核对对运行中／正在暂停的端口本就拒绝。这是既有门控、与本次修复无关，用例改为先把端口停到 paused 再认领，没有放宽任何断言。

### 当前源码的一次完整集成门槛

`npm run verify`（23:29:13–23:32:50），**exit 0**：

| 阶段 | 结果 |
|---|---|
| 架构正反样例 | 32/32 |
| 架构检查 | **PASS，59 源文件** |
| 全范围类型 ＋ Lint | 通过 |
| 运行集成测试 | **81/81**（78 ＋ F2 第二轮 2 条 ＋ retrySend 1 条） |
| 契约 | 5/5 |
| 构建 ＋ 后台界面 | exit 0，**70/70** |

**源码身份**：对 `src/`、`test/`、`tools/` 与工程配置（`package.json`、`package-lock.json`、`tsconfig.json`、`electron.vite.config.ts`、`architecture-policy.json`）求聚合 sha256，排除 `dist`／`out`／`evidence`／`node_modules` 等生成产物。共取样**三次**，结果相同：**115 文件、`e75c3e56729f8190212365ba6e9f2e4e9cb6c9e5b4d9a01e4e280ec63fdf9926`**。

| 取样时点 | 时间 | 结果 |
|---|---|---|
| 运行中（末段） | 23:32:30 | 115 / `e75c3e56…f9926`，最新源码 mtime 23:28:38 |
| 运行结束后 | 23:35:01 | 同上 |
| 独立当前（文档定稿后复算） | 23:4x | 同上 |

三次的最新源码文件都是 `test/runtime/auth-flow.test.mjs`，mtime **23:28:38，早于本次启动的 23:29:13**；该轮运行期间与此后都没有任何源码或测试文件被写入，运行期间只写了文档。

**边界必须写清**：**没有启动前的哈希清单**，所以这不是「运行前后逐字节对照」，而是「运行中／结束后／当前三次采样一致 ＋ 最新源码 mtime 早于启动点」两项证据。mtime 不会因未写入而改变，因此足以支持「运行期间无源码写入」这一条，但不能冒充成有基线的前后哈希对照。

### 三版门槛结果的区分

| 版本 | 运行 | 结果 | 是否为当前源码背书 |
|---|---|---|---|
| 接入完成、F1/F2 未处理 | 第四节各次（19:26–19:34） | exit 0，75/5/70 | 否，只作该时点记录 |
| F1＋F2 第一轮 | `f1f2-verify`（22:55:10–22:58:18） | exit 0，78/5/70 | 否 |
| F2 第二轮（并发／发布修正） | `f2b-verify`（23:25:07–23:28:29） | exit 0 | **否——中间版，运行期间源码已变**：23:27 补上 `retrySend` 的投递门禁（`f1c-retry-red`／`f1c-retry-green2` 就在该窗口内），这条流水线的开始与结束不是同一份源码 |
| F1 补漏 ＋ F2 第二轮（当前） | `f2c-final-verify`（23:29:13–23:32:50） | exit 0，**81/5/70** | 是，运行前后源码 sha 一致 |

### 本轮其余运行的定位

- 有效的红：`f2b-redcheck2`（复核版目录服务源码，14/16，两条新用例以干净的 `testCodeFailure` 失败）、`f1c-retry-red`（补 retrySend 门控之前，失败于「A 自身认证在途时不得实际重投」）。
- 有效的绿：`f2b-green1`／`f2b-green2`（目录服务 16/16）、`f2b-targeted`（类型 ＋ 目录服务／认证流程 23/23）、`f1c-retry-green2`（24/24）。
- **作废**：`f2b-run`（用例自身的代理前提错误——它把初始刷新的写盘也一并拦住了）、`f2b-redcheck`（并发用例在旧实现上挂死而非断言失败，信号太弱，已重写为先登记后统一断言）、`f1c-retry-green`（用例把「运行中端口拒绝供应商认证认领」这一既有门控误当成缺陷，已改为先把端口停到 paused）。中间绿项未反复重跑。

## 十、真实公开目录的只读取证（与本地验证分开记）

作者当时的目录验证全部走本地协议服务器与隔离状态目录。本轮另行做了一次**只读**真实公开目录 GET：不带认证头、不发模型探针、不写用户目录、不触碰任何真实账户。

| 事实 | 取值 |
|---|---|
| 端点 | `GET https://pi.dev/api/models/providers/openai?types=chat`，HTTP 200 |
| 正文构成 | 共 45 条：`chat` 44 条、`classifier` 1 条 |
| 产品接收侧校验结果 | `sanitizeCatalogModel` 接受恰好 44 条 chat，拒绝 1 条 classifier；全部为 `type: 'chat'` |
| `last-modified` | `Fri, 09 Oct 2026 12:42:08 GMT` = `1791549728000` |
| 本地内置生成时间 | `builtinCatalogGeneratedAt() = 1790881031882` |
| freshness gate | `1791549728000 > 1790881031882` **成立**，远端资料不会被判为倒退 |

边界，必须分开记：

- 该证据只覆盖 **openai 一家的公开目录**。不代表其余 41 家供应商、不代表任何账户、不代表缓存写入与界面呈现链路。
- 真实网络路径在本机不稳定：同一进程内第一次裸 GET 以 `TypeError` 失败（6351ms），产品 fetch 随即命中自身 4s 超时；第二次热连接下裸 GET 920ms、产品 fetch **成功返回 44 条**（3193ms）。产品通路的成功结果来自热连接那次。
- 因此记一条**尚未处理**的观察：产品硬编码的 `CATALOG_REQUEST_TIMEOUT_MS = 4_000` 与实测 3193ms 的成功请求同量级，冷连接下会呈现 `catalog-timeout` 失败（本机已实际发生两次）。这属于超时余量偏紧，本轮未改，也未授权改动——留待 507 定夺。
- 实际模型探针（对具体模型发推理请求）**仍未授权**，本轮一次也没有发。

## 十一、本轮生产改动范围与收口边界

### 生产改动共五处

| 文件 | 性质 |
|---|---|
| `src/application/app.ts` | **核心修复一（F1）**：认证在途按 providerId 登记；`sendMessage`／`resumeRun` 改按当前供应商判定；`recoverOrSubmit` 在投递前消费同一判定 |
| `src/adapters/pi/catalog-service.ts` | **核心修复二（F2）**：来源变更在途登记与唯一性、`close` 真实等待、原子提交点门禁、提交后复核 |
| `src/contracts/ui.ts` | `committed-not-checked` 的结果态进入共享类型联合 |
| `src/renderer/views/SettingsPage.tsx` | 按该结果态单独呈现，不复用失败文案 |
| `src/renderer/i18n.ts` | 对应文案 `settings.catalogSourceSavedNotChecked` |

后三处是第二处核心修复的**必要承接**，不是独立改动：`committed-not-checked` 若不进入契约类型与界面，就会被渲染成「来源保存未完成／Source not saved」，把已保存的事实说成未保存。测试改动只在 `test/runtime/auth-flow.test.mjs` 与 `test/runtime/catalog-service.test.mjs` 两个文件。

### 收口结论与仍然未验收的范围

按独立复核结论，**本模型目录片可收口**：F1／F2 四处实路缺陷已闭合，当前源码的 `npm run verify` exit 0（81/81、5/5、70/70，架构 PASS 59 源文件）。

未验收、不得据此宣称完成的：

- 真实账户：从未登录、从未对任何真实付费账户发过请求；OAuth／设备码流程只经本地模拟覆盖。
- 全供应商在线链路：只读真实 GET 只覆盖 openai 一家，其余 41 家未验证；缓存写入与界面呈现链路未在真实目录下端到端跑过。
- 会话独立的来源／模型选择与条件化思考强度：仍未实现。
- 完整工作台（输入区几何、单主按钮、＋入口、成员协作、侧问等）：仍未实现，仍按各片推进。
- 目录请求 4s 超时余量偏紧：已记录，本轮未改。

## 十二、下一片依赖

1. 切片 A 输入几何、B 单主按钮——B 需先改写 `test/e2e/composer-run-states.test.mjs` 的第一个场景（它仍按已取消的「写字时菜单内暂停」断言）。
2. 切片 C ＋入口、D 会话独立来源／模型接口——D 依赖本片确立的 `providerId` ＋ `modelId` 身份与 `preset` / `preset-with-custom` 契约形状。
3. 本片的 `ProviderCatalogService`、`ProviderDirectoryStore` 与 `ProviderLoginController` 是 D 的既有落点，不另建通路。
4. 完整工作台切片 E／F／G／H 完成后，连同本片一并交 `507-review` 收口。
