# D Code Design

> Status: design entry point（设计入口）. It describes D Code's character and routes every design question to one authority; it is not a second component specification.

## Character

Calm, precise, capable.

D Code should feel like a focused native macOS ADE: the current Project and Task are obvious, Sessions and Agent Runs remain available without becoming the product spine, technical depth is available without dominating the reading surface, and every visible state corresponds to a real D Code fact. It must not become a browser dashboard, a terminal skin, a Pi CLI skin, or a decorative imitation of another Agent product.

The workbench has two persistent structural regions: Navigation Sidebar（导航栏；当前实现名会话栏）on the left and Main Workspace（主工作区）in the center. When a Task is active, its compact Task HUD（任务浮层）remains a visibly inset, independently rounded floating card in the workspace's upper-right gutter, never a third rail. The Main Workspace reserves paired safety gutters around a stable reading canvas before laying out that card, so HUD updates neither cover nor move reading content. Only when width is insufficient may it overlap the reading area and gain collapse / reopen controls. Information Inspector（信息检查器）appears as a full-height right rail only when the user opens a file, Artifact, Diff or another object that needs sustained inspection. Settings（设置）and Archived Sessions（已归档会话）remain Workbench Pages（工作台页面）inside the Main Workspace.

Each structural rail owns one Shared Rail Geometry（共享栏位几何）across the whole window. Settings navigation inherits the Navigation Sidebar's actual width, and every full-height Information Inspector uses one shared width. Task HUD is content-sized and never creates a second stored rail width.

## Brand identity

507 于 2026-09-06 选定 C-A 黑白变色龙作为 D Code 标志：头部保持空心，卷尾承担实心视觉分量，`</>` 与四肢共用造型。系统图标使用浅色底板，界面内使用随主题变色的透明标志。母版、导出命令与全端消费入口由 [品牌资源](app/Resources/README.md) 维护。

## Principles

- **Hierarchy before decoration**：先用布局、排版和渐进披露建立层级，再考虑表面效果。
- **Container before offset**：由容器、共同中心线和共享尺寸决定几何；页面不得用逐图标 `offset`（偏移）修补布局。
- **Native before custom**：优先使用 macOS 语义色、系统字体、真实 `Button`（按钮）、键盘焦点和 VoiceOver（旁白）语义。
- **Stable before animated**：Hover（悬停）、选中、焦点、按下和禁用只改变反馈，不推动标题、图标或相邻控件。
- **One geometry per rail**：同一逻辑栏位只有一份持久化实际宽度；页面可以改变内容或响应式呈现，但不能建立自己的宽度副本。
- **Result before process**：对话默认突出最终结果；thinking（思考）、工具和诊断过程按需展开。
- **Truth before reassurance**：只把已验证的状态显示为成功；活动、限制、失败和 destructive（破坏性）操作分别表达。
- **Accessible by construction**：视觉 glyph（字形）、组件表面和 hit target（命中区）分层设计；不能事后用透明层补可访问性。
- **Task before session**：任务是完成单位；会话、Agent Run 和过程视图服务任务，不反向成为工作身份。
- **Overview floats, inspection docks**：任务进度、Agent Team 与交付物使用轻量浮层；只有需要连续阅读和操作的文件、Diff 与 Artifact 详情占据全高右栏。
- **Source before summary**：摘要、推断和上下文投影必须能回到提交原文、一等项目文档、工具结果与已确认决定。
- **D Code before runtime**：Pi SDK 或其他 Runtime 只提供运行能力；产品对象、数据、配置和原生呈现由 D Code 拥有。
- **Self-hosting with recovery**：全局创造模式通过候选、重启、恢复、人工验收和回滚开发 D Code 自己，不用热迁移伪装连续性。

## Authority

| Question | Authority |
|---|---|
| 当前 App 的视觉、组件几何、状态矩阵与验收规则 | [D Code 原生界面设计系统](doc/10-架构与运行/0002-D-Code-原生界面设计系统.md) |
| 当前 Host、Protocol 与运行边界 | [架构与运行](doc/10-架构与运行/README.md) |
| 稳定产品使命、产品主干与长期非目标 | [产品宪章](PRODUCT.md) |
| 项目专有概念与禁用混称 | [项目术语](GLOSSARY.md) |
| 跨版本最终产品行为 | [产品与交互](doc/20-产品与交互/README.md) |
| 当前版本承诺与验收 | [版本实施方案](doc/40-版本实施方案/README.md) |
| 外部产品只提供什么参考 | [外部产品与仓库参考](doc/参考文件/README.md) |
| 可执行 token（令牌）与共享 primitive（基础组件） | [`DesignSystem.swift`](app/Sources/PiDCode/Views/DesignSystem.swift) |

The design document defines semantic rules and observable results. Shared code owns concrete reusable values. Feature views consume those primitives; they do not become independent design authorities.

## Reference boundary

Codex informs workbench structure and self-hosting workflow, MiniMax Code informs visible local Goal / Agent Team and activity hierarchy, Curio informs design-document governance and container-driven geometry, ZCode informs information density, and Orca informs tabs and previews. D Code translates useful patterns into its own SwiftUI / AppKit components and D Code-owned product model; Pi SDK remains a runtime reference, not a visual or data authority.

References never authorize copying another product's brand, visual skin, assets, runtime, cloud authority, account system, remote control, or hidden implementation. Confirmed future behavior remains in `doc/20-产品与交互/`; it does not enter the current design-system document until the native component is implemented and verified.

## Change discipline

When a shared visual or interaction contract changes:

1. update the current design-system document;
2. update the shared token or primitive when the rule is reusable;
3. keep feature code free of duplicated magic values and per-glyph layout patches;
4. verify geometry, pointer, keyboard, VoiceOver, Dark Mode, Increase Contrast and Reduce Motion as applicable;
5. record version scope separately from design truth.
