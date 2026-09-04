import Foundation

enum TaskHUDLayout: String, Equatable, Sendable {
    case wideFloating
    case mediumOverlay
    case compactEntry
}

enum TaskHUDLayoutPolicy {
    static let wideMinimum: CGFloat = 1_320
    static let mediumMinimum: CGFloat = 880
    static let compactMinimum: CGFloat = 640
    static let wideCardWidth: CGFloat = 304
    static let wideCardTopInset: CGFloat = 66
    static let wideCardTrailingInset: CGFloat = 24
    static let wideCardBottomInset: CGFloat = 32
    /// A wide HUD is a finite floating card, not a full-height third rail. When
    /// its sections exceed this height, its own scroll view absorbs the overflow.
    static let wideCardPreferredMaximumHeight: CGFloat = 620
    static let wideConversationLeadingInset: CGFloat = 72
    static let wideConversationTrailingInset: CGFloat = 374

    static func layout(for width: CGFloat) -> TaskHUDLayout {
        if width >= wideMinimum { return .wideFloating }
        if width >= mediumMinimum { return .mediumOverlay }
        return .compactEntry
    }

    static func wideCardMaximumHeight(for workspaceHeight: CGFloat) -> CGFloat {
        let available = max(0, workspaceHeight - wideCardTopInset - wideCardBottomInset)
        return min(wideCardPreferredMaximumHeight, available)
    }
}

enum TaskWorkbenchInspectorTarget: Hashable, Sendable {
    case artifact(String)
    case evidence(String)
    case report(String)
    case context(String)

    var persistenceKey: String {
        switch self {
        case let .artifact(id): "artifact:\(id)"
        case let .evidence(id): "evidence:\(id)"
        case let .report(id): "report:\(id)"
        case let .context(id): "context:\(id)"
        }
    }

    static func restore(_ value: String?) -> TaskWorkbenchInspectorTarget? {
        guard let value, let separator = value.firstIndex(of: ":") else { return nil }
        let kind = String(value[..<separator])
        let id = String(value[value.index(after: separator)...])
        guard !id.isEmpty else { return nil }
        switch kind {
        case "artifact": return TaskWorkbenchInspectorTarget.artifact(id)
        case "evidence": return TaskWorkbenchInspectorTarget.evidence(id)
        case "report": return TaskWorkbenchInspectorTarget.report(id)
        case "context": return TaskWorkbenchInspectorTarget.context(id)
        default: return nil
        }
    }

    var remoteValue: FoundationTaskWorkbenchInspectorTarget {
        switch self {
        case let .artifact(id): .init(kind: "artifact", id: id)
        case let .evidence(id): .init(kind: "evidence", id: id)
        case let .report(id): .init(kind: "report", id: id)
        case let .context(id): .init(kind: "context", id: id)
        }
    }

    init?(remoteValue: FoundationTaskWorkbenchInspectorTarget?) {
        guard let remoteValue else { return nil }
        switch remoteValue.kind {
        case "artifact": self = .artifact(remoteValue.id)
        case "evidence": self = .evidence(remoteValue.id)
        case "report": self = .report(remoteValue.id)
        case "context": self = .context(remoteValue.id)
        default: return nil
        }
    }
}

enum TaskWorkbenchContentTarget: Hashable, Sendable {
    case artifact(String)
    case report(String)

    var remoteKind: String {
        switch self {
        case .artifact: "artifact"
        case .report: "report"
        }
    }

    var id: String {
        switch self {
        case let .artifact(id), let .report(id): id
        }
    }

    init?(remoteValue: FoundationTaskWorkbenchWorkspaceContent?) {
        guard let remoteValue else { return nil }
        switch remoteValue.kind {
        case "artifact": self = .artifact(remoteValue.id)
        case "report": self = .report(remoteValue.id)
        default: return nil
        }
    }
}

struct TaskWorkbenchProjection: Equatable, Sendable {
    let taskID: String
    let coordinationSessionID: String?
    let childSessionIDs: [String]

    init?(task: FoundationTask, snapshot: FoundationSnapshot) {
        let sessions = snapshot.sessions.filter { $0.taskId == task.id }
        guard !sessions.isEmpty else { return nil }
        taskID = task.id
        coordinationSessionID = sessions.first(where: { $0.kind == "coordination" })?.id
        childSessionIDs = sessions
            .filter { $0.kind == "child" }
            .map(\.id)
    }

    static func defaultSessionID(for task: FoundationTask, snapshot: FoundationSnapshot) -> String? {
        let sessions = snapshot.sessions.filter { $0.taskId == task.id }
        return sessions.first(where: { $0.kind == "coordination" })?.id ?? sessions.first?.id
    }

    static func sessions(for taskID: String, snapshot: FoundationSnapshot) -> [FoundationSession] {
        snapshot.sessions.filter { $0.taskId == taskID }
    }
}
