import XCTest
@testable import PiDCode

@MainActor
final class ActivityModelsTests: XCTestCase {
    func testSidebarProjectionAccessibilityValueDescribesCurrentViewAndAttention() {
        XCTAssertEqual(
            SidebarProjection.navigation.bellAccessibilityValue(hasUnseenActivity: false),
            "当前为会话导航，没有新完成结果"
        )
        XCTAssertEqual(
            SidebarProjection.activity.bellAccessibilityValue(hasUnseenActivity: true),
            "当前为活动视图，有新完成结果"
        )
    }

    func testAttentionStoreRoundTripsAndPreservesMalformedBytes() async throws {
        let root = temporaryURL("attention-store")
        let file = root.appending(path: "attention.json")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ActivityAttentionStore(fileURL: file)
        let record = ActivityAttentionRecord(
            sessionID: "session-a",
            runID: "run-a",
            completionID: "run-a:assistant-a",
            entryID: "assistant-a",
            completedAt: "2026-08-16T01:00:00Z",
            presentedAt: nil
        )

        try await store.save(ActivityAttentionDocument(records: [record]), revision: 1)
        try await store.save(ActivityAttentionDocument(), revision: 0)
        let loaded = try await store.load()
        XCTAssertEqual(loaded.records, [record])

        let malformed = Data("{\"version\":99,\"records\":[]}".utf8)
        try malformed.write(to: file, options: .atomic)
        do {
            _ = try await store.load()
            XCTFail("Malformed attention store should fail closed")
        } catch {}
        do {
            try await store.save(ActivityAttentionDocument(records: [record]), revision: 2)
            XCTFail("A failed load should block later writes")
        } catch {}
        XCTAssertEqual(try Data(contentsOf: file), malformed)
    }

    func testActivityProjectionPrioritizesTruthThenUsesStableTimeOrder() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = try XCTUnwrap(ActivityTimestamp.parse("2026-08-16T12:00:00Z"))
        let waiting = summary(id: "waiting", modified: "2026-08-14T10:00:00Z")
        let completed = summary(id: "completed", modified: "2026-08-15T10:00:00Z")
        let historyB = summary(id: "b", modified: "2026-08-16T08:00:00Z")
        let historyA = summary(id: "a", modified: "2026-08-16T08:00:00Z")
        let runState = SessionRunState(
            sessionID: waiting.id,
            runID: "run-waiting",
            phase: .waitingForUser,
            waitingFor: .confirm,
            startedAt: "2026-08-16T09:00:00Z",
            updatedAt: "2026-08-16T09:05:00Z",
            completionID: nil,
            completionEntryID: nil,
            completedAt: nil,
            inputPersisted: true,
            retryable: false
        )
        let attention = ActivityAttentionRecord(
            sessionID: completed.id,
            runID: "run-completed",
            completionID: "run-completed:assistant",
            entryID: "assistant",
            completedAt: "2026-08-16T09:10:00Z",
            presentedAt: nil
        )

        let sections = ActivityProjection.sections(
            sessions: [historyB, completed, waiting, historyA],
            runState: runState,
            attentionRecords: [attention],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(sections.map(\.kind), [.waiting, .newCompletion, .today])
        XCTAssertEqual(sections[0].sessions.map(\.id), [waiting.id])
        XCTAssertEqual(sections[0].sessions.first?.waitingFor, .confirm)
        XCTAssertEqual(sections[1].sessions.map(\.id), [completed.id])
        XCTAssertEqual(sections[2].sessions.map(\.id), ["a", "b"])
        XCTAssertEqual(sections[1].sessions.first?.hasUnseenCompletion, true)
    }

    func testCompletionAttentionClearsOnlyWhenMatchingConversationEntryAppears() {
        let model = AppModel()
        model.selectedSessionID = "session-a"
        model.transcript = [transcriptItem(id: "assistant-old")]

        model.handle(HostEvent(
            name: "session.runStateChanged",
            data: runStateData(
                runID: "run-1",
                completionID: "run-1:assistant-new",
                entryID: "assistant-new"
            )
        ))
        XCTAssertEqual(model.activity.attentionRecords.first?.isUnseen, true)

        model.markCompletionPresented(entryID: "assistant-old")
        XCTAssertEqual(model.activity.attentionRecords.first?.isUnseen, true)

        model.transcript.append(transcriptItem(id: "assistant-new"))
        model.markCompletionPresented(entryID: "assistant-new")
        XCTAssertEqual(model.activity.attentionRecords.first?.isUnseen, false)

        model.handle(HostEvent(
            name: "session.runStateChanged",
            data: runStateData(
                runID: "run-2",
                completionID: "run-2:assistant-latest",
                entryID: "assistant-latest"
            )
        ))
        XCTAssertEqual(model.activity.attentionRecords.first?.entryID, "assistant-latest")
        XCTAssertEqual(model.activity.attentionRecords.first?.isUnseen, true)
        model.markCompletionPresented(entryID: "assistant-new")
        XCTAssertEqual(model.activity.attentionRecords.first?.isUnseen, true)
    }

