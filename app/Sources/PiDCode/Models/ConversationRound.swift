import Foundation

struct ConversationRound: Identifiable, Equatable, Sendable {
    let id: String
    let user: TranscriptItem?
    let processItems: [TranscriptItem]
    let finalAssistant: TranscriptItem?
    let startedAt: Date?
    let completedAt: Date?
    let toolCount: Int
    let hasError: Bool
    let totalTokens: Int?
    let entryIDs: Set<String>
    let processEntryIDs: Set<String>

    var duration: TimeInterval? {
        guard let startedAt, let completedAt else { return nil }
        return max(0, completedAt.timeIntervalSince(startedAt))
    }

    var finalAssistantFailed: Bool {
        guard let finalAssistant else { return hasError }
        if ["error", "aborted"].contains(finalAssistant.assistantStopReason) { return true }
        return finalAssistant.blocks.contains { block in
            if case .error = block { return true }
            return false
        }
    }
}

enum ConversationRoundProjector {
    static func project(_ transcript: [TranscriptItem]) -> [ConversationRound] {
        var groups: [[TranscriptItem]] = []
        var current: [TranscriptItem] = []

        for item in transcript {
            if item.role == .user, !current.isEmpty {
                groups.append(current)
                current = [item]
            } else {
                current.append(item)
            }
        }
        if !current.isEmpty { groups.append(current) }
        return groups.compactMap(projectGroup)
    }

    private static func projectGroup(_ group: [TranscriptItem]) -> ConversationRound? {
        guard let first = group.first else { return nil }
        let user = first.role == .user ? first : nil
        let responseStart = user == nil ? group.startIndex : group.index(after: group.startIndex)
        let responses = Array(group[responseStart...])
        let finalIndex = responses.lastIndex(where: isFinalAssistant)

        var processItems: [TranscriptItem] = []
        var finalAssistant: TranscriptItem?
        var processEntryIDs: Set<String> = []

        for (index, item) in responses.enumerated() {
            guard index == finalIndex else {
                processItems.append(item)
                processEntryIDs.insert(item.id)
                continue
            }

            let processBlocks = item.blocks.filter(\.isProcessBlock)
            let finalBlocks = item.blocks.filter { !$0.isProcessBlock }
            if !processBlocks.isEmpty {
                processItems.append(item.replacing(
                    id: "\(item.id)-process",
                    blocks: processBlocks
                ))
            }
            if !finalBlocks.isEmpty {
                finalAssistant = item.replacing(blocks: finalBlocks)
            }
        }

        let allItems = (user.map { [$0] } ?? []) + responses
        let toolIDs = Set(allItems.flatMap { item in
            item.blocks.compactMap { block -> String? in
                switch block {
                case let .toolCall(_, call): call.id
                case let .toolResult(_, result): result.id
                default: nil
                }
            }
        })
        let hasError = allItems.contains { item in
            item.blocks.contains { block in
                switch block {
                case .error: true
                case let .toolResult(_, result): result.isError
                default: false
                }
            }
        }
        let startedAt = user?.persistedAt ?? user?.timestamp
            ?? allItems.compactMap { $0.timestamp ?? $0.persistedAt }.min()
        let completedAt = allItems.compactMap(\.persistedAt).max()
            ?? allItems.compactMap(\.timestamp).max()
        let totalTokens = safeTotalTokens(in: responses)

        return ConversationRound(
            id: user?.id ?? first.id,
            user: user,
            processItems: processItems,
            finalAssistant: finalAssistant,
            startedAt: startedAt,
            completedAt: finalAssistant == nil && !hasError ? nil : completedAt,
            toolCount: toolIDs.count,
            hasError: hasError,
            totalTokens: totalTokens,
            entryIDs: Set(group.map(\.id)),
            processEntryIDs: processEntryIDs
        )
    }

