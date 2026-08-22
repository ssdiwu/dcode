import Foundation

enum SidebarProjection: String, Codable, Sendable {
    case navigation
    case activity

    func bellAccessibilityValue(hasUnseenActivity: Bool) -> String {
        let projection = self == .activity ? "当前为活动视图" : "当前为会话导航"
        let attention = hasUnseenActivity ? "有新完成结果" : "没有新完成结果"
        return "\(projection)，\(attention)"
    }
}

enum SessionRunPhase: String, Codable, Sendable {
    case running
    case waitingForUser
    case stopRequested
    case completed
    case failed
    case aborted
    case unknown

    var isActive: Bool {
        switch self {
        case .running, .waitingForUser, .stopRequested: true
        case .completed, .failed, .aborted, .unknown: false
        }
    }

    var requiresInteractionDock: Bool {
        switch self {
        case .completed, .aborted: false
        case .running, .waitingForUser, .stopRequested, .failed, .unknown: true
        }
    }
}

enum RunningMessageDeliveryMode: String, CaseIterable, Identifiable, Sendable {
    case steer
    case queue

    var id: String { rawValue }

    var label: String {
        switch self {
        case .steer: "立即介入"
        case .queue: "排队等待"
        }
    }

    var detail: String {
        switch self {
        case .steer: "在当前工具安全结束后、下一次模型调用前交给 Pi。"
        case .queue: "等待当前一轮正常结束后，再作为下一条消息发送。"
        }
    }
}

enum SessionRunWaitKind: String, Codable, Sendable {
    case select
    case confirm
    case input
    case editor

    var label: String {
        switch self {
        case .select: "等待选择"
        case .confirm: "等待确认"
        case .input: "等待输入"
        case .editor: "等待编辑"
        }
    }

    var instruction: String {
        switch self {
        case .select: "请在结构化请求中选择一个选项；普通队列不会截获答案。"
        case .confirm: "请在结构化请求中确认或拒绝；普通队列不会截获决定。"
        case .input: "请在结构化请求中填写内容；普通队列不会截获答案。"
        case .editor: "请在结构化编辑器中完成内容；普通队列不会截获答案。"
        }
    }
}

struct SessionRunState: Codable, Equatable, Sendable {
    let sessionID: String
    let runID: String
    let phase: SessionRunPhase
    let waitingFor: SessionRunWaitKind?
    let startedAt: String
    let updatedAt: String
    let completionID: String?
    let completionEntryID: String?
    let completedAt: String?
    let inputPersisted: Bool
    let retryable: Bool

    enum CodingKeys: String, CodingKey {
        case sessionID = "sessionId"
        case runID = "runId"
        case phase
        case waitingFor
        case startedAt
        case updatedAt
        case completionID = "completionId"
        case completionEntryID = "completionEntryId"
        case completedAt
        case inputPersisted
        case retryable
    }

    init(
        sessionID: String,
        runID: String,
        phase: SessionRunPhase,
        waitingFor: SessionRunWaitKind? = nil,
        startedAt: String,
        updatedAt: String,
        completionID: String?,
        completionEntryID: String?,
        completedAt: String?,
        inputPersisted: Bool,
        retryable: Bool
    ) {
        self.sessionID = sessionID
        self.runID = runID
        self.phase = phase
        self.waitingFor = waitingFor
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.completionID = completionID
        self.completionEntryID = completionEntryID
        self.completedAt = completedAt
        self.inputPersisted = inputPersisted
        self.retryable = retryable
    }

    var updatedDate: Date? { ActivityTimestamp.parse(updatedAt) }
    var completedDate: Date? { completedAt.flatMap(ActivityTimestamp.parse) }
}

struct ActivityAttentionRecord: Codable, Identifiable, Equatable, Hashable, Sendable {
    var id: String { sessionID }

    let sessionID: String
    let runID: String
    let completionID: String
    let entryID: String
    let completedAt: String
    var presentedAt: String?

    var isUnseen: Bool { presentedAt == nil }
    var completedDate: Date? { ActivityTimestamp.parse(completedAt) }
}

struct ActivityAttentionDocument: Codable, Equatable, Sendable {
    static let currentVersion = 1

    let version: Int
    var records: [ActivityAttentionRecord]

    init(records: [ActivityAttentionRecord] = []) {
        version = Self.currentVersion
        self.records = records
    }
}

