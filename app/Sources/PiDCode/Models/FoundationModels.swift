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

struct FoundationModelProvider: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let baseUrl: String?
    let apiKind: String?
    let authMode: String?
    let nonsecret: JSONValue
    let revision: Int
}

struct FoundationModelCatalogEntry: Codable, Identifiable, Sendable {
    let id: String
    let providerId: String
    let modelId: String
    let name: String
    let contextWindow: Int?
    let maxTokens: Int?
    let reasoning: Bool
    let nonsecret: JSONValue
    let revision: Int
}

struct FoundationCredentialReference: Codable, Identifiable, Sendable {
    let id: String
    let providerId: String
    let referenceKind: String
    let locator: String
    let configured: Bool
    let sourceDigest: String?
    let revision: Int
}

struct FoundationRuntimeModelSelection: Codable, Hashable, Sendable {
    let providerId: String
    let modelId: String
    let sourceKind: String
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
    let modelProviders: [FoundationModelProvider]?
    let modelCatalogEntries: [FoundationModelCatalogEntry]?
    let credentialReferences: [FoundationCredentialReference]?
    let runtimeModelSelection: FoundationRuntimeModelSelection?
    let taskWorkbenchViewState: FoundationTaskWorkbenchViewState?
    let agentProfiles: [FoundationAgentProfile]
    let tasks: [FoundationTask]
    let taskContextSets: [FoundationTaskContextSet]
    let taskPlans: [FoundationTaskPlan]
    let taskWorkItems: [FoundationTaskWorkItem]
    let composerDrafts: [FoundationComposerDraft]?
    let sessions: [FoundationSession]
    let sessionPaths: [FoundationSessionPath]
    let coordinatorAssignments: [FoundationCoordinatorAssignment]
    let piImports: [FoundationPiImport]
    let sessionRuntimeBindings: [FoundationSessionRuntimeBinding]?
    let sessionRuns: [FoundationSessionRun]
    let operationAttempts: [FoundationOperationAttempt]
    let runtimeEnvironments: [FoundationRuntimeEnvironment]
    let activeToolSets: [FoundationActiveToolSet]
    let promptReceipts: [FoundationPromptReceipt]
    let teamRuns: [FoundationTeamRun]
    let teamFailures: [FoundationTeamFailure]
    let agentRuns: [FoundationAgentRun]
    let agentAssignments: [FoundationAgentAssignment]
    let agentRequests: [FoundationAgentRequest]
    let agentReports: [FoundationAgentReport]
    let findings: [FoundationFinding]
    let artifacts: [FoundationArtifact]
    let managedWorkerWorktrees: [FoundationManagedWorkerWorktree]
    let evidence: [FoundationEvidence]
}

struct FoundationTaskWorkbenchViewState: Codable, Sendable {
    let version: Int
    let selection: FoundationTaskWorkbenchSelection
    let expandedHudSections: [String]
    let inspectorTarget: FoundationTaskWorkbenchInspectorTarget?
    let revision: Int
}

struct FoundationTaskWorkbenchSelection: Codable, Sendable {
    let taskId: String?
    let sessionId: String?
}

struct FoundationTaskWorkbenchInspectorTarget: Codable, Hashable, Sendable {
    let kind: String
    let id: String
}

struct FoundationTaskWorkbenchViewStateMutation: Codable, Sendable {
    let storeRevision: Int
    let taskWorkbenchViewState: FoundationTaskWorkbenchViewState
}

struct FoundationComposerDraft: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String?
    let sessionId: String?
    let draftKind: String
    let text: String
    let revision: Int
    let createdAt: String
    let updatedAt: String
}

struct FoundationComposerDraftMutation: Codable, Sendable {
    let storeRevision: Int
    let composerDraft: FoundationComposerDraft?
}

struct FoundationSessionRuntimeBinding: Codable, Identifiable, Sendable {
    var id: String { sessionId }
    let sessionId: String
    let taskId: String
    let adapterKind: String
    let adapterSessionId: String
    let adapterSessionPath: String
    let cwd: String
    let state: String
    let revision: Int
}

struct FoundationDCodeSessionRuntime: Codable, Sendable {
    let runtimeId: String
    let state: HostState
}

struct FoundationDCodeSessionPresentation: Codable, Sendable {
    let dcodeSession: FoundationSession
    let binding: FoundationSessionRuntimeBinding?
    let runtime: FoundationDCodeSessionRuntime?
    let adapterState: String
    let inspection: SessionInspection?
}

struct FoundationDCodeSessionPromptResult: Codable, Sendable {
    let runtimeId: String
    let started: Bool
    let result: JSONValue
}

struct FoundationTaskContextSource: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let taskId: String
    let kind: String
    let relativePath: String
    let title: String
    let ordinal: Int
    let rootPath: String?
    let createdAt: String
    let updatedAt: String
}

struct FoundationTaskContextSet: Codable, Identifiable, Hashable, Sendable {
    var id: String { taskId }
    let taskId: String
    let revision: Int
    let sources: [FoundationTaskContextSource]
    let createdAt: String
    let updatedAt: String
}

struct FoundationTaskContextReplacement: Codable, Sendable {
    let storeRevision: Int
    let contextSet: FoundationTaskContextSet
}

struct FoundationTaskContextSourceInput: Hashable, Sendable {
    let kind: String
    let relativePath: String
    let title: String?
    let rootPath: String?

    var jsonValue: JSONValue {
        var value: [String: JSONValue] = [
            "kind": .string(kind),
            "relativePath": .string(relativePath),
        ]
        if let title { value["title"] = .string(title) }
        if let rootPath { value["rootPath"] = .string(rootPath) }
        return .object(value)
    }
}

struct FoundationTaskPlan: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let state: String
    let document: JSONValue
    let revision: Int
    let createdAt: String
    let updatedAt: String
}

struct FoundationTaskWorkItem: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let ordinal: Int
    let title: String
    let state: String
    let ownerAssignmentId: String?
    let details: JSONValue
    let revision: Int
    let createdAt: String
    let updatedAt: String
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
    let kind: String?
    let title: String?
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

struct FoundationTeamFailure: Codable, Identifiable, Sendable {
    var id: String { teamRunId }
    let teamRunId: String
    let taskId: String
    let status: String
    let reason: String
    let reasonCode: String?
    let eventSequence: Int
    let createdAt: String
}

struct FoundationAgentRun: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let teamRunId: String?
    let sessionId: String
    let profileId: String
    let profileSnapshot: JSONValue
    let role: String
    let modelProvider: String?
    let modelId: String?
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

struct FoundationManagedWorkerWorktree: Codable, Identifiable, Sendable {
    var id: String { artifactId }
    let artifactId: String
    let taskId: String
    let teamRunId: String
    let agentRunId: String
    let projectId: String
    let workspaceId: String
    let managedPath: String
    let workspaceCwd: String
    let sourceProjectDirectory: String
    let repositoryRoot: String
    let commonGitDirectory: String
    let baseCommit: String
    let projectRelativePath: String
    let provisionAttemptId: String
    let state: String
    let failureCode: String?
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
