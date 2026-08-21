import Foundation

struct ToolActivityDescriptor: Equatable, Sendable {
    let title: String
    let subtitle: String?
    let systemImage: String
}

struct DHashlineAnchorLine: Identifiable, Equatable, Sendable {
    let number: Int
    let text: String
    let isMatch: Bool

    var id: Int { number }
}

struct DHashlineAnchorSection: Identifiable, Equatable, Sendable {
    let path: String
    let tag: String
    let lines: [DHashlineAnchorLine]

    var id: String { "\(path)#\(tag)" }
}

enum ToolPresentationFormatter {
    static func callDescriptor(_ call: ToolCallPresentation) -> ToolActivityDescriptor {
        callDescriptor(name: call.name, arguments: call.arguments)
    }

    static func callDescriptor(name: String, arguments: String) -> ToolActivityDescriptor {
        let kind = name.lowercased()
        let arguments = jsonObject(arguments)
        switch kind {
        case "read":
            let path = text(arguments?["path"]) ?? text(arguments?["file_path"]) ?? "文件"
            let offset = integer(arguments?["offset"])
            let limit = integer(arguments?["limit"])
            let range = offset.map { start in
                limit.map { "第 \(start)–\(start + max(0, $0 - 1)) 行" } ?? "从第 \(start) 行开始"
            }
            return ToolActivityDescriptor(title: "读取 \(path)", subtitle: range, systemImage: "doc.text.magnifyingglass")
        case "edit":
            let input = text(arguments?["input"]) ?? ""
            let path = editPath(input) ?? text(arguments?["path"]) ?? text(arguments?["file_path"]) ?? "文件"
            return ToolActivityDescriptor(
                title: "编辑 \(path)",
                subtitle: editActionSummary(input),
                systemImage: "pencil.and.outline"
            )
        case "write":
            let path = text(arguments?["path"]) ?? text(arguments?["file_path"]) ?? "文件"
            let content = text(arguments?["content"]) ?? ""
            let count = lineCount(content)
            return ToolActivityDescriptor(
                title: "创建 \(path)",
                subtitle: count == 0 ? nil : "\(count) 行",
                systemImage: "doc.badge.plus"
            )
        case "search", "grep":
            let pattern = text(arguments?["pattern"]) ?? text(arguments?["query"]) ?? "内容"
            let path = text(arguments?["path"])
            return ToolActivityDescriptor(
                title: "搜索“\(compact(pattern, limit: 72))”",
                subtitle: path,
                systemImage: "magnifyingglass"
            )
        case "bash", "shell":
            let command = text(arguments?["command"]) ?? text(arguments?["cmd"])
            return ToolActivityDescriptor(
                title: "运行命令",
                subtitle: command.map { compact($0, limit: 96) },
                systemImage: "terminal"
            )
        default:
            return ToolActivityDescriptor(
                title: "运行 \(name)",
                subtitle: nil,
                systemImage: "wrench.and.screwdriver"
            )
        }
    }

    static func resultDescriptor(_ result: ToolResultPresentation) -> ToolActivityDescriptor {
        let kind = result.name.lowercased()
        let icon = result.isError ? "xmark.circle.fill" : "checkmark.circle.fill"
        let sections = anchorSections(from: result.content)
        switch kind {
        case "read":
            if let section = sections.first {
                return ToolActivityDescriptor(
                    title: result.isError ? "读取 \(section.path) 失败" : "已读取 \(section.path)",
                    subtitle: "\(section.lines.count) 行 · tag \(section.tag)",
                    systemImage: icon
                )
            }
        case "search", "grep":
            if !sections.isEmpty {
                let matches = sections.flatMap(\.lines).filter(\.isMatch).count
                return ToolActivityDescriptor(
                    title: result.isError ? "搜索失败" : "搜索完成",
                    subtitle: "\(sections.count) 个文件 · \(matches) 处匹配",
                    systemImage: icon
                )
            }
        case "edit":
            let path = result.content
                .split(separator: "\n", maxSplits: 1)
                .first
                .flatMap { line in line.hasPrefix("Updated ") ? String(line.dropFirst("Updated ".count)) : nil }
            return ToolActivityDescriptor(
                title: path.map { result.isError ? "编辑 \($0) 失败" : "已编辑 \($0)" }
                    ?? (result.isError ? "编辑失败" : "编辑完成"),
                subtitle: diff(from: result.details).map(diffSummary),
                systemImage: icon
            )
        case "write":
            let details = result.details.flatMap(jsonObject)
            let path = text(details?["path"])
            let lines = integer(details?["lines"])
            let bytes = integer(details?["bytes"])
            let subtitle = [lines.map { "\($0) 行" }, bytes.map { "\($0) bytes" }]
                .compactMap { $0 }
                .joined(separator: " · ")
            return ToolActivityDescriptor(
                title: path.map { result.isError ? "创建 \($0) 失败" : "已创建 \($0)" }
                    ?? (result.isError ? "创建失败" : "创建完成"),
                subtitle: subtitle.isEmpty ? nil : subtitle,
                systemImage: icon
            )
        default:
            break
        }
        return ToolActivityDescriptor(
            title: result.isError ? "\(result.name) 失败" : "\(result.name) 完成",
            subtitle: nil,
            systemImage: icon
        )
    }

