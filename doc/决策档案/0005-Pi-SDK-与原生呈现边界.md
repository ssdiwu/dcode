# Pi SDK 与原生呈现边界

状态：Accepted（已接受）

`D Code` 通过 `pi-coding-agent` 的程序化 SDK 使用 Pi Session、模型、工具、分支与恢复等运行能力；`pi-agent-core` 与 `pi-ai` 是其底层能力。D Code 不启动完整 Pi CLI，不直接依赖或调用 `pi-tui`，也不把终端组件、字符帧或 ANSI 输出转换成产品界面。

所有用户可见界面由 D Code 自有 SwiftUI/AppKit 组件或受控内容渲染器实现。标准 `select`、`confirm`、`input`、`editor`、通知、状态和工作消息可以通过结构化 Host 事件进入原生界面；扩展请求 `custom`、Widget、header、footer、theme、terminal input 等 TUI 能力时，Host 必须发出 `extension.unsupported`，等待返回值的操作明确失败，其余操作明确忽略，不能调用 TUI factory、显示兼容终端面板或返回虚假成功。

Goal、Agent Team、跨会话通信等产品能力可以借鉴 dgoal、dteam、`pi-intercom`、`pi-messenger` 等既有扩展的机制，但由 D Code 定义自己的产品对象、结构化数据合同、生命周期与原生呈现；参考扩展包不是这些能力的必要运行时依赖。

已启用扩展可以经 Pi SDK 在 Host 中注册并执行 headless 工具；这与界面所有权是两条边界。D Code 不调用扩展的 `renderCall` / `renderResult` TUI 组件，而是将已识别的结构化工具结果投影为自有原生 presenter，未识别结构使用通用且安全的 fallback。例如 `pi-dhashline` 可以继续为模型提供带锚点的 read/edit/write/search 安全语义，但 D Code 的行锚点、边界行和 diff 界面由 SwiftUI 实现。“扩展已安装或已执行”不等于“D Code 使用了它的 `pi-tui` 界面”。

`@earendil-works/pi-coding-agent` 当前仍把 `pi-tui` 作为传递依赖安装。该文件可以存在于应用依赖闭包中，但 D Code 源码不得直接导入或调用它，也不得从打包目录强行删除 SDK 所需的私有依赖。未来上游如提供不含 TUI 的等价 headless SDK，可在不改变产品合同的前提下替换。

这一选择牺牲了任意 Pi TUI 扩展的无损兼容，换取单一原生呈现路径、明确的产品所有权和更小的界面耦合。未适配能力必须诚实失败；不能以恢复旧兼容面为理由重新建立第二条产品 UI 路径。