    private static func isFinalAssistant(_ item: TranscriptItem) -> Bool {
        guard item.role == .assistant else { return false }
        if item.blocks.contains(where: { if case .error = $0 { return true }; return false }) {
            return true
        }
        if item.assistantStopReason == "toolUse" { return false }
        let hasVisibleContent = item.blocks.contains { !$0.isProcessBlock }
        guard hasVisibleContent else { return false }
        if item.assistantStopReason != nil { return true }
        return !item.blocks.contains { if case .toolCall = $0 { return true }; return false }
    }

    private static func safeTotalTokens(in responses: [TranscriptItem]) -> Int? {
        var foundUsage = false
        var total = 0
        for item in responses {
            guard let value = item.assistantUsage?.totalTokens else { continue }
            foundUsage = true
            let (nextTotal, overflow) = total.addingReportingOverflow(value)
            guard !overflow else { return nil }
            total = nextTotal
        }
        return foundUsage ? total : nil
    }
}

enum ConversationTimingFormatter {
    static func durationText(_ duration: TimeInterval?) -> String? {
        guard let duration else { return nil }
        let seconds = max(0, Int(duration.rounded()))
        if seconds < 60 { return "\(seconds) 秒" }
        let minutes = seconds / 60
        let remainingSeconds = seconds % 60
        if minutes < 60 {
            return remainingSeconds == 0
                ? "\(minutes) 分钟"
                : "\(minutes) 分钟 \(remainingSeconds) 秒"
        }
        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        return remainingMinutes == 0
            ? "\(hours) 小时"
            : "\(hours) 小时 \(remainingMinutes) 分钟"
    }

    static func completionText(
        duration: TimeInterval?,
        completedAt: Date?,
        totalTokens: Int? = nil,
        relativeTo referenceDate: Date = Date(),
        calendar: Calendar = .autoupdatingCurrent
    ) -> String? {
        var parts: [String] = []
        if let completedAt {
            parts.append(dateTimeText(completedAt, relativeTo: referenceDate, calendar: calendar))
        }
        if let duration = durationText(duration) { parts.append("耗时 \(duration)") }
        if let totalTokens, totalTokens > 0 { parts.append("\(tokenText(totalTokens)) token") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func tokenText(_ tokens: Int) -> String {
        let value = max(0, tokens)
        if value < 1_000 { return "\(value)" }
        let divisor: Double
        let suffix: String
        if value < 1_000_000 {
            divisor = 1_000
            suffix = "k"
        } else {
            divisor = 1_000_000
            suffix = "m"
        }
        let compact = String(format: "%.1f", Double(value) / divisor)
            .replacingOccurrences(of: ".0", with: "")
        return "\(compact)\(suffix)"
    }

    static func timestampText(
        _ timestamp: Date?,
        relativeTo referenceDate: Date = Date(),
        calendar: Calendar = .autoupdatingCurrent
    ) -> String? {
        guard let timestamp else { return nil }
        return dateTimeText(timestamp, relativeTo: referenceDate, calendar: calendar)
    }

    private static func dateTimeText(
        _ date: Date,
        relativeTo referenceDate: Date,
        calendar: Calendar
    ) -> String {
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: referenceDate)
        let year = components.year ?? 0
        let month = components.month ?? 0
        let day = components.day ?? 0
        let hour = components.hour ?? 0
        let minute = components.minute ?? 0
        let clock = String(format: "%02d:%02d", hour, minute)
        return sameYear
            ? "\(month)月\(day)日 \(clock)"
            : "\(year)年\(month)月\(day)日 \(clock)"
    }
}

private extension TranscriptBlock {
    var isProcessBlock: Bool {
        switch self {
        case .thinking, .toolCall: true
        default: false
        }
    }
}

private extension TranscriptItem {
    func replacing(id: String? = nil, blocks: [TranscriptBlock]) -> TranscriptItem {
        TranscriptItem(
            id: id ?? self.id,
            role: role,
            timestamp: timestamp,
            persistedAt: persistedAt,
            blocks: blocks,
            editableText: editableText,
            assistantStopReason: assistantStopReason,
            assistantUsage: assistantUsage
        )
    }
}