    static func expandedCallDetails(_ call: ToolCallPresentation) -> String {
        let kind = call.name.lowercased()
        guard let arguments = jsonObject(call.arguments) else { return call.arguments }
        if kind == "write" {
            let path = text(arguments["path"]) ?? text(arguments["file_path"]) ?? "未知文件"
            let content = text(arguments["content"]) ?? ""
            return "目标：\(path)\n内容：\(lineCount(content)) 行 · \(content.utf8.count) bytes（正文默认隐藏）"
        }
        if kind == "edit" {
            let input = text(arguments["input"]) ?? ""
            let path = editPath(input) ?? text(arguments["path"]) ?? text(arguments["file_path"]) ?? "未知文件"
            let actions = editActionLabels(input)
            let actionText = actions.isEmpty
                ? "编辑协议无法解析，修改正文已隐藏"
                : actions.map { "- \($0)" }.joined(separator: "\n")
            return "目标：\(path)\n动作：\n\(actionText)\n修改正文默认隐藏"
        }
        return call.arguments
    }

    static func visibleAnchorLines(
        toolName: String,
        section: DHashlineAnchorSection
    ) -> [DHashlineAnchorLine] {
        guard toolName.lowercased() == "read", section.lines.count > 2,
              let first = section.lines.first,
              let last = section.lines.last else { return section.lines }
        return [first, last]
    }

    static func anchorSections(from content: String) -> [DHashlineAnchorSection] {
        var sections: [DHashlineAnchorSection] = []
        var path: String?
        var tag: String?
        var lines: [DHashlineAnchorLine] = []

        func finish() {
            guard let path, let tag else { return }
            sections.append(DHashlineAnchorSection(path: path, tag: tag, lines: lines))
            lines = []
        }

        for sourceLine in content.components(separatedBy: "\n") {
            if let header = anchorHeader(sourceLine) {
                finish()
                path = header.path
                tag = header.tag
                continue
            }
            guard path != nil else { continue }
            var line = sourceLine
            var isMatch = false
            if line.hasPrefix("*") {
                isMatch = true
                line.removeFirst()
            } else if line.hasPrefix(" ") {
                line.removeFirst()
            }
            guard let colon = line.firstIndex(of: ":"),
                  let number = Int(line[..<colon]) else { continue }
            lines.append(DHashlineAnchorLine(
                number: number,
                text: String(line[line.index(after: colon)...]),
                isMatch: isMatch
            ))
        }
        finish()
        return sections
    }

    static func diff(from details: String?) -> String? {
        guard let details, let object = jsonObject(details) else { return nil }
        return text(object["diff"])
    }

    static func anchorHeader(_ line: String) -> (path: String, tag: String)? {
        guard line.first == "[", line.last == "]" else { return nil }
        let body = line.dropFirst().dropLast()
        guard let separator = body.lastIndex(of: "#") else { return nil }
        let path = String(body[..<separator])
        let tag = String(body[body.index(after: separator)...])
        guard !path.isEmpty, tag.count == 8, tag.allSatisfy(\.isHexDigit) else { return nil }
        return (path, tag.uppercased())
    }

