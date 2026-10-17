# 扩展会话元数据事件

## 状态

首轮与第二轮独立审查指出的必要残余均已形成受控反例并修复。r3 完整门槛曾通过，但第三轮审查发现同一 owner 连续设置同名仍会重复投递事件，且当时首段状态文字与门槛记录冲突；r4 已改为由 Durable 原子回执判定名称变化，同名受控反例和八项完整门槛均通过，第四轮独立 Standards／Spec／CodeQuality 三项 PASS，Root 已接收本片有限消费者。此记录只覆盖 Pi 1.0 扩展 `session_info_changed` 的实际消费者；不表示完整 Pi SDK、普通服务商账户、前台人工视觉接受或整个产品已完成。

## 行为与所有权

扩展 `setSessionName(name)` 先沿当前资源线程 owner/actionId 写入原 Durable 会话。名称在写入前遵循 Pi `SessionManager.appendSessionInfo` 的公开规则：连续换行转为空格并去除首尾空白。Host 在原 Durable 事务里读取当前会话名称、比较规范化值并持久记录 `nameChanged`；只有确认实际变化才追加名称 entry。Worker 按该原子回执刷新只读 `SessionManager` 并向原 Runner 发 `session_info_changed`，不会用可能过期的本地视图决定是否投递；空名称投影为 `undefined`，连续同名设置不追加重复 entry 或重复发事件。

回调里的 `SessionManager` 与 `pi.getSessionName()` 都读同一写后投影。回调产生的后续扩展动作留在原 action flush 中收束。名称写回回执和后续普通请求均用单调 Durable entry-id 高水位接受快照，旧的异步请求快照不能覆盖较新的名称。只读重开只读回历史，不重载并重放元数据事件。

## 目标反例和验证

新增运行时场景通过真实 SDK Loader／Runner、资源 Worker、普通 `input` 事件及 Durable Host 路径验证：名称写入先于事件；规范化结果同时出现在事件、只读 SessionManager 与 `pi.getSessionName()`；同一规范化名称不会再次触发事件；只读重开不增加模型请求或重放事件。

新增 Worker 级交错反例在原名称 `Old Name` 已更新为 `New Name` 后，刻意将旧 `entries` 快照送入普通 `configuration` 和 `input` 请求；后续扩展读取必须仍为 `New Name`。该用例直接覆盖 Worker 的状态采纳门，不把源码静态推理冒充真实 Durable 竞态复现。

第一次目标测试在实现前观察到事件数量为 0；接线后测试又发现换行规范化与 SDK 不一致，按 Pi 实际规则修正。独立审查首轮进一步指出普通请求状态入口仍能覆盖名称回执，并指出本记录链接当时尚无文件；两项均已修复，须由第二轮审查确认。

首轮独立审查报告为 `/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd/Root-extension-session-info-event-independent-review-20261016.md`（SHA-256 `4b7ab9d5df1057ff0de8385d84a317ed81f6eb577ac966c44708f6dd72fcdd1a`）。首轮两个必要项分别是普通状态快照可能回滚新名称、导航链接目标缺文件。现在 name reply 与普通 request state 共用 entry-id 高水位接收门；新增 Worker 级反例把旧快照分别经普通 `configuration` 与 `input` 送入，要求后续仍读到 `New Name`。记录文件已实际创建并纳入导航。

第二轮独立审查确认首轮两项已关闭，但发现相反方向的时序缺口：普通新快照先刷新 Worker 视图后，稍后到达的 name reply 会因“当前名称已相同”而吞掉尚未交付的事件。该审查没有执行复现，也没有冒称真实 Durable RED。新增受控测试暂缓名称回复、先送携新名称的普通 `configuration`、再释放名称回复；在固定 r2 源码上，目标断言真实 RED（exit 1，`a newer ordinary snapshot must not suppress an undelivered name-change event`），r3 修后该目标 GREEN（exit 0）。第三轮独立审查确认此时序修复有效，但指出同一输入处理器同步调用 `setSessionName('B')` 与 `setSessionName(' B ')` 会各自捕获旧 Worker 名称并重复发出 `session_info_changed`；另指出本记录首段错误地把 r3 全量门槛写成待完成。固定 r3 产品文件加本轮测试 overlay 后，目标断言真实 RED（exit 1，事件数 `2 !== 1`）；门槛状态文字也已更正。r4 在原 Durable 事务内比较规范化后的当前名称并保存 `nameChanged` 回执；只有变化时追加名称 entry，Worker 按回执投递事件，不再用旧本地基线判定。原真实 SDK Runtime 目标及 r3 快照交错目标在同一次 focused run 中 2/2 通过。第三轮独立审查结论与固定 r3 身份核验记录在 `/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd/Root-extension-session-info-event-third-review-response-capture-20261016.md`。

