# D Code 0.0.27 自进化运行回执原型验证

状态：Validated Web Prototype（五轮隔离网页 eval 已收敛；不构成原生 App 或真实自进化验收）

## 验证问题

不同用户能否只看回执界面，正确区分 Candidate Manifest、Bootstrap Receipt、Full Receipt、Session 恢复、人工验收、完整循环 `1/3` 与发布，并在阻塞或恢复失败时采取不会丢失当前工作的动作？

## 场景入口

- `?mode=bootstrap&state=session_restored`：`v0.0.26 → v0.0.27` 恢复后补建，引导回执不计数。
- `?mode=full&state=candidate_ready`：下一版 Full Receipt，主动作必须在 `1280 × 800` 首屏可见。
- `?mode=full&state=restart_blocked&reason=active_run`：Sol 或工具仍在执行，App 未替换。
- `?mode=full&state=app_started`：新 App 已启动但 Session 尚未恢复。
- `?mode=full&state=recovery_required&reason=session_restore`：Session 恢复失败，可重试或回滚。
- `?mode=full&state=rolled_back`：候选未通过，本轮不计数。

## 真实与模拟边界

- 页面层级、状态名、证据边界和动作来自 `0.0.27` PRD / ADR 与 Swift 实现；候选、时间、重启、Host、Session 恢复和回滚均为内存模拟。
- 不读取真实 Pi 配置、会话、Goal、凭据或源码，不执行测试、构建、App 替换、重启、人工验收、commit、tag 或发布。
- App 端 eval 驱动已退役，本轮只能验证网页信息理解与决策路径；真实 `0.0.26 → 0.0.27` Bootstrap 和 `0.0.27 → 0.0.28` Full Receipt 仍需原生人工证据。

## 完成信号

- Bootstrap 使用者明确说出“恢复后补建、没有重启前证据、不计入 `1/3`”。
- Full 使用者无需滚动即可找到主动作，并只在人工验收后把本次理解为完整循环。
- Restart Blocked 使用者理解 App 未替换、工作未丢失，应返回原 Session 收口。
- Recovery 使用者不会误点验收，能在重试恢复和回滚之间作出有证据的选择。
- 没有人把 Local-only、签名、Session 恢复或 `1/3` 说成 commit、tag 或发布。

## Eval 结果

本地 session：`/Users/diwu/.mirasim/eval/sessions/260823-1853-dcode-self-evolution`

- Round 1：四个基础场景均完成安全决定；发现证据详情未暴露为可操作控件，以及下一构建区常驻造成两次无关路径漂移。
- Round 2：详情改为显式可访问按钮、证据与下一构建统一默认隐藏后，用户可以直接核对证据；同时发现 Blocked / Rolled Back 仍复用了成功时间线，形成事实冲突。
- Round 3：按状态重写 Assurance、计数、进度和事件投影。Bootstrap 用户保留重启前未知且不计数；Recovery 用户看到失败与回滚事件；全新发布负责人在 Blocked 状态确认重启未执行、App / Session 未改变。
- Round 4：从未参与修改的新开发者完整走通 Candidate Ready → 重启请求 → 新 App → Session 恢复 → 人工验收，并只在人工确认后理解为完整循环 `1/3`。
- Round 5：独立交付审查后补测追加式事件历史；人工接受会追加验收事件，恢复后人工发现回归会保留 Session 恢复并继续追加人工问题与回滚，不再把成功恢复改写成恢复失败。

共执行 13 个 case；12 个进入行为结论，1 个因 GUI 操作缺少紧随截图被排除。最后受影响路径没有新增高 / 中优先级需求，`converged: true`。

## 评测后原型约束

- `候选已就绪` / `暂不能重启` 只表示 Candidate 已验证，不得显示成已经建立 Full Receipt；计数为“尚未开始”。
- 技术证据与下一构建配置由同一个“查看证据与构建详情”按钮按需展开，初态不占据当前回执的主路径。
- Bootstrap 的第一阶段固定为“重启前记录未知”；不能把旧版本没有写下的时间倒填为完成。
- Full 时间线严格按状态截断；Blocked 显示未执行，Recovery 显示恢复失败，Rolled Back 追加回滚事件，只有 Session Restored / Manual Accepted 才出现恢复成功。
- 网页里的所有切换、Host、Session 和回滚仍是内存模拟；评测结果不得写成原生 App 运行证据。
