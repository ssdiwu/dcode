import CryptoKit
import Darwin
import Foundation
import Observation

enum SelfEvolutionAssurance: String, Codable, Sendable, Equatable {
    case legacyBootstrap = "legacy_bootstrap"
    case fullPreflight = "full_preflight"

    var label: String {
        switch self {
        case .legacyBootstrap: "引导回执"
        case .fullPreflight: "完整回执"
        }
    }
}

enum SelfEvolutionState: String, Codable, Sendable, Equatable {
    case restartRequested = "restart_requested"
    case appStarted = "app_started"
    case sessionRestored = "session_restored"
    case manualAccepted = "manual_accepted"
    case recoveryRequired = "recovery_required"
    case rolledBack = "rolled_back"

    var isTerminal: Bool { self == .manualAccepted || self == .rolledBack }

    var label: String {
        switch self {
        case .restartRequested: "已记录重启请求"
        case .appStarted: "新构建已启动"
        case .sessionRestored: "会话已恢复，待人工验收"
        case .manualAccepted: "本机验收完成"
        case .recoveryRequired: "需要恢复"
        case .rolledBack: "已回滚"
        }
    }
}

enum SelfEvolutionEventKind: String, Codable, Sendable, Equatable {
    case restartRequested = "restart_requested"
    case appStarted = "app_started"
    case sessionRestored = "session_restored"
    case manualAccepted = "manual_accepted"
    case recoveryRequired = "recovery_required"
    case rolledBack = "rolled_back"

    var resultingState: SelfEvolutionState {
        switch self {
        case .restartRequested: .restartRequested
        case .appStarted: .appStarted
        case .sessionRestored: .sessionRestored
        case .manualAccepted: .manualAccepted
        case .recoveryRequired: .recoveryRequired
        case .rolledBack: .rolledBack
        }
    }

    var label: String {
        switch self {
        case .restartRequested: "重启请求已记录"
        case .appStarted: "新 App 已启动"
        case .sessionRestored: "原 Session 已恢复"
        case .manualAccepted: "用户已人工验收"
        case .recoveryRequired: "进入恢复状态"
        case .rolledBack: "已回滚上一构建"
        }
    }
}

struct SelfEvolutionEvent: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let kind: SelfEvolutionEventKind
    let occurredAt: String
    let issue: String?

    init(
        id: String = UUID().uuidString,
        kind: SelfEvolutionEventKind,
        occurredAt: String = Date().ISO8601Format(),
        issue: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.occurredAt = occurredAt
        self.issue = issue
    }
}

struct SelfEvolutionCandidateEvidence: Codable, Sendable, Equatable {
    let schemaVersion: Int
    let kind: String
    let generatedAt: String
    let appVersion: String
    let hostVersion: String
    let sourceRevision: String
    let sourceDigest: String
    let sourceDirty: Bool
    let changedFileCount: Int
    let localOnly: Bool
    let verifications: [SelfBuildVerificationManifestRecord]

    init(appVersion: String, hostVersion: String, manifest: SelfBuildCandidateManifest) {
        schemaVersion = manifest.schemaVersion
        kind = manifest.kind
        generatedAt = manifest.generatedAt
        self.appVersion = appVersion
        self.hostVersion = hostVersion
        sourceRevision = manifest.sourceRevision
        sourceDigest = manifest.sourceDigest
        sourceDirty = manifest.sourceDirty
        changedFileCount = manifest.changedFileCount
        localOnly = manifest.localOnly
        verifications = manifest.verifications
    }

    func matches(appVersion: String, manifest: SelfBuildCandidateManifest?) -> Bool {
        guard let manifest else { return false }
        return self.appVersion == appVersion
            && schemaVersion == manifest.schemaVersion
            && kind == manifest.kind
            && generatedAt == manifest.generatedAt
            && sourceRevision == manifest.sourceRevision
            && sourceDigest == manifest.sourceDigest
            && sourceDirty == manifest.sourceDirty
            && changedFileCount == manifest.changedFileCount
            && localOnly == manifest.localOnly
            && verifications == manifest.verifications
    }
}

