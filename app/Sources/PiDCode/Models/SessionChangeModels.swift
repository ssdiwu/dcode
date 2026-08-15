import Foundation

enum SessionMutationOperation: String, Codable, Hashable, Sendable {
    case edit
    case create

    var label: String {
        switch self {
        case .edit: "编辑"
        case .create: "创建"
        }
    }
}

struct SessionMutationRecord: Codable, Identifiable, Hashable, Sendable {
    var id: String { recordId }

    let recordId: String
    let sessionId: String
    let runId: String
    let pathEntryId: String?
    let toolCallId: String
    let operation: SessionMutationOperation
    let filePath: String
    let firstChangedLine: Int?
    let additions: Int
    let deletions: Int
    let occurredAt: String
    let source: String

    var occurredDate: Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(occurredAt))
            ?? (try? Date.ISO8601FormatStyle().parse(occurredAt))
    }
}

struct SessionChangeDocument: Codable, Equatable, Sendable {
    static let currentVersion = 1

    let version: Int
    var records: [SessionMutationRecord]

    init(records: [SessionMutationRecord] = []) {
        version = Self.currentVersion
        self.records = records
    }
}

struct SessionChangedFileSummary: Identifiable, Hashable, Sendable {
    var id: String { filePath }

    let filePath: String
    let additions: Int
    let deletions: Int
    let firstChangedLine: Int?
    let mutationCount: Int
    let latestDate: Date?
}

struct SessionChangeSummary: Equatable, Sendable {
    let sessionID: String
    let records: [SessionMutationRecord]
    let files: [SessionChangedFileSummary]
    let additions: Int
    let deletions: Int
    let runCount: Int

    var fileCount: Int { files.count }
    var isEmpty: Bool { records.isEmpty }

    static func build(sessionID: String, records: [SessionMutationRecord]) -> SessionChangeSummary {
        let scoped = records
            .filter { $0.sessionId == sessionID }
            .sorted { left, right in
                if left.occurredAt != right.occurredAt { return left.occurredAt > right.occurredAt }
                return left.recordId < right.recordId
            }
        let grouped = Dictionary(grouping: scoped, by: \SessionMutationRecord.filePath)
        let files = grouped.map { filePath, records in
            SessionChangedFileSummary(
                filePath: filePath,
                additions: records.reduce(0) { $0 + $1.additions },
                deletions: records.reduce(0) { $0 + $1.deletions },
                firstChangedLine: records.compactMap(\.firstChangedLine).min(),
                mutationCount: records.count,
                latestDate: records.compactMap(\.occurredDate).max()
            )
        }.sorted { left, right in
            switch (left.latestDate, right.latestDate) {
            case let (leftDate?, rightDate?) where leftDate != rightDate:
                return leftDate > rightDate
            default:
                return left.filePath < right.filePath
            }
        }
        return SessionChangeSummary(
            sessionID: sessionID,
            records: scoped,
            files: files,
            additions: scoped.reduce(0) { $0 + $1.additions },
            deletions: scoped.reduce(0) { $0 + $1.deletions },
            runCount: Set(scoped.map(\.runId)).count
        )
    }
}

enum SessionChangeStoreError: LocalizedError, Equatable {
    case invalidDocumentVersion(Int)
    case tooManyRecords(Int)
    case duplicateRecord(String)
    case invalidIdentifier(String)
    case invalidFilePath(String)
    case invalidCount(Int)
    case invalidTimestamp(String)
    case invalidSource(String)
    case unavailableAfterLoadFailure

