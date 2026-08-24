import SwiftUI
import XCTest
@testable import PiDCode

@MainActor
final class SelfEvolutionTests: XCTestCase {
    private func temporaryStore(_ name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "dcode-self-evolution-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root.appending(path: "runs.json")
    }

    private func checks() -> [SelfBuildCommandResult] {
        [
            SelfBuildCommandResult(
                id: "swift-tests", label: "Swift 回归", command: "swift test",
                succeeded: true, exitCode: 0, durationMs: 7_000, outputTail: ["private output"]
            ),
            SelfBuildCommandResult(
                id: "host-tests", label: "Host 回归", command: "cd host && npm test",
                succeeded: true, exitCode: 0, durationMs: 8_000, outputTail: ["private output"]
            ),
        ]
    }

    private func manifest(digest: Character = "b") -> SelfBuildCandidateManifest {
        SelfBuildCandidateManifest(
            snapshot: SelfBuildSourceSnapshot(
                revision: String(repeating: "a", count: 40),
                dirty: true,
                changedFileCount: 4,
                digest: String(repeating: String(digest), count: 64)
            ),
            verifications: checks(),
            generatedAt: "2026-08-23T10:00:00Z"
        )
    }

    func testFullReceiptRequiresRestoreAndManualAcceptanceBeforeItQualifies() async throws {
        let fileURL = try temporaryStore("full")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        let candidate = manifest()
        let projectID = UUID()
        let run = try await evolution.prepareFullRestart(
            context: SelfEvolutionFullContext(
                sourceAppVersion: "0.0.27",
                sourceBuildDigest: String(repeating: "c", count: 64),
                projectID: projectID,
                sessionID: "session-full",
                modelProvider: "openai-codex",
                modelID: "gpt-5.6-sol",
                goalID: "goal-1"
            ),
            candidateAppVersion: "0.0.28",
            candidateHostVersion: "0.0.28",
            manifest: candidate
        )
        XCTAssertEqual(run.state, .restartRequested)
        XCTAssertFalse(run.qualifiesForContinuity)

        try await evolution.markAppStarted(runID: run.id, appVersion: "0.0.28", manifest: candidate)
        try await evolution.markSessionRestored(
            runID: run.id,
            projectID: projectID,
            modelProvider: "openai-codex",
            modelID: "gpt-5.6-sol",
            goalID: "goal-1"
        )
        XCTAssertEqual(evolution.latestReceipt?.state, .sessionRestored)
        XCTAssertEqual(evolution.qualifyingCycleCount, 0)

        try await evolution.markManualAccepted(runID: run.id)
        XCTAssertEqual(evolution.latestReceipt?.state, .manualAccepted)
        XCTAssertTrue(evolution.latestReceipt?.qualifiesForContinuity == true)
        XCTAssertEqual(evolution.qualifyingCycleCount, 1)

        let encoded = try String(decoding: Data(contentsOf: fileURL), as: UTF8.self)
        XCTAssertFalse(encoded.contains("private output"), "回执不能保存测试输出正文")
        for forbidden in ["outputTail", "prompt", "apiKey", "environment"] {
            XCTAssertFalse(encoded.lowercased().contains(forbidden.lowercased()))
        }
    }