    static func editPath(_ input: String) -> String? {
        input.components(separatedBy: "\n").first.flatMap { anchorHeader($0)?.path }
    }

    static func editActionSummary(_ input: String) -> String? {
        let actions = editActionLabels(input)
        guard !actions.isEmpty else { return nil }
        return "\(actions.count) 个修改动作"
    }

    static func editActionLabels(_ input: String) -> [String] {
        input.components(separatedBy: "\n").compactMap { line in
            if let match = line.wholeMatch(of: /^SWAP (\d+)(?:\.=(\d+))?:$/) {
                return rangeLabel("替换", start: String(match.1), end: match.2.map(String.init))
            }
            if let match = line.wholeMatch(of: /^DEL (\d+)(?:\.=(\d+))?$/) {
                return rangeLabel("删除", start: String(match.1), end: match.2.map(String.init))
            }
            if let match = line.wholeMatch(of: /^INS\.(PRE|POST) (\d+):$/) {
                return "在第 \(match.2) 行\(match.1 == "PRE" ? "前" : "后")插入"
            }
            if let match = line.wholeMatch(of: /^INS\.(HEAD|TAIL):$/) {
                return "在文件\(match.1 == "HEAD" ? "开头" : "末尾")插入"
            }
            return nil
        }
    }

    static func rangeLabel(_ action: String, start: String, end: String?) -> String {
        guard let end, end != start else { return "\(action)第 \(start) 行" }
        return "\(action)第 \(start)–\(end) 行"
    }

    static func diffSummary(_ diff: String) -> String {
        let additions = diff.components(separatedBy: "\n").filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }.count
        let deletions = diff.components(separatedBy: "\n").filter { $0.hasPrefix("-") && !$0.hasPrefix("---") }.count
        return "+\(additions) −\(deletions)"
    }

    static func lineCount(_ content: String) -> Int {
        guard !content.isEmpty else { return 0 }
        return content.components(separatedBy: "\n").count - (content.hasSuffix("\n") ? 1 : 0)
    }

    static func compact(_ value: String, limit: Int) -> String {
        let collapsed = value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard collapsed.count > limit else { return collapsed }
        return "\(collapsed.prefix(limit - 1))…"
    }

    static func jsonObject(_ value: String) -> [String: Any]? {
        guard let data = value.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    static func text(_ value: Any?) -> String? {
        value as? String
    }

    static func integer(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        return nil
    }
}

/// 轮次折叠态的逐步状态摘要（0.0.14）：相邻同类步骤合并为安静的一行，
/// 如「探索 · 3 文件」「已编辑 文件名 目录 +1 −1」「思考过程 持续了 4 秒」。
/// 展开后的完整过程行不受影响。
struct ConversationStepSummary: Identifiable, Equatable, Sendable {
    let id: String
    let text: String
    let detail: String?
    let systemImage: String
    let isError: Bool
}

enum ConversationStepSummarizer {
    static let maximumVisibleLines = 8

    private enum Token {
        case thinking(duration: TimeInterval?, id: String)
        case tool(call: ToolCallPresentation, result: ToolResultPresentation?)
    }