    var errorDescription: String? {
        switch self {
        case let .invalidDocumentVersion(version):
            "会话变更账本版本 \(version) 暂不受支持；原文件已保留。"
        case let .tooManyRecords(count):
            "会话变更账本包含 \(count) 条记录，超过 50,000 条安全上限；原文件已保留。"
        case let .duplicateRecord(id):
            "会话变更账本包含重复记录：\(id)；原文件已保留。"
        case let .invalidIdentifier(id):
            "会话变更账本包含无效标识：\(id.isEmpty ? "<empty>" : id)；原文件已保留。"
        case let .invalidFilePath(path):
            "会话变更账本包含无效文件路径：\(path.isEmpty ? "<empty>" : path)；原文件已保留。"
        case let .invalidCount(count):
            "会话变更账本包含无效行数：\(count)；原文件已保留。"
        case let .invalidTimestamp(timestamp):
            "会话变更账本包含无效时间：\(timestamp)；原文件已保留。"
        case let .invalidSource(source):
            "会话变更账本包含未知来源：\(source)；原文件已保留。"
        case .unavailableAfterLoadFailure:
            "会话变更账本尚未安全载入；本次不允许继续写入。"
        }
    }
}

actor SessionChangeStore {
    nonisolated let fileURL: URL
    private var latestRevision = -1
    private var writeBlocked = false

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else if let override = ProcessInfo.processInfo.environment["D_CODE_SESSION_CHANGE_STORE_PATH"], !override.isEmpty {
            self.fileURL = URL(fileURLWithPath: override)
        } else {
            self.fileURL = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/D Code", directoryHint: .isDirectory)
                .appending(path: "session-changes-v1.json", directoryHint: .notDirectory)
        }
    }

    func load() throws -> SessionChangeDocument {
        do {
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                writeBlocked = false
                return SessionChangeDocument()
            }
            let document = try JSONDecoder().decode(SessionChangeDocument.self, from: Data(contentsOf: fileURL))
            guard document.version == SessionChangeDocument.currentVersion else {
                throw SessionChangeStoreError.invalidDocumentVersion(document.version)
            }
            try Self.validate(document)
            writeBlocked = false
            return document
        } catch {
            writeBlocked = true
            throw error
        }
    }

    func save(_ document: SessionChangeDocument, revision: Int) throws {
        guard !writeBlocked else { throw SessionChangeStoreError.unavailableAfterLoadFailure }
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

    static func validate(_ document: SessionChangeDocument) throws {
        guard document.records.count <= 50_000 else {
            throw SessionChangeStoreError.tooManyRecords(document.records.count)
        }
        var seen = Set<String>()
        for record in document.records {
            guard validIdentifier(record.recordId, maximum: 12_288),
                  validIdentifier(record.sessionId),
                  validIdentifier(record.runId),
                  validIdentifier(record.toolCallId),
                  record.pathEntryId.map({ validIdentifier($0) }) ?? true else {
                throw SessionChangeStoreError.invalidIdentifier(record.recordId)
            }
            guard seen.insert(record.recordId).inserted else {
                throw SessionChangeStoreError.duplicateRecord(record.recordId)
            }
            guard record.filePath.hasPrefix("/"),
                  record.filePath.utf16.count <= 4_096,
                  !record.filePath.contains("\0"),
                  !record.filePath.contains("\n"),
                  !record.filePath.contains("\r") else {
                throw SessionChangeStoreError.invalidFilePath(record.filePath)
            }
            for count in [record.additions, record.deletions] {
                guard (0...10_000_000).contains(count) else {
                    throw SessionChangeStoreError.invalidCount(count)
                }
            }
            if let line = record.firstChangedLine, !(1...10_000_000).contains(line) {
                throw SessionChangeStoreError.invalidCount(line)
            }
            guard record.occurredDate != nil else {
                throw SessionChangeStoreError.invalidTimestamp(record.occurredAt)
            }
            guard record.source == "structured-tool-v1" else {
                throw SessionChangeStoreError.invalidSource(record.source)
            }
        }
    }

    private static func validIdentifier(_ value: String, maximum: Int = 4_096) -> Bool {
        !value.isEmpty
            && value.utf16.count <= maximum
            && !value.contains("\0")
            && !value.contains("\n")
            && !value.contains("\r")
    }
}
