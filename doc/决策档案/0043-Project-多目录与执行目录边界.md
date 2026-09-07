# Project 多目录与执行目录边界

状态：Proposed（草案骨架；2026-09-05 起草，待 507 确认。确认后取代 [ADR 0029](0029-Project-目录一一对应与会话-cwd-迁移边界.md) 的"一个 Project 对应一个目录"结论，并回写根 `GLOSSARY.md` 术语权威；不确认则须回退 `0.0.29` 基线中先行引入的 Primary / Linked / Execution Directory 术语）

## 背景

ADR 0029 确认"一个 D Code Project 对应一个目录"，该结论在 `0.0.25` 交付时成立。此后真实使用暴露出单一目录假设的代价：一个产品工作横跨多个本机目录（主仓库之外的知识库、资源目录、多仓库前后端）时，用户只能把多个目录伪装成一个目录，或把它们拆成多个 Project，两者都扭曲 Project 的产品身份。同时，"项目唯一目录"把 Project 身份与默认执行锚点绑死，Agent Run 的执行目录没有独立语义。

`0.0.29` 基线（`main@714a555`）的 `GLOSSARY.md` 已先行引入 Primary Directory（项目主目录）、Linked Directory（关联目录）与 Execution Directory（执行目录）术语；本 ADR 补齐其决策依据，使文档权威重新一致。

## 决定（候选，待确认）

1. **Project 拥有可选且至多一个 Primary Directory。** 它存在时，是新 Task、协调会话与未另行指定目录的 Agent Run 的默认执行锚点，也是默认 Git、项目规则与文件发现的锚点；它不拥有 Project。没有 Primary Directory 的 Project 合法存在（纯知识 / 规划项目），不得伪造目录身份。
2. **Linked Directory 只建立"可发现 + 显式选择"关系。** 关联使目录可被 Project 发现，由具体 Task / Agent Run 显式选择后才进入工作；不自动加入模型上下文、不自动加载其中的项目规则、不自动授予写入。
3. **Execution Directory 是 Agent Run 的运行期不变量。** 每个 Agent Run 启动前确定唯一执行目录（即 Runtime 中的 `cwd`），运行期间不可静默切换；需要换目录继续工作必须建立新的 Agent Run。涉及 Linked Directory 的 Git 写入工作使用该目录对应的受管隔离工作树；符合边界的非 Git 工作经验证后可使用原目录。Shell 命令内的临时 `cd` 只影响该次命令。
4. **目录不拥有 Project，目录集合不是 Project 身份。** Project 的名称、一等项目文档、Knowledge、Vision 与 Task 集合不依赖任何单一目录存在。
5. **取代关系。** 本 ADR 接受后取代 ADR 0029 的"一一对应"结论；0029 中"保持 Session 身份的 `cwd` 迁移、目录迁移二次选择"的经验继续适用于 Primary Directory 变更场景。

## 影响

- Product Store schema 需要表达 Project 与目录的一对多关系及 Run 级执行目录记录；演进路径（就地扩展或版本化晋升）与降级边界在多目录项目专项 PRD（版本待排期）中收口，延续 `0.0.28`"不支持降级"的既有结论方向。
- Task 创建、Composer 与派发流程的目录选择 UI 不在本 ADR 冻结，由多目录项目专项 PRD（版本待排期）与相应原型确认。
- 若本 ADR 被拒绝：回退 `GLOSSARY.md` 中的三个术语条目及 Project / Project Scope 定义改动，ADR 0029 继续成立。

## 待决问题（507 拍板后收口）

- Linked Directory 是否允许同一目录被多个 Project 登记？是否允许嵌套或互相重叠？
- Linked Directory 内的项目规则（如 `AGENTS.md`）确认不自动加载后，是否提供显式"按本次运行加载"入口？
- 既有单目录 Project 的无损迁移合同：唯一目录自动转为 Primary Directory，还是经用户确认转换？
- 受管隔离工作树在 Linked Directory 场景下的落点（跟随该目录所在仓库，还是集中到 Project Artifact Home）。

## 未选择的方案

- **维持目录一一对应（现状）**：跨目录工作被迫伪装成单目录或拆成多个 Project，Project 身份继续被目录绑架。
- **平权多目录（不设 Primary）**：默认执行锚点、Git 锚点与文件发现失去唯一性，每个 Run 都要用户手工选目录。
- **Task 任意携带目录、脱离 Project 登记**：绕过 Project Scope 归属与结构性 Scope 校验，重建 ADR 0042 要阻止的第二写入路径。