    func testLegacyBootstrapIsIdempotentAndNeverQualifies() async throws {
        let fileURL = try temporaryStore("bootstrap")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        let candidate = manifest()
        let first = try await evolution.beginLegacyBootstrap(
            sessionID: "session-bootstrap",
            sourceAppVersion: "0.0.26",
            targetAppVersion: "0.0.27",
            targetHostVersion: "0.0.27",
            manifest: candidate
        )
        let second = try await evolution.beginLegacyBootstrap(
            sessionID: "session-bootstrap",
            sourceAppVersion: "0.0.26",
            targetAppVersion: "0.0.27",
            targetHostVersion: "0.0.27",
            manifest: candidate
        )
        XCTAssertEqual(first.id, second.id)
        XCTAssertEqual(evolution.document.runs.count, 1)
        XCTAssertNil(first.qualifyingCycleOrdinal)

        try await evolution.markSessionRestored(
            runID: first.id,
            projectID: UUID(),
            modelProvider: "openai-codex",
            modelID: "gpt-5.6-sol",
            goalID: nil
        )
        do {
            _ = try await evolution.prepareFullRestart(
                context: SelfEvolutionFullContext(
                    sourceAppVersion: "0.0.27",
                    sourceBuildDigest: String(repeating: "c", count: 64),
                    projectID: UUID(),
                    sessionID: "session-next",
                    modelProvider: "openai-codex",
                    modelID: "gpt-5.6-sol",
                    goalID: nil
                ),
                candidateAppVersion: "0.0.28",
                candidateHostVersion: "0.0.28",
                manifest: candidate
            )
            XCTFail("引导回执尚未人工收口时不能开始下一条完整运行")
        } catch {
            XCTAssertNotNil(error as? SelfEvolutionStoreError)
        }
        try await evolution.markManualAccepted(runID: first.id)
        XCTAssertEqual(evolution.latestReceipt?.state, .manualAccepted)
        XCTAssertFalse(evolution.latestReceipt?.qualifiesForContinuity == true)
        XCTAssertEqual(evolution.qualifyingCycleCount, 0)
        XCTAssertFalse(evolution.latestReceipt?.events.contains(where: { $0.kind == .restartRequested }) == true)
    }

    func testManifestMismatchPersistsRecoveryRequired() async throws {
        let fileURL = try temporaryStore("mismatch")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        let projectID = UUID()
        let run = try await evolution.prepareFullRestart(
            context: SelfEvolutionFullContext(
                sourceAppVersion: "0.0.27",
                sourceBuildDigest: String(repeating: "c", count: 64),
                projectID: projectID,
                sessionID: "session-mismatch",
                modelProvider: "openai-codex",
                modelID: "gpt-5.6-sol",
                goalID: nil
            ),
            candidateAppVersion: "0.0.28",
            candidateHostVersion: "0.0.28",
            manifest: manifest()
        )

        try await evolution.markAppStarted(
            runID: run.id,
            appVersion: "0.0.28",
            manifest: manifest(digest: "d")
        )
        XCTAssertEqual(evolution.latestReceipt?.state, .recoveryRequired)
        XCTAssertTrue(evolution.latestReceipt?.latestIssue?.contains("digest") == true)

        do {
            try await evolution.markSessionRestored(
                runID: run.id,
                projectID: projectID,
                modelProvider: "openai-codex",
                modelID: "gpt-5.6-sol",
                goalID: nil
            )
            XCTFail("候选身份未恢复前不得用 Session 恢复覆盖 recovery_required")
        } catch {
            XCTAssertEqual(error as? SelfEvolutionStoreError, .invalidState(runID: run.id))
        }

        let integrityReady = try await evolution.markAppStarted(
            runID: run.id,
            appVersion: "0.0.28",
            manifest: manifest()
        )
        XCTAssertTrue(integrityReady)
        try await evolution.markSessionRestored(
            runID: run.id,
            projectID: projectID,
            modelProvider: "openai-codex",
            modelID: "gpt-5.6-sol",
            goalID: nil
        )
        XCTAssertEqual(evolution.latestReceipt?.state, .sessionRestored)
        XCTAssertNil(evolution.latestReceipt?.latestIssue)

        let reloaded = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await reloaded.load()
        XCTAssertNil(reloaded.pendingRecoveryRun)
        XCTAssertEqual(reloaded.latestReceipt?.state, .sessionRestored)
    }