此前针对固定 r2 候选的完整验证使用锁定的 `npm run verify`，真实命令出口为 0，运行前后均为 189 项 canonical 映射，SHA-256 aggregate `d638c96f2a886f81be579e657141b00a798b28edb63b7df3ccc707411a6515c9` 且完整文件映射相同；未超时。该轮结果只属于 r2 旧 Worker/test 字节，保留作历史，不用于当前结论。r3 修复后重新执行锁定的 `npm run verify`，真实 `exit 0`、657.556 秒、未超时；189 项 canonical 映射运行前后均为 `b107fd753390f6c7c9dd85823c0241a20348c1dc26efdab87bd710b543ad7ea3`，完整文件映射相同。架构正反样例 32/32，源码架构审计 83 项，TypeScript 检查通过，Lint 0 error／1 warning，runtime 480/480，contracts 14/14，隐藏桌面 E2E 125/125，均无 fail／skip／cancel。r3 原始输出、回执与前后身份在 `/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd/Root-extension-session-info-event-full-verify-20261016-r3/`。`python3 tools/launch-desktop.py --check` 在当前主目录返回版本 `0.1.0-dev`、入口与品牌资源存在、数据目录为 D Code Development；只检查，不启动窗口。当前 `git diff --check` 与 `doc/README.md` 本地链接核对通过。

r4 在 2026-10-16 对停写源码逐项运行 8 个门槛，均记录真实 exit 0 且各门前后 canonical 完整映射相同：架构正反 32/32、源码架构检查 83 项、TypeScript、Lint、构建、runtime 480/480、contracts 14/14、隐藏桌面 E2E 125/125，无 fail／skip／cancel。Lint 保留 0 error／1 项已有 Timeline warning；189 个 canonical 文件 aggregate 为 `3cc4b67e096bba575185292a3e3d5f41dabae41d18b9ca0f1ae56ac8746cf1ce`。8 门完整原始输出、逐门真实出口及身份台账在 `/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd/Root-extension-session-info-event-full-gates-r4-20261016/`。同一源码另运行 `python3 tools/launch-desktop.py --check`，真实 exit 0，核实当前来源根、`0.1.0-dev`、固定入口与品牌资源存在和 D Code Development 数据目录；未打开前台窗口。运行前后 `git diff --check` 与本地导航目标均通过。该检查是固定入口预检和隐藏 E2E，不等于 507 前台人工视觉接受。
第四轮独立审查固定候选为 489 项项目文件、214 项公开证据和 189 项 canonical 文件，完整 SHA-256 映射一致；八门逐项真实 exit 0，每门及总前后身份均与候选一致。Standards、Spec、CodeQuality 均 PASS，无本片必要剩余。审查报告 `/Users/diwu/.codex/visualizations/2026/10/02/01a0fd5d-2c45-7783-bdeb-42ce2e19d2dd/Root-extension-session-info-event-r4-independent-review-20261016.md`，SHA-256 `d0699c2853fb369045136ef36fb69f68a7bacd75f4f1066ff86d5ede3d60b050`。审查确认名称清空、重复 actionId 与 owner 门沿直接源码及锁定 SDK 合同成立，但没有将它们表述为本轮所有交错均另有受控测试。

固定 r3 候选已由第三轮独立审查拒绝；其后固定 r4 候选通过独立三项并由 Root 接收。已保存的完整恢复快照承接同一范围，文件身份见当前 `PROGRESS.md`。本片接收不扩展到完整 Pi SDK、真实服务商账户、前台人工视觉接受或整产品验收。

## 范围边界

本片没有增加第二历史、输入或执行 owner，也没有更换 Pi、改配置、接触真实用户目录／凭据或发付费模型请求。仍待完成的扩展 SDK 消费者、完整压缩／消息事件、typed/provider 原生配置、vision、`exec` 和命令专属 UI 等继续保留在 `PROGRESS.md`，不能由本片替代。
