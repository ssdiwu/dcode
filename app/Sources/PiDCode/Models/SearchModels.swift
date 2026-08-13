import Foundation

enum SessionSearchIndexState: String, Codable, Sendable {
    case idle
    case building
    case updating
    case rebuilding
    case ready
    case failed
}

struct SessionSearchProgress: Codable, Equatable, Sendable {
    let completed: Int
    let total: Int
}

struct SessionSearchIndexStatus: Codable, Equatable, Sendable {
    let state: SessionSearchIndexState
    let complete: Bool
    let progress: SessionSearchProgress?
    let revision: Int?
    let message: String?

    static let idle = SessionSearchIndexStatus(
        state: .idle,
        complete: false,
        progress: nil,
        revision: nil,
        message: nil
    )

    var canServeResults: Bool { state == .ready && complete }
}

struct SessionSearchResult: Codable, Identifiable, Hashable, Sendable {
    let sessionId: String
    let entryId: String?
    let entryDigest: String?
    let matchKind: String
    let role: String?
    let title: String
    let cwd: String
    let modified: String
    let snippet: String
    let matchCount: Int

    init(
        sessionId: String,
        entryId: String?,
        entryDigest: String? = nil,
        matchKind: String,
        role: String?,
        title: String,
        cwd: String,
        modified: String,
        snippet: String,
        matchCount: Int
    ) {
        self.sessionId = sessionId
        self.entryId = entryId
        self.entryDigest = entryDigest
        self.matchKind = matchKind
        self.role = role
        self.title = title
        self.cwd = cwd
        self.modified = modified
        self.snippet = snippet
        self.matchCount = matchCount
    }

    var id: String { sessionId }

    var modifiedDate: Date? {
        try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(modified)
    }

    func accessibilityDescription(ownership: SearchResultOwnership) -> String {
        let roleLabel = switch role {
        case "user": "用户消息"
        case "assistant": "助手回复"
        default: "会话标题"
        }
        let location = if let projectName = ownership.projectName,
                          let folderName = ownership.sourceFolderName {
            "项目 \(projectName)，源文件夹 \(folderName)"
        } else {
            "未加入项目"
        }
        let matchLabel = matchCount > 1 ? "，共 \(matchCount) 处命中" : ""
        let snippetLabel = snippet.isEmpty || snippet == title ? "" : "，\(snippet)"
        return "\(title)\(snippetLabel)，\(roleLabel)\(matchLabel)，\(location)，工作目录 \(cwd)"
    }
}

struct SessionSearchResponse: Codable, Sendable {
    let requestToken: String
    let index: SessionSearchIndexStatus
    let results: [SessionSearchResult]
}

struct SessionSearchRequestPlan: Equatable, Sendable {
    let generation: UUID
    let query: String
    let projectSourceFolders: [String]
    let filterSourceFolders: [String]?
    let excludedSessionIDs: [String]
    let refresh: Bool

    init(
        generation: UUID,
        query: String,
        projectSourceFolders: [String],
        filterSourceFolders: [String]?,
        excludedSessionIDs: [String] = [],
        refresh: Bool
    ) {
        self.generation = generation
        self.query = query
        self.projectSourceFolders = projectSourceFolders
        self.filterSourceFolders = filterSourceFolders
        self.excludedSessionIDs = excludedSessionIDs
        self.refresh = refresh
    }

    var parameters: [String: JSONValue] {
        var result: [String: JSONValue] = [
            "query": .string(query),
            "requestToken": .string(generation.uuidString),
            "limit": .number(50),
            "projectSourceFolders": .array(projectSourceFolders.map(JSONValue.string)),
            "excludedSessionIds": .array(excludedSessionIDs.map(JSONValue.string)),
            "refresh": .bool(refresh),
        ]
        if let filterSourceFolders {
            result["filterSourceFolders"] = .array(filterSourceFolders.map(JSONValue.string))
        }
        return result
    }

    func accepts(
        _ response: SessionSearchResponse,
        searchPresented: Bool,
        currentGeneration: UUID
    ) -> Bool {
        searchPresented
            && currentGeneration == generation
            && response.requestToken == generation.uuidString
    }
}

struct SessionSearchProbePlan: Equatable, Sendable {
    let token: UUID
    let projectSourceFolders: [String]
    let excludedSessionIDs: [String]

    init(token: UUID, projectSourceFolders: [String], excludedSessionIDs: [String] = []) {
        self.token = token
        self.projectSourceFolders = projectSourceFolders
        self.excludedSessionIDs = excludedSessionIDs
    }

    var parameters: [String: JSONValue] {
        [
            "query": .string(""),
            "requestToken": .string(token.uuidString),
            "limit": .number(1),
            "projectSourceFolders": .array(projectSourceFolders.map(JSONValue.string)),
            "excludedSessionIds": .array(excludedSessionIDs.map(JSONValue.string)),
            "refresh": .bool(false),
            "probe": .bool(true),
        ]
    }
}

struct SessionOpenRequestPlan: Equatable, Sendable {
    let sessionID: String
    let writable: Bool
    let expectedEntryID: String?
    let expectedEntryDigest: String?
    let preserveActive: Bool
    let pathID: String?

    init(
        sessionID: String,
        writable: Bool,
        expectedEntryID: String?,
        expectedEntryDigest: String?,
        preserveActive: Bool,
        pathID: String? = nil
    ) {
        self.sessionID = sessionID
        self.writable = writable
        self.expectedEntryID = expectedEntryID
        self.expectedEntryDigest = expectedEntryDigest
        self.preserveActive = preserveActive
        self.pathID = pathID
    }

    var parameters: [String: JSONValue] {
        var result: [String: JSONValue] = [
            "sessionId": .string(sessionID),
            "mode": .string(writable ? "writable" : "readOnly"),
        ]
        if writable { result["writeIntent"] = .bool(true) }
        if let expectedEntryID { result["expectedEntryId"] = .string(expectedEntryID) }
        if let expectedEntryDigest { result["expectedEntryDigest"] = .string(expectedEntryDigest) }
        if preserveActive { result["preserveActive"] = .bool(true) }
        if let pathID { result["pathId"] = .string(pathID) }
        return result
    }

    static func searchResult(_ result: SessionSearchResult) -> SessionOpenRequestPlan {
        SessionOpenRequestPlan(
            sessionID: result.sessionId,
            writable: false,
            expectedEntryID: result.entryId,
            expectedEntryDigest: result.entryDigest,
            preserveActive: true,
            pathID: nil
        )
    }
}

struct ConversationTarget: Equatable, Sendable {
    let sessionID: String
    let entryID: String
    let token: UUID
}

struct SearchResultOwnership: Equatable, Sendable {
    let projectName: String?
    let sourceFolderName: String?
}
