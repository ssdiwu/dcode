import Foundation
import XCTest
@testable import PiDCode

final class SessionPathAndArchiveTests: XCTestCase {
    @MainActor
    func testSettingsAndArchivedSessionsUseTheWorkbenchNavigationStack() async {
        let model = AppModel()

        XCTAssertEqual(model.workbenchDestination, .workspace)
        model.presentSettings()
        XCTAssertEqual(model.workbenchDestination, .settings(.appearance))

        model.presentArchivedSessions()
        XCTAssertEqual(model.workbenchDestination, .settings(.archivedSessions))
        model.dismissArchivedSessions()
        XCTAssertEqual(model.workbenchDestination, .settings(.appearance))

        model.presentSettings(.about)
        XCTAssertEqual(model.workbenchDestination, .settings(.about))

        await model.selectProject(UUID())
        XCTAssertEqual(model.workbenchDestination, .workspace)
    }

    @MainActor
    func testHealthyHostStateDoesNotOccupyTheSessionSidebarFooter() {
        XCTAssertNil(HostConnectionState.ready.sidebarLabel)
        XCTAssertEqual(HostConnectionState.idle.sidebarLabel, "未连接")
        XCTAssertEqual(HostConnectionState.connecting.sidebarLabel, "正在连接")
        XCTAssertEqual(HostConnectionState.failed.sidebarLabel, "连接失败")
    }

    @MainActor
    func testOnlyEmptyVisibleDCodeSessionsOfferRecoverableTrash() {
        let model = AppModel()
        let empty = sessionSummary(id: "empty", messageCount: 0)
        let nonEmpty = sessionSummary(id: "non-empty", messageCount: 1)

        XCTAssertFalse(model.canTrashSession(empty))
        model.recentSessions = [empty, nonEmpty]
        XCTAssertTrue(model.canTrashSession(empty))
        XCTAssertFalse(model.canTrashSession(nonEmpty))

        model.archivedSessions = [ArchivedSessionRecord(
            sessionID: empty.id,
            archivedAt: "2026-08-12T01:02:03Z",
            copiedToSessionID: "copy",
            copiedToTitle: "Copy",
            copiedToCwd: "/tmp/copy",
            sourceTitle: empty.displayTitle,
            sourceCwd: empty.cwd
        )]
        XCTAssertFalse(model.canTrashSession(empty))
    }

    @MainActor
    func testPendingPromptShutdownKeepsTheOriginalDraftBytes() async throws {
        let root = temporaryDirectory("pending-shutdown")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SessionDraftStore(fileURL: root.appending(path: "drafts.json"))
        let archiveStore = SessionArchiveStore(fileURL: root.appending(path: "archives.json"))
        let model = AppModel(
            sessionDraftStore: store,
            sessionArchiveStore: archiveStore,
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json"))
        )
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        let target = SessionDraftTarget.path(sessionID: "session-a", pathID: "leaf:assistant-a")
        model.currentDraftTarget = target
        model.updateComposerText("逐字保留\n  两个空格")
        model.pendingPrompt = PendingPromptDraft(
            sessionID: "session-a",
            promptID: "prompt-a",
            draft: "逐字保留\n  两个空格",
            draftTarget: target
        )
        model.composerText = ""

        await model.shutdown()

        let persisted = try await store.load()
        XCTAssertEqual(persisted.records.first(where: { $0.target == target })?.text, "逐字保留\n  两个空格")
    }