    func testCorruptStorePreservesBytesAndBlocksWritesUntilExplicitRepair() async throws {
        let fileURL = try temporaryStore("corrupt")
        let corrupt = Data("{not-json".utf8)
        try corrupt.write(to: fileURL)
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        XCTAssertFalse(evolution.loaded)
        XCTAssertNotNil(evolution.issue)

        do {
            _ = try await evolution.beginLegacyBootstrap(
                sessionID: "session-corrupt",
                sourceAppVersion: "0.0.26",
                targetAppVersion: "0.0.27",
                targetHostVersion: "0.0.27",
                manifest: manifest()
            )
            XCTFail("损坏资料加载失败后不得写入")
        } catch {
            XCTAssertEqual(error as? SelfEvolutionStoreError, .unavailableAfterLoadFailure)
        }
        XCTAssertEqual(try Data(contentsOf: fileURL), corrupt)

        let encoder = JSONEncoder()
        try encoder.encode(SelfEvolutionRunDocument()).write(to: fileURL, options: [.atomic])
        let recovered = await evolution.retryStoreUnblock()
        XCTAssertTrue(recovered)
        XCTAssertTrue(evolution.loaded)
        XCTAssertTrue(evolution.document.runs.isEmpty)
    }

    func testStoreRejectsTwoActiveFullRunsAndInvalidEventOrder() throws {
        let candidate = SelfEvolutionCandidateEvidence(
            appVersion: "0.0.28",
            hostVersion: "0.0.28",
            manifest: manifest()
        )
        let now = "2026-08-23T10:00:00Z"
        func run(_ id: String) -> SelfEvolutionRunRecord {
            SelfEvolutionRunRecord(
                id: id,
                assurance: .fullPreflight,
                sourceAppVersion: "0.0.27",
                sourceBuildDigest: String(repeating: "c", count: 64),
                candidate: candidate,
                projectID: UUID().uuidString,
                sessionID: "session-\(id)",
                modelProvider: "openai-codex",
                modelID: "gpt-5.6-sol",
                goalID: nil,
                qualifyingCycleOrdinal: 1,
                requiredCycleCount: 3,
                createdAt: now,
                updatedAt: now,
                state: .restartRequested,
                events: [SelfEvolutionEvent(id: "event-\(id)", kind: .restartRequested, occurredAt: now)]
            )
        }
        XCTAssertThrowsError(try SelfEvolutionRunStore.validate(SelfEvolutionRunDocument(runs: [run("a"), run("b")]))) {
            XCTAssertEqual($0 as? SelfEvolutionStoreError, .multipleActiveFullRuns)
        }

        var invalid = run("invalid")
        invalid.events.append(SelfEvolutionEvent(id: "event-invalid-2", kind: .manualAccepted, occurredAt: now))
        invalid.state = .manualAccepted
        XCTAssertThrowsError(try SelfEvolutionRunStore.validate(SelfEvolutionRunDocument(runs: [invalid])))
    }

    func testStoreCASPreventsTwoInstancesFromOverwritingEachOther() async throws {
        let fileURL = try temporaryStore("cas")
        let first = SelfEvolutionRunStore(fileURL: fileURL)
        let second = SelfEvolutionRunStore(fileURL: fileURL)
        _ = try await first.load()
        _ = try await second.load()
        let firstDocument = SelfEvolutionRunDocument(
            bootstrapRecovery: SelfEvolutionBootstrapRecovery(
                sessionID: "session-first",
                targetAppVersion: "0.0.27",
                reason: .missingCandidateEvidence
            ),
            revision: 1
        )
        let secondDocument = SelfEvolutionRunDocument(
            bootstrapRecovery: SelfEvolutionBootstrapRecovery(
                sessionID: "session-second",
                targetAppVersion: "0.0.27",
                reason: .missingBackupVersion
            ),
            revision: 1
        )
        func saveSucceeded(
            _ store: SelfEvolutionRunStore,
            document: SelfEvolutionRunDocument
        ) async -> Bool {
            do {
                try await store.save(document)
                return true
            } catch {
                return false
            }
        }
        async let firstSucceeded = saveSucceeded(first, document: firstDocument)
        async let secondSucceeded = saveSucceeded(second, document: secondDocument)
        let outcomes = await [firstSucceeded, secondSucceeded]
        XCTAssertEqual(outcomes.filter { $0 }.count, 1, "跨实例 flock + digest CAS 只能允许一个写者")
        let persisted = try JSONDecoder().decode(
            SelfEvolutionRunDocument.self,
            from: Data(contentsOf: fileURL)
        )
        XCTAssertTrue(["session-first", "session-second"].contains(persisted.bootstrapRecovery?.sessionID))
    }

