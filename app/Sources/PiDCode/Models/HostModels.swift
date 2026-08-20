import Foundation

struct HostHello: Codable, Sendable {
    let protocolVersion: Int
    let hostVersion: String?
    let piVersion: String
    let nodeVersion: String
    let capabilities: [String: JSONValue]
}

enum HostCompatibilityError: LocalizedError, Equatable {
    case unsupportedProtocol(Int)
    case incompatibleHostVersion(String?)
    case missingCapabilities([String])

    var errorDescription: String? {
        switch self {
        case let .unsupportedProtocol(version):
            "D Code 0.0.9 不支持 Host Protocol \(version)。请重新构建并使用同一版本的 App 与 Host。"
        case let .incompatibleHostVersion(version):
            "当前 Host 版本为 \(version ?? "未知")，D Code App 需要 0.0.9。请重新构建 App，避免混用旧 Host。"
        case let .missingCapabilities(capabilities):
            "当前 Host 缺少 0.0.9 必需能力：\(capabilities.joined(separator: "、"))。D Code 已停止连接，以免错误读取或写入会话。"
        }
    }
}

enum HostCompatibility {
    static let appVersion = "0.0.9"
    static let requiredCapabilities = [
        "sessionLease",
        "onDemandWrite",
        "structuredPlan",
        "mermaidUnicode",
        "projectCwdScope",
        "contextUsage",
        "contextBreakdown",
        "fastMode",
        "sessionExternalSync",
        "dcodeSessionOrigin",
        "sessionSearch",
        "sessionPaths",
        "sessionCopy",
        "sessionTrash",
        "sessionVisibilityExclusions",
        "sessionChangeLedger",
        "sessionRename",
        "sessionRunCorrelation",
        "sessionRunState",
        "preSessionModelSelection",
        "modelSettings",
        "sessionSteer",
        "modelAuthentication",
    ]

    static func validate(_ hello: HostHello) throws {
        guard hello.protocolVersion == 1 else {
            throw HostCompatibilityError.unsupportedProtocol(hello.protocolVersion)
        }
        guard hello.hostVersion == appVersion else {
            throw HostCompatibilityError.incompatibleHostVersion(hello.hostVersion)
        }
        let missing = requiredCapabilities.filter { hello.capabilities[$0]?.boolValue != true }
        guard missing.isEmpty else { throw HostCompatibilityError.missingCapabilities(missing) }
    }
}

struct SessionListResult: Codable, Sendable {
    let sessions: [SessionSummary]
}

struct SessionSummary: Codable, Identifiable, Hashable, Sendable {
    let path: String
    let id: String
    let cwd: String
    let name: String?
    let parentSessionPath: String?
    let created: String
    let modified: String
    let messageCount: Int
    let firstMessage: String

    var displayTitle: String {
        if let name, !name.isEmpty { return name }
        if !firstMessage.isEmpty { return firstMessage }
        return URL(fileURLWithPath: cwd).lastPathComponent.isEmpty ? cwd : URL(fileURLWithPath: cwd).lastPathComponent
    }

    var projectName: String {
        let name = URL(fileURLWithPath: cwd).lastPathComponent
        return name.isEmpty ? cwd : name
    }

    var modifiedDate: Date? { try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(modified) }
}

struct SessionInspection: Codable, Sendable {
    let summary: SessionSummary
    let header: JSONValue
    let parentSessionId: String?
    let leafId: String?
    let currentPathId: String
    let selectedPathId: String
    let paths: [SessionPathSummary]
    let entries: [JSONValue]
    let context: SessionContextSnapshot
    let activePlan: JSONValue?
    /// dgoal-work-v1 最新条目携带的待批计划提案；旧 Host 无此字段时为 nil。
    let activeProposal: JSONValue?
}

struct SessionCopySource: Codable, Sendable {
    let id: String
    let path: String
    let leafId: String?
    let entryCount: Int
}

struct SessionCopyVerification: Codable, Sendable {
    let entryCount: Int
    let leafId: String?
    let origin: Bool
}

struct SessionCopyResult: Codable, Sendable {
    let copied: Bool
    let source: SessionCopySource
    let target: SessionSummary
    let verification: SessionCopyVerification
}

struct SessionTrashResult: Codable, Sendable {
    let trashed: Bool
    let sessionId: String
    let originalPath: String
    let trashPath: String
}

struct SessionRenameResult: Codable, Sendable {
    let summary: SessionSummary
}

struct SessionContextSnapshot: Codable, Sendable {
    let messageCount: Int
    let model: SessionContextModel?
    let thinkingLevel: String
}

struct SessionContextModel: Codable, Hashable, Sendable {
    let provider: String
    let modelId: String
}

struct HostModel: Codable, Hashable, Sendable, Identifiable {
    let provider: String
    let id: String
    let name: String?
    let reasoning: Bool?
    let contextWindow: Int?
    let maxTokens: Int?
    let thinkingLevels: [String]?
    let fastModeSupported: Bool?