    @MainActor
    func testPromptSettlementForAnotherSessionNeverReplacesTheVisibleDraftTarget() async throws {
        let root = temporaryDirectory("scoped-prompt")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SessionDraftStore(fileURL: root.appending(path: "drafts.json"))
        let archiveStore = SessionArchiveStore(fileURL: root.appending(path: "archives.json"))
        let model = AppModel(
            sessionDraftStore: store,
            sessionArchiveStore: archiveStore,
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json"))
        )
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        let targetA = SessionDraftTarget.path(sessionID: "session-a", pathID: "leaf:a")
        let targetB = SessionDraftTarget.path(sessionID: "session-b", pathID: "leaf:b")
        model.selectedSessionID = "session-b"
        model.currentDraftTarget = targetB
        model.updateComposerText("B 的草稿")
        model.pendingPrompt = PendingPromptDraft(
            sessionID: "session-a",
            promptID: "prompt-a",
            draft: "A 已发送",
            draftTarget: targetA
        )

        model.handle(HostEvent(name: "session.promptCompleted", data: .object([
            "sessionId": .string("session-a"),
            "promptId": .string("prompt-a"),
            "outcome": .string("persisted"),
            "entryId": .string("user-a-new"),
        ])))

        XCTAssertEqual(model.selectedSessionID, "session-b")
        XCTAssertEqual(model.currentDraftTarget, targetB)
        XCTAssertEqual(model.composerText, "B 的草稿")
        XCTAssertNil(model.pendingPrompt)
        await model.shutdown()
        let persisted = try await store.load()
        XCTAssertFalse(persisted.records.contains(where: { $0.text == "B 的草稿" && $0.target.sessionID == "session-a" }))
    }

    @MainActor
    func testPromptSettlementRebasesWhenTheFinalAssistantSnapshotArrivedFirst() {
        let model = AppModel()
        let oldTarget = SessionDraftTarget.path(sessionID: "session-a", pathID: "leaf:assistant-old")
        model.selectedSessionID = "session-a"
        model.currentDraftTarget = oldTarget
        model.inspection = inspection(
            sessionID: "session-a",
            selectedPathID: "leaf:assistant-new",
            entryIDs: ["user-new", "assistant-new"]
        )
        model.pendingPrompt = PendingPromptDraft(
            sessionID: "session-a",
            promptID: "prompt-a",
            draft: "第一轮",
            draftTarget: oldTarget
        )

        model.handle(HostEvent(name: "session.promptCompleted", data: .object([
            "sessionId": .string("session-a"),
            "promptId": .string("prompt-a"),
            "outcome": .string("persisted"),
            "entryId": .string("user-new"),
        ])))

        let expected = SessionDraftTarget.path(sessionID: "session-a", pathID: "leaf:assistant-new")
        XCTAssertEqual(model.currentDraftTarget, expected)
        XCTAssertNil(model.currentDraftTarget?.actionForSending(currentPathID: "leaf:assistant-new"))
        XCTAssertNil(model.pendingPrompt)
    }

    func testDraftTargetUsesPendingActionAndRebasesOnlyAlongTheVisibleBranch() {
        let pendingAction = SessionPathAction(kind: .editUser, entryId: "user-old")
        let pending = SessionDraftTarget.pending(
            sessionID: "session-a",
            originPathID: "leaf:assistant-current",
            action: pendingAction
        )
        XCTAssertEqual(pending.openingPathID, "leaf:assistant-current")
        XCTAssertEqual(pending.actionForSending(currentPathID: "leaf:assistant-current"), pendingAction)

        let current = SessionDraftTarget.path(sessionID: "session-a", pathID: "leaf:user-new")
        XCTAssertEqual(
            current.actionForSending(currentPathID: "leaf:assistant-new"),
            SessionPathAction(kind: .continuePath, entryId: "user-new")
        )
        XCTAssertNil(current.actionForSending(currentPathID: "leaf:user-new"))

        XCTAssertEqual(
            current.rebasedPathTarget(
                sessionID: "session-a",
                nextPathID: "leaf:assistant-new",
                visibleEntryIDs: ["user-new", "assistant-new"]
            ),
            .path(sessionID: "session-a", pathID: "leaf:assistant-new")
        )
        XCTAssertNil(current.rebasedPathTarget(
            sessionID: "session-a",
            nextPathID: "leaf:assistant-other",
            visibleEntryIDs: ["assistant-other"]
        ))

        XCTAssertEqual(
            current.rebasedPathTarget(
                sessionID: "session-a",
                nextPathID: "leaf:assistant-fast",
                visibleEntryIDs: ["assistant-old", "user-new", "assistant-fast"]
            ),
            .path(sessionID: "session-a", pathID: "leaf:assistant-fast")
        )
    }

