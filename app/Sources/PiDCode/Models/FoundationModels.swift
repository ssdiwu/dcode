import Foundation

enum FoundationTaskScope: Codable, Hashable, Sendable {
    case user(userId: String)
    case project(projectId: String)

    private enum CodingKeys: String, CodingKey { case kind, userId, projectId }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "user":
            self = .user(userId: try container.decode(String.self, forKey: .userId))
        case "project":
            self = .project(projectId: try container.decode(String.self, forKey: .projectId))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown Task Scope")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .user(userId):
            try container.encode("user", forKey: .kind)
            try container.encode(userId, forKey: .userId)
        case let .project(projectId):
            try container.encode("project", forKey: .kind)
            try container.encode(projectId, forKey: .projectId)
        }
    }

    var jsonValue: JSONValue {
        switch self {
        case let .user(userId):
            .object(["kind": .string("user"), "userId": .string(userId)])
        case let .project(projectId):
            .object(["kind": .string("project"), "projectId": .string(projectId)])
        }
    }
}

struct FoundationLocalUser: Codable, Hashable, Sendable {
    let id: String
    let homeDirectory: String
    let revision: Int
}

struct FoundationProject: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let userId: String
    let title: String
    let directory: String
    let revision: Int
}

struct FoundationAgentProfile: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let role: String
    let name: String
    let roleContract: String
    let enabled: Bool
    let builtin: Bool
    let profileVersion: Int
    let revision: Int
}

struct FoundationTask: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let scope: FoundationTaskScope
    let title: String
    let goal: String
    let acceptance: [String]
    let cwd: String
    let state: String
    let revision: Int
}

struct FoundationSession: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let taskId: String
    let kind: String
    let title: String
    let runtimeAdapter: String
    let lineageStatus: String
    let state: String
    let revision: Int
}

struct FoundationSessionPath: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let sessionId: String
    let sourcePathId: String?
    let sourceLeafEntryId: String?
    let title: String
    let isCurrent: Bool
    let revision: Int
}

struct FoundationCoordinatorAssignment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let taskId: String
    let sessionId: String
    let profileId: String
    let revision: Int
}

struct FoundationPiImport: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let sourceSessionId: String
    let sourcePath: String
    let sourceDigest: String
    let taskId: String
    let sessionId: String
    let lineageStatus: String
    let state: String
}

struct FoundationSnapshot: Codable, Sendable {
    let schemaVersion: Int
    let storeRevision: Int
    let dataRoot: String
    let currentUser: FoundationLocalUser
    let projects: [FoundationProject]
    let agentProfiles: [FoundationAgentProfile]
    let tasks: [FoundationTask]
    let sessions: [FoundationSession]
    let sessionPaths: [FoundationSessionPath]
    let coordinatorAssignments: [FoundationCoordinatorAssignment]
    let piImports: [FoundationPiImport]
    let sessionRuns: [FoundationSessionRun]
    let operationAttempts: [FoundationOperationAttempt]
    let runtimeEnvironments: [FoundationRuntimeEnvironment]
    let activeToolSets: [FoundationActiveToolSet]
    let promptReceipts: [FoundationPromptReceipt]
    let teamRuns: [FoundationTeamRun]
    let agentRuns: [FoundationAgentRun]
    let agentAssignments: [FoundationAgentAssignment]
    let agentRequests: [FoundationAgentRequest]
    let agentReports: [FoundationAgentReport]
    let findings: [FoundationFinding]
    let artifacts: [FoundationArtifact]
    let evidence: [FoundationEvidence]
}

struct FoundationSessionRun: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let taskId: String
    let sessionId: String
    let runtimeId: String
    let agentRunId: String?
    let effectiveInputId: String?
    let runtimeEnvironmentId: String?
    let activeToolSetId: String?
    let status: String
    let revision: Int
    let startedAt: String?
    let completedAt: String?
}

struct FoundationOperationAttempt: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let sessionId: String?
    let sessionRunId: String?
    let agentRunId: String?
    let operationKind: String
    let targetIdentity: String
    let parameterDigest: String
    let replayPolicy: String
    let status: String
    let outcome: JSONValue?
    let preparedAt: String
    let completedAt: String?
}

struct FoundationRuntimeEnvironment: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let sessionId: String
    let runtimeId: String
    let workspaceId: String
    let cwd: String
    let workspaceAccess: String
    let modelProvider: String?
    let modelId: String?
    let environment: JSONValue
    let revision: Int
    let createdAt: String
}

struct FoundationActiveToolSet: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let sessionId: String
    let revision: Int
    let digest: String
    let tools: JSONValue
    let writable: Bool
    let createdAt: String
}