struct SelfEvolutionRunRecord: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let assurance: SelfEvolutionAssurance
    let sourceAppVersion: String?
    let sourceBuildDigest: String?
    let candidate: SelfEvolutionCandidateEvidence
    var projectID: String?
    var sessionID: String
    var modelProvider: String?
    var modelID: String?
    var goalID: String?
    let qualifyingCycleOrdinal: Int?
    let requiredCycleCount: Int?
    let createdAt: String
    var updatedAt: String
    var state: SelfEvolutionState
    var events: [SelfEvolutionEvent]

    var qualifiesForContinuity: Bool {
        guard assurance == .fullPreflight,
              state == .manualAccepted,
              qualifyingCycleOrdinal != nil,
              requiredCycleCount == 3 else { return false }
        let kinds = events.map(\.kind)
        guard let restart = kinds.firstIndex(of: .restartRequested),
              let started = kinds[restart...].firstIndex(of: .appStarted),
              let restored = kinds[started...].firstIndex(of: .sessionRestored),
              let accepted = kinds[restored...].firstIndex(of: .manualAccepted) else { return false }
        return restart < started && started < restored && restored < accepted
    }

    var latestIssue: String? {
        guard state == .recoveryRequired else { return nil }
        return events.reversed().first(where: { $0.kind == .recoveryRequired })?.issue
    }
}

enum SelfEvolutionBootstrapRecoveryReason: String, Codable, Sendable, Equatable {
    case missingSessionID = "missing_session_id"
    case missingBackupVersion = "missing_backup_version"
    case missingCandidateEvidence = "missing_candidate_evidence"

    var label: String {
        switch self {
        case .missingSessionID: "旧恢复标记缺少 Session ID"
        case .missingBackupVersion: "未找到可核对的 0.0.26 备份构建"
        case .missingCandidateEvidence: "当前 App 缺少有效 Candidate Manifest 或签名"
        }
    }
}

struct SelfEvolutionBootstrapRecovery: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let sessionID: String?
    let targetAppVersion: String
    let reason: SelfEvolutionBootstrapRecoveryReason
    let observedAt: String

    init(
        sessionID: String?,
        targetAppVersion: String,
        reason: SelfEvolutionBootstrapRecoveryReason,
        observedAt: String = Date().ISO8601Format()
    ) {
        id = "bootstrap-recovery:\(targetAppVersion)"
        self.sessionID = sessionID
        self.targetAppVersion = targetAppVersion
        self.reason = reason
        self.observedAt = observedAt
    }
}

struct SelfEvolutionRunDocument: Codable, Sendable, Equatable {
    static let currentVersion = 1
    static let maximumRuns = 256
    static let maximumEventsPerRun = 64
    static let maximumDocumentBytes = 2_000_000

    let version: Int
    var revision: Int
    var runs: [SelfEvolutionRunRecord]
    var bootstrapRecovery: SelfEvolutionBootstrapRecovery?

    init(
        runs: [SelfEvolutionRunRecord] = [],
        bootstrapRecovery: SelfEvolutionBootstrapRecovery? = nil,
        revision: Int = 0
    ) {
        version = Self.currentVersion
        self.revision = revision
        self.runs = runs
        self.bootstrapRecovery = bootstrapRecovery
    }
}

enum SelfEvolutionStoreError: LocalizedError, Equatable {
    case invalidDocumentVersion(Int)
    case documentTooLarge(Int)
    case tooManyRuns(Int)
    case tooManyEvents(runID: String, count: Int)
    case duplicateIdentifier(String)
    case invalidIdentifier(String)
    case invalidTimestamp(String)
    case invalidCandidate(String)
    case invalidState(runID: String)
    case multipleActiveFullRuns
    case unfinishedRun(String)
    case externalChange
    case storeLockFailed
    case staleRevision(expected: Int, actual: Int)
    case unavailableAfterLoadFailure

