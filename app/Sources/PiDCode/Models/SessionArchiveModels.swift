import Foundation

enum SessionCopyMode: String, Identifiable, Sendable {
    case copy
    case copyAndArchive

    var id: String { rawValue }
}

struct ArchivedSessionRecord: Codable, Identifiable, Hashable, Sendable {
    var id: String { sessionID }

    let sessionID: String
    let archivedAt: String
    let copiedToSessionID: String?
    let copiedToTitle: String?
    let copiedToCwd: String?
    let sourceTitle: String
    let sourceCwd: String

    var archivedDate: Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(archivedAt))
            ?? (try? Date.ISO8601FormatStyle().parse(archivedAt))
    }
}

struct SessionArchiveDocument: Codable, Equatable, Sendable {
    static let currentVersion = 1

    let version: Int
    var records: [ArchivedSessionRecord]
    var pending: ArchivedSessionRecord?

    init(records: [ArchivedSessionRecord] = [], pending: ArchivedSessionRecord? = nil) {
        version = Self.currentVersion
        self.records = records
        self.pending = pending
    }
}

enum SessionArchiveStoreError: LocalizedError, Equatable {
    case invalidDocumentVersion(Int)
    case tooManyRecords(Int)
    case invalidSessionID(String)
    case duplicateSessionID(String)
    case invalidCopyIdentity(String)
    case incompleteCopyTarget(String)
    case pendingArchiveRequiresCopyTarget(String)
    case unavailableAfterLoadFailure

    var errorDescription: String? {
        switch self {
        case let .invalidDocumentVersion(version):
            "会话归档资料版本 \(version) 暂不受支持；原文件已保留。"
        case let .tooManyRecords(count):
            "会话归档资料包含 \(count) 条记录，超过 10,000 条安全上限；原文件已保留。"
        case let .invalidSessionID(id):
            "会话归档资料包含无效的 Session ID：\(id.isEmpty ? "<empty>" : id)；原文件已保留。"
        case let .duplicateSessionID(id):
            "会话归档资料包含重复的 Session ID：\(id)；原文件已保留。"
        case let .invalidCopyIdentity(id):
            "归档源与复制目标不能使用同一 Session ID：\(id)。"
        case let .incompleteCopyTarget(id):
            "会话 \(id) 的复制目标资料不完整；原文件已保留。"
        case let .pendingArchiveRequiresCopyTarget(id):
            "待重试归档 \(id) 必须来自已经完成的会话复制。"
        case .unavailableAfterLoadFailure:
            "会话归档资料尚未安全载入；为防止归档对象泄漏，本次不允许普通会话导航。"
        }
    }
}

actor SessionArchiveStore {
    nonisolated let fileURL: URL
    private var writeBlocked = false

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else if let override = ProcessInfo.processInfo.environment["D_CODE_SESSION_ARCHIVE_STORE_PATH"], !override.isEmpty {
            self.fileURL = URL(fileURLWithPath: override)
        } else {
            self.fileURL = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/D Code", directoryHint: .isDirectory)
                .appending(path: "session-archives-v1.json", directoryHint: .notDirectory)
        }
    }

    func load() throws -> [ArchivedSessionRecord] {
        try loadDocument().records
    }

    func loadDocument() throws -> SessionArchiveDocument {
        do {
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                writeBlocked = false
                return SessionArchiveDocument()
            }
            let document = try JSONDecoder().decode(SessionArchiveDocument.self, from: Data(contentsOf: fileURL))
            guard document.version == SessionArchiveDocument.currentVersion else {
                throw SessionArchiveStoreError.invalidDocumentVersion(document.version)
            }
            try Self.validate(document.records, pending: document.pending)
            writeBlocked = false
            return document
        } catch {
            writeBlocked = true
            throw error
        }
    }

    func save(_ records: [ArchivedSessionRecord]) throws {
        try save(records: records, pending: nil)
    }

    func save(records: [ArchivedSessionRecord], pending: ArchivedSessionRecord?) throws {
        guard !writeBlocked else { throw SessionArchiveStoreError.unavailableAfterLoadFailure }
        try Self.validate(records, pending: pending)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(SessionArchiveDocument(records: records, pending: pending))
            .write(to: fileURL, options: [.atomic])
    }

    private static func validate(
        _ records: [ArchivedSessionRecord],
        pending: ArchivedSessionRecord?
    ) throws {
        let allRecords = records + (pending.map { [$0] } ?? [])
        guard allRecords.count <= 10_000 else {
            throw SessionArchiveStoreError.tooManyRecords(allRecords.count)
        }
        var seen = Set<String>()
        for record in allRecords {
            guard !record.sessionID.isEmpty, record.sessionID.utf16.count <= 4_096 else {
                throw SessionArchiveStoreError.invalidSessionID(record.sessionID)
            }
            if let copiedToSessionID = record.copiedToSessionID {
                guard !copiedToSessionID.isEmpty, copiedToSessionID.utf16.count <= 4_096 else {
                    throw SessionArchiveStoreError.invalidSessionID(copiedToSessionID)
                }
            }
            guard seen.insert(record.sessionID).inserted else {
                throw SessionArchiveStoreError.duplicateSessionID(record.sessionID)
            }
            let copyValues = [record.copiedToSessionID, record.copiedToTitle, record.copiedToCwd]
            let populatedCopyValues = copyValues.compactMap { $0 }.count
            guard populatedCopyValues == 0 || populatedCopyValues == copyValues.count else {
                throw SessionArchiveStoreError.incompleteCopyTarget(record.sessionID)
            }
            guard record.sessionID != record.copiedToSessionID else {
                throw SessionArchiveStoreError.invalidCopyIdentity(record.sessionID)
            }
        }
        if let pending, pending.copiedToSessionID == nil {
            throw SessionArchiveStoreError.pendingArchiveRequiresCopyTarget(pending.sessionID)
        }
    }
}
