import CoreGraphics
import Foundation

struct ConversationNavigationItem: Identifiable, Equatable, Sendable {
    let id: String
    let anchorID: String
    let questionPreview: String
    let answerPreview: String
    let hasError: Bool
}

enum ConversationNavigation {
    static let minimumPersistentWidth: CGFloat = 640
    static let minimumRoundCount = 2

    static func items(from rounds: [ConversationRound]) -> [ConversationNavigationItem] {
        rounds.map { round in
            ConversationNavigationItem(
                id: round.id,
                anchorID: anchorID(for: round.id),
                questionPreview: compactPreview(round.user, fallback: "会话开始"),
                answerPreview: compactPreview(
                    round.finalAssistant,
                    fallback: round.hasError ? "执行失败" : "尚无最终回答"
                ),
                hasError: round.hasError
            )
        }
    }

    static func anchorID(for roundID: String) -> String {
        "round-nav:\(roundID)"
    }

    static func presentationIdentity(sessionID: String?, pathID: String?) -> String {
        "\(sessionID ?? "none"):\(pathID ?? "none")"
    }

    static func shouldShowPersistentRail(width: CGFloat, roundCount: Int) -> Bool {
        width >= minimumPersistentWidth && roundCount >= minimumRoundCount
    }

    static func index(at y: CGFloat, height: CGFloat, count: Int, verticalInset: CGFloat = 12) -> Int? {
        guard count > 0, height > 0 else { return nil }
        guard count > 1 else { return 0 }
        let usableHeight = max(1, height - (verticalInset * 2))
        let normalized = min(1, max(0, (y - verticalInset) / usableHeight))
        return min(count - 1, max(0, Int((normalized * CGFloat(count - 1)).rounded())))
    }

    static func yPosition(
        for index: Int,
        height: CGFloat,
        count: Int,
        verticalInset: CGFloat = 12
    ) -> CGFloat {
        guard count > 1 else { return max(0, height / 2) }
        let clampedIndex = min(count - 1, max(0, index))
        let usableHeight = max(1, height - (verticalInset * 2))
        return verticalInset + (CGFloat(clampedIndex) / CGFloat(count - 1) * usableHeight)
    }

    static func renderedIndices(count: Int, height: CGFloat, minimumSpacing: CGFloat = 6) -> [Int] {
        guard count > 0 else { return [] }
        guard count > 1 else { return [0] }
        let maximumTicks = max(2, Int(max(1, height) / max(1, minimumSpacing)))
        guard count > maximumTicks else { return Array(0..<count) }
        let stride = Int(ceil(Double(count - 1) / Double(maximumTicks - 1)))
        var result = Array(Swift.stride(from: 0, to: count, by: stride))
        if result.last != count - 1 { result.append(count - 1) }
        return result
    }

    static func compactPreview(_ source: String?, fallback: String, limit: Int = 180) -> String {
        compactPreview(sources: source.map { [$0] } ?? [], fallback: fallback, limit: limit)
    }

    private static func compactPreview(
        _ item: TranscriptItem?,
        fallback: String,
        limit: Int = 180
    ) -> String {
        let sources = item?.blocks.compactMap { block -> String? in
            switch block {
            case let .text(_, value), let .code(_, _, value), let .mermaid(_, value): value
            case let .attachment(_, label): label
            default: nil
            }
        } ?? []
        return compactPreview(sources: sources, fallback: fallback, limit: limit)
    }

    private static func compactPreview(
        sources: [String],
        fallback: String,
        limit: Int
    ) -> String {
        guard limit > 0 else { return fallback }
        var compact = ""
        var compactCount = 0
        var pendingSpace = false

        sourceLoop: for source in sources {
            for character in source {
                if character.isWhitespace {
                    if compactCount > 0 { pendingSpace = true }
                    continue
                }
                if pendingSpace, compactCount > 0 {
                    compact.append(" ")
                    compactCount += 1
                    pendingSpace = false
                    if compactCount > limit { break sourceLoop }
                }
                compact.append(character)
                compactCount += 1
                if compactCount > limit { break sourceLoop }
            }
            if compactCount > 0 { pendingSpace = true }
        }

        guard !compact.isEmpty else { return fallback }
        guard compactCount > limit else { return compact }
        return "\(compact.prefix(limit).trimmingCharacters(in: .whitespacesAndNewlines))…"
    }
}