    var errorDescription: String? {
        switch self {
        case let .invalidDocumentVersion(version):
            "自进化回执版本 \(version) 暂不受支持；原文件已保留。"
        case let .documentTooLarge(bytes):
            "自进化回执占用 \(bytes) 字节，超过本机安全上限。"
        case let .tooManyRuns(count):
            "自进化回执包含 \(count) 次运行，超过 \(SelfEvolutionRunDocument.maximumRuns) 次上限。"
        case let .tooManyEvents(runID, count):
            "自进化运行 \(runID) 包含 \(count) 个事件，超过安全上限。"
        case let .duplicateIdentifier(identifier):
            "自进化回执包含重复标识：\(identifier)。"
        case let .invalidIdentifier(identifier):
            "自进化回执包含无效标识：\(identifier.isEmpty ? "<empty>" : identifier)。"
        case let .invalidTimestamp(timestamp):
            "自进化回执包含无效时间：\(timestamp)。"
        case let .invalidCandidate(runID):
            "自进化运行 \(runID) 的候选证据无效。"
        case let .invalidState(runID):
            "自进化运行 \(runID) 的状态或事件顺序无效。"
        case .multipleActiveFullRuns:
            "同时只能存在一条未终结的完整自进化运行。"
        case let .unfinishedRun(runID):
            "自进化运行 \(runID) 尚未人工验收或回滚；请先收口当前回执。"
        case .externalChange:
            "自进化回执已被另一个 D Code 实例修改；本次未覆盖外部结果。"
        case .storeLockFailed:
            "自进化回执暂时被另一个 D Code 实例写入；本次未执行覆盖。"
        case let .staleRevision(expected, actual):
            "自进化回执 revision 已变化（期望 \(expected)，收到 \(actual)）；本次未覆盖较新状态。"
        case .unavailableAfterLoadFailure:
            "自进化回执尚未安全载入；为保留原文件，本次不允许继续写入。"
        }
    }
}