enum ActivityAttentionStoreError: LocalizedError, Equatable {
    case invalidDocumentVersion(Int)
    case tooManyRecords(Int)
    case duplicateSessionID(String)
    case invalidIdentifier(String)
    case invalidTimestamp(String)
    case unavailableAfterLoadFailure

    var errorDescription: String? {
        switch self {
        case let .invalidDocumentVersion(version):
            "活动关注记录版本 \(version) 暂不受支持；原文件已保留。"
        case let .tooManyRecords(count):
            "活动关注记录包含 \(count) 条记录，超过 10,000 条安全上限；原文件已保留。"
        case let .duplicateSessionID(id):
            "活动关注记录包含重复的 Session ID：\(id)；原文件已保留。"
        case let .invalidIdentifier(id):
            "活动关注记录包含无效标识：\(id.isEmpty ? "<empty>" : id)；原文件已保留。"
        case let .invalidTimestamp(timestamp):
            "活动关注记录包含无效时间：\(timestamp)；原文件已保留。"
        case .unavailableAfterLoadFailure:
            "活动关注记录尚未安全载入；本次不允许继续写入。"
        }
    }
}

actor ActivityAttentionStore {
    nonisolated let fileURL: URL
    private var latestRevision = -1
    private var writeBlocked = false

    /// ADR 0027 决定 6：熔断状态供“本机存储状态”呈现。
    func writeBlockedProbe() -> Bool { writeBlocked }

    /// 用户显式重试：重新 load 校验，成功即解除熔断。
    @discardableResult
    func retryLoadUnblock() -> Bool {
        guard writeBlocked else { return true }
        _ = try? load()
        return !writeBlocked
    }

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else if let override = ProcessInfo.processInfo.environment["D_CODE_ACTIVITY_ATTENTION_STORE_PATH"],
                  !override.isEmpty {
            self.fileURL = URL(fileURLWithPath: override)
        } else {
            self.fileURL = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/D Code", directoryHint: .isDirectory)
                .appending(path: "activity-attention-v1.json", directoryHint: .notDirectory)
        }
    }

    func load() throws -> ActivityAttentionDocument {
        do {
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                writeBlocked = false
                return ActivityAttentionDocument()
            }
            let document = try JSONDecoder().decode(
                ActivityAttentionDocument.self,
                from: Data(contentsOf: fileURL)
            )
            guard document.version == ActivityAttentionDocument.currentVersion else {
                throw ActivityAttentionStoreError.invalidDocumentVersion(document.version)
            }
            try Self.validate(document)
            writeBlocked = false
            return document
        } catch {
            writeBlocked = true
            throw error
        }
    }

    func save(_ document: ActivityAttentionDocument, revision: Int) throws {
        guard !writeBlocked else { throw ActivityAttentionStoreError.unavailableAfterLoadFailure }
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

    static func validate(_ document: ActivityAttentionDocument) throws {
        guard document.records.count <= 10_000 else {
            throw ActivityAttentionStoreError.tooManyRecords(document.records.count)
        }
        var seen = Set<String>()
        for record in document.records {
            for identifier in [record.sessionID, record.runID, record.completionID, record.entryID] {
                guard validIdentifier(identifier) else {
                    throw ActivityAttentionStoreError.invalidIdentifier(identifier)
                }
            }
            guard seen.insert(record.sessionID).inserted else {
                throw ActivityAttentionStoreError.duplicateSessionID(record.sessionID)
            }
            for timestamp in [record.completedAt, record.presentedAt].compactMap({ $0 }) {
                guard ActivityTimestamp.parse(timestamp) != nil else {
                    throw ActivityAttentionStoreError.invalidTimestamp(timestamp)
                }
            }
        }
    }

    private static func validIdentifier(_ value: String) -> Bool {
        !value.isEmpty
            && value.utf16.count <= 4_096
            && !value.contains("\0")
            && !value.contains("\n")
            && !value.contains("\r")
    }
}

enum ActivitySessionStatus: String, Equatable, Hashable, Sendable {
    case waitingForUser
    case running
    case stopRequested
    case newCompletion
    case completed
    case failed
    case aborted
    case unknown
    case history
}

struct ActivitySessionPresentation: Identifiable, Equatable, Hashable, Sendable {
    var id: String { summary.id }