    func testSameModelConcurrentMutationsCannotOverwriteFirstEvent() async throws {
        let fileURL = try temporaryStore("same-model-concurrency")
        let evolution = SelfEvolutionModel(
            store: SelfEvolutionRunStore(fileURL: fileURL, writeDelaySeconds: 0.05)
        )
        await evolution.load()
        let receipt = try await evolution.beginLegacyBootstrap(
            sessionID: "session-concurrent",
            sourceAppVersion: "0.0.26",
            targetAppVersion: "0.0.27",
            targetHostVersion: "0.0.27",
            manifest: manifest()
        )
        func mark(_ message: String) async -> Bool {
            do {
                try await evolution.markRecoveryRequired(runID: receipt.id, issue: message)
                return true
            } catch {
                return false
            }
        }
        async let first = mark("first failure")
        async let second = mark("second failure")
        let outcomes = await [first, second]
        XCTAssertEqual(outcomes.filter { $0 }.count, 1)
        XCTAssertEqual(evolution.latestReceipt?.events.filter { $0.kind == .recoveryRequired }.count, 1)

        let reloaded = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await reloaded.load()
        XCTAssertEqual(reloaded.latestReceipt?.events.filter { $0.kind == .recoveryRequired }.count, 1)
    }

    func testFirstSaveCreatesMissingParentAndBootstrapRecoveryClearsOnReceipt() async throws {
        let baseFile = try temporaryStore("first-save")
        let fileURL = baseFile.deletingLastPathComponent()
            .appending(path: "missing/nested/runs.json")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        try await evolution.recordBootstrapRecovery(
            sessionID: "session-bootstrap-recovery",
            targetAppVersion: "0.0.27",
            reason: .missingCandidateEvidence
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertEqual(evolution.bootstrapRecovery?.reason, .missingCandidateEvidence)

        _ = try await evolution.beginLegacyBootstrap(
            sessionID: "session-bootstrap-recovery",
            sourceAppVersion: "0.0.26",
            targetAppVersion: "0.0.27",
            targetHostVersion: "0.0.27",
            manifest: manifest()
        )
        XCTAssertNil(evolution.bootstrapRecovery)
        XCTAssertEqual(evolution.latestReceipt?.state, .appStarted)
    }

    func testStoreEnforcesRunAndEventBounds() throws {
        let candidate = SelfEvolutionCandidateEvidence(
            appVersion: "0.0.27",
            hostVersion: "0.0.27",
            manifest: manifest()
        )
        func acceptedBootstrap(_ index: Int) -> SelfEvolutionRunRecord {
            let base = Date(timeIntervalSince1970: 1_800_000_000 + Double(index * 10))
            let created = base.ISO8601Format()
            let restored = base.addingTimeInterval(1).ISO8601Format()
            let accepted = base.addingTimeInterval(2).ISO8601Format()
            return SelfEvolutionRunRecord(
                id: "bootstrap-\(index)",
                assurance: .legacyBootstrap,
                sourceAppVersion: "0.0.26",
                sourceBuildDigest: String(repeating: "c", count: 64),
                candidate: candidate,
                projectID: nil,
                sessionID: "session-\(index)",
                modelProvider: nil,
                modelID: nil,
                goalID: nil,
                qualifyingCycleOrdinal: nil,
                requiredCycleCount: nil,
                createdAt: created,
                updatedAt: accepted,
                state: .manualAccepted,
                events: [
                    SelfEvolutionEvent(id: "start-\(index)", kind: .appStarted, occurredAt: created),
                    SelfEvolutionEvent(id: "restore-\(index)", kind: .sessionRestored, occurredAt: restored),
                    SelfEvolutionEvent(id: "accept-\(index)", kind: .manualAccepted, occurredAt: accepted),
                ]
            )
        }
        XCTAssertThrowsError(
            try SelfEvolutionRunStore.validate(
                SelfEvolutionRunDocument(
                    runs: (0...SelfEvolutionRunDocument.maximumRuns).map(acceptedBootstrap)
                )
            )
        ) {
            XCTAssertEqual($0 as? SelfEvolutionStoreError, .tooManyRuns(257))
        }

        var tooManyEvents = acceptedBootstrap(999)
        var overflowEvents: [SelfEvolutionEvent] = []
        for index in 0...SelfEvolutionRunDocument.maximumEventsPerRun {
            let kind: SelfEvolutionEventKind = index == 0 ? .appStarted : .recoveryRequired
            let occurredAt = Date(
                timeIntervalSince1970: 1_800_020_000 + Double(index)
            ).ISO8601Format()
            overflowEvents.append(SelfEvolutionEvent(
                id: "event-overflow-\(index)",
                kind: kind,
                occurredAt: occurredAt,
                issue: index == 0 ? nil : "retry"
            ))
        }
        tooManyEvents.events = overflowEvents
        tooManyEvents.state = .recoveryRequired
        tooManyEvents.updatedAt = tooManyEvents.events.last!.occurredAt
        XCTAssertThrowsError(
            try SelfEvolutionRunStore.validate(SelfEvolutionRunDocument(runs: [tooManyEvents]))
        ) {
            XCTAssertEqual(
                $0 as? SelfEvolutionStoreError,
                .tooManyEvents(runID: "bootstrap-999", count: 65)
            )
        }
    }

    func testStartupPlannerNeverFallsBackWhenMarkerNamesMissingRun() {
        let candidate = SelfEvolutionCandidateEvidence(
            appVersion: "0.0.27",
            hostVersion: "0.0.27",
            manifest: manifest()
        )
        let now = "2026-08-23T10:00:00Z"
        let existing = SelfEvolutionRunRecord(
            id: "existing-run",
            assurance: .legacyBootstrap,
            sourceAppVersion: "0.0.26",
            sourceBuildDigest: nil,
            candidate: candidate,
            projectID: nil,
            sessionID: "existing-session",
            modelProvider: nil,
            modelID: nil,
            goalID: nil,
            qualifyingCycleOrdinal: nil,
            requiredCycleCount: nil,
            createdAt: now,
            updatedAt: now,
            state: .appStarted,
            events: [SelfEvolutionEvent(id: "existing-event", kind: .appStarted, occurredAt: now)]
        )
        let document = SelfEvolutionRunDocument(runs: [existing])
        XCTAssertNil(
            SelfEvolutionStartupPlanner.pendingRun(
                intent: SelfBuildRestartIntent(
                    kind: .selfEvolution,
                    sessionID: "missing-session",
                    selfEvolutionRunID: "missing-run"
                ),
                document: document
            )
        )
        XCTAssertNil(
            SelfEvolutionStartupPlanner.pendingRun(
                intent: SelfBuildRestartIntent(
                    kind: .ordinary,
                    sessionID: "ordinary-session",
                    selfEvolutionRunID: nil
                ),
                document: document
            ),
            "显式普通重启不得附着到未终结自进化回执"
        )
        XCTAssertEqual(
            SelfEvolutionStartupPlanner.route(
                intent: SelfBuildRestartIntent(
                    kind: .selfEvolutionRollback,
                    sessionID: "session-after-rollback",
                    selfEvolutionRunID: nil
                ),
                document: SelfEvolutionRunDocument()
            ),
            .reopenSelfEvolutionRollbackSession,
            "0.0.28 回滚到 0.0.27 后必须按普通 Session 恢复处理，不能进入 legacy Bootstrap"
        )
        XCTAssertEqual(
            SelfEvolutionStartupPlanner.route(
                intent: SelfBuildRestartIntent(
                    kind: .legacyBootstrap,
                    sessionID: "legacy-session",
                    selfEvolutionRunID: nil
                ),
                document: SelfEvolutionRunDocument()
            ),
            .legacyBootstrap
        )
        XCTAssertEqual(SelfEvolutionStartupPlanner.pendingRun(intent: nil, document: document)?.id, existing.id)
    }

    func testContinuityCountRequiresVersionAndDigestChain() async throws {
        let fileURL = try temporaryStore("continuity")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        let projectID = UUID()

        func complete(
            sourceVersion: String,
            sourceDigest: Character,
            targetVersion: String,
            targetDigest: Character
        ) async throws -> SelfEvolutionRunRecord {
            let candidateManifest = manifest(digest: targetDigest)
            let run = try await evolution.prepareFullRestart(
                context: SelfEvolutionFullContext(
                    sourceAppVersion: sourceVersion,
                    sourceBuildDigest: String(repeating: String(sourceDigest), count: 64),
                    projectID: projectID,
                    sessionID: "session-continuity",
                    modelProvider: "openai-codex",
                    modelID: "gpt-5.6-sol",
                    goalID: nil
                ),
                candidateAppVersion: targetVersion,
                candidateHostVersion: targetVersion,
                manifest: candidateManifest
            )
            try await evolution.markAppStarted(
                runID: run.id,
                appVersion: targetVersion,
                manifest: candidateManifest
            )
            try await evolution.markSessionRestored(
                runID: run.id,
                projectID: projectID,
                modelProvider: "openai-codex",
                modelID: "gpt-5.6-sol",
                goalID: nil
            )
            try await evolution.markManualAccepted(runID: run.id)
            return evolution.latestReceipt!
        }

        let first = try await complete(
            sourceVersion: "0.0.27", sourceDigest: "c",
            targetVersion: "0.0.28", targetDigest: "b"
        )
        XCTAssertEqual(first.qualifyingCycleOrdinal, 1)
        XCTAssertEqual(evolution.qualifyingCycleCount, 1)

        let second = try await complete(
            sourceVersion: "0.0.28", sourceDigest: "b",
            targetVersion: "0.0.29", targetDigest: "d"
        )
        XCTAssertEqual(second.qualifyingCycleOrdinal, 2)
        XCTAssertEqual(evolution.qualifyingCycleCount, 2)

        let broken = try await complete(
            sourceVersion: "0.0.29", sourceDigest: "e",
            targetVersion: "0.0.30", targetDigest: "f"
        )
        XCTAssertEqual(broken.qualifyingCycleOrdinal, 1)
        XCTAssertEqual(evolution.qualifyingCycleCount, 1, "同版本但不同 source digest 必须重新计数")
    }

    func testPreSwapRecoveryEndsReceiptWithoutExchangingBackup() async throws {
        let fileURL = try temporaryStore("pre-swap-rollback")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        let run = try await evolution.prepareFullRestart(
            context: SelfEvolutionFullContext(
                sourceAppVersion: "0.0.27",
                sourceBuildDigest: String(repeating: "c", count: 64),
                projectID: UUID(),
                sessionID: "session-pre-swap",
                modelProvider: "openai-codex",
                modelID: "gpt-5.6-sol",
                goalID: nil
            ),
            candidateAppVersion: "0.0.28",
            candidateHostVersion: "0.0.28",
            manifest: manifest()
        )
        try await evolution.markRecoveryRequired(runID: run.id, issue: "swap failed before install")
        let app = AppModel(selfEvolution: evolution)
        await app.rollbackSelfEvolutionReceipt()
        XCTAssertEqual(evolution.latestReceipt?.state, .rolledBack)
    }

    func testGenericRollbackCannotBypassUnfinishedReceipt() async throws {
        let fileURL = try temporaryStore("generic-rollback")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        let receipt = try await evolution.beginLegacyBootstrap(
            sessionID: "session-generic-rollback",
            sourceAppVersion: "0.0.26",
            targetAppVersion: "0.0.27",
            targetHostVersion: "0.0.27",
            manifest: manifest()
        )
        try await evolution.markSessionRestored(
            runID: receipt.id,
            projectID: UUID(),
            modelProvider: "openai-codex",
            modelID: "gpt-5.6-sol",
            goalID: nil
        )
        let app = AppModel(selfEvolution: evolution)
        await app.rollbackSelfBuild()
        XCTAssertEqual(evolution.latestReceipt?.state, .sessionRestored)
    }

    func testOrdinaryCandidateRestartCannotBypassUnfinishedReceiptOrReplaceBackup() async throws {
        let fileURL = try temporaryStore("ordinary-restart-guard")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        let receipt = try await evolution.beginLegacyBootstrap(
            sessionID: "session-ordinary-restart",
            sourceAppVersion: "0.0.26",
            targetAppVersion: "0.0.27",
            targetHostVersion: "0.0.27",
            manifest: manifest()
        )
        try await evolution.markSessionRestored(
            runID: receipt.id,
            projectID: UUID(),
            modelProvider: "openai-codex",
            modelID: "gpt-5.6-sol",
            goalID: nil
        )
        let dist = fileURL.deletingLastPathComponent().appending(path: "dist", directoryHint: .isDirectory)
        let backup = dist.appending(path: SelfBuildModels.backupBundleName, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        let sentinel = backup.appending(path: "sentinel.txt")
        try Data("keep-backup".utf8).write(to: sentinel)
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .standardizedFileURL.resolvingSymlinksInPath()
        let selfBuild = SelfBuildModel(rootDirectory: root, distDirectory: dist)
        let app = AppModel(selfBuild: selfBuild, selfEvolution: evolution)

        await app.restartIntoSelfBuildCandidate()

        XCTAssertEqual(evolution.unfinishedReceipt?.state, .sessionRestored)
        XCTAssertTrue(app.notice?.message.contains("唯一回滚备份") == true)
        XCTAssertEqual(try String(contentsOf: sentinel, encoding: .utf8), "keep-backup")
    }

    func testSolPolicyAndReceiptSettingsRendering() async throws {
        XCTAssertTrue(SelfEvolutionPreflightPolicy.isSolModel(provider: "openai-codex", modelID: "gpt-5.6-sol"))
        XCTAssertFalse(SelfEvolutionPreflightPolicy.isSolModel(provider: "openai", modelID: "gpt-5.6-sol"))
        XCTAssertFalse(SelfEvolutionPreflightPolicy.isSolModel(provider: "openai-codex", modelID: "not-gpt-5.6-sol"))
        XCTAssertFalse(SelfEvolutionPreflightPolicy.isSolModel(provider: "openai-codex", modelID: "gpt-5.6-luna"))
        XCTAssertTrue(SelfEvolutionAcceptancePolicy.hostIsStable(
            connectionState: .ready,
            restartRequired: false,
            hasReadyClient: true,
            writable: true,
            hasConflict: false,
            isCompacting: false,
            pendingMessageCount: 0
        ))
        XCTAssertFalse(SelfEvolutionAcceptancePolicy.hostIsStable(
            connectionState: .failed,
            restartRequired: false,
            hasReadyClient: true,
            writable: true,
            hasConflict: false,
            isCompacting: false,
            pendingMessageCount: 0
        ))
        XCTAssertFalse(SelfEvolutionAcceptancePolicy.hostIsStable(
            connectionState: .ready,
            restartRequired: true,
            hasReadyClient: true,
            writable: true,
            hasConflict: false,
            isCompacting: false,
            pendingMessageCount: 0
        ))
        XCTAssertFalse(SelfEvolutionAcceptancePolicy.hostIsStable(
            connectionState: .ready,
            restartRequired: false,
            hasReadyClient: true,
            writable: true,
            hasConflict: false,
            isCompacting: true,
            pendingMessageCount: 0
        ))

        let fileURL = try temporaryStore("render")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        do {
            _ = try await evolution.prepareFullRestart(
                context: SelfEvolutionFullContext(
                    sourceAppVersion: "0.0.27",
                    sourceBuildDigest: String(repeating: "c", count: 64),
                    projectID: UUID(),
                    sessionID: "session-fake-sol",
                    modelProvider: "custom-provider",
                    modelID: "gpt-5.6-sol",
                    goalID: nil
                ),
                candidateAppVersion: "0.0.28",
                candidateHostVersion: "0.0.28",
                manifest: manifest()
            )
            XCTFail("Store 不能只依赖 UI preflight 接受伪 Sol tuple")
        } catch {
            XCTAssertNotNil(error as? SelfEvolutionStoreError)
        }
        _ = try await evolution.beginLegacyBootstrap(
            sessionID: "session-render",
            sourceAppVersion: "0.0.26",
            targetAppVersion: "0.0.27",
            targetHostVersion: "0.0.27",
            manifest: manifest()
        )
        let model = AppModel(selfEvolution: evolution)
        let host = NSHostingView(
            rootView: SelfBuildSettingsView().environment(model).frame(width: 720, height: 700)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero)
    }

    func testAppPreflightRequiresExactProjectSolAndIdleSession() async throws {
        let fileURL = try temporaryStore("preflight")
        let evolution = SelfEvolutionModel(store: SelfEvolutionRunStore(fileURL: fileURL))
        await evolution.load()
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .standardizedFileURL.resolvingSymlinksInPath()
        let selfBuild = SelfBuildModel(rootDirectory: root, activeManifestOverride: manifest())
        selfBuild.candidate = SelfBuildCandidateInfo(
            bundlePath: "/tmp/candidate",
            appVersion: "0.0.28",
            hostVersion: "0.0.28",
            codesignValid: true,
            manifest: manifest(),
            issue: nil
        )
        let projectID = UUID()
        let app = AppModel(selfBuild: selfBuild, selfEvolution: evolution)
        app.projects = [
            DCodeProject(id: projectID, name: "D Code", directory: SourceFolder(path: root.path)),
        ]
        app.selectedProjectID = projectID
        app.selectedSessionID = "session-preflight"
        app.hostState = HostState(
            mode: "writable",
            sessionId: "session-preflight",
            sessionFile: "/tmp/session.jsonl",
            sessionName: "Self evolution",
            cwd: root.path,
            model: HostModel(
                provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol",
                reasoning: true, contextWindow: nil, maxTokens: nil,
                thinkingLevels: nil, fastModeSupported: nil
            ),
            thinkingLevel: "high",
            activePlan: nil,
            isStreaming: false,
            runState: nil,
            pendingMessageCount: 0,
            contextUsage: nil,
            fastMode: nil,
            writable: true,
            conflict: nil,
            isCompacting: false
        )

        XCTAssertTrue(app.selfEvolutionRestartBlockers.isEmpty)

        app.isStreaming = true
        XCTAssertTrue(app.selfEvolutionRestartBlockers.contains(where: { $0.contains("运行") }))
        app.isStreaming = false
        app.hostState = HostState(
            mode: "writable",
            sessionId: "session-preflight",
            sessionFile: "/tmp/session.jsonl",
            sessionName: "Self evolution",
            cwd: root.path,
            model: HostModel(
                provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna",
                reasoning: true, contextWindow: nil, maxTokens: nil,
                thinkingLevels: nil, fastModeSupported: nil
            ),
            thinkingLevel: "high",
            activePlan: nil,
            isStreaming: false,
            runState: nil,
            pendingMessageCount: 0,
            contextUsage: nil,
            fastMode: nil,
            writable: true,
            conflict: nil,
            isCompacting: false
        )
        XCTAssertTrue(app.selfEvolutionRestartBlockers.contains(where: { $0.contains("Sol") }))
    }
}
