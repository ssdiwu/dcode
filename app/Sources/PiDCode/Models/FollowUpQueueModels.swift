import Foundation

enum FollowUpQueueItemState: String, Codable, Hashable, Sendable {
    case pending
    case dispatching
    case unknown

    var label: String {
        switch self {
        case .pending: "待派发"
        case .dispatching: "正在派发"
        case .unknown: "派发结果未知"
        }
    }
}

enum FollowUpQueuePauseReason: String, Codable, Hashable, Sendable {
    case runFailed
    case runAborted
    case waitingForUser
    case hostInterrupted
    case conflict
    case pathChanged
    case dispatchUnknown
    case runOutcomeUnknown
    case manualResume

    var label: String {
        switch self {
        case .runFailed: "上一轮运行失败，已暂停派发"
        case .runAborted: "上一轮已中止，已暂停派发"
        case .waitingForUser: "正在等待你的处理"
        case .hostInterrupted: "Host 已中断，已保留队列"
        case .conflict: "检测到外部写入，已暂停派发"
        case .pathChanged: "当前会话路径已变化"
        case .dispatchUnknown: "队首派发结果需要核对"
        case .runOutcomeUnknown: "上一轮结果需要核对"
        case .manualResume: "等待手动继续"
        }
    }

    var requiresResultResolution: Bool {
        self == .dispatchUnknown || self == .runOutcomeUnknown
    }
}

struct FollowUpQueueItem: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var text: String
    let createdAt: String
    var updatedAt: String
    var state: FollowUpQueueItemState
    var promptID: String?

    init(
        id: String = UUID().uuidString,
        text: String,
        createdAt: String = Date().ISO8601Format(),
        updatedAt: String? = nil,
        state: FollowUpQueueItemState = .pending,
        promptID: String? = nil
    ) {
        self.id = id
        self.text = text
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.state = state
        self.promptID = promptID
    }
}

struct FollowUpQueueRecord: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let sessionID: String
    let createdAt: String
    var pathID: String
    var lineageEntryID: String
    var items: [FollowUpQueueItem]
    var activeRunID: String?
    var activeRunEntryID: String?
    var pauseReason: FollowUpQueuePauseReason?
    var updatedAt: String

    init(
        id: String = UUID().uuidString,
        sessionID: String,
        pathID: String? = nil,
        lineageEntryID: String,
        items: [FollowUpQueueItem] = [],
        activeRunID: String? = nil,
        activeRunEntryID: String? = nil,
        pauseReason: FollowUpQueuePauseReason? = nil,
        createdAt: String = Date().ISO8601Format(),
        updatedAt: String? = nil
    ) {
        self.id = id
        self.sessionID = sessionID
        self.createdAt = createdAt
        self.pathID = pathID ?? "leaf:\(lineageEntryID)"
        self.lineageEntryID = lineageEntryID
        self.items = items
        self.activeRunID = activeRunID
        self.activeRunEntryID = activeRunEntryID
        self.pauseReason = pauseReason
        self.updatedAt = updatedAt ?? createdAt
    }

    var pendingCount: Int { items.filter { $0.state == .pending }.count }
    var unresolvedCount: Int { items.count }
    var hasUnknownDispatch: Bool { items.contains { $0.state == .unknown } }
    var canAutomaticallyDispatch: Bool {
        pauseReason == nil
            && activeRunID == nil
            && items.first?.state == .pending
    }
}

struct FollowUpQueueDocument: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let maximumQueues = 256
    static let maximumItemsPerQueue = 100
    static let maximumTotalItems = 500
    static let maximumTextUTF16Count = 32_000
    static let maximumTotalTextBytes = 2_000_000

    let version: Int
    var queues: [FollowUpQueueRecord]

    init(queues: [FollowUpQueueRecord] = []) {
        version = Self.currentVersion
        self.queues = queues
    }

    func matchingQueueIndex(
        sessionID: String,
        currentPathID: String?,
        orderedPathEntryIDs: [String]
    ) -> Int? {
        let positions = Dictionary(uniqueKeysWithValues: orderedPathEntryIDs.enumerated().map { ($1, $0) })
        return queues.indices
            .filter { index in
                let queue = queues[index]
                let pathCanAdvance = queue.activeRunID != nil
                    || queue.pauseReason?.requiresResultResolution == true
                return queue.sessionID == sessionID
                    && positions[queue.lineageEntryID] != nil
                    && (queue.pathID == currentPathID || pathCanAdvance)
            }
            .max { left, right in
                let leftPosition = positions[queues[left].lineageEntryID] ?? -1
                let rightPosition = positions[queues[right].lineageEntryID] ?? -1
                if leftPosition != rightPosition { return leftPosition < rightPosition }
                if queues[left].updatedAt != queues[right].updatedAt {
                    return queues[left].updatedAt < queues[right].updatedAt
                }
                return queues[left].id > queues[right].id
            }
    }
}