    let summary: SessionSummary
    let status: ActivitySessionStatus
    let waitingFor: SessionRunWaitKind?
    let activityDate: Date
    let hasUnseenCompletion: Bool
}

struct ActivitySection: Identifiable, Equatable, Sendable {
    enum Kind: String, Sendable {
        case waiting
        case running
        case newCompletion
        case today
        case yesterday
        case earlier
    }

    var id: Kind { kind }
    let kind: Kind
    let title: String
    let sessions: [ActivitySessionPresentation]
}

enum ActivityProjection {
    static func sections(
        sessions: [SessionSummary],
        runState: SessionRunState?,
        attentionRecords: [ActivityAttentionRecord],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [ActivitySection] {
        let attentionBySession = Dictionary(
            uniqueKeysWithValues: attentionRecords.map { ($0.sessionID, $0) }
        )
        let presentations = sessions.map { summary -> ActivitySessionPresentation in
            let attention = attentionBySession[summary.id]
            let scopedRun = runState?.sessionID == summary.id ? runState : nil
            let hasUnseenCompletion = attention?.isUnseen == true
            let status = status(runState: scopedRun, hasUnseenCompletion: hasUnseenCompletion)
            let activityDate = scopedRun?.updatedDate
                ?? attention?.completedDate
                ?? summary.modifiedDate
                ?? .distantPast
            return ActivitySessionPresentation(
                summary: summary,
                status: status,
                waitingFor: scopedRun?.phase == .waitingForUser ? scopedRun?.waitingFor : nil,
                activityDate: activityDate,
                hasUnseenCompletion: hasUnseenCompletion
            )
        }

        let ordered = presentations.sorted { left, right in
            let leftRank = priorityRank(left.status)
            let rightRank = priorityRank(right.status)
            if leftRank != rightRank { return leftRank < rightRank }
            if left.activityDate != right.activityDate { return left.activityDate > right.activityDate }
            return left.id < right.id
        }

        let waiting = ordered.filter { $0.status == .waitingForUser || $0.status == .unknown }
        let running = ordered.filter { $0.status == .running || $0.status == .stopRequested }
        let newCompletion = ordered.filter { $0.status == .newCompletion }
        let ordinary = ordered.filter { priorityRank($0.status) == 3 }
        let startOfToday = calendar.startOfDay(for: now)
        let startOfYesterday = calendar.date(byAdding: .day, value: -1, to: startOfToday) ?? startOfToday
        let today = ordinary.filter { $0.activityDate >= startOfToday }
        let yesterday = ordinary.filter {
            $0.activityDate >= startOfYesterday && $0.activityDate < startOfToday
        }
        let earlier = ordinary.filter { $0.activityDate < startOfYesterday }

        return [
            section(.waiting, title: "需要处理", sessions: waiting),
            section(.running, title: "正在运行", sessions: running),
            section(.newCompletion, title: "新完成", sessions: newCompletion),
            section(.today, title: "今天", sessions: today),
            section(.yesterday, title: "昨天", sessions: yesterday),
            section(.earlier, title: "更早", sessions: earlier),
        ].compactMap { $0 }
    }

    private static func status(
        runState: SessionRunState?,
        hasUnseenCompletion: Bool
    ) -> ActivitySessionStatus {
        if let runState {
            switch runState.phase {
            case .waitingForUser: return .waitingForUser
            case .running: return .running
            case .stopRequested: return .stopRequested
            case .failed: return .failed
            case .aborted: return .aborted
            case .unknown: return .unknown
            case .completed: break
            }
        }
        if hasUnseenCompletion { return .newCompletion }
        return runState?.phase == .completed ? .completed : .history
    }

    private static func priorityRank(_ status: ActivitySessionStatus) -> Int {
        switch status {
        case .waitingForUser, .unknown: 0
        case .running, .stopRequested: 1
        case .newCompletion: 2
        case .completed, .failed, .aborted, .history: 3
        }
    }

    private static func section(
        _ kind: ActivitySection.Kind,
        title: String,
        sessions: [ActivitySessionPresentation]
    ) -> ActivitySection? {
        sessions.isEmpty ? nil : ActivitySection(kind: kind, title: title, sessions: sessions)
    }
}

enum ActivityTimestamp {
    static func parse(_ value: String) -> Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) {
            return date
        }
        return try? Date.ISO8601FormatStyle().parse(value)
    }
}
