# D Code Design

> Status: design entry point（设计入口）. It describes D Code's character and routes every design question to one authority; it is not a second component specification.

## Character

Calm, precise, capable.

D Code should feel like a focused native macOS workbench: the current task is obvious, technical depth is available without dominating the reading surface, and every visible state corresponds to a real product fact. It must not become a browser dashboard, a terminal skin, or a decorative imitation of another Agent product.

The workbench has three stable regions: Session Sidebar（会话栏）on the left, Main Workspace（主工作区）in the center, and Information Inspector（信息检查器）on the right. Settings（设置）and Archived Sessions（已归档会话）are Workbench Pages（工作台页面）inside the Main Workspace, not separate windows or names for the surrounding regions.

Each logical rail owns one Shared Rail Geometry（共享栏位几何）across the whole window. Settings navigation inherits the Session Sidebar's actual width, and the Information Inspector keeps one actual width across every scope and page; changing either rail anywhere updates every surface that displays it.

## Principles

- **Hierarchy before decoration**：先用布局、排版和渐进披露建立层级，再考虑表面效果。
- **Container before offset**：由容器、共同中心线和共享尺寸决定几何；页面不得用逐图标 `offset`（偏移）修补布局。
- **Native before custom**：优先使用 macOS 语义色、系统字体、真实 `Button`（按钮）、键盘焦点和 VoiceOver（旁白）语义。
- **Stable before animated**：Hover（悬停）、选中、焦点、按下和禁用只改变反馈，不推动标题、图标或相邻控件。
- **One geometry per rail**：同一逻辑栏位只有一份持久化实际宽度；页面可以改变内容或响应式呈现，但不能建立自己的宽度副本。
- **Result before process**：对话默认突出最终结果；thinking（思考）、工具和诊断过程按需展开。
- **Truth before reassurance**：只把已验证的状态显示为成功；活动、限制、失败和 destructive（破坏性）操作分别表达。
- **Accessible by construction**：视觉 glyph（字形）、组件表面和 hit target（命中区）分层设计；不能事后用透明层补可访问性。

## Authority

| Question | Authority |
|---|---|
| 当前 App 的视觉、组件几何、状态矩阵与验收规则 | [D Code 原生界面设计系统](doc/10-架构与运行/0002-D-Code-原生界面设计系统.md) |
| 当前 Host、Protocol 与运行边界 | [架构与运行](doc/10-架构与运行/README.md) |
| 跨版本最终产品行为 | [产品与交互](doc/20-产品与交互/README.md) |
| 当前版本承诺与验收 | [版本实施方案](doc/40-版本实施方案/README.md) |
| 外部产品只提供什么参考 | [外部产品与仓库参考](doc/参考文件/README.md) |
| 可执行 token（令牌）与共享 primitive（基础组件） | [`DesignSystem.swift`](app/Sources/PiDCode/Views/DesignSystem.swift) |

The design document defines semantic rules and observable results. Shared code owns concrete reusable values. Feature views consume those primitives; they do not become independent design authorities.

## Reference boundary

Codex informs workbench structure, MiniMax Code informs visible local Goal / Agent Team / permission and activity hierarchy, Curio informs design-document governance and container-driven geometry, ZCode informs information density, and Orca informs tabs and previews. D Code translates useful patterns into its own SwiftUI / AppKit components and Pi-backed product model.

References never authorize copying another product's brand, visual skin, assets, runtime, cloud authority, account system, remote control, or hidden implementation. Confirmed future behavior remains in `doc/20-产品与交互/`; it does not enter the current design-system document until the native component is implemented and verified.

## Change discipline

When a shared visual or interaction contract changes:

1. update the current design-system document;
2. update the shared token or primitive when the rule is reusable;
3. keep feature code free of duplicated magic values and per-glyph layout patches;
4. verify geometry, pointer, keyboard, VoiceOver, Dark Mode, Increase Contrast and Reduce Motion as applicable;
5. record version scope separately from design truth.