    func testDraftStoreKeepsNewestRevisionAndFailsClosedAfterMalformedLoad() async throws {
        let root = temporaryDirectory("draft-store")
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appending(path: "drafts.json")
        let store = SessionDraftStore(fileURL: fileURL)
        let target = SessionDraftTarget.path(sessionID: "session-a", pathID: "leaf:a")
        let newest = SessionDraftDocument(
            records: [SessionDraftRecord(target: target, text: "newest", updatedAt: "2026-08-12T00:00:00Z")],
            activeTargets: ["session-a": target]
        )
        let stale = SessionDraftDocument(
            records: [SessionDraftRecord(target: target, text: "stale", updatedAt: "2026-08-11T00:00:00Z")],
            activeTargets: ["session-a": target]
        )
        try await store.save(newest, revision: 2)
        try await store.save(stale, revision: 1)
        let loadedNewest = try await store.load()
        XCTAssertEqual(loadedNewest, newest)

        let malformed = Data(#"{"version":1,"records":["#.utf8)
        try malformed.write(to: fileURL)
        let blockedStore = SessionDraftStore(fileURL: fileURL)
        do {
            _ = try await blockedStore.load()
            XCTFail("Expected malformed draft data to fail")
        } catch {
            XCTAssertEqual(try Data(contentsOf: fileURL), malformed)
        }
        do {
            try await blockedStore.save(SessionDraftDocument(), revision: 3)
            XCTFail("Expected writes to remain blocked after a failed load")
        } catch SessionDraftStoreError.unavailableAfterLoadFailure {
            XCTAssertEqual(try Data(contentsOf: fileURL), malformed)
        }
    }

    func testDraftStoreLoadsVersionOneDocumentsWrittenBeforeNewSessionDrafts() async throws {
        let root = temporaryDirectory("legacy-draft-document")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let fileURL = root.appending(path: "drafts.json")
        try Data(#"{"activeTargets":{},"records":[],"version":1}"#.utf8).write(to: fileURL)

        let document = try await SessionDraftStore(fileURL: fileURL).load()

        XCTAssertTrue(document.records.isEmpty)
        XCTAssertTrue(document.activeTargets.isEmpty)
        XCTAssertNil(document.newSessionDraft)
    }

    func testArchiveStoreRoundTripsAndFailsClosedWithoutOverwritingUnknownData() async throws {
        let root = temporaryDirectory("archive-store")
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appending(path: "archives.json")
        let store = SessionArchiveStore(fileURL: fileURL)
        let record = ArchivedSessionRecord(
            sessionID: "source-session",
            archivedAt: "2026-08-12T01:02:03Z",
            copiedToSessionID: "target-session",
            copiedToTitle: "目标",
            copiedToCwd: "/work/target",
            sourceTitle: "来源",
            sourceCwd: "/work/source"
        )
        try await store.save([record])
        let loadedRecords = try await store.load()
        XCTAssertEqual(loadedRecords, [record])
        XCTAssertNotNil(record.archivedDate)

        try await store.save(records: [], pending: record)
        let pendingDocument = try await store.loadDocument()
        XCTAssertEqual(pendingDocument.records, [])
        XCTAssertEqual(pendingDocument.pending, record)

        try await store.save(records: [record], pending: nil)
        let completedDocument = try await store.loadDocument()
        XCTAssertEqual(completedDocument.records, [record])
        XCTAssertNil(completedDocument.pending)

        let unsupported = Data(#"{"records":[],"version":2}"#.utf8)
        try unsupported.write(to: fileURL)
        let blockedStore = SessionArchiveStore(fileURL: fileURL)
        do {
            _ = try await blockedStore.load()
            XCTFail("Expected an unsupported archive document to fail")
        } catch SessionArchiveStoreError.invalidDocumentVersion(2) {
            XCTAssertEqual(try Data(contentsOf: fileURL), unsupported)
        }
        do {
            try await blockedStore.save([])
            XCTFail("Expected archive writes to remain blocked after a failed load")
        } catch SessionArchiveStoreError.unavailableAfterLoadFailure {
            XCTAssertEqual(try Data(contentsOf: fileURL), unsupported)
        }
    }

    func testArchiveStoreSupportsDirectArchiveButRejectsItAsPendingCopyRetry() async throws {
        let root = temporaryDirectory("direct-archive")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SessionArchiveStore(fileURL: root.appending(path: "archives.json"))
        let direct = ArchivedSessionRecord(
            sessionID: "source-session",
            archivedAt: "2026-08-13T01:02:03Z",
            copiedToSessionID: nil,
            copiedToTitle: nil,
            copiedToCwd: nil,
            sourceTitle: "来源",
            sourceCwd: "/work/source"
        )

        try await store.save([direct])
        let loadedDirectRecords = try await store.load()
        XCTAssertEqual(loadedDirectRecords, [direct])

        do {
            try await store.save(records: [], pending: direct)
            XCTFail("Expected direct archive to be rejected as a copy retry")
        } catch SessionArchiveStoreError.pendingArchiveRequiresCopyTarget("source-session") {
            let recordsAfterRejectedPending = try await store.load()
            XCTAssertEqual(recordsAfterRejectedPending, [direct])
        }

        let invalidStore = SessionArchiveStore(fileURL: root.appending(path: "invalid-archives.json"))
        let invalid = ArchivedSessionRecord(
            sessionID: "",
            archivedAt: direct.archivedAt,
            copiedToSessionID: nil,
            copiedToTitle: nil,
            copiedToCwd: nil,
            sourceTitle: direct.sourceTitle,
            sourceCwd: direct.sourceCwd
        )
        do {
            try await invalidStore.save([invalid])
            XCTFail("Expected an empty Session ID to be rejected before Host requests")
        } catch SessionArchiveStoreError.invalidSessionID("") {
            XCTAssertFalse(FileManager.default.fileExists(atPath: invalidStore.fileURL.path))
        }

        let oversizedUnicodeID = String(repeating: "🧠", count: 2_049)
        let oversizedTarget = ArchivedSessionRecord(
            sessionID: direct.sessionID,
            archivedAt: direct.archivedAt,
            copiedToSessionID: oversizedUnicodeID,
            copiedToTitle: "目标",
            copiedToCwd: "/work/target",
            sourceTitle: direct.sourceTitle,
            sourceCwd: direct.sourceCwd
        )
        do {
            try await invalidStore.save([oversizedTarget])
            XCTFail("Expected the UTF-16 Host protocol bound to be enforced")
        } catch SessionArchiveStoreError.invalidSessionID(oversizedUnicodeID) {
            XCTAssertFalse(FileManager.default.fileExists(atPath: invalidStore.fileURL.path))
        }
    }

    @MainActor
    func testDirectArchiveIsDisabledForPendingCopyAndStopsWhenDraftCannotPersist() async throws {
        let root = temporaryDirectory("archive-safety")
        defer { try? FileManager.default.removeItem(at: root) }
        let draftURL = root.appending(path: "drafts.json")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data(#"{"version":1,"records":["#.utf8).write(to: draftURL)
        let archiveStore = SessionArchiveStore(fileURL: root.appending(path: "archives.json"))
        let model = AppModel(
            sessionDraftStore: SessionDraftStore(fileURL: draftURL),
            sessionArchiveStore: archiveStore,
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json"))
        )
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        let session = sessionSummary(id: "source-session", messageCount: 2)
        model.recentSessions = [session]
        model.selectedSessionID = session.id
        model.currentDraftTarget = .path(sessionID: session.id, pathID: "leaf:a")
        model.updateComposerText("尚未安全落盘")

        let pending = ArchivedSessionRecord(
            sessionID: session.id,
            archivedAt: "2026-08-13T01:02:03Z",
            copiedToSessionID: "copy-session",
            copiedToTitle: "副本",
            copiedToCwd: "/work/copy",
            sourceTitle: session.displayTitle,
            sourceCwd: session.cwd
        )
        model.pendingArchiveRetry = pending
        XCTAssertFalse(model.canArchiveSession(session))
        model.pendingArchiveRetry = nil
        XCTAssertTrue(model.canArchiveSession(session))

        await model.archiveSession(session)

        XCTAssertTrue(model.archivedSessions.isEmpty)
        XCTAssertEqual(model.recentSessions.map(\.id), [session.id])
        XCTAssertEqual(model.selectedSessionID, session.id)
        XCTAssertEqual(model.composerText, "尚未安全落盘")
        let savedArchive = try await archiveStore.load()
        XCTAssertTrue(savedArchive.isEmpty)
    }

    @MainActor
    func testDirectArchiveHidesOrdinaryProjectionsButKeepsPinAndDraft() async throws {
        let root = temporaryDirectory("direct-archive-projection")
        defer { try? FileManager.default.removeItem(at: root) }
        let draftStore = SessionDraftStore(fileURL: root.appending(path: "drafts.json"))
        let archiveStore = SessionArchiveStore(fileURL: root.appending(path: "archives.json"))
        let pinStore = SessionPinStore(fileURL: root.appending(path: "pins.json"))
        let model = AppModel(
            sessionDraftStore: draftStore,
            sessionArchiveStore: archiveStore,
            sessionPinStore: pinStore,
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json"))
        )
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)

        let session = sessionSummary(id: "source-session", messageCount: 2)
        let projectID = UUID()
        model.recentSessions = [session]
        model.projectSessions[projectID] = [session]
        model.pinnedSessions = [PinnedSessionRecord(
            sessionID: session.id,
            pinnedAt: "2026-08-13T01:02:03Z"
        )]
        model.selectedSessionID = session.id
        let draftTarget = SessionDraftTarget.path(sessionID: session.id, pathID: "leaf:a")
        model.currentDraftTarget = draftTarget
        model.updateComposerText("归档前草稿\n逐字保留")

        await model.archiveSession(session)

        XCTAssertTrue(model.archivedSessions.contains(where: { $0.sessionID == session.id }))
        XCTAssertFalse(model.recentSessions.contains(where: { $0.id == session.id }))
        XCTAssertFalse(model.projectSessions[projectID, default: []].contains(where: { $0.id == session.id }))
        XCTAssertNil(model.selectedSessionID)
        XCTAssertTrue(model.isSessionPinned(session.id))
        let persistedDrafts = try await draftStore.load()
        XCTAssertEqual(
            persistedDrafts.records.first(where: { $0.target == draftTarget })?.text,
            "归档前草稿\n逐字保留"
        )
    }

    func testPinStoreRoundTripsAndFailsClosedWithoutOverwritingMalformedData() async throws {
        let root = temporaryDirectory("pin-store")
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appending(path: "pins.json")
        let store = SessionPinStore(fileURL: fileURL)
        let record = PinnedSessionRecord(
            sessionID: "session-old",
            pinnedAt: "2026-08-13T01:02:03Z"
        )

        try await store.save([record])
        let loadedPins = try await store.load()
        XCTAssertEqual(loadedPins, [record])

        let malformed = Data(#"{"version":1,"records":["#.utf8)
        try malformed.write(to: fileURL)
        let blockedStore = SessionPinStore(fileURL: fileURL)
        do {
            _ = try await blockedStore.load()
            XCTFail("Expected malformed pin data to fail")
        } catch {
            XCTAssertEqual(try Data(contentsOf: fileURL), malformed)
        }
        do {
            try await blockedStore.save([])
            XCTFail("Expected pin writes to remain blocked after a failed load")
        } catch SessionPinStoreError.unavailableAfterLoadFailure {
            XCTAssertEqual(try Data(contentsOf: fileURL), malformed)
        }

        let boundedStore = SessionPinStore(fileURL: root.appending(path: "too-many-pins.json"))
        let tooMany = (0...10_000).map {
            PinnedSessionRecord(sessionID: "session-\($0)", pinnedAt: "2026-08-13T01:02:03Z")
        }
        do {
            try await boundedStore.save(tooMany)
            XCTFail("Expected the pin catalog to enforce the Host protocol bound")
        } catch SessionPinStoreError.tooManyRecords(10_001) {
            XCTAssertFalse(FileManager.default.fileExists(atPath: boundedStore.fileURL.path))
        }

        let invalidStore = SessionPinStore(fileURL: root.appending(path: "invalid-pins.json"))
        do {
            try await invalidStore.save([PinnedSessionRecord(sessionID: "", pinnedAt: record.pinnedAt)])
            XCTFail("Expected an empty Session ID to be rejected before Host requests")
        } catch SessionPinStoreError.invalidSessionID("") {
            XCTAssertFalse(FileManager.default.fileExists(atPath: invalidStore.fileURL.path))
        }

        let oversizedUnicodeID = String(repeating: "🧠", count: 2_049)
        do {
            try await invalidStore.save([
                PinnedSessionRecord(sessionID: oversizedUnicodeID, pinnedAt: record.pinnedAt),
            ])
            XCTFail("Expected the UTF-16 Host protocol bound to be enforced")
        } catch SessionPinStoreError.invalidSessionID(oversizedUnicodeID) {
            XCTAssertFalse(FileManager.default.fileExists(atPath: invalidStore.fileURL.path))
        }
    }

    func testPinnedSessionsSortBeforePaginationWithoutDuplicatingNormalResults() {
        let newest = sessionSummary(
            id: "newest",
            messageCount: 1,
            modified: "2026-08-13T03:00:00Z"
        )
        let middle = sessionSummary(
            id: "middle",
            messageCount: 1,
            modified: "2026-08-13T02:00:00Z"
        )
        let oldest = sessionSummary(
            id: "oldest",
            messageCount: 1,
            modified: "2026-08-13T01:00:00Z"
        )
        let pins = [PinnedSessionRecord(
            sessionID: oldest.id,
            pinnedAt: "2026-08-13T04:00:00Z"
        )]

        let ordered = SessionPinOrdering.mergedAndOrdered(
            [[newest, middle], [oldest, newest]],
            pinnedRecords: pins
        )

        XCTAssertEqual(ordered.map(\.id), ["oldest", "newest", "middle"])
        XCTAssertEqual(Set(ordered.map(\.id)).count, 3)
    }

    func testEditableUserTextPreservesMarkdownExactlyAndRejectsStructuredContent() throws {
        let original = """
        请保留：
        ```swift
        print("hello")
        ```

        最后一行
        """
        let rawEntry: JSONValue = .object([
            "type": .string("message"),
            "id": .string("raw-user"),
            "message": .object([
                "role": .string("user"),
                "content": .string(original),
                "timestamp": .number(1),
            ]),
        ])
        XCTAssertEqual(TranscriptParser.parse(entries: [rawEntry]).first?.editableText, original)

        let structuredEntry: JSONValue = .object([
            "type": .string("message"),
            "id": .string("structured-user"),
            "message": .object([
                "role": .string("user"),
                "content": .array([.object(["type": .string("text"), "text": .string("正文")])]),
                "timestamp": .number(1),
            ]),
        ])
        XCTAssertNil(TranscriptParser.parse(entries: [structuredEntry]).first?.editableText)
    }

    private func temporaryDirectory(_ name: String) -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: "dcode-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    private func inspection(
        sessionID: String,
        selectedPathID: String,
        entryIDs: [String]
    ) -> SessionInspection {
        SessionInspection(
            summary: SessionSummary(
                path: "/tmp/\(sessionID).jsonl",
                id: sessionID,
                cwd: "/tmp",
                name: nil,
                parentSessionPath: nil,
                created: "2026-08-12T00:00:00Z",
                modified: "2026-08-12T00:00:00Z",
                messageCount: entryIDs.count,
                firstMessage: ""
            ),
            header: .object(["type": .string("session"), "id": .string(sessionID)]),
            parentSessionId: nil,
            leafId: entryIDs.last,
            currentPathId: selectedPathID,
            selectedPathId: selectedPathID,
            paths: [],
            entries: entryIDs.map { .object(["id": .string($0)]) },
            context: SessionContextSnapshot(messageCount: entryIDs.count, model: nil, thinkingLevel: "off"),
            activePlan: nil
        )
    }

    private func sessionSummary(
        id: String,
        messageCount: Int,
        modified: String = "2026-08-12T00:00:00Z"
    ) -> SessionSummary {
        SessionSummary(
            path: "/tmp/\(id).jsonl",
            id: id,
            cwd: "/tmp",
            name: id,
            parentSessionPath: nil,
            created: "2026-08-12T00:00:00Z",
            modified: modified,
            messageCount: messageCount,
            firstMessage: ""
        )
    }
}
