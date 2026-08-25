# 任务上下文选择与 Product Store schema 演进边界

状态：Accepted（已接受；`0.0.28` 已实现 Product Store 与 Prompt Assembler 基础，正式编辑体验归 `0.0.29` Task Workbench）

## 背景

`AGENTS.md`、`DESIGN.md`、精确 PRD、术语表、项目 `doc/` 与 507 的 Global Knowledge（全局知识）都可能帮助 Agent 完成任务，但它们的职责不同。把固定的一组 Markdown 每轮全文注入，会让 D Code 看似“懂项目”、实际却无法解释为何读了某份文档；把整个 Content Vault（内容库）加入全局 Prompt 则会把长期知识变成噪音和隐式记忆。

同时，`0.0.28` 的 Product Store 初版 schema 尚未拥有 Task 级上下文事实。D Code 已承诺 `~/.dcode/` 是自己的产品权威，不能为了增加上下文选择而退回 Pi 配置、JSONL 或临时 UI 状态。

## 决定

1. 每个 Task 拥有一个 revisioned（带修订号）Task Context Selection（任务上下文选择）集合；其成员是有序、稳定的具体 Context Source（上下文来源），不是 Task Goal 中的一段文本、窗口打开历史或 Pi 的自动项目上下文。
2. `AGENTS.md` 是当前运行目录的强制规则来源，不进入可取消的选择列表。其他来源必须由用户或 D Code 的明确 Task 合同选择后才加载：
   - **Scope Document（作用域文档）**：相对 Task `cwd` 的具体普通文件。Project Scope 在 Worker worktree 中以同一相对路径映射，且必须在冻结 Git revision 中作为普通 blob（文件对象）物化；不能指向 `..`、绝对路径、符号链接、ignored（忽略）或仅本机文件。
   - **Global Knowledge（全局知识）**：当前用户 Home Directory（用户主目录）之下某个显式根目录中的具体文件。它允许引用 507 的 Content Vault，但不等于挂载、扫描或注入整棵目录。
3. 任务选择保存来源类型、根、相对路径、展示名、顺序与集合 revision；不保存文档正文、摘要、凭据或“自动学到的知识”。选中目录本身无效，选中来源在下一运行读取时必须是安全的普通文件、非符号链接并受大小限制。
4. Prompt Assembler（提示词组装器）只加载强制 `AGENTS.md` 加当前 Task Context Selection。每个 Effective Input（生效输入）和 Effective Prompt Receipt（生效提示词回执）都冻结 Task Context revision 与带类型/路径/hash/字节数的来源回执；后续文件修改不会改写历史回执。
5. 用户显式选中的来源在运行开始时缺失、越界、不可安全读取或含凭据，D Code 必须在 Pi Session 绑定与 Provider 请求之前拒绝该运行，不能静默漏掉一份选择。保存选择与持久化 Session Run 之间用 Context revision compare-and-set（比较并交换）校验，选择被并发更新时不发出旧 Prompt。
6. Product Store schema 从 v1 单向晋升到 v2。Host 在独占 lease 下先校验 v1、checkpoint 并在 `~/.dcode/migrations/` 写入私有只读前备份，再在一个 SQLite 事务中建立 Context tables、给全部已有 Task 补空选择集合、更新 schema metadata 与记录 `schema.promoted` 事件。失败不提交半个新 schema；成功后最低 reader version 升为 v2，不提供降级、反向转换或双写。

## 影响

- D Code 可以把“本轮读了什么”解释为 Task 的显式选择和不可变回执，而不再把固定文档枚举误称为 Context Selection。
- `PRODUCT.md`、`DESIGN.md`、`GLOSSARY.md`、精确 PRD、ADR 和 Project Knowledge 仍是一等文档类型；一等不等于默认进入每轮 Prompt。
- Global Knowledge 可以跨 Project 被复用，但每个 Task 只引用必要的具体文件，原文件不复制进 Product Store。
- `0.0.29` 负责把这套真实事实呈现为 Task Workbench 中的上下文编辑和可见回执；没有 UI 时 Foundation Console 只投影当前选择，不能伪装成已完成的全局知识体验。

## 未选择的方案

- **固定自动枚举一组项目文档**：无法表达任务相关性，也无法追溯用户或协调者为何选择它。
- **把 Context Selection 存进 Task Goal、Prompt 文本或 Pi JSONL**：丢失独立 revision、来源结构和 D Code 产品所有权。
- **选择整个 `doc/` 或 Content Vault 目录**：范围会随文件变化悄悄扩大，成本、噪音和安全边界不可解释。
- **允许每次运行继续读取 Pi 自动 project context**：会重新引入 Pi 身份和 D Code 选择之外的隐式来源。
- **schema 版本不变，把选择塞进 JSON blob**：无法建立可验证迁移、关系完整性、独立 revision 和后续界面投影。
