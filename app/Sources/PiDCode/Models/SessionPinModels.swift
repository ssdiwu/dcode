import Foundation

struct PinnedSessionRecord: Codable, Identifiable, Hashable, Sendable {
    var id: String { sessionID }

    let sessionID: String
    let pinnedAt: String
}

struct SessionPinDocument: Codable, Equatable, Sendable {
    static let currentVersion = 1

    let version: Int
    var records: [PinnedSessionRecord]

    init(records: [PinnedSessionRecord] = []) {
        version = Self.currentVersion
        self.records = records
    }
}

enum SessionPinOrdering {
    static func mergedAndOrdered(
        _ groups: [[SessionSummary]],
        pinnedRecords: [PinnedSessionRecord]
    ) -> [SessionSummary] {
        var merged: [String: SessionSummary] = [:]
        for session in groups.flatMap({ $0 }) {
            if let existing = merged[session.id], existing.modified >= session.modified { continue }
            merged[session.id] = session
        }
        return ordered(Array(merged.values), pinnedRecords: pinnedRecords)
    }

    static func ordered(
        _ sessions: [SessionSummary],
        pinnedRecords: [PinnedSessionRecord]
    ) -> [SessionSummary] {
        let pinnedAt = Dictionary(uniqueKeysWithValues: pinnedRecords.map { ($0.sessionID, $0.pinnedAt) })
        return sessions.sorted { left, right in
            switch (pinnedAt[left.id], pinnedAt[right.id]) {
            case let (leftPinned?, rightPinned?):
                if leftPinned != rightPinned { return leftPinned > rightPinned }
                return left.id < right.id
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            case (nil, nil):
                if left.modified != right.modified { return left.modified > right.modified }
                return left.id < right.id
            }
        }
    }
}

enum SessionPinStoreError: LocalizedError, Equatable {
    case tooManyRecords(Int)
    case invalidDocumentVersion(Int)
    case invalidSessionID(String)
    case duplicateSessionID(String)
    case unavailableAfterLoadFailure

    var errorDescription: String? {
        switch self {
        case let .tooManyRecords(count):
            "会话置顶资料包含 \(count) 条记录，超过 10,000 条安全上限；原文件已保留。"
        case let .invalidDocumentVersion(version):
            "会话置顶资料版本 \(version) 暂不受支持；原文件已保留。"
        case let .invalidSessionID(id):
            "会话置顶资料包含无效的 Session ID：\(id.isEmpty ? "<empty>" : id)；原文件已保留。"
        case let .duplicateSessionID(id):
            "会话置顶资料包含重复的 Session ID：\(id)；原文件已保留。"
        case .unavailableAfterLoadFailure:
            "会话置顶资料尚未安全载入；本次不允许继续写入置顶状态。"
        }
    }
}

actor SessionPinStore {
    nonisolated let fileURL: URL
    private var writeBlocked = false

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else if let override = ProcessInfo.processInfo.environment["D_CODE_SESSION_PIN_STORE_PATH"], !override.isEmpty {
            self.fileURL = URL(fileURLWithPath: override)
        } else {
            self.fileURL = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/D Code", directoryHint: .isDirectory)
                .appending(path: "session-pins-v1.json", directoryHint: .notDirectory)
        }
    }

    func load() throws -> [PinnedSessionRecord] {
        do {
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                writeBlocked = false
                return []
            }
            let document = try JSONDecoder().decode(SessionPinDocument.self, from: Data(contentsOf: fileURL))
            guard document.version == SessionPinDocument.currentVersion else {
                throw SessionPinStoreError.invalidDocumentVersion(document.version)
            }
            try Self.validate(document.records)
            writeBlocked = false
            return document.records
        } catch {
            writeBlocked = true
            throw error
        }
    }

    func save(_ records: [PinnedSessionRecord]) throws {
        guard !writeBlocked else { throw SessionPinStoreError.unavailableAfterLoadFailure }
        try Self.validate(records)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(SessionPinDocument(records: records))
            .write(to: fileURL, options: [.atomic])
    }

    private static func validate(_ records: [PinnedSessionRecord]) throws {
        guard records.count <= 10_000 else {
            throw SessionPinStoreError.tooManyRecords(records.count)
        }
        var seen = Set<String>()
        for record in records {
            guard !record.sessionID.isEmpty, record.sessionID.utf16.count <= 4_096 else {
                throw SessionPinStoreError.invalidSessionID(record.sessionID)
            }
            guard seen.insert(record.sessionID).inserted else {
                throw SessionPinStoreError.duplicateSessionID(record.sessionID)
            }
        }
    }
}