actor SelfEvolutionRunStore {
    nonisolated let fileURL: URL
    private let writeDelaySeconds: TimeInterval
    private var writeBlocked = false
    private var baselineDigest: String?
    private var baselineRevision = 0

    init(fileURL: URL? = nil, writeDelaySeconds: TimeInterval = 0) {
        self.writeDelaySeconds = writeDelaySeconds
        if let fileURL {
            self.fileURL = fileURL
        } else if let override = ProcessInfo.processInfo.environment["D_CODE_SELF_EVOLUTION_RUN_STORE_PATH"],
                  !override.isEmpty {
            self.fileURL = URL(fileURLWithPath: override)
        } else {
            self.fileURL = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/D Code", directoryHint: .isDirectory)
                .appending(path: "self-evolution-runs-v1.json", directoryHint: .notDirectory)
        }
    }

    func writeBlockedProbe() -> Bool { writeBlocked }

    @discardableResult
    func retryLoadUnblock() -> Bool {
        guard writeBlocked else { return true }
        _ = try? load()
        return !writeBlocked
    }

    func load() throws -> SelfEvolutionRunDocument {
        do {
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                writeBlocked = false
                baselineDigest = nil
                baselineRevision = 0
                return SelfEvolutionRunDocument()
            }
            let data = try Data(contentsOf: fileURL)
            guard data.count <= SelfEvolutionRunDocument.maximumDocumentBytes else {
                throw SelfEvolutionStoreError.documentTooLarge(data.count)
            }
            let document = try JSONDecoder().decode(SelfEvolutionRunDocument.self, from: data)
            try Self.validate(document)
            writeBlocked = false
            baselineDigest = Self.digest(data)
            baselineRevision = document.revision
            return document
        } catch {
            writeBlocked = true
            throw error
        }
    }

    func save(_ document: SelfEvolutionRunDocument) throws {
        guard !writeBlocked else { throw SelfEvolutionStoreError.unavailableAfterLoadFailure }
        try Self.validate(document)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(document)
        guard data.count <= SelfEvolutionRunDocument.maximumDocumentBytes else {
            throw SelfEvolutionStoreError.documentTooLarge(data.count)
        }
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
        } catch {
            writeBlocked = true
            throw error
        }
        let lockDescriptor = Darwin.open(
            fileURL.appendingPathExtension("lock").path,
            O_CREAT | O_RDWR,
            S_IRUSR | S_IWUSR
        )
        guard lockDescriptor >= 0 else { throw SelfEvolutionStoreError.storeLockFailed }
        guard flock(lockDescriptor, LOCK_EX) == 0 else {
            Darwin.close(lockDescriptor)
            throw SelfEvolutionStoreError.storeLockFailed
        }
        defer {
            _ = flock(lockDescriptor, LOCK_UN)
            Darwin.close(lockDescriptor)
        }
        do {
            if writeDelaySeconds > 0 { Thread.sleep(forTimeInterval: writeDelaySeconds) }
            let currentDigest: String?
            if FileManager.default.fileExists(atPath: fileURL.path) {
                currentDigest = Self.digest(try Data(contentsOf: fileURL))
            } else {
                currentDigest = nil
            }
            guard currentDigest == baselineDigest else { throw SelfEvolutionStoreError.externalChange }
            guard document.revision == baselineRevision + 1 else {
                throw SelfEvolutionStoreError.staleRevision(
                    expected: baselineRevision + 1,
                    actual: document.revision
                )
            }
            try data.write(to: fileURL, options: [.atomic])
            baselineDigest = Self.digest(data)
            baselineRevision = document.revision
        } catch {
            writeBlocked = true
            throw error
        }
    }

    static func validate(_ document: SelfEvolutionRunDocument) throws {
        guard document.version == SelfEvolutionRunDocument.currentVersion else {
            throw SelfEvolutionStoreError.invalidDocumentVersion(document.version)
        }
        guard document.revision >= 0 else {
            throw SelfEvolutionStoreError.staleRevision(expected: 0, actual: document.revision)
        }
        guard document.runs.count <= SelfEvolutionRunDocument.maximumRuns else {
            throw SelfEvolutionStoreError.tooManyRuns(document.runs.count)
        }
        let activeFullCount = document.runs.filter {
            $0.assurance == .fullPreflight && !$0.state.isTerminal
        }.count
        guard activeFullCount <= 1 else { throw SelfEvolutionStoreError.multipleActiveFullRuns }

        if let recovery = document.bootstrapRecovery {
            try validateIdentifier(recovery.id)
            if let sessionID = recovery.sessionID { try validateIdentifier(sessionID) }
            guard !recovery.targetAppVersion.isEmpty,
                  recovery.targetAppVersion.utf16.count <= 64,
                  SelfEvolutionTimestamp.parse(recovery.observedAt) != nil else {
                throw SelfEvolutionStoreError.invalidState(runID: recovery.id)
            }
        }

        var identifiers = Set<String>()
        for run in document.runs {
            try validateIdentifier(run.id)
            guard identifiers.insert(run.id).inserted else {
                throw SelfEvolutionStoreError.duplicateIdentifier(run.id)
            }
            try validateIdentifier(run.sessionID)
            for value in [run.projectID, run.modelProvider, run.modelID, run.goalID].compactMap({ $0 }) {
                try validateIdentifier(value)
            }
            for timestamp in [run.createdAt, run.updatedAt] {
                guard SelfEvolutionTimestamp.parse(timestamp) != nil else {
                    throw SelfEvolutionStoreError.invalidTimestamp(timestamp)
                }
            }
            guard run.events.count <= SelfEvolutionRunDocument.maximumEventsPerRun else {
                throw SelfEvolutionStoreError.tooManyEvents(runID: run.id, count: run.events.count)
            }
            for event in run.events {
                try validateIdentifier(event.id)
                guard identifiers.insert(event.id).inserted else {
                    throw SelfEvolutionStoreError.duplicateIdentifier(event.id)
                }
                guard SelfEvolutionTimestamp.parse(event.occurredAt) != nil else {
                    throw SelfEvolutionStoreError.invalidTimestamp(event.occurredAt)
                }
                if event.kind == .recoveryRequired,
                   event.issue?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
                    throw SelfEvolutionStoreError.invalidState(runID: run.id)
                }
                if let issue = event.issue, issue.utf16.count > 1_024 {
                    throw SelfEvolutionStoreError.invalidState(runID: run.id)
                }
            }
            try validateCandidate(run)
            try validateState(run)
        }
    }

    private static func validateIdentifier(_ value: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= 256 else {
            throw SelfEvolutionStoreError.invalidIdentifier(value)
        }
    }

    private static func validateCandidate(_ run: SelfEvolutionRunRecord) throws {
        let candidate = run.candidate
        let isHex: (String) -> Bool = { value in
            !value.isEmpty && value.unicodeScalars.allSatisfy {
                CharacterSet(charactersIn: "0123456789abcdef").contains($0)
            }
        }
        let sourceBuildDigestValid = run.sourceBuildDigest.map {
            $0.count == 64 && isHex($0)
        } ?? true
        guard candidate.schemaVersion == SelfBuildCandidateManifest.currentVersion,
              candidate.kind == "local-self-build-candidate",
              SelfEvolutionTimestamp.parse(candidate.generatedAt) != nil,
              !candidate.appVersion.isEmpty,
              candidate.appVersion.utf16.count <= 64,
              candidate.appVersion == candidate.hostVersion,
              sourceBuildDigestValid,
              [40, 64].contains(candidate.sourceRevision.count),
              isHex(candidate.sourceRevision),
              candidate.sourceDigest.count == 64,
              isHex(candidate.sourceDigest),
              candidate.changedFileCount >= 0,
              candidate.localOnly,
              candidate.sourceDirty ? candidate.changedFileCount > 0 : candidate.changedFileCount == 0,
              candidate.verifications.count == 2,
              candidate.verifications.contains(where: {
                  $0.id == "swift-tests" && $0.command == "swift test" && $0.succeeded && $0.exitCode == 0
              }),
              candidate.verifications.contains(where: {
                  $0.id == "host-tests" && $0.command == "cd host && npm test" && $0.succeeded && $0.exitCode == 0
              }) else {
            throw SelfEvolutionStoreError.invalidCandidate(run.id)
        }
    }

    private static func validateState(_ run: SelfEvolutionRunRecord) throws {
        guard !run.events.isEmpty,
              run.events.last?.kind.resultingState == run.state else {
            throw SelfEvolutionStoreError.invalidState(runID: run.id)
        }
        if run.assurance == .legacyBootstrap {
            guard run.qualifyingCycleOrdinal == nil,
                  run.requiredCycleCount == nil,
                  run.events.first?.kind == .appStarted,
                  !run.events.contains(where: { $0.kind == .restartRequested }) else {
                throw SelfEvolutionStoreError.invalidState(runID: run.id)
            }
        } else {
            guard run.projectID != nil,
                  run.sourceAppVersion?.isEmpty == false,
                  run.sourceBuildDigest != nil,
                  run.modelProvider != nil,
                  run.modelID != nil,
                  SelfEvolutionPreflightPolicy.isSolModel(
                      provider: run.modelProvider ?? "",
                      modelID: run.modelID ?? ""
                  ),
                  run.qualifyingCycleOrdinal != nil,
                  run.requiredCycleCount == 3,
                  run.events.first?.kind == .restartRequested else {
                throw SelfEvolutionStoreError.invalidState(runID: run.id)
            }
        }

        var previous: SelfEvolutionState?
        var previousDate = SelfEvolutionTimestamp.parse(run.createdAt) ?? .distantFuture
        for event in run.events {
            let next = event.kind.resultingState
            guard transitionAllowed(from: previous, to: next, assurance: run.assurance) else {
                throw SelfEvolutionStoreError.invalidState(runID: run.id)
            }
            guard let eventDate = SelfEvolutionTimestamp.parse(event.occurredAt),
                  eventDate >= previousDate else {
                throw SelfEvolutionStoreError.invalidState(runID: run.id)
            }
            previousDate = eventDate
            previous = next
        }
        guard run.updatedAt == run.events.last?.occurredAt else {
            throw SelfEvolutionStoreError.invalidState(runID: run.id)
        }
    }

    private static func transitionAllowed(
        from previous: SelfEvolutionState?,
        to next: SelfEvolutionState,
        assurance: SelfEvolutionAssurance
    ) -> Bool {
        switch (previous, next) {
        case (nil, .appStarted): assurance == .legacyBootstrap
        case (nil, .restartRequested): assurance == .fullPreflight
        case (.restartRequested, .appStarted),
             (.restartRequested, .recoveryRequired),
             (.restartRequested, .rolledBack),
             (.appStarted, .sessionRestored),
             (.appStarted, .recoveryRequired),
             (.appStarted, .rolledBack),
             (.sessionRestored, .manualAccepted),
             (.sessionRestored, .recoveryRequired),
             (.sessionRestored, .rolledBack),
             (.recoveryRequired, .appStarted),
             (.recoveryRequired, .recoveryRequired),
             (.recoveryRequired, .rolledBack): true
        default: false
        }
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

enum SelfEvolutionTimestamp {
    static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }
}