    func testRunStateDistinguishesStopRequestFromConfirmedAbort() {
        let model = AppModel()
        model.selectedSessionID = "session-a"
        model.handle(HostEvent(
            name: "session.runStateChanged",
            data: runStateData(runID: "run-1", phase: "stopRequested")
        ))
        XCTAssertEqual(model.activity.currentRunState?.phase, .stopRequested)
        XCTAssertTrue(model.isStreaming)

        model.handle(HostEvent(
            name: "session.runStateChanged",
            data: runStateData(runID: "run-1", phase: "aborted", completedAt: "2026-08-16T01:00:03Z")
        ))
        XCTAssertEqual(model.activity.currentRunState?.phase, .aborted)
        XCTAssertFalse(model.isStreaming)
        XCTAssertTrue(model.activity.attentionRecords.isEmpty)
    }

    func testHostRunStateStillGatesActionsAfterAgentEndStopsStreamingPresentation() {
        let model = AppModel()
        model.selectedSessionID = "session-a"
        model.handle(HostEvent(
            name: "session.runStateChanged",
            data: runStateData(runID: "run-1", phase: "running")
        ))

        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("agent_end"),
            "sessionId": .string("session-a"),
            "runId": .string("run-1"),
            "willRetry": .bool(false),
        ])))

        XCTAssertFalse(model.isStreaming)
        XCTAssertTrue(model.hasActiveRun)
        XCTAssertTrue(model.shouldQueueComposerText)
        XCTAssertTrue(model.isPromptTransactionActive)
    }

    func testWaitingReasonDecodesAndUnseenCompletionNeedsAVisibleSession() throws {
        let waiting = try runStateData(
            runID: "run-waiting",
            phase: "waitingForUser",
            waitingFor: "editor"
        ).decoded(SessionRunState.self)
        XCTAssertEqual(waiting.waitingFor, .editor)

        let model = AppModel()
        model.activity.attentionRecords = [ActivityAttentionRecord(
            sessionID: "session-a",
            runID: "run-completed",
            completionID: "run-completed:assistant",
            entryID: "assistant",
            completedAt: "2026-08-16T09:10:00Z",
            presentedAt: nil
        )]
        XCTAssertFalse(model.hasUnseenActivity)
        model.activity.sessions = [summary(id: "session-a", modified: "2026-08-16T09:10:00Z")]
        XCTAssertTrue(model.hasUnseenActivity)
    }

    private func summary(id: String, modified: String) -> SessionSummary {
        SessionSummary(
            path: "/tmp/\(id).jsonl",
            id: id,
            cwd: "/tmp/project",
            name: id,
            parentSessionPath: nil,
            created: "2026-08-14T09:00:00Z",
            modified: modified,
            messageCount: 2,
            firstMessage: id
        )
    }

    private func transcriptItem(id: String) -> TranscriptItem {
        TranscriptItem(
            id: id,
            role: .assistant,
            timestamp: nil,
            blocks: [.text(id: "\(id)-text", value: "done")]
        )
    }

    private func runStateData(
        runID: String,
        phase: String = "completed",
        waitingFor: String? = nil,
        completionID: String? = nil,
        entryID: String? = nil,
        completedAt: String? = nil
    ) -> JSONValue {
        var object: [String: JSONValue] = [
            "sessionId": .string("session-a"),
            "runId": .string(runID),
            "phase": .string(phase),
            "startedAt": .string("2026-08-16T01:00:00Z"),
            "updatedAt": .string(completedAt ?? "2026-08-16T01:00:02Z"),
            "inputPersisted": .bool(true),
            "retryable": .bool(false),
        ]
        if let waitingFor { object["waitingFor"] = .string(waitingFor) }
        if let completionID { object["completionId"] = .string(completionID) }
        if let entryID { object["completionEntryId"] = .string(entryID) }
        if let completedAt = completedAt ?? (phase == "completed" ? "2026-08-16T01:00:02Z" : nil) {
            object["completedAt"] = .string(completedAt)
        }
        return .object(object)
    }

    private func temporaryURL(_ name: String) -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: "dcode-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
    }
}
