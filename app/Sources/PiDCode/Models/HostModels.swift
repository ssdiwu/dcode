import Foundation

struct HostHello: Codable, Sendable {
    let protocolVersion: Int
    let hostVersion: String?
    let piVersion: String
    let nodeVersion: String
    let capabilities: [String: JSONValue]
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
    let leafId: String?
    let entries: [JSONValue]
    let context: SessionContextSnapshot
    let activePlan: JSONValue?

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

    var displayName: String { name ?? id }
    var qualifiedName: String { "\(provider)/\(id)" }
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
    let pendingMessageCount: Int?
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

struct ExtensionLoadResult: Codable, Sendable {
    let loaded: Int
    let errors: [JSONValue]
}

struct ModelsResult: Codable, Sendable {
    let models: [HostModel]
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
