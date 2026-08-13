import Foundation

struct SessionPathSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let leafId: String?
    let title: String
    let updated: String
    let entryCount: Int
    let branchFromEntryId: String?
    let branchFromPreview: String?
    let isCurrent: Bool
    let isSelected: Bool
}

enum SessionPathActionKind: String, Codable, Hashable, Sendable {
    case editUser
    case continueAssistant
    case continuePath
}

struct SessionPathAction: Codable, Hashable, Sendable {
    let kind: SessionPathActionKind
    let entryId: String
}

enum SessionDraftTarget: Codable, Hashable, Sendable {
    case path(sessionID: String, pathID: String)
    case pending(sessionID: String, originPathID: String, action: SessionPathAction)

    var sessionID: String {
        switch self {
        case let .path(sessionID, _), let .pending(sessionID, _, _): sessionID
        }
    }

    var stableID: String {
        switch self {
        case let .path(sessionID, pathID):
            "path:\(sessionID):\(pathID)"
        case let .pending(sessionID, _, action):
            "pending:\(sessionID):\(action.kind.rawValue):\(action.entryId)"
        }
    }

    var pathAction: SessionPathAction? {
        if case let .pending(_, _, action) = self { return action }
        return nil
    }

    var pathID: String? {
        if case let .path(_, pathID) = self { return pathID }
        return nil
    }

    var openingPathID: String {
        switch self {
        case let .path(_, pathID): pathID
        case let .pending(_, originPathID, _): originPathID
        }
    }

    func actionForSending(currentPathID: String?) -> SessionPathAction? {
        if let pathAction { return pathAction }
        guard let pathID,
              pathID != currentPathID,
              pathID.hasPrefix("leaf:"),
              pathID.count > 5 else { return nil }
        return SessionPathAction(kind: .continuePath, entryId: String(pathID.dropFirst(5)))
    }

    func rebasedPathTarget(
        sessionID: String,
        nextPathID: String,
        visibleEntryIDs: Set<String>
    ) -> SessionDraftTarget? {
        guard case let .path(targetSessionID, targetPathID) = self,
              targetSessionID == sessionID,
              targetPathID != nextPathID,
              targetPathID.hasPrefix("leaf:"),
              visibleEntryIDs.contains(String(targetPathID.dropFirst(5))) else { return nil }
        return .path(sessionID: sessionID, pathID: nextPathID)
    }
}

struct SessionDraftRecord: Codable, Hashable, Sendable {
    let target: SessionDraftTarget
    var text: String
    var updatedAt: String
}

struct SessionDraftDocument: Codable, Equatable, Sendable {
    static let currentVersion = 1

    let version: Int
    var records: [SessionDraftRecord]
    var activeTargets: [String: SessionDraftTarget]

    init(records: [SessionDraftRecord] = [], activeTargets: [String: SessionDraftTarget] = [:]) {
        version = Self.currentVersion
        self.records = records
        self.activeTargets = activeTargets
    }
}

enum SessionDraftStoreError: LocalizedError, Equatable {
    case invalidDocumentVersion(Int)
    case duplicateTarget(String)
    case unavailableAfterLoadFailure

    var errorDescription: String? {
        switch self {
        case let .invalidDocumentVersion(version):
            "会话草稿资料版本 \(version) 暂不受支持；原文件已保留。"
        case let .duplicateTarget(target):
            "会话草稿资料包含重复目标：\(target)；原文件已保留。"
        case .unavailableAfterLoadFailure:
            "会话草稿尚未安全载入；为保留原文件，本次不允许写入。"
        }
    }
}

actor SessionDraftStore {
    nonisolated let fileURL: URL
    private var latestRevision = -1
    private var writeBlocked = false

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else if let override = ProcessInfo.processInfo.environment["D_CODE_SESSION_DRAFT_STORE_PATH"], !override.isEmpty {
            self.fileURL = URL(fileURLWithPath: override)
        } else {
            self.fileURL = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/D Code", directoryHint: .isDirectory)
                .appending(path: "session-drafts-v1.json", directoryHint: .notDirectory)
        }
    }

    func load() throws -> SessionDraftDocument {
        do {
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                writeBlocked = false
                return SessionDraftDocument()
            }
            let document = try JSONDecoder().decode(SessionDraftDocument.self, from: Data(contentsOf: fileURL))
            guard document.version == SessionDraftDocument.currentVersion else {
                throw SessionDraftStoreError.invalidDocumentVersion(document.version)
            }
            try Self.validate(document)
            writeBlocked = false
            return document
        } catch {
            writeBlocked = true
            throw error
        }
    }

    func save(_ document: SessionDraftDocument, revision: Int) throws {
        guard !writeBlocked else { throw SessionDraftStoreError.unavailableAfterLoadFailure }
        guard revision > latestRevision else { return }
        do {
            try Self.validate(document)
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            try encoder.encode(document).write(to: fileURL, options: [.atomic])
            latestRevision = revision
        } catch {
            writeBlocked = true
            throw error
        }
    }

    private static func validate(_ document: SessionDraftDocument) throws {
        var targets = Set<String>()
        for record in document.records {
            guard targets.insert(record.target.stableID).inserted else {
                throw SessionDraftStoreError.duplicateTarget(record.target.stableID)
            }
        }
        for (sessionID, target) in document.activeTargets where target.sessionID != sessionID {
            throw SessionDraftStoreError.duplicateTarget("active:\(sessionID)")
        }
    }
}
