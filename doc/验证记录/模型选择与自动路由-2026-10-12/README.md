# 模型选择与自动路由（D）验证记录

日期：2026-10-12。范围：spec [模型选择与自动切换](../../../spec/模型选择与自动切换.md)、[用量与账户额度](../../../spec/用量与账户额度.md)、[页面与交互组件 · C07 来源与模型入口](../../../spec/页面与交互组件.md#工作输入区)，即会话级 Auto／手动选择、条件参数已核实档位、账户额度事实与两层模型入口。

本记录只登记**本片实际运行过**的结果与边界。产品要求以 spec 为准。**本片尚未经 Root 独立验收**；下文所有绿项都是自测证据，不是放行结论。

## 结论

D 片（会话级模型选择、条件参数、账户额度事实、自动路由与任务用量）在 2026-10-12 第二轮补齐后冻结。**本片尚未经 Root 独立验收**；下文所有绿项都是自测证据，不是放行结论。

本轮在独立只读预审（`minimax-D1-WIP1117-independent-pre-review-20261012.md`，针对 11:17 的 415 文件副本）之后补齐了下列**真实残余**，每项都配了先红后绿的行为用例：

| 预审指出的残余 | 本轮实际改动 | 证据 |
|---|---|---|
| `resolveSessionRouting` 只是独立查询，发送/重投/恢复都不消费正式判定 | 新增 `admitRequest`：发送前按真实工作条件重新判定，`hold-*` 与「等待明确继续」**保留工作、不提交**，回执新增真实原因 `model-unavailable`；`resumeRun` 清除等待后立即重核，条件仍不成立则保留等待 | `test/runtime/model-request-gate.test.ts` 前两例；`session-model-request.test.mjs` 暂停期反例 |
| 应用模型失败/端口无该能力时只诊断并继续用旧配置 | `applySessionModel` 三条失败路径（无方法、抛错、诊断）一律返回拒绝，不再静默回落旧模型 | `model-request-gate.test.ts` 第三例 |
| 普通装配只登记当前默认来源一个模型 | `createPresetPiBackend` 登记**全部已配置来源**（同源全部已解析模型 + 保留下来的自定义接入），共用同一套净化与额度观察 | `src/adapters/pi/real.ts` / `src/main/assembly.ts`；类型与构建门槛 |
| 同响应里 requests 有剩余就判可用，忽略 tokens 已耗尽 | `factsFromObservation` 收齐同一响应的**全部适用窗口**（Anthropic 另有 input/output 独立约束）后统一判定；任一已知耗尽即整体耗尽，并写明另一约束仍有剩余 | `model-routing.test.ts`「同一个响应里的全部适用约束收齐后才判定」 |
| 观测无失效，会带上一个账户的过期事实 | 观测按「来源+模型+`accountKey`」保存；换身份丢弃旧观测；`invalidateSource` 在换凭据后显式失效；窗口重置时间已过的观察退回「未读到」 | `model-routing.test.ts`「观测会失效」 |
| 会话累计用观测总量，较小视图会把它降回 A | 会话累计改为**从合并后的逐次记录求和**；`actual` 单调推进（取已入账序列最后一条），重开或换实例后视图变小都不回落 | `model-request-gate.test.ts`、`task-usage.test.ts`「较小视图不回落」与「真实存储重开」 |
| 「本次实际采用」复用选择摘要，改选后界面谎称已采用 B | 拆分 `describeActual`：选择行显示选择，实际采用行只读真实 `actual` | `session-model-request.test.mjs`「改选后界面仍显示来源 A」 |
| `setDefaultModelChoice` 绕过 `settingsSaveFlight` | 走与普通设置同一套在途协调与 `flush` 等待 | `model-request-gate.test.ts`「默认模型保存走既有在途协调」 |
| 候选范围只按目录遍历、无用户名单 | `Settings.modelCandidates` 为唯一范围依据；受控装配之外补上**设置页候选配置面板**（真实复选框） | `SettingsPage.tsx`；E2E 走真实勾选 |
| E2E 用桥调用代替 UI 全路径 | 名单配置改为设置页真实勾选；暂停/继续改为点唯一主按钮 | `session-model-request.test.mjs` |
| 没有第二个受控来源的精确证据 | 受控装配登记两个真实来源（都经真实 Pi SDK 调用）；E2E 证明改选后**下一次真实请求**才发给来源 B，且带界面选的档位 | E2E 证据摘要（见下） |

### 本轮 E2E 的精确请求证据（`test/e2e/evidence/runs/<run>/session-model-request/`）

四次真实请求，逐次来自受控装配写下的请求记录，不是界面自述：

| # | provider | modelId | 档位 | 本次正文 |
|---|---|---|---|---|
| 0–2 | `dcode-test` | `fixture` | 无（用模型默认档） | `请处理这段输入-<一次性随机串>` |
| 3 | `dcode-test-b` | `fixture-b` | `high` | `第二次真实请求：应改由来源 B 应答` |

其中档位是从 Pi SDK 的 `streamOptions.reasoning` 读到的（`pi-durable/harness/generation.js:116` 在档位为 `off` 时不下发该字段）——这是「档位真的进了 SDK 请求」而非界面自述的直接证据。

## 接入现状取证（决定实现口径的事实）

`@earendil-works/pi-ai@1.0.0` 的 `node_modules/@earendil-works/pi-ai/dist/types.d.ts` 已按全量核对：

| 事实 | 位置 | 对实现的约束 |
|---|---|---|
| `ThinkingLevel = "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`，`ModelThinkingLevel = "off" \| ThinkingLevel` | 第 24–25 行 | 六档定义以 SDK 实际类型为准，不自造档数 |
| `Model.thinkingLevelMap?: ThinkingLevelMap`，`ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string \| null>>`，注释为「Missing keys use provider defaults. null marks a level as unsupported.」 | 第 26、920–925 行 | 键值三义：字符串＝已核实支持；`null`＝已核实不支持；**缺键＝未核实**（用来源默认值）。缺键**不能**当成支持，也不能当成不支持 |
| `Model.reasoning: boolean` | 第 918 行 | 只是「有没有思考能力」，**推不出**支持几档 |
| `Usage { input, output, cacheRead, cacheWrite, … }` | — | 真实用量来源；本片未接入界面 |
| **无任何 quota／subscription／balance API** | 全文件检索无命中 | 账户额度只能做明确 `unsupported`／`unknown`，**禁止**造余额或用 token／价格表估算 |

内置目录数据侧核实：`node_modules/@earendil-works/pi-ai/dist/providers/data/*.json` 共 827 处 `thinkingLevelMap`，形状确实是逐模型逐档。例如 `anthropic.json` 的 `claude-opus-4-6` 为 `{"max": "max"}`、`claude-sonnet-5-5` 为 `{"off": null, "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max"}` —— 前者只有一档被核实、其余未核实；后者明确把 `off`／`minimal` 标为不支持。两者在界面上必须呈现得不一样。

## 落地范围

| 层 | 文件 | 职责 |
|---|---|---|
| 契约 | `src/contracts/model-routing.ts` | D 全部契约与接收侧运行时校验（`isQuotaFacts`／`isModelRoutingAttempt`／`isSessionModelState` 等） |
| 契约 | `src/contracts/ui.ts` | 两层入口视图类型、`Settings.newSessionModelChoice`、`AppSnapshot.sessionModels`、六个操作与入口校验 |
| 判定 | `src/application/model-router.ts` | **纯函数** `decideModelRouting`：不碰端口、不发请求、不写状态 |
| 应用 | `src/application/session-models.ts` | `SessionModelRegistry`：`sessionModels` 的**唯一写入者**；选择版本与迟到结果作废 |
| 适配 | `src/adapters/pi/capability-port.ts` | 逐模型读 `thinkingLevelMap`，三义分开 |
| 适配 | `src/adapters/pi/quota-port.ts` | 无可靠来源即如实 `unsupported`；读取失败降级 `unknown`；形状不可核对不采信为可用 |
| 装配 | `src/main/assembly.ts` | 普通装配才建三个端口；验证装配（mock／pi-controlled）为 `null`，界面如实显示本实例无模型目录 |
| 界面 | `src/renderer/components/ModelEntry.tsx` | 两层入口（第一层事实摘要／第二层按来源分组搜索） |
| 界面 | `Composer.tsx`、`DraftState.tsx`、`Timeline.tsx`、`i18n.ts` | 入口挂载与会话模型状态透传 |

`state.sessionModels` 只是**持久化与快照的投影**，每次使用前从注册表重取，不作事实来源（`DCodeApplication.persistedState()`）。这样「谁在写这条状态」只有一处答案。

## 红反例回检（21 项注入缺陷，全部使对应用例转红）

绿项本身不算证据。冻结副本在 `/tmp/d-red/frozen`，驱动脚本 `/tmp/d-red/verify.py`（逐项注入 → 跑 D 行为测试 → 必须红 → 从冻结副本还原 → 校验还原后逐字节一致）。基线 36 项全绿；**21/21 注入后 exit 1，还原后与冻结副本无漂移**。

| 编号 | 注入的缺陷 | 结果 |
|---|---|---|
| M1 | 自动模式跳过能力筛选，任何候选都算适合 | RED |
| M2 | 有已知耗尽依据时也允许有界尝试（改标绕过接续要求） | RED |
| M3 | 共享池不再识别同池已耗尽，用另一窗口的剩余冒充可用 | RED |
| M4 | 把未知／不支持／过期都当成已确认可用 | RED |
| M5 | 把未知当成已知耗尽 | RED |
| M6 | 暂停／等待中的工作被选模唤醒 | RED |
| M7 | 迟到结果（改选／暂停／失效期间）不再拦截 | RED |
| M8 | 指定模式偷偷换成别的候选（擅自换备用） | RED |
| M9 | 指定模式额度未知也直接采信为采用 | RED |
| M10 | 有已确认可用候选时不采用，先制造无额度调用失败 | RED |
| M11 | 条件参数接受未被逐档核实的档位 | RED |
| M12 | 额度读取窗口内改选后，旧结果仍可写入实际采用 | RED |
| M13 | 设置默认值不再核对目录（存下指向不可用模型的默认） | RED |
| M14 | 选定目录里不存在的模型时不给出真实失效原因 | RED |
| M15 | 按模型名／布尔猜全六档 | RED |
| M16 | 无逐档资料时仍按 `reasoning` 布尔给出档位 | RED |
| M17 | 没有额度来源时跳过真实状态 | RED |
| M18 | 没有可靠来源时报成「可用」 | RED |
| M19 | 接收侧不再要求「可用」带更新时间与可核对来源 | RED |
| M20 | 接收侧不再要求「一个档位都没核实」时给出说明 | RED |
| M21 | 采用记录可以同时带失败原因（采用与失败不再分开） | RED |

### 回检过程本身暴露的覆盖缺口（已补用例，不靠改断言换绿）

- **M2 第一次注入时仍绿**：原用例里「全耗尽」场景只有一个候选，没有「已耗尽 + 未知并存」的情形，注入改不到行为。补了 `已知存在耗尽依据时，即使还有未知候选也不做有界尝试` 一例后转红。这说明绿过的用例未必咬得住判据。
- **M21 第一次注入时仍绿**：没有任何用例断言「`adopted` 记录不得带 reason」。补了直接断言与「判定产出的每条尝试记录都过接收侧校验」一例后转红。
- 另有一处工具链问题：第一版批量注入脚本（bash + heredoc）在两个用例上误报 `exit 0`，手工复现却转红。已换成 Python 驱动（`verify.py`），逐项打印注入前后的差异并校验还原字节一致；上表是 Python 驱动的结果，不是那版脚本的。

## 界面路径证据（隐藏窗口、隔离状态目录、普通装配 + loopback 目录）

`test/e2e/model-entry.test.mjs`，走**普通装配**（模型目录服务、Pi 预设目录与 D 的能力端口只在普通装配建立；验证装配为 `null`，入口会如实显示不可用）。目录源与预设端点都指向 loopback，不连公网 pi.dev。

实测输出：`[d-model-entry] {"grouped":{"allItems":1532,"filtered":139,"groupCount":42},"identity":{"checked":true,"n":8},"quota":"unsupported"}`

覆盖并通过的判据：

1. **两层结构**：第一层呈现选择方式、本次实际采用与条件参数，三者分别可辨；第二层按来源分组（42 组／1532 条），搜索 `anthropic` 收窄到 139 条，无匹配时给出空态。
2. **同名模型以来源与标识区分**：搜 `claude-sonnet-4-6` 得 8 条独立条目，每条都带自己的 modelId 文本，未被合并成一条。
3. **条件参数只用逐档核实的档位**：`anthropic/claude-opus-4-6` 的档位控件全部来自该模型真实的 `thinkingLevelMap`；标识只落在 `none/off/minimal/low/medium/high/xhigh/max` 之内；若只出现「默认」一项，则必须同时给出未核实／不支持的说明。
4. **改选只作用于后续请求**：改选后快照里该会话 `choice.mode === "explicit"`，而 `actual` 仍为 `null`（未假装已切换）、`lastResult` 仍为 `none`（判定成立不等于请求成功）；该会话没有任何非就绪态运行，时间线没有新增用户消息——不中断、不重投、不重复接收。
5. **额度按如实态呈现**：未读取时显示「尚未读取额度（未读取不等于可用，也不等于没有）」，不是可用也不是 0；点「读取额度」后实测 `state === "unsupported"`、`updatedAt === null`、带真实原因「当前接入没有账户额度查询来源，未能核实」，界面文案为「当前接入不支持额度查询 — 当前接入没有账户额度查询来源，未能核实」，**没有**显示成「额度可用」或「余额 0」。
6. **新会话默认与会话选择分别成立**：不指定会话时列出各会话自己的选择；指定会话时只返回该会话；两种情况下 `defaultChoice` 都仍是 `auto`，不受该会话显式选择影响。

## 冻结前全范围门槛

运行器 `/tmp/d-freeze-run1.sh`，台账与 raw 见 `evidence/`。每项 `cmd > <name>.raw.log 2>&1; ec=$?`，不接管道取退出码。

| 项 | 退出码 | 起止 | raw |
|---|---|---|---|
| `architecture:test` | 0 | 05:22:37 → 05:22:38 | `evidence/arch-test.raw.log` |
| `architecture:check` | 0 | 05:22:38 → 05:22:38 | `evidence/arch-check.raw.log`（69 源文件 PASS） |
| `typecheck` | 0 | 05:22:38 → 05:22:42 | `evidence/typecheck.raw.log` |
| `lint` | 0 | 05:22:42 → 05:22:47 | `evidence/lint.raw.log` |
| `build` | 0 | 05:22:47 → 05:22:52 | `evidence/build.raw.log` |
| `test:runtime` | 0 | 05:22:52 → 05:22:58 | `evidence/test-runtime.raw.log`（123 项） |
| `test:contracts` | 0 | 05:22:58 → 05:22:59 | `evidence/test-contracts.raw.log`（8 项） |
| D 行为测试 | 0 | 05:22:59 → 05:23:00 | `evidence/test-d-routing.raw.log`（36 项） |
| D 界面 E2E | 0 | 05:23:00 → 05:23:03 | `evidence/e2e-model-entry.raw.log` |

**源码身份（配方 `/tmp/dcode-source-identity.sh`：`src`/`test`/`tools` 按序排序后追加 6 个根配置，排除 `dist`/`out`/`evidence`/`node_modules`）**：

- 运行前：138 文件，`e6f6cbb1fd1662677a9bb5e577f63fbf5fa7621dbdc1121fb62ba7230bdaa359`，最新源码 mtime `2026-10-12T05:22:22 test/runtime/model-routing.test.ts`
- 运行后：138 文件，**同一聚合值**，同一 mtime
- 最新源码 mtime 早于门槛启动点（05:22:37）⇒ 整轮运行期间源码未变，九项 exit 0 对同一份源码成立

### 前一轮（`d-freeze1`）的两项 exit 1，如实保留

`architecture:check` 与 `lint` 在第一轮为 exit 1，**不删也不背书**。真因不是环境问题，是我自己的两处缺陷：

1. **仓库根多出一个游离 `model-router.ts`**：早前一次写入的目标路径写错，文件落在仓库根而非 `src/application/`。架构检查以 `[UNMANAGED] Source file has no declared module` 拦下（源文件数 70→69）。已用 `mavis-trash` 回收，该文件与 `src/application/model-router.ts` 此前逐字节相同（`440f8487…`），源码本体未受影响。
2. **新写的 D 测试文件有 47 处 Lint 错误**：`describe`／`it` 返回 Promise 未显式忽略（`no-floating-promises`），以及一个 `let` 应为 `const`、一个未使用变量。已按本仓既有写法修好，未放宽规则。

修完后重跑即上表九项全 0。**第一轮那两项 exit 1 对应的是与最终源码不同的版本，不能替当前源码说话。**

## 本轮修掉的真实缺陷（先红后绿）

| 缺陷 | 根因 | 发现方式 |
|---|---|---|
| 真实请求结束后 `actual` 永远为空 | `publishRequestFacts` 只在发送前那次读里调用，运行期轮询不发布 | 真实全链 E2E 首跑失败（"真实请求后应发布实际采用的模型"） |
| 切到来源 B 后界面仍说已采用 A | 「实际采用」那行复用了选择摘要 | 改选后的界面 DOM 断言 |
| 改选到 B，下一次请求仍发给 A | `effectiveTarget` 优先用 `actual`，把新选择盖住 | 双来源 E2E：`switchRequest` 断言 |
| 会话用量随视图变小回落 | 会话累计取「本次观测总量」而不是逐次记录 | `task-usage.test.ts`「较小视图不回落」 |
| 档位选完不进 SDK | 受控模型读 `streamOptions.thinkingLevel`，而 Pi 实际下发的是 `streamOptions.reasoning` | E2E 的档位精确断言 |
| 用量已记录但界面仍显示「尚无记录」 | 观测发布后没有置脏，快照不重渲染 | E2E 的界面用量断言 |
| 契约测试夹具缺必需字段 | G1/G2 加字段时没有同步更新夹具（`modelCandidates`／`actualResponseId`／`requests`） | `test:contracts` exit 1 |

## 2026-10-13 第三轮：限定预审残余的闭合（先红后绿）

对象是 1548／2111 两份限定预审点名的残余。每一项都配了**先红后绿**的行为用例：红的那次把被修的那一行改回去，确认用例转红，再恢复实现。

| 预审残余 | 本轮实际改动 | 反例（先红 → 绿） |
|---|---|---|
| `isUnverifiedOnly` 只看「有没有未核实项」，于是「一项已核实不支持 + 一项未知」也能执行 | 能力筛选改为：`已核实不满足` 优先于 `资料未核实`；只有**全部**必需能力都只是未核实的候选才走有界尝试 | `model-routing.test.ts`「一项已核实不支持 + 另一项未核实：仍出局」／「全部必需能力都未核实：仍是有界尝试」 |
| `attempted-unverified-capability` 不在接收侧 `ATTEMPT_OUTCOMES`，合法判定会被当成畸形拒掉 | 接收侧补齐该 outcome（不放松其它校验，未知 outcome 仍被拒） | `contracts-validation.test.mjs`「路由判定公开接收」 |
| 装配的身份集合只在启动时取一次；交互重建后的能力与账户端点仍是旧快照 | 身份集合改为**每次读取按当次目录记录与目录服务重新解析**；能力端口的身份/候选回调允许异步 | 与 `preset-catalog` / `model-setup` 真实装配 E2E 一起验 |
| custom 后端不登记其它已配置来源；preset 后端跳过同源的其它模型 | 两条装配共用同一个 `registerAdditionalSources`；当前 provider 的同源模型并入它自己的 provider 模型表；启动路径也登记全量集合 | `model-setup` E2E（keep 原 key／新 ID／下一 HTTP 请求／新回复标记） |
| 认证门与额度失效仍按设置里的「当前选择」猜在途来源 | 认证门按**本次请求实际来源**（会话有效目标，无目标时用当前后端来源）判定；`beginProviderAuth` 的相位核对覆盖任一会话实际在用的来源 | `request-identity-binding.test.ts`「认证门按会话实际来源」「换实际在用来源的凭据要核运行相位」 |
| 生产没有提供 `accountKey`；`invalidateSource` 只在测试里调用 | 额度观测带**本次请求真正使用的凭据＋端点**指纹；读取侧按当前绑定凭据算同一指纹，带身份时不跨身份回落；凭据提交成功即失效 | `request-identity-binding.test.ts`「额度观测按账户身份隔离」「凭据提交即让该来源的旧观测失效」「观测端与读取端算同一个身份指纹」 |
| 改选只落在端口打开/输入提交，运行中改选不到下一次 SDK 请求 | 改选/改档位后推给已打开的端口（经同一 `applySessionModel` 通路，不新建执行器）；推送**不阻塞**改选本身，投递与恢复前再收束 | `session-model-request.test.mjs`「运行中改选：下一次真实 SDK 请求就用新来源」（请求 0/1 属 A、请求 2 属 B 且带 high） |
| 打开端口的 await 窗口里改选到已耗尽来源，裁决结论仍替它背书 | 记住裁决时的代次与目标；打开端口与读令牌后若已漂移，按**此刻**的目标重新核条件 | `model-request-gate.test.ts`「打开端口窗口里改选到已耗尽来源」 |
| 空候选名单的自动模式无条件放行 | 空范围只让额度与能力无从判起；**等待明确继续**与**认证在途**与范围无关，任何范围下都拦 | `model-request-gate.test.ts`「空名单的自动模式：认证在途仍然拦得住」「等待明确继续期间清空名单：重投仍被拒」 |
| 恢复前只等推送，应用失败被吞掉（会带着旧模型恢复） | 恢复前**权威应用**模型与档位；应用不了就保持暂停并保留这次选择，如实说明 | `model-request-gate.test.ts`「恢复前应用模型失败：保持暂停并保留这次选择」 |
| `pause` 相位否决了「明确继续」，继续按钮永远恢复不了 | 明确继续时 `paused`/`pausing` 视为可推进，**恢复是否成立由执行端控制令牌裁定**；过期恢复按真实拒绝呈现（`工作状态已变化`），额度/能力/等待/认证仍逐条重核 | `model-request-gate.test.ts`「对暂停工作明确继续：条件成立就真的恢复」；`send-receipts.test.mjs`「stale 恢复拒绝」 |
| 「可靠 not-found 后重投」用例其实走的是新的 sendMessage | 夹具让 `lookupReceipt` 恒为可靠未找到，走真实 `retrySend` 同身份重投 | `model-request-gate.test.ts`「同身份 retrySend」 |
| 默认选择的**校验**在途保护登记得太晚，收束可以先完成、随后又写一次 | 在首个 await 之前认领在途（`claimSettingsSave`），收束必须等校验与写盘一起成立 | `model-request-gate.test.ts`「默认选择校验在途：关闭收束必须等校验与写盘一起成立」 |
| 保存测试把多次 save 合成一个 promise，证明不了 FIFO | 存储替身按到达顺序逐个入队、各自带完成信号；断言写入**已到达**、关闭在放行前**未完成**、完成顺序等于到达顺序 | `model-request-gate.test.ts`「默认模型保存走既有在途协调：关闭收束等的是这次写入」 |
| 两个来源的回复只是固定文案，证不了对应这一次的输入 | 受控模型回显本次请求真正收到的最后一条用户正文；E2E 对两个来源分别断言回复里的正文等于该轮随机串，且不互相冒充 | `session-model-request.test.mjs` 的 `reply-marker-a` / `reply-marker-b` |
| 窄窗＋检查器下输入行退回堆叠形态（compact 为 false） | 窄卡片时模型入口收成图标形态（可访问名称仍在 `aria-label`）；判定用**收起后的固有宽度**，与当前形态无关，不自激 | `composer-geometry.test.mjs`「单行垂直居中在窄窗与检查器打开时同样成立」 |
| 设置页「模型」分区入口用 `getByLabel` 定位，与新增的候选复选框/筛选框同名冲突 | 按**角色 + 准确名称**定位分区入口，不改产品含义 | `preset-catalog.test.mjs` 协同全路径（exit 0） |
| 流式模拟宿主缺 `sessionModels`/`taskUsage`，时间线初始化即崩 | 模拟快照补齐这两份字段（如实给「没有实际采用/没有用量/没有任务汇总」），并给模拟运行装一份有限桥（模型目录空、额度无来源） | `streaming-sim.test.mjs` 同块流式五组（exit 0，无 pageerror） |

**红项留档**：本轮红证据分别是 `/tmp/d-red-capability.log`（能力混合缺口）、`/tmp/d-red-contracts.log`（接收侧 outcome）、`/tmp/d-red-residual3.log`（恢复前应用）、`/tmp/d-red-drift-final.log`（打开窗口漂移）、`/tmp/d-red-scope-final.log`（空名单门控）、`/tmp/d-red-retry-final.log`（重投准入）、`/tmp/d-red-validate-final.log`（默认选择校验在途）、`/tmp/d-red-resume.log`（继续被暂停相位否决）、`/tmp/d-red-identity-final.log`（认证与额度身份）。每条都在被修的那一行上转红，不是靠改断言或放宽规则换绿。

## 已知边界与未覆盖（不得当作已完成）

- **真实账户额度仍未接、未验。** 额度事实取自**服务商真实响应头**（`StreamOptions.onResponse` → `PiQuotaPort.observe`），字段已按官方文档逐来源核实（Anthropic `anthropic-ratelimit-*` 与 `anthropic-workspace-id`；OpenAI 兼容 `x-ratelimit-*` 与 `Retry-After`）。但本片**没有用真实账户跑通过一次额度查询**：没有真实 profile、没有凭据、也没有付费探针。受控装配下只证明「同一响应多约束收齐」「观测失效」「按账户区分」这三条规则成立。
- **额度支持清单里的 `connected` 指本装配已接通读取通路**，不等于任何具体账户已验证；逐来源依据写在 `support()` 返回值里，界面按来源如实呈现。
- **费用估算未做**：没有任何已核验的价格与计费规则依据，因此界面不显示任何金额（spec 允许「缺依据不报金额」）。
- **任务用量已接入界面**，但范围只覆盖**执行端助手条目里的真实 `usage`**；某次请求缺用量字段时如实标缺口，不按零补齐。
- **能力三态的「catalog」依据**目前来自 Pi 内置目录逐模型字段；自定义接入没有内置资料，一律「未核实」并给出原因，不借用同名预设的真值。
- **未做**：真实服务商调用、付费模型探针、真实 profile/Home/凭据、手机端同一入口、可见窗口下的人工接受。
- **架构检查不证明**：类型导入指向的声明可能与最终运行文件不同；本片另经全量类型、Lint、构建与真实界面路径覆盖，仍不等于任何真实账户行为已被验证。

## 复算方式

```bash
# 全范围门槛（每项单独取真实退出码）
LEDGER_DIR=/tmp/d-freeze-recheck bash /tmp/d-freeze-run1.sh
# 红反例回检（21 项注入必须全部转红）
python3 /tmp/d-red/verify.py
# 源码身份
bash /tmp/dcode-source-identity.sh
```