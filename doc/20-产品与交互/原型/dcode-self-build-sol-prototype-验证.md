# D Code Sol 自迭代候选原型验证

状态：Prototype（用于 `0.0.26` 隔离 eval；不构成原生 App 验收）

## 验证问题

当 D Code 使用 Sol 修改自身后，自构建页能否让用户不读内部实现就完成三项判断：源码 checkout 是否正确、候选是否通过完整回归、这个候选是否只能本机重启而不能分发？

## 真实与模拟边界

- 页面信息层级、字段和文案来自 `0.0.26` 原生实现；按钮、验证时序、候选和重启结果均为内存模拟。
- 不读取真实 Pi 配置、Sol 认证、项目文件、Git diff 或候选 App，不执行测试、构建、替换、重启或发布。
- 真实自动证据仍来自 Swift / Host 回归、`app/build.sh` 候选构建、签名与 bundle 内 Candidate Manifest；原生界面仍待人工走查。

## 场景入口

- 默认：源码 checkout 有效、工作树有未提交改动，尚未验证或构建。
- `?source=invalid`：没有有效源码 checkout，验证用户能否修复来源。
- `?state=ready`：候选已经通过回归和签名，验证重启 / 发布判断。

## 完成信号

- 使用者能在不依赖模型文案的情况下说出 Source Checkout、Verification、Candidate 与 Active Build 的区别。
- 使用者不会把“测试通过、签名通过、已启动”说成 commit、人工验收或可发布。
- 使用者能从错误来源恢复到当前 D Code Project，并完成候选构建或明确停下。

## 2026-08-23 隔离 eval 结果

- 本地 session：`~/.mirasim/eval/sessions/260823-1733-dcode-sol-selfbuild`；状态 `local_only`，未连接或上传平台。
- 三个独立 `agent-browser` profile 在 `1280 × 800` 下全部 `succeeded`：脏工作树候选生成并重启、错误源码根恢复后生成候选、候选已就绪时区分本机重启与对外分发。
- 三位使用者都能复述 Source Checkout、Swift / Host 两项门禁、Candidate Manifest 摘要、签名、Local-only 边界，以及重启后仍待原生界面与真实 Pi 人工验收；没有把 Sol、版本号或“签名通过”单独当成发布证明。
- 共性摩擦：两个重启场景的主动作位于首屏之外；按钮进入视口前的首次点击没有现场变化，滚动后确认框正常出现。该问题未阻断任务，但应作为后续动作可见性需求保留。
- 证据包括 11 个规划 step、17 张操作后截图、逐 case runner log、完整 trace、bundle、feedback 与 SHA-256 manifest；全部浏览器 session 已关闭，本地测试服务已停止。

该结果只证明网页原型中的信息理解与决策路径，不证明 SwiftUI 原生布局、真实测试耗时、候选替换、会话恢复或 Sol / Pi 真实行为。
