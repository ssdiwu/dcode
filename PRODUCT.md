# D Code Product Charter（产品宪章）

> Status: confirmed product charter（已确认产品宪章）。本文件定义 D Code 长期稳定的用户、使命、产品主干、核心价值和非目标，不复制当前实现、版本功能或逐项验收。

## Register

product

## 产品身份

D Code 是面向 macOS 的原生 `ADE（智能体开发环境）`，不是 Pi 客户端、Pi CLI 的 GUI，也不是一次性聊天工具。D Code 自己拥有项目、任务、会话、上下文、Agent 协作、能力、模型资源、知识、产物和证据；Pi SDK 是首个 Agent Runtime，负责模型循环和工具执行，但不拥有 D Code 的产品身份或耐久数据格式。

## 用户

核心用户是持续开发真实产品、内容与复杂项目的人。他们需要让一个任务跨多次讨论、多个 Agent、串行或并行执行、验证和返工仍保持同一身份，并能随时回到项目规则、设计、需求、术语、知识与原始事实继续工作。

## 产品使命

D Code 把 AI 工作从“围绕一段会话临时完成一次回答”提升为“围绕项目和任务持续完成可验收结果”。它既帮助用户开展普通项目，也最终能够在自己的全局创造模式中开发和自进化 D Code 本身。

## 产品主干

- User Scope（用户作用域）承载未选择 Project 的 Task，默认工作目录映射为当前用户 Home Directory；日常界面把它们直接列在「任务」分区，不把 User Home 或 User Scope 呈现为容器，也不把它伪造成默认 Project。
- Project（项目）是长期持续演化的产品与工作容器，拥有唯一项目目录、一等项目文档、Project Knowledge、Project Vision 和 Task 集合。
- Task（任务）是基本完成单位，必须恰好属于 User Scope 或一个 Project，并拥有短期目标、范围、计划、工作清单、多个 D Code Session、Agent Run、产物、证据与验收。
- D Code Session（D Code 会话）是任务拥有的对话与上下文容器，不是任务本身。一个任务可以没有、一个或多个会话。
- Task 可以指定一个 Coordination Session（协调会话）作为用户与 Coordinator Agent（协调智能体）持续沟通、派发和综合结果的默认入口；它仍只是任务拥有的一条会话。
- Agent Team（智能体团队）属于任务；Coordinator Agent 管理任务执行，成员 Agent Run 承担有界工作，每个 Agent Run 记录职责、实际模型、工具、上下文、执行目录、报告和证据。
- Capability Module（能力模块）统一实现能力；产品层区分基础能力、可选一等拓展、能力提供方与普通 Skill / 工具。

## 数据与上下文

- 当前用户的 `~/.dcode/` 是 D Code Data Root；D Code Product Store 在其中持久化 User Scope / Project、任务、会话、提交原文、生效输入、Agent Run、模型资源、能力配置、产物、证据与恢复事实。
- User Scope Task 的默认工作目录是用户 Home Directory，但产品数据仍进入 `~/.dcode/`；Project 源码和一等项目文档正文继续留在真实 Project Directory。
- Pi Session 可以一次性导入为 D Code Session；导入后独立演化，不双写、不持续同步，也不承诺导出后可由 Pi CLI 继续使用。
- 提交原文不可被技能展开、输入转换或压缩覆盖；生效输入和上下文投影可以组装、压缩和重建，但必须可追溯回原始来源。
- D Code 为每个运行生成自己的 System Prompt（系统提示词），完整替换 Pi 的通用身份，并明确告诉 Agent 当前 D Code 环境、角色职责和本轮真实可调用工具；工具清单与 Runtime 实际注册必须同源。
- `AGENTS.md`、`DESIGN.md`、`PRODUCT.md`、精确 PRD、`GLOSSARY.md`、Project Map 与 ADR 是带职责的一等项目文档，由 LLM 按任务需要读取，不把全部文档静默塞入系统提示词。
- 全局 Knowledge 与 Project Knowledge 分层；Project、Task 和 Session 只引用当前所需内容，不因一次会话自动复制或改写整库。

## 全局创造模式

Creation Mode（全局创造模式）只用于开发和自进化 D Code 自身。它复用同一项目—任务—会话—Agent 运行主干，串联能力开发、验证、自构建候选、受控切换、原任务恢复、人工验收与回滚。Codex 是当前引导开发环境，不是 D Code 的长期产品依赖。

创造模式不是权限模式，不服务普通项目，也不承诺在途 Runtime 热迁移。恢复任务、会话关系和证据，不等于伪装恢复已经消失的模型生成、工具调用或进程。

## 产品原则

1. **任务优先于会话。** 会话服务任务；会话结束、归档或切换模型都不会自动完成任务。
2. **D Code 拥有产品。** Runtime、模型供应商和外部服务可以替换，不能反向定义 D Code 的身份、界面或数据语义。
3. **原始事实可回查。** 摘要、推断、当前状态与原始输入、工具结果、项目决定必须可区分并可追溯。
4. **界面也是上下文。** 用户应当看见本轮使用了什么项目对象、文档和知识；不可见的隐式注入不能成为默认交互。
5. **复杂度渐进呈现。** 结果和下一步优先；过程、工具、诊断和深层技术事实按需展开。
6. **完成必须有证据。** 模型回复、Agent Run、测试、人工验收、提交、推送和发布分别成立，不自动互相推导。
7. **自进化必须可恢复。** 候选、切换、恢复、人工验收和回滚是独立门禁，不能以“模型已经改完”代替。

## 长期非目标

- 不把 Pi TUI、任意终端帧或其他 Agent 产品界面包装成 D Code。
- 不以 Pi JSONL、Pi 配置或任意外部 Runtime 的私有格式作为永久产品权威。
- 不让一个任务强制等于一条会话，也不让模型身份拥有任务或团队。
- 不把所有 Markdown、历史聊天和外部资料默认全文注入模型。
- 不把 Goal、看板、提醒事项或 Agent Team 变成彼此竞争的第二任务系统。
- 不把权限模式与创造模式混为一谈，不用运行中热手术替代候选、重启和回滚。
- 不以“未选项目”、nullable Project 或把整个用户主目录伪造成 Project 的方式表达 User Scope Task。

## 权威路由

- 项目入口与文档地图：`README.md`、`doc/README.md`
- 项目工作规则：`AGENTS.md`
- 项目术语：`GLOSSARY.md`
- 设计性格与设计权威：`DESIGN.md`
- 需求与验收：`doc/40-版本实施方案/` 中的精确 PRD
- 当前实现事实：`doc/10-架构与运行/`
- 难逆转决定与取代关系：`doc/决策档案/`