enum SelfEvolutionIssueSanitizer {
    static func sanitize(_ input: String) -> String {
        let redacted = DiagnosticSanitizer.redact(input, limit: 1_024)
        let tokens = redacted.split(separator: " ", omittingEmptySubsequences: false).map { token -> String in
            let value = String(token)
            return value.hasPrefix("/") ? "[LOCAL_PATH]" : value
        }
        return String(tokens.joined(separator: " ").prefix(1_024))
    }
}

struct SelfEvolutionFullContext: Sendable, Equatable {
    let sourceAppVersion: String
    let sourceBuildDigest: String?
    let projectID: UUID
    let sessionID: String
    let modelProvider: String
    let modelID: String
    let goalID: String?
}

enum SelfEvolutionPreflightPolicy {
    static func isSolModel(provider: String, modelID: String) -> Bool {
        provider == "openai-codex" && modelID == "gpt-5.6-sol"
    }
}

enum SelfEvolutionAcceptancePolicy {
    static func hostIsStable(
        connectionState: HostConnectionState,
        restartRequired: Bool,
        hasReadyClient: Bool,
        writable: Bool,
        hasConflict: Bool,
        isCompacting: Bool,
        pendingMessageCount: Int
    ) -> Bool {
        connectionState == .ready
            && !restartRequired
            && hasReadyClient
            && writable
            && !hasConflict
            && !isCompacting
            && pendingMessageCount == 0
    }
}

