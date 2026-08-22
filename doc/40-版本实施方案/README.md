# 版本实施方案

本目录保存已经确认、用于指导当前版本交付与验收的 PRD 和专项规格，也是发布、实现候选、本地回归基线、人工验收与持续回归状态的唯一文档索引。具体测试与人工证据保留在对应 PRD 的 Verification Record（验证记录）中，其他 README 只链接本页，不复制动态状态。文档完成后只要仍是有效验收基准，就继续保留在本目录；仅在被取代、放弃或只供追溯时归档。

`0.0.17`（`837af03`）、`0.0.18`（`617249e`）、`0.0.19`（`8f0c319`）已提交到 `main`（其后 `5ad3b06` 为首页品牌资产追加，HEAD 以实际 checkout 为准）；`0.0.20` 已按 0021 PRD 完成实现与自动门禁并提交到 `main`（2026-08-22 本机，Swift 246/246、Host 143/143；tag 待人工验收后打）。公开源码标签仍至 `v0.0.16`，`v0.0.17`–`v0.0.19` 待人工验收后打标推送。（历史核验：`0.0.19` 门禁 Swift 238/238、Host 142/142。）这里的 Published Source Tag（已发布源码标签）只证明源码可取回，不等于人工验收、GitHub Release、签名分发或真实设备行为已经成立；2026-08-22 本轮核验未发现 GitHub Release。各 PRD 未勾选的人工场景仍是当前验收边界。

### 当前已知缺口

此前记录的四项缺口已全部收口：`modelOverrides.<model>.headers` 凭据正文不再进入 Swift（0.0.16 审计 P1，40e02b9 修复、0.0.17 补嵌套脱敏断言）；搜索正文命中打开不再携带被 Protocol v1 拒绝的 `expectedEntryDigest`（40e02b9 修复、0.0.17 加回归钉子并删除误导审计的死代码）；`dcode_facts` 的 `evidence` / `project` 合同已对齐 Swift 真实存储（40e02b9 修复文件名与形状，0.0.17 再修 `changes.source` 枚举、project 符号链接归属并落地 golden fixture）；`host/package-lock.json` 版本已回补并随 `0.0.17` 提版保持一致。当前剩余边界为各 PRD 未勾选的人工验收场景。

`0.0.13 → 0.0.20+ → 0.1.0` 的已确认顺序、逐版差异和“连续自构建后才晋升”的门禁见[版本界面演进](../20-产品与交互/原型/版本演进/README.md)。该路线允许按真实 dogfood 缺口继续增加 `0.0.x`。