    static func summaries(for items: [TranscriptItem]) -> [ConversationStepSummary] {
        var resultsById: [String: ToolResultPresentation] = [:]
        for item in items {
            for block in item.blocks {
                if case let .toolResult(_, result) = block {
                    resultsById[result.id] = result
                }
            }
        }

        var tokens: [Token] = []
        for item in items {
            let hasThinking = item.blocks.contains { block in
                if case .thinking = block { return true }
                return false
            }
            if hasThinking {
                let duration: TimeInterval?
                if let started = item.timestamp, let persisted = item.persistedAt {
                    duration = max(0, persisted.timeIntervalSince(started))
                } else {
                    duration = nil
                }
                tokens.append(.thinking(duration: duration, id: item.id))
            }
            for block in item.blocks {
                if case let .toolCall(_, call) = block {
                    tokens.append(.tool(call: call, result: resultsById[call.id]))
                }
            }
        }

        var lines: [ConversationStepSummary] = []
        var index = 0
        while index < tokens.count {
            switch tokens[index] {
            case let .thinking(duration, id):
                var total: TimeInterval = 0
                var hasDuration = false
                var segments = 0
                while index < tokens.count,
                      case let .thinking(nextDuration, _) = tokens[index] {
                    segments += 1
                    if let nextDuration {
                        total += nextDuration
                        hasDuration = true
                    }
                    index += 1
                }
                lines.append(ConversationStepSummary(
                    id: id,
                    text: segments > 1 ? "思考过程 · \(segments) 段" : "思考过程",
                    detail: thinkingDetail(total: total, hasDuration: hasDuration),
                    systemImage: "brain",
                    isError: false
                ))

            case let .tool(call, result):
                var additions = 0
                var deletions = 0
                var failed = false
                var members = 0
                var distinctPaths: Set<String> = []
                var matches = 0
                var lineCount: Int?
                while index < tokens.count,
                      case let .tool(nextCall, nextResult) = tokens[index],
                      mergesWith(call: call, into: tokens, at: index) {
                    members += 1
                    collect(
                        call: nextCall,
                        result: nextResult,
                        additions: &additions,
                        deletions: &deletions,
                        failed: &failed,
                        distinctPaths: &distinctPaths,
                        matches: &matches,
                        lineCount: &lineCount
                    )
                    index += 1
                }
                lines.append(toolLine(
                    call: call,
                    members: members,
                    distinctPaths: distinctPaths,
                    additions: additions,
                    deletions: deletions,
                    matches: matches,
                    lineCount: lineCount,
                    failed: failed
                ))
            }
        }

        if lines.count > maximumVisibleLines {
            let hidden = lines.count - (maximumVisibleLines - 1)
            lines = Array(lines.prefix(maximumVisibleLines - 1))
            lines.append(ConversationStepSummary(
                id: "truncated",
                text: "另有 \(hidden) 步",
                detail: nil,
                systemImage: "ellipsis",
                isError: false
            ))
        }
        return lines
    }

    /// 只有相邻且同类的工具步骤才合并；编辑 / 创建按目标文件聚合，其余按工具名聚合。
    private static func mergesWith(call: ToolCallPresentation, into tokens: [Token], at index: Int) -> Bool {
        guard case let .tool(nextCall, _) = tokens[index] else { return false }
        return kind(of: call) == kind(of: nextCall)
    }

    private enum ToolKind: Equatable {
        case explore
        case search
        case edit(String)
        case write(String)
        case command
        case other(String)
    }

    private static func kind(of call: ToolCallPresentation) -> ToolKind {
        switch call.name.lowercased() {
        case "read", "ls", "find":
            return .explore
        case "search", "grep":
            return .search
        case "edit":
            return .edit(editTarget(call))
        case "write":
            return .write(ToolPresentationFormatter.text(ToolPresentationFormatter.jsonObject(call.arguments)?["path"]) ?? ToolPresentationFormatter.text(ToolPresentationFormatter.jsonObject(call.arguments)?["file_path"]) ?? "")
        case "bash", "shell":
            return .command
        default:
            return .other(call.name)
        }
    }

    private static func editTarget(_ call: ToolCallPresentation) -> String {
        let input = ToolPresentationFormatter.text(ToolPresentationFormatter.jsonObject(call.arguments)?["input"]) ?? ""
        return ToolPresentationFormatter.editPath(input)
            ?? ToolPresentationFormatter.text(ToolPresentationFormatter.jsonObject(call.arguments)?["path"])
            ?? ToolPresentationFormatter.text(ToolPresentationFormatter.jsonObject(call.arguments)?["file_path"])
            ?? ""
    }

    private static func thinkingDetail(total: TimeInterval, hasDuration: Bool) -> String? {
        guard hasDuration, let text = ConversationTimingFormatter.durationText(total) else { return nil }
        return "持续了 \(text)"
    }