    var displayName: String { name ?? id }
    var qualifiedName: String { "\(provider)/\(id)" }
}

struct ContextUsage: Codable, Equatable, Sendable {
    let tokens: Int?
    let contextWindow: Int
    let percent: Double?

    var remainingPercent: Double? {
        guard let percent else { return nil }
        return min(max(100 - percent, 0), 100)
    }

    var usedFraction: Double? {
        guard let percent else { return nil }
        return min(max(percent / 100, 0), 1)
    }
}

struct ContextBreakdownPart: Codable, Equatable, Sendable {
    let kind: String
    let tokens: Int?
}

/// `session.contextBreakdown` 的结果：按消息种类估算的上下文构成，
/// totalTokens 为最近一次真实 usage 锚定值；estimated 为 true 时无锚定。
struct ContextBreakdownResult: Codable, Equatable, Sendable {
    let available: Bool
    let reason: String?
    let estimated: Bool?
    let totalTokens: Int?
    let estimatedMessageTokens: Int?
    let contextWindow: Int?
    let parts: [ContextBreakdownPart]?
}

enum ContextPartKind: String, CaseIterable, Sendable {
    case systemTools
    case user
    case assistant
    case thinking
    case toolResult

    var label: String {
        switch self {
        case .systemTools: "系统与工具"
        case .user: "用户消息"
        case .assistant: "助手回复"
        case .thinking: "思考"
        case .toolResult: "工具结果"
        }
    }
}

struct ContextCompositionRow: Identifiable, Equatable, Sendable {
    let kind: ContextPartKind
    let tokens: Int?
    let fraction: Double?

    var id: String { kind.rawValue }
}

extension ContextBreakdownResult {
    /// 供圆环弹层使用的构成行；锚定总量时含“系统与工具（推算）”与剩余空闲。
    var compositionRows: [ContextCompositionRow] {
        guard available else { return [] }
        let anchored = estimated == false ? totalTokens : nil
        let basis = anchored ?? estimatedMessageTokens
        return (parts ?? []).compactMap { part in
            guard let kind = ContextPartKind(rawValue: part.kind) else { return nil }
            let fraction: Double?
            if let tokens = part.tokens, let basis, basis > 0 {
                fraction = min(Double(tokens) / Double(basis), 1)
            } else {
                fraction = nil
            }
            return ContextCompositionRow(kind: kind, tokens: part.tokens, fraction: fraction)
        }
    }

    var freeTokens: Int? {
        guard available, let total = totalTokens, let window = contextWindow, window > 0 else { return nil }
        return max(window - total, 0)
    }
}

struct FastModeState: Codable, Equatable, Sendable {
    let enabled: Bool
    let active: Bool
    let provider: String?
    let model: String?
    let requestedServiceTier: String
    let reason: String
}

struct HostState: Codable, Sendable {
    let mode: String
    let sessionId: String
    let sessionFile: String
    let sessionName: String?
    let cwd: String
    let model: HostModel?
    let thinkingLevel: String
    let activePlan: JSONValue?
    let isStreaming: Bool
    let runState: SessionRunState?
    let pendingMessageCount: Int?
    let contextUsage: ContextUsage?
    let fastMode: FastModeState?
    let writable: Bool
    let conflict: HostErrorPayload?
}

struct SessionOpenResult: Codable, Sendable {
    let created: Bool?
    let mode: String
    let snapshot: SessionInspection
    let state: HostState?
    let extensions: ExtensionLoadResult?
}

struct SessionActivationResult: Codable, Sendable {
    let status: String
    let open: SessionOpenResult?
    let error: HostErrorPayload?
    let observationError: HostErrorPayload?
}

struct SessionCreateResult: Codable, Sendable {
    let created: Bool
    let session: SessionSummary
    let activation: SessionActivationResult
}

struct ExtensionLoadResult: Codable, Sendable {
    let loaded: Int
    let errors: [JSONValue]
}

struct ModelsResult: Codable, Sendable {
    let models: [HostModel]
    let defaultModel: HostModel?
    let defaultThinkingLevel: String?
}

struct ModelSelectionResult: Codable, Sendable {
    let model: HostModel
}

struct ThinkingLevelsResult: Codable, Sendable {
    let levels: [String]
}

struct CommandDescriptor: Codable, Identifiable, Sendable {
    var id: String { "\(source):\(name)" }
    let name: String
    let description: String?
    let source: String
    let sourceInfo: JSONValue?
}

struct CommandsResult: Codable, Sendable {
    let commands: [CommandDescriptor]
}

struct Acknowledgement: Codable, Sendable {
    let accepted: Bool?
    let completed: Bool?
    let aborted: Bool?
    let closed: Bool?
    let shuttingDown: Bool?
    let level: String?
}

struct SessionSteerResult: Codable, Equatable, Sendable {
    let accepted: Bool
    let steerID: String
    let runID: String

    enum CodingKeys: String, CodingKey {
        case accepted
        case steerID = "steerId"
        case runID = "runId"
    }
}