| 文档 | Source（源码） | Acceptance（验收） | 职责 |
|---|---|---|---|
| [0021-0.0.20 Composer 命令面板与附件产品需求](0021-0.0.20-Composer-命令面板与附件产品需求.md) | Committed `main`（tag 待人工验收后打） | Automated Passed；Manual Pending |
| [人工验收 0.0.17–0.0.20 用户路径清单](人工验收-0.0.17-0.0.20-用户路径清单.md) | —（验收辅助，非 PRD） | 面向用户路径的走查清单：输入与附件 / Markdown / HTML / 恢复 / 版本一致性；结论回填各 PRD 的人工验收项。 | 统一 `/` 面板（扩展命令 / 命令 / Skill / 模板混排 + 类型标注 + 悬停描述）、`+` 附件入口（图片经协议 `images` 进入模型输入、文件插入路径引用）与扩展就绪横幅降噪（ADR 0028）的验收权威。 |
| [0020-0.0.19 失败与恢复加固产品需求](0020-0.0.19-失败与恢复加固产品需求.md) | Committed `main@8f0c319`（tag 待人工验收后打） | Automated Passed；Manual Pending | 中断三态辨认与恢复入口（ADR 0027）：Host 重连、半条 JSONL 受控修复、promptId/steerId 幂等、store 熔断可见化与显式重试、恢复链路去静默的验收权威。 |
| [0019-0.0.18 HTML 编辑缓冲区与隔离即时预览产品需求](0019-0.0.18-HTML-编辑缓冲区与隔离即时预览产品需求.md) | Committed `main@617249e`（tag 待人工验收后打） | Automated Passed；Manual Pending | HTML 编辑（复用 ADR 0025 缓冲区）、隔离 WKWebView 即时预览与网络询问边界（ADR 0026）验收权威。 |
| [0018-0.0.17 Markdown 编辑缓冲区与安全保存产品需求](0018-0.0.17-Markdown-编辑缓冲区与安全保存产品需求.md) | Committed `main@837af03`（tag 待人工验收后打） | Automated Passed；Manual Pending | Markdown 编辑缓冲区、Source / Preview 切换与安全保存（ADR 0025）验收权威；同时收口 0.0.16 三项审计缺口、`dcode_facts` 残留与 `models.json` 并发写入收紧。 |
| [0017-0.0.16 自定义模型供应商与一次性资源调用产品需求](0017-0.0.16-自定义模型供应商与一次性资源调用产品需求.md) | Published Source Tag `v0.0.16` | Automated Passed；Manual Pending；0.0.17 收口审计缺口 | Pi `models.json` 自定义供应商管理与 Composer `+` 一次性资源调用验收权威；审计发现的 argumentHint / 删除刷新 / 嵌套 headers 缺口与并发写入已在 0.0.17 收口。 |
| [0016-0.0.15 界面即上下文与本机资源产品需求](0016-0.0.15-界面即上下文与本机资源产品需求.md) | Published Source Tag `v0.0.15` | Automated Passed；Manual Pending；facade 合同 0.0.17 收口 | Composer 预填、压缩可见性、本机资源页、扩展包启停、`dcode_facts`、文件树键盘与性能收口验收权威；facade 两类生产合同的不一致已在 0.0.17 修复并落地 golden fixture。 |
| [0015-0.0.14 主页落地 Composer 与界面收口产品需求](0015-0.0.14-主页落地-Composer-与界面收口产品需求.md) | Published Source Tag `v0.0.14` | Automated Passed；Manual Pending | 主页会话前草稿、会话打开加载态、⌘N、发送按钮与字号收口、Host 诊断页及 ADR 0023 固定完全访问验收权威。 |
| [0014-0.0.13 第一次 Self-build Loop 产品需求](0014-0.0.13-第一次-Self-build-Loop-产品需求.md) | Published Source Tag `v0.0.13` | Automated Passed；Core Manual Loop Pending | 候选构建隔离、受控替换 / 回滚 / 重启恢复与第一次真实闭环验收权威。 |
| [0013-0.0.12 结构化验证证据产品需求](0013-0.0.12-结构化验证证据产品需求.md) | Published Source Tag `v0.0.12` | Automated Passed；Manual Pending | bash 执行证据账本、退出推导、revision 补全、会话检查器呈现与非门禁边界权威。 |
| [0012-0.0.11 只读 Exact Git Diff 产品需求](0012-0.0.11-只读-Exact-Git-Diff-产品需求.md) | Published Source Tag `v0.0.11` | Automated Passed；Manual Pending | 逐文件 / 逐 hunk 行级 Git 差异、staged / unstaged 分流、诚实截断与只读边界权威。 |
| [0011-0.0.10 Project Trust 与动作级权限产品需求](0011-0.0.10-Project-Trust-与动作级权限产品需求.md) | Published Historical Tag `v0.0.10` | Superseded（ADR 0023）；历史未验项 N/A | 保留当时的权限闸门、授权语义、权限卡与审计记录；机制已于 `0.0.14` 整体移除，仅作历史追溯。 |
| [0010-0.0.9 打开即接管产品需求](0010-0.0.9-打开即接管产品需求.md) | Published Source Tag `v0.0.9` | Automated Passed；Manual Pending；Search Regression | 打开即接管、租约抢占、冲突卡重接、只读观察删除与性能收口权威；搜索正文命中打开的当前回归另见已知缺口。 |
| [0009-0.0.8 AppModel 域拆分与测试基线产品需求](0009-0.0.8-AppModel-域拆分与测试基线产品需求.md) | Published Source Tag `v0.0.8` | Automated Passed；Manual Pending | AppModel 领域子模型、`HostProviding` 注入、Fake-host 集成测试、dgoal 融入与上下文构成验收权威。 |
| [0008-0.0.7 模型设置与回复运行信息产品需求](0008-0.0.7-模型设置与回复运行信息产品需求.md) | Published Source Tag `v0.0.7` | Automated Passed；Manual Pending | 已认证 Pi 模型目录、Provider 关联、全局选择设置、steer / queue、Context / Thinking / 轮次导航与回复运行信息权威。 |
| [0007-0.0.6 活动视图与运行状态产品需求](0007-0.0.6-活动视图与运行状态产品需求.md) | Published Source Tag `v0.0.6` | Automated Passed；Manual Pending | Activity View、可靠 Run State、完成关注态、Interaction Dock、会话前模型选择与 Context 圆环权威。 |
| [0006-0.0.5 后续消息队列产品需求](0006-0.0.5-后续消息队列产品需求.md) | Published Source Tag `v0.0.5` | Automated Passed；Manual Pending | 后续消息队列、新会话延迟创建、Composer 焦点与左右栏宽度收口权威。 |
| [0005-0.0.4 Workspace Tab 与只读文件预览产品需求](0005-0.0.4-工作区标签与只读文件预览产品需求.md) | Published Source Tag `v0.0.4` | Automated Passed；Manual Pending | 唯一会话主页面、按需文件标签、受限只读文件预览、置顶区与会话级摘要权威。 |
| [0004-0.0.3 会话路径与复制归档产品需求](0004-0.0.3-会话路径与复制归档产品需求.md) | Published Regression Tag `v0.0.3` | Automated Passed；Manual Pending | 路径草稿、完整会话复制、直接归档、置顶、轮次级会话与 Markdown 呈现权威。 |
| [0003-0.0.2 可见会话搜索产品需求](0003-0.0.2-可见会话搜索产品需求.md) | Published Regression Tag `v0.0.2` | Historical Automated Passed；Manual Pending；Current Regression | 可见范围、全文搜索、筛选与定位权威；当前正文命中打开回归另见已知缺口。 |
| [0002-0.0.1 用户首页与项目工作台产品需求](0002-0.0.1-用户首页与项目工作台产品需求.md) | Released Source `v0.0.1` | Recorded Acceptance | `v0.0.1` 的范围、验收记录与持续回归基准。 |
| [0001-首个可日常使用版本产品需求](0001-首个可日常使用版本产品需求.md) | Historical Baseline | Selective Regression | 只保留 Pi 会话权威、原生聊天 / 结构化呈现、安全与 App 生命周期约束；观察态、按需写入与 Write Intent 条款已由 ADR 0018 取代。 |