    private static func collect(
        call: ToolCallPresentation,
        result: ToolResultPresentation?,
        additions: inout Int,
        deletions: inout Int,
        failed: inout Bool,
        distinctPaths: inout Set<String>,
        matches: inout Int,
        lineCount: inout Int?
    ) {
        if let path = callPath(call) { distinctPaths.insert(path) }
        if result?.isError == true { failed = true }
        if case .edit = kind(of: call) {
            if let diff = ToolPresentationFormatter.diff(from: result?.details) {
                additions += diff.components(separatedBy: "\n").filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }.count
                deletions += diff.components(separatedBy: "\n").filter { $0.hasPrefix("-") && !$0.hasPrefix("---") }.count
            }
        }
        if case .search = kind(of: call), let result {
            matches += ToolPresentationFormatter.anchorSections(from: result.content).flatMap(\.lines).filter(\.isMatch).count
        }
        if case .write = kind(of: call), let result {
            let details = result.details.flatMap { ToolPresentationFormatter.jsonObject($0) }
            if let lines = details.flatMap({ ToolPresentationFormatter.integer($0["lines"]) }) { lineCount = lines }
        }
    }

    private static func toolLine(
        call: ToolCallPresentation,
        members: Int,
        distinctPaths: Set<String>,
        additions: Int,
        deletions: Int,
        matches: Int,
        lineCount: Int?,
        failed: Bool
    ) -> ConversationStepSummary {
        let failureSuffix = failed ? "（失败）" : ""
        switch kind(of: call) {
        case .explore:
            let scope = distinctPaths.isEmpty
                ? "\(members) 次"
                : "\(distinctPaths.count) 文件"
            return ConversationStepSummary(
                id: call.id,
                text: "探索 · \(scope)\(failureSuffix)",
                detail: nil,
                systemImage: "folder",
                isError: failed
            )
        case .search:
            let matchSuffix = matches > 0 ? " · \(matches) 处匹配" : ""
            return ConversationStepSummary(
                id: call.id,
                text: "搜索 · \(members) 次\(matchSuffix)\(failureSuffix)",
                detail: nil,
                systemImage: "magnifyingglass",
                isError: failed
            )
        case let .edit(path):
            var parts: [String] = []
            if let directory = parentDirectoryLabel(path) { parts.append(directory) }
            if additions > 0 || deletions > 0 { parts.append("+\(additions) −\(deletions)") }
            return ConversationStepSummary(
                id: call.id,
                text: "已编辑 \(fileNameLabel(path))\(failureSuffix)",
                detail: parts.isEmpty ? nil : parts.joined(separator: " "),
                systemImage: "pencil.and.outline",
                isError: failed
            )
        case let .write(path):
            let linesPart = lineCount.map { " · \($0) 行" } ?? ""
            return ConversationStepSummary(
                id: call.id,
                text: "已创建 \(fileNameLabel(path))\(linesPart)\(failureSuffix)",
                detail: parentDirectoryLabel(path),
                systemImage: "doc.badge.plus",
                isError: failed
            )
        case .command:
            if members == 1 {
                let command = ToolPresentationFormatter.text(ToolPresentationFormatter.jsonObject(call.arguments)?["command"]) ?? ToolPresentationFormatter.text(ToolPresentationFormatter.jsonObject(call.arguments)?["cmd"])
                return ConversationStepSummary(
                    id: call.id,
                    text: "运行命令\(failureSuffix)",
                    detail: command.map { ToolPresentationFormatter.compact($0, limit: 72) },
                    systemImage: "terminal",
                    isError: failed
                )
            }
            return ConversationStepSummary(
                id: call.id,
                text: "运行命令 · \(members) 次\(failureSuffix)",
                detail: nil,
                systemImage: "terminal",
                isError: failed
            )
        case let .other(name):
            return ConversationStepSummary(
                id: call.id,
                text: "运行 \(name) · \(members) 次\(failureSuffix)",
                detail: nil,
                systemImage: "wrench.and.screwdriver",
                isError: failed
            )
        }
    }

    private static func callPath(_ call: ToolCallPresentation) -> String? {
        let arguments = ToolPresentationFormatter.jsonObject(call.arguments)
        return ToolPresentationFormatter.text(arguments?["path"]) ?? ToolPresentationFormatter.text(arguments?["file_path"])
    }

    private static func fileNameLabel(_ path: String) -> String {
        guard !path.isEmpty else { return "文件" }
        return URL(fileURLWithPath: path, isDirectory: false).lastPathComponent
    }

    private static func parentDirectoryLabel(_ path: String) -> String? {
        guard !path.isEmpty else { return nil }
        let parent = URL(fileURLWithPath: path, isDirectory: false)
            .deletingLastPathComponent()
            .lastPathComponent
        return parent.isEmpty ? nil : parent
    }
}
