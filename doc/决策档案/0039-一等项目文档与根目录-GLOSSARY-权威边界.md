# 一等项目文档与根目录 GLOSSARY 权威边界

状态：Accepted（已接受；定义 D Code 项目上下文的一等文档和术语权威）

## 背景

D Code 的项目上下文不应只是一批同等权重的 Markdown 文件。`AGENTS.md`、`DESIGN.md`、产品需求、术语和决策分别回答不同问题，LLM 需要按任务直接读取原文、理解作用域并辨认取代关系。把术语改为 JSON 虽便于程序读取，却会牺牲解释、边界、链接和共同编辑；同时维护 Markdown 与 JSON 正文又会形成双权威。

## 决定

1. First-class Project Document（一等项目文档）是 D Code 能识别类型、权威职责、作用域、版本与取代关系，并能按需把当前原文连同路径和 revision 加载给 LLM 的项目对象；一等不等于每轮全文注入。
2. 根 `README.md` 与按需存在的 `doc/README.md` 是 Project Map；`AGENTS.md` 是智能体规则；`DESIGN.md` 是设计文档；`PRODUCT.md` 是稳定产品宪章；具体 PRD 是需求与验收合同；根 `GLOSSARY.md` 是术语唯一权威；ADR 保存难逆转决定及取代关系。
3. `AGENTS.md` 在 Agent Run 开始及作用域变化时必须解析；其余文档根据 Task、用户动作、术语冲突和当前判断按需读取。加载必须保留来源、作用域、revision 与当前或历史身份，不把任意 Markdown 升级为系统规则。
4. `GLOSSARY.md` 使用 Markdown 作为人和 LLM 共同维护的唯一正文权威。若实现需要结构化检索，可以从 Markdown 生成带 schema 版本的 JSON 索引或数据库缓存；派生物可删除重建，不接受人工并行编辑，也不进入 Git 作为第二正文权威，除非未来有独立决策取代本条。
5. `PRODUCT.md` 不再复制版本功能、当前实现状态和逐项验收；这些分别归当前实现文档、版本 PRD 与验证记录。

## 影响

- 项目文档从“普通文件搜索结果”升级为有类型和职责的上下文来源。
- 根 `GLOSSARY.md` 取代 `doc/术语表.md`；旧路径不保留第二份定义正文。
- README 负责指路，不能覆盖 AGENTS、DESIGN、PRODUCT、PRD、GLOSSARY 或 ADR 的结论。
- 上下文组装可以按需、可见、可追溯地加载文档，而不是把整个项目文档库静默塞入系统提示词。

## 未选择的方案

- **以 JSON 作为术语正文权威**：结构严格但不适合维护有解释、有边界和有链接的产品语言。
- **Markdown 与 JSON 双向编辑**：无法稳定决定冲突时哪一份是真相。
- **每轮全文加载全部一等文档**：成本和噪音会随项目增长，且无法表达任务相关性。