enum SelfEvolutionStartupRoute: Equatable {
    case none
    case resumeRun(String)
    case legacyBootstrap
    case reopenOrdinarySession
    case reopenSelfEvolutionRollbackSession
    case missingSelfEvolutionRun
    case unknownIntentKind(String)
}

enum SelfEvolutionStartupPlanner {
    static func route(
        intent: SelfBuildRestartIntent?,
        document: SelfEvolutionRunDocument
    ) -> SelfEvolutionStartupRoute {
        if let intent {
            switch intent.kind {
            case .legacyBootstrap:
                return .legacyBootstrap
            case .ordinary:
                return .reopenOrdinarySession
            case .selfEvolutionRollback:
                return .reopenSelfEvolutionRollbackSession
            case let .unknown(value):
                return .unknownIntentKind(value)
            case .selfEvolution:
                guard let runID = intent.selfEvolutionRunID,
                      document.runs.contains(where: { $0.id == runID }) else {
                    return .missingSelfEvolutionRun
                }
                return .resumeRun(runID)
            }
        }
        if let run = document.runs.reversed().first(where: {
            !$0.state.isTerminal && [.restartRequested, .appStarted, .recoveryRequired].contains($0.state)
        }) {
            return .resumeRun(run.id)
        }
        return .none
    }

    static func pendingRun(
        intent: SelfBuildRestartIntent?,
        document: SelfEvolutionRunDocument
    ) -> SelfEvolutionRunRecord? {
        guard case let .resumeRun(runID) = route(intent: intent, document: document) else { return nil }
        return document.runs.first(where: { $0.id == runID })
    }
}

@MainActor
@Observable
final class SelfEvolutionModel {
    @ObservationIgnored private let store: SelfEvolutionRunStore
    private(set) var document = SelfEvolutionRunDocument()
    private(set) var issue: String?
    private(set) var loaded = false

    init(store: SelfEvolutionRunStore = SelfEvolutionRunStore()) {
        self.store = store
    }

    var storeFileURL: URL { store.fileURL }

    func writeBlockedProbe() async -> Bool { await store.writeBlockedProbe() }

    @discardableResult
    func retryStoreUnblock() async -> Bool {
        let recovered = await store.retryLoadUnblock()
        if recovered { await load() }
        return recovered
    }

    var latestReceipt: SelfEvolutionRunRecord? { document.runs.last }
    var unfinishedReceipt: SelfEvolutionRunRecord? {
        document.runs.reversed().first(where: { !$0.state.isTerminal })
    }
    var bootstrapRecovery: SelfEvolutionBootstrapRecovery? { document.bootstrapRecovery }

