import Foundation

/// Composer 统一命令面板行（0.0.20）：斜杠面板一次混排命令、Skill 与 Prompt
/// 模板，行尾标注用户可操作的资源类型；描述单行常显，悬停经 `help` 显示完整描述。
/// `session.getCommands` 的运行时命令和 `resources.list`（与 设置 > 本机资源
/// 同源）都可能来自扩展，但来源不成为 Composer 的产品标签；同名时以前者为准。
struct ComposerCommandSuggestion: Identifiable, Equatable, Sendable {
    /// 插入输入框的调用文本（0.0.16 `composerInvocationText` 合同：只预填不发送）。
    let invocationText: String
    /// 面板显示名：命令保留 `/mcp`，Skill 只显示 `llm-wiki`，不暴露内部路由语法。
    let displayCommand: String
    let description: String?
    /// 行尾类型标签：命令 / Skill / 模板。
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
    /// 顺序：运行时命令（getCommands）在前，resources 的 命令 / Skill / 模板在后；
    /// 同名资源只保留 getCommands 版本。
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
            let presentation = presentation(for: command.name, source: command.source)
            return ComposerCommandSuggestion(
                invocationText: "/\(command.name) ",
                displayCommand: presentation.displayCommand,
                description: command.description,
                typeLabel: presentation.typeLabel,
                id: "command/\(command.source)/\(command.name)"
            )
        }
        for entry in resources {
            guard !extensionNames.contains(entry.name.lowercased()) else { continue }
            guard matches(entry.name) else { continue }
            let presentation = presentation(for: entry.name, source: entry.source)
            rows.append(ComposerCommandSuggestion(
                invocationText: entry.composerInvocationText,
                displayCommand: presentation.displayCommand,
                description: entry.description,
                typeLabel: presentation.typeLabel,
                id: "resource/\(entry.id)"
            ))
        }
        return rows
    }

    /// Host 的 `session.getCommands` 与 `resources.list` 都可能返回 Skill；统一在这里
    /// 分离用户可见名称与内部 `/skill:<name>` 调用语法，避免会话态和草稿态显示不一致。
    private static func presentation(for name: String, source: String) -> (
        displayCommand: String,
        typeLabel: String
    ) {
        let isSkill = source == "skill" || name.hasPrefix("skill:")
        if isSkill {
            let skillName = name.hasPrefix("skill:") ? String(name.dropFirst("skill:".count)) : name
            return (skillName, "技能")
        }
        if source == "prompt" {
            return ("/\(name)", "模板")
        }
        return ("/\(name)", "命令")
    }
}