struct FoundationPromptSourceState: Codable, Identifiable, Sendable {
    var id: String { "\(path)#\(receiptDigest)" }
    let path: String
    let receiptDigest: String
    let receiptBytes: Int
    let state: String
    let contentStored: Bool
    let currentDigest: String?
    let currentBytes: Int?
    let unavailableReason: String?
}

struct FoundationPromptReceipt: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let sessionId: String
    let sessionRunId: String
    let effectiveInputId: String
    let runtimeEnvironmentId: String
    let activeToolSetId: String
    let systemPromptDigest: String
    let identityRevision: String
    let roleRevision: String
    let sourceReceipts: JSONValue
    let sourceStates: [FoundationPromptSourceState]
    let createdAt: String
}

struct FoundationPiImportCandidate: Codable, Identifiable, Hashable, Sendable {
    var id: String { sourceSessionId }
    let sourceSessionId: String
    let title: String
    let cwd: String
    let created: String
    let modified: String
    let messageCount: Int
    let firstMessage: String
    let previouslyImported: Bool
}

struct FoundationPiImportCandidateList: Codable, Sendable {
    let candidates: [FoundationPiImportCandidate]
}

struct FoundationPiImportPreview: Codable, Sendable {
    struct OmittedContent: Codable, Sendable {
        let hiddenThinking: Bool
        let binaryImages: Bool
        let toolArguments: Bool
        let toolResults: Bool
        let redactedSecrets: Bool
    }

    let sourceSessionId: String
    let title: String
    let cwd: String
    let created: String
    let modified: String
    let messageCount: Int
    let firstMessage: String
    let previouslyImported: Bool
    let sourcePath: String
    let sourceDigest: String
    let importedEntryCount: Int
    let lineageStatus: String
    let omittedContent: OmittedContent
}

struct FoundationTaskBundle: Codable, Sendable {
    let storeRevision: Int
    let task: FoundationTask
    let coordinationSession: FoundationSession
    let coordinatorAssignment: FoundationCoordinatorAssignment
}

struct FoundationProjectCreation: Codable, Sendable {
    let storeRevision: Int
    let project: FoundationProject
}

struct FoundationTaskDecision: Codable, Sendable {
    let storeRevision: Int
    let task: FoundationTask
}

struct FoundationAgentProfileUpdate: Codable, Sendable {
    let storeRevision: Int
    let agentProfile: FoundationAgentProfile
}

struct FoundationTeamRun: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let taskId: String
    let coordinatorAgentRunId: String
    let status: String
    let revision: Int
}

struct FoundationAgentRun: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let teamRunId: String?
    let sessionId: String
    let profileId: String
    let profileSnapshot: JSONValue
    let role: String
    let status: String
    let revision: Int
}

struct FoundationAgentAssignment: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let teamRunId: String?
    let agentRunId: String?
    let profileId: String
    let assignmentKind: String
    let taskPacket: JSONValue
    let revision: Int
}

struct FoundationTeamRunCreation: Codable, Sendable {
    let storeRevision: Int
    let teamRun: FoundationTeamRun
    let coordinatorAgentRun: FoundationAgentRun
    let childSessions: [FoundationSession]
    let childAgentRuns: [FoundationAgentRun]
    let assignments: [FoundationAgentAssignment]
}

struct FoundationTeamStartResult: Codable, Sendable {
    let taskId: String
    let teamRunId: String
    let coordinatorManaged: Bool
    let started: Bool
    let terminalStatus: String?
    let reasonCode: String?
    let replayed: Bool?
}

struct FoundationAgentStopResult: Codable, Sendable {
    let stopped: Bool
    let outcome: String?
    let reasonCode: String?
    let attemptId: String
    let storeRevision: Int
    let replayed: Bool?
}

struct FoundationAgentReport: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let agentRunId: String
    let reportKind: String
    let body: JSONValue
    let createdAt: String
}

struct FoundationAgentRequestOption: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let description: String?
    let recommended: Bool
}

struct FoundationAgentRequest: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let teamRunId: String?
    let agentRunId: String
    let sessionId: String
    let sessionRunId: String
    let runtimeId: String
    let kind: String
    let prompt: String
    let options: [FoundationAgentRequestOption]
    let status: String
    let answer: JSONValue?
    let revision: Int
    let createdAt: String
    let updatedAt: String
}

struct FoundationFinding: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let agentRunId: String
    let severity: String
    let body: String
    let evidenceRefs: JSONValue
    let createdAt: String
}

struct FoundationArtifact: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let sessionId: String?
    let agentRunId: String?
    let kind: String
    let title: String
    let managedPath: String?
    let externalPath: String?
    let digest: String?
    let metadata: JSONValue
    let revision: Int
}

struct FoundationEvidence: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let sessionId: String
    let agentRunId: String?
    let evidenceKind: String
    let commandRedacted: String?
    let exitKind: String?
    let exitCode: Int?
    let cwd: String?
    let payload: JSONValue
    let createdAt: String
}