    var pendingRecoveryRun: SelfEvolutionRunRecord? {
        document.runs.reversed().first {
            !$0.state.isTerminal && [.restartRequested, .appStarted, .recoveryRequired].contains($0.state)
        }
    }

    var qualifyingCycleCount: Int {
        let accepted = document.runs
            .filter(\.qualifiesForContinuity)
            .sorted { (SelfEvolutionTimestamp.parse($0.createdAt) ?? .distantPast) < (SelfEvolutionTimestamp.parse($1.createdAt) ?? .distantPast) }
        var chain: [SelfEvolutionRunRecord] = []
        for run in accepted {
            if let last = chain.last,
               run.sourceAppVersion == last.candidate.appVersion,
               run.sourceBuildDigest == last.candidate.sourceDigest,
               run.candidate.appVersion != last.candidate.appVersion {
                chain.append(run)
            } else {
                chain = [run]
            }
        }
        return chain.count
    }

    func load() async {
        do {
            document = try await store.load()
            issue = nil
            loaded = true
        } catch {
            issue = error.localizedDescription
            loaded = false
        }
    }

    @discardableResult
    func beginLegacyBootstrap(
        sessionID: String,
        sourceAppVersion: String?,
        targetAppVersion: String,
        targetHostVersion: String,
        manifest: SelfBuildCandidateManifest
    ) async throws -> SelfEvolutionRunRecord {
        let deterministicID = "bootstrap:\(targetAppVersion):\(manifest.sourceDigest):\(sessionID)"
        if let existing = document.runs.first(where: { $0.id == deterministicID }) { return existing }
        let now = Date().ISO8601Format()
        let record = SelfEvolutionRunRecord(
            id: deterministicID,
            assurance: .legacyBootstrap,
            sourceAppVersion: sourceAppVersion,
            sourceBuildDigest: nil,
            candidate: SelfEvolutionCandidateEvidence(
                appVersion: targetAppVersion,
                hostVersion: targetHostVersion,
                manifest: manifest
            ),
            projectID: nil,
            sessionID: sessionID,
            modelProvider: nil,
            modelID: nil,
            goalID: nil,
            qualifyingCycleOrdinal: nil,
            requiredCycleCount: nil,
            createdAt: now,
            updatedAt: now,
            state: .appStarted,
            events: [SelfEvolutionEvent(kind: .appStarted, occurredAt: now)]
        )
        var next = document
        next.runs.append(record)
        next.bootstrapRecovery = nil
        try await persist(next)
        return record
    }

    func recordBootstrapRecovery(
        sessionID: String?,
        targetAppVersion: String,
        reason: SelfEvolutionBootstrapRecoveryReason
    ) async throws {
        var next = document
        next.bootstrapRecovery = SelfEvolutionBootstrapRecovery(
            sessionID: sessionID,
            targetAppVersion: targetAppVersion,
            reason: reason
        )
        try await persist(next)
    }

    @discardableResult
    func prepareFullRestart(
        context: SelfEvolutionFullContext,
        candidateAppVersion: String,
        candidateHostVersion: String,
        manifest: SelfBuildCandidateManifest
    ) async throws -> SelfEvolutionRunRecord {
        if let unfinished = document.runs.reversed().first(where: { !$0.state.isTerminal }) {
            throw SelfEvolutionStoreError.unfinishedRun(unfinished.id)
        }
        let now = Date().ISO8601Format()
        let lastAccepted = document.runs.reversed().first(where: { $0.qualifiesForContinuity })
        let continuesPrevious = lastAccepted.map {
            context.sourceAppVersion == $0.candidate.appVersion
                && context.sourceBuildDigest == $0.candidate.sourceDigest
        } ?? false
        let ordinal = continuesPrevious ? qualifyingCycleCount + 1 : 1
        let record = SelfEvolutionRunRecord(
            id: UUID().uuidString,
            assurance: .fullPreflight,
            sourceAppVersion: context.sourceAppVersion,
            sourceBuildDigest: context.sourceBuildDigest,
            candidate: SelfEvolutionCandidateEvidence(
                appVersion: candidateAppVersion,
                hostVersion: candidateHostVersion,
                manifest: manifest
            ),
            projectID: context.projectID.uuidString,
            sessionID: context.sessionID,
            modelProvider: context.modelProvider,
            modelID: context.modelID,
            goalID: context.goalID,
            qualifyingCycleOrdinal: ordinal,
            requiredCycleCount: 3,
            createdAt: now,
            updatedAt: now,
            state: .restartRequested,
            events: [SelfEvolutionEvent(kind: .restartRequested, occurredAt: now)]
        )
        var next = document
        next.runs.append(record)
        try await persist(next)
        return record
    }

