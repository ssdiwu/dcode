# 版本实施方案

本目录保存已经确认、用于指导当前版本交付与验收的 PRD 和专项规格，也是发布、实现候选、本地回归基线、人工验收与持续回归状态的唯一文档索引。具体测试与人工证据保留在对应 PRD 的 Verification Record（验证记录）中，其他 README 只链接本页，不复制动态状态。文档完成后只要仍是有效验收基准，就继续保留在本目录；仅在被取代、放弃或只供追溯时归档。

当前公开源码基线是 `main@1e9f80a` 与源码标签 `v0.0.16`；`v0.0.1` 至 `v0.0.16` 均已推送到 `origin`。这里的 Published Source Tag（已发布源码标签）只证明源码可取回，不等于人工验收、GitHub Release、签名分发或真实设备行为已经成立；2026-08-22 本轮核验未发现 GitHub Release。精确 `v0.0.16` checkout 的 Host `136/136` 与 Swift `205/205` 自动测试通过，但下列已知缺口和各 PRD 未勾选的人工场景仍是当前验收边界。

### 当前已知缺口

- `0.0.16` 自定义供应商的 `modelOverrides.<model>.headers` 仍可能把 header 值正文带入 Swift 高级 JSON 编辑器，违反凭据脱敏合同；在修复前不要把该页面视为可安全验收的凭据界面。
- 搜索正文命中携带 `expectedEntryDigest`，App 当前又以 writable 打开；Protocol v1 明确拒绝这个参数组合，因此正文搜索结果打开尚未形成有效回归。
- `0.0.15` 的 `dcode_facts` 中 `evidence` / `project` 与 Swift 真实存储文件名、文档形状和退出状态值不一致；当前只有 `changes` / `lineage` 的生产合同有实现证据。
- `host/package-lock.json` 的根包版本仍为 `0.0.14`，与 `host/package.json`、App / Host 兼容门禁和源码标签的 `0.0.16` 不一致。

`0.0.13 → 0.0.20+ → 0.1.0` 的已确认顺序、逐版差异和“连续自构建后才晋升”的门禁见[版本界面演进](../20-产品与交互/原型/版本演进/README.md)。该路线允许按真实 dogfood 缺口继续增加 `0.0.x`。

| 文档 | Source（源码） | Acceptance（验收） | 职责 |
|---|---|---|---|
| [0017-0.0.16 自定义模型供应商与一次性资源调用产品需求](0017-0.0.16-自定义模型供应商与一次性资源调用产品需求.md) | Published Source Tag `v0.0.16` | Automated Passed；Manual Pending；Known Gaps | Pi `models.json` 自定义供应商管理与 Composer `+` 一次性资源调用验收权威；凭据脱敏、Prompt 参数提示与删除后目录刷新仍按已知缺口收口。 |
| [0016-0.0.15 界面即上下文与本机资源产品需求](0016-0.0.15-界面即上下文与本机资源产品需求.md) | Published Source Tag `v0.0.15` | Automated Passed；Manual Pending；Known Gap | Composer 预填、压缩可见性、本机资源页、扩展包启停、`dcode_facts`、文件树键盘与性能收口验收权威；facade 的两类生产合同仍待修正。 |
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