enum FollowUpQueueStoreError: LocalizedError, Equatable {
    case invalidDocumentVersion(Int)
    case tooManyQueues(Int)
    case tooManyItems(queueID: String, count: Int)
    case tooManyTotalItems(Int)
    case tooManyTextBytes(Int)
    case duplicateIdentifier(String)
    case invalidIdentifier(String)
    case invalidText(itemID: String)
    case invalidTimestamp(String)
    case invalidDispatchState(itemID: String)
    case multipleInFlightItems(queueID: String)
    case unavailableAfterLoadFailure

    var errorDescription: String? {
        switch self {
        case let .invalidDocumentVersion(version):
            "后续消息队列资料版本 \(version) 暂不受支持；原文件已保留。"
        case let .tooManyQueues(count):
            "后续消息队列包含 \(count) 个路径队列，超过 \(FollowUpQueueDocument.maximumQueues) 个安全上限。"
        case let .tooManyItems(_, count):
            "单个后续消息队列包含 \(count) 项，超过 \(FollowUpQueueDocument.maximumItemsPerQueue) 项安全上限。"
        case let .tooManyTotalItems(count):
            "后续消息队列共包含 \(count) 项，超过 \(FollowUpQueueDocument.maximumTotalItems) 项本机上限。"
        case let .tooManyTextBytes(count):
            "后续消息正文共占用 \(count) 字节，超过 \(FollowUpQueueDocument.maximumTotalTextBytes) 字节本机上限。"
        case let .duplicateIdentifier(identifier):
            "后续消息队列包含重复标识：\(identifier)。"
        case let .invalidIdentifier(identifier):
            "后续消息队列包含无效标识：\(identifier.isEmpty ? "<empty>" : identifier)。"
        case let .invalidText(itemID):
            "队列项 \(itemID) 的正文为空或超过 \(FollowUpQueueDocument.maximumTextUTF16Count) 个 UTF-16 code unit。"
        case let .invalidTimestamp(timestamp):
            "后续消息队列包含无效时间：\(timestamp)。"
        case let .invalidDispatchState(itemID):
            "队列项 \(itemID) 的派发状态与 Prompt ID 不一致。"
        case let .multipleInFlightItems(queueID):
            "路径队列 \(queueID) 同时包含多个正在派发或结果未知的项目。"
        case .unavailableAfterLoadFailure:
            "后续消息队列尚未安全载入；为保留原文件，本次不允许写入。"
        }
    }
}