    @discardableResult
    func markAppStarted(runID: String, appVersion: String, manifest: SelfBuildCandidateManifest?) async throws -> Bool {
        guard let index = document.runs.firstIndex(where: { $0.id == runID }) else {
            throw SelfEvolutionStoreError.invalidIdentifier(runID)
        }
        guard document.runs[index].candidate.matches(appVersion: appVersion, manifest: manifest) else {
            if document.runs[index].state != .recoveryRequired {
                try await appendEvent(runID: runID, kind: .recoveryRequired, issue: "当前 App 与预期候选版本或 digest 不一致")
            }
            return false
        }
        if document.runs[index].state == .appStarted { return true }
        try await appendEvent(runID: runID, kind: .appStarted)
        return true
    }

    func markSessionRestored(
        runID: String,
        projectID: UUID?,
        modelProvider: String?,
        modelID: String?,
        goalID: String?
    ) async throws {
        guard let index = document.runs.firstIndex(where: { $0.id == runID }) else {
            throw SelfEvolutionStoreError.invalidIdentifier(runID)
        }
        if document.runs[index].state == .sessionRestored { return }
        guard document.runs[index].state == .appStarted else {
            throw SelfEvolutionStoreError.invalidState(runID: runID)
        }
        if document.runs[index].assurance == .fullPreflight,
           (document.runs[index].projectID != projectID?.uuidString
               || document.runs[index].modelProvider != modelProvider
               || document.runs[index].modelID != modelID) {
            try await appendEvent(
                runID: runID,
                kind: .recoveryRequired,
                issue: "恢复后的 Project 或模型与重启前回执不一致"
            )
            return
        }
        var next = document
        if next.runs[index].assurance == .legacyBootstrap {
            next.runs[index].projectID = projectID?.uuidString
            next.runs[index].modelProvider = modelProvider
            next.runs[index].modelID = modelID
            next.runs[index].goalID = goalID
        }
        let event = SelfEvolutionEvent(kind: .sessionRestored)
        next.runs[index].events.append(event)
        next.runs[index].state = .sessionRestored
        next.runs[index].updatedAt = event.occurredAt
        try await persist(next)
    }

    func markRecoveryRequired(runID: String, issue: String) async throws {
        try await appendEvent(runID: runID, kind: .recoveryRequired, issue: issue)
    }

    func markManualAccepted(runID: String) async throws {
        if document.runs.first(where: { $0.id == runID })?.state == .manualAccepted { return }
        try await appendEvent(runID: runID, kind: .manualAccepted)
    }

    func markRolledBack(runID: String) async throws {
        if document.runs.first(where: { $0.id == runID })?.state == .rolledBack { return }
        try await appendEvent(runID: runID, kind: .rolledBack)
    }

    private func appendEvent(runID: String, kind: SelfEvolutionEventKind, issue: String? = nil) async throws {
        guard let index = document.runs.firstIndex(where: { $0.id == runID }) else {
            throw SelfEvolutionStoreError.invalidIdentifier(runID)
        }
        var next = document
        let event = SelfEvolutionEvent(
            kind: kind,
            issue: issue.map(SelfEvolutionIssueSanitizer.sanitize)
        )
        next.runs[index].events.append(event)
        next.runs[index].state = kind.resultingState
        next.runs[index].updatedAt = event.occurredAt
        try await persist(next)
    }

    private func persist(_ next: SelfEvolutionRunDocument) async throws {
        var stamped = next
        stamped.revision = document.revision + 1
        try await store.save(stamped)
        document = stamped
        issue = nil
        loaded = true
    }
}
