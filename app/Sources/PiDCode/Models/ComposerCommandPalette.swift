import Foundation

/// Composer 统一命令面板行（0.0.20）：斜杠面板一次混排 扩展命令、命令、Skill 与
/// Prompt 模板，行尾标注资源类型；描述单行常显，悬停经 `help` 显示完整描述。
/// 扩展命令来自 `session.getCommands`（可写会话的实时注册表），其余来自
/// `resources.list`（与 设置 > 本机资源 同源）；两边都会列出扩展命令，按名去重，
/// 以 getCommands 为准。
struct ComposerCommandSuggestion: Identifiable, Equatable, Sendable {
    /// 插入输入框的调用文本（0.0.16 `composerInvocationText` 合同：只预填不发送）。
    let invocationText: String
    /// 面板显示的调用名，如 `/mcp`、`/skill:llm-wiki`。
    let displayCommand: String
    let description: String?
    /// 行尾类型标签：扩展 / 命令 / Skill / 模板。
    let typeLabel: String
    let id: String

    /// help 悬停全文：类型、调用名与完整描述。
    var hoverDescription: String {
        var lines = ["\(typeLabel) · \(displayCommand)"]
        if let description, !description.isEmpty {
            lines.append(description)
        }
        return lines.joined(separator: "\n")
    }

    /// 合并两类来源并按片段过滤（片段为空 = 面板展开全部）。
    /// 顺序：扩展命令（getCommands）在前，resources 的 命令 / Skill / 模板 在后，
    /// 与 0.0.16 `+` 菜单的分组顺序一致；同名资源只保留 getCommands 版本。
    static func build(
        commands: [CommandDescriptor],
        resources: [ResourceCommandEntry],
        fragment: String
    ) -> [ComposerCommandSuggestion] {
        let extensionNames = Set(commands.map { $0.name.lowercased() })
        func matches(_ name: String) -> Bool {
            fragment.isEmpty || name.localizedCaseInsensitiveContains(fragment)
        }
        var rows: [ComposerCommandSuggestion] = commands.compactMap { command in
            guard matches(command.name) else { return nil }
            return ComposerCommandSuggestion(
                invocationText: "/\(command.name) ",
                displayCommand: "/\(command.name)",
                description: command.description,
                typeLabel: "扩展",
                id: "command/\(command.source)/\(command.name)"
            )
        }
        for entry in resources {
            guard !extensionNames.contains(entry.name.lowercased()) else { continue }
            let typeLabel: String
            if entry.name.hasPrefix("skill:") {
                typeLabel = "Skill"
            } else if entry.source == "prompt" {
                typeLabel = "模板"
            } else {
                typeLabel = "命令"
            }
            guard matches(entry.name) else { continue }
            rows.append(ComposerCommandSuggestion(
                invocationText: entry.composerInvocationText,
                displayCommand: "/\(entry.name)",
                description: entry.description,
                typeLabel: typeLabel,
                id: "resource/\(entry.id)"
            ))
        }
        return rows
    }
}
