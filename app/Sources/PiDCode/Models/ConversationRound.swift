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
    let entryIDs: Set<String>
    let processEntryIDs: Set<String>

    var duration: TimeInterval? {
        guard let startedAt, let completedAt else { return nil }
        return max(0, completedAt.timeIntervalSince(startedAt))
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

        return ConversationRound(
            id: user?.id ?? first.id,
            user: user,
            processItems: processItems,
            finalAssistant: finalAssistant,
            startedAt: startedAt,
            completedAt: finalAssistant == nil && !hasError ? nil : completedAt,
            toolCount: toolIDs.count,
            hasError: hasError,
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
            assistantStopReason: assistantStopReason
        )
    }
}