actor FollowUpQueueStore {
    nonisolated let fileURL: URL
    private var latestRevision = -1
    private var writeBlocked = false

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else if let override = ProcessInfo.processInfo.environment["D_CODE_FOLLOW_UP_QUEUE_STORE_PATH"],
                  !override.isEmpty {
            self.fileURL = URL(fileURLWithPath: override)
        } else {
            self.fileURL = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/D Code", directoryHint: .isDirectory)
                .appending(path: "follow-up-queues-v1.json", directoryHint: .notDirectory)
        }
    }

    func load() throws -> FollowUpQueueDocument {
        do {
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                writeBlocked = false
                return FollowUpQueueDocument()
            }
            let document = try JSONDecoder().decode(
                FollowUpQueueDocument.self,
                from: Data(contentsOf: fileURL)
            )
            guard document.version == FollowUpQueueDocument.currentVersion else {
                throw FollowUpQueueStoreError.invalidDocumentVersion(document.version)
            }
            try Self.validate(document)
            writeBlocked = false
            return document
        } catch {
            writeBlocked = true
            throw error
        }
    }

    func save(_ document: FollowUpQueueDocument, revision: Int) throws {
        guard !writeBlocked else { throw FollowUpQueueStoreError.unavailableAfterLoadFailure }
        guard revision > latestRevision else { return }
        try Self.validate(document)
        do {
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

    static func validate(_ document: FollowUpQueueDocument) throws {
        guard document.queues.count <= FollowUpQueueDocument.maximumQueues else {
            throw FollowUpQueueStoreError.tooManyQueues(document.queues.count)
        }
        let totalItems = document.queues.reduce(0) { $0 + $1.items.count }
        guard totalItems <= FollowUpQueueDocument.maximumTotalItems else {
            throw FollowUpQueueStoreError.tooManyTotalItems(totalItems)
        }
        let totalTextBytes = document.queues
            .flatMap(\.items)
            .reduce(0) { $0 + $1.text.utf8.count }
        guard totalTextBytes <= FollowUpQueueDocument.maximumTotalTextBytes else {
            throw FollowUpQueueStoreError.tooManyTextBytes(totalTextBytes)
        }

        var identifiers = Set<String>()
        for queue in document.queues {
            try validateIdentifier(queue.id)
            try validateIdentifier(queue.sessionID)
            try validateIdentifier(queue.pathID)
            try validateIdentifier(queue.lineageEntryID)
            if let activeRunID = queue.activeRunID { try validateIdentifier(activeRunID) }
            if let activeRunEntryID = queue.activeRunEntryID { try validateIdentifier(activeRunEntryID) }
            guard (queue.activeRunID == nil) == (queue.activeRunEntryID == nil) else {
                throw FollowUpQueueStoreError.invalidDispatchState(itemID: queue.id)
            }
            guard identifiers.insert("queue:\(queue.id)").inserted else {
                throw FollowUpQueueStoreError.duplicateIdentifier(queue.id)
            }
            try validateTimestamp(queue.createdAt)
            try validateTimestamp(queue.updatedAt)
            guard queue.items.count <= FollowUpQueueDocument.maximumItemsPerQueue else {
                throw FollowUpQueueStoreError.tooManyItems(queueID: queue.id, count: queue.items.count)
            }
            let inFlight = queue.items.filter { $0.state != .pending }
            guard inFlight.count <= 1 else {
                throw FollowUpQueueStoreError.multipleInFlightItems(queueID: queue.id)
            }
            guard inFlight.isEmpty || queue.items.first?.id == inFlight.first?.id else {
                throw FollowUpQueueStoreError.multipleInFlightItems(queueID: queue.id)
            }
            for item in queue.items {
                try validateIdentifier(item.id, maximumUTF16Count: 128)
                guard identifiers.insert("item:\(item.id)").inserted else {
                    throw FollowUpQueueStoreError.duplicateIdentifier(item.id)
                }
                guard !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      item.text.utf16.count <= FollowUpQueueDocument.maximumTextUTF16Count else {
                    throw FollowUpQueueStoreError.invalidText(itemID: item.id)
                }
                try validateTimestamp(item.createdAt)
                try validateTimestamp(item.updatedAt)
                switch item.state {
                case .pending where item.promptID != nil,
                     .dispatching where item.promptID == nil,
                     .unknown where item.promptID == nil:
                    throw FollowUpQueueStoreError.invalidDispatchState(itemID: item.id)
                default:
                    if let promptID = item.promptID {
                        try validateIdentifier(promptID, maximumUTF16Count: 128)
                    }
                }
            }
        }
    }

    private static func validateIdentifier(_ value: String, maximumUTF16Count: Int = 4_096) throws {
        guard !value.isEmpty,
              value.utf16.count <= maximumUTF16Count,
              !value.contains("\0"),
              !value.contains("\n"),
              !value.contains("\r") else {
            throw FollowUpQueueStoreError.invalidIdentifier(value)
        }
    }

    private static func validateTimestamp(_ value: String) throws {
        let parsed = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value))
        guard parsed != nil else { throw FollowUpQueueStoreError.invalidTimestamp(value) }
    }
}
