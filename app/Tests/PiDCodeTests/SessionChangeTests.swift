import Foundation
import XCTest
@testable import PiDCode

final class SessionChangeTests: XCTestCase {
    func testSummaryAggregatesFilesAcrossRunsWithoutCrossingSessionIdentity() {
        let records = [
            mutation(
                recordID: "session-a:run-a:tool-a",
                sessionID: "session-a",
                runID: "run-a",
                toolID: "tool-a",
                path: "/work/Sources/A.swift",
                line: 4,
                additions: 3,
                deletions: 1,
                occurredAt: "2026-08-14T10:00:00.000Z"
            ),
            mutation(
                recordID: "session-a:run-b:tool-b",
                sessionID: "session-a",
                runID: "run-b",
                toolID: "tool-b",
                path: "/work/Sources/A.swift",
                line: 8,
                additions: 2,
                deletions: 0,
                occurredAt: "2026-08-14T10:01:00.000Z"
            ),
            mutation(
                recordID: "session-b:run-c:tool-c",
                sessionID: "session-b",
                runID: "run-c",
                toolID: "tool-c",
                path: "/work/Other.swift",
                line: 1,
                additions: 9,
                deletions: 9,
                occurredAt: "2026-08-14T10:02:00.000Z"
            ),
        ]

        let source = SessionChangeSummary.build(sessionID: "session-a", records: records)
        XCTAssertEqual(source.fileCount, 1)
        XCTAssertEqual(source.runCount, 2)
        XCTAssertEqual(source.additions, 5)
        XCTAssertEqual(source.deletions, 1)
        XCTAssertEqual(source.files.first?.firstChangedLine, 4)
        XCTAssertEqual(source.files.first?.mutationCount, 2)

        let copiedIdentity = SessionChangeSummary.build(sessionID: "copied-session", records: records)
        XCTAssertTrue(copiedIdentity.isEmpty)
    }

    func testStoreRoundTripsNewestRevisionAndPreservesMalformedBytes() async throws {
        let root = temporaryDirectory("session-change-store")
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appending(path: "changes.json")
        let record = mutation(
            recordID: "session-a:run-a:tool-a",
            sessionID: "session-a",
            runID: "run-a",
            toolID: "tool-a",
            path: "/work/A.swift",
            line: 3,
            additions: 2,
            deletions: 1,
            occurredAt: "2026-08-14T10:00:00.000Z"
        )
        let store = SessionChangeStore(fileURL: fileURL)
        try await store.save(SessionChangeDocument(records: [record]), revision: 2)
        try await store.save(SessionChangeDocument(), revision: 1)
        let loaded = try await store.load()
        XCTAssertEqual(loaded.records, [record])

        let malformed = Data(#"{"version":2,"records":[]}"#.utf8)
        try malformed.write(to: fileURL)
        let blocked = SessionChangeStore(fileURL: fileURL)
        do {
            _ = try await blocked.load()
            XCTFail("Expected unsupported version")
        } catch SessionChangeStoreError.invalidDocumentVersion(2) {
            // Expected.
        }
        do {
            try await blocked.save(SessionChangeDocument(), revision: 3)
            XCTFail("Expected writes to remain blocked")
        } catch SessionChangeStoreError.unavailableAfterLoadFailure {
            // Expected.
        }
        XCTAssertEqual(try Data(contentsOf: fileURL), malformed)
    }

    @MainActor
    func testStructuredHostEventUpdatesAndPersistsTheSelectedSessionSummary() async throws {
        let root = temporaryDirectory("session-change-event")
        defer { try? FileManager.default.removeItem(at: root) }
        let changeStore = SessionChangeStore(fileURL: root.appending(path: "changes.json"))
        let model = AppModel(
            sessionDraftStore: SessionDraftStore(fileURL: root.appending(path: "drafts.json")),
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: changeStore,
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json"))
        )
        let loaded = await model.loadSessionMetadata()
        XCTAssertTrue(loaded)
        model.selectedSessionID = "session-a"
        model.handle(HostEvent(name: "session.changeRecorded", data: .object([
            "recordId": .string("session-a:run-a:tool-a"),
            "sessionId": .string("session-a"),
            "runId": .string("run-a"),
            "pathEntryId": .string("user-a"),
            "toolCallId": .string("tool-a"),
            "operation": .string("edit"),
            "filePath": .string("/work/A.swift"),
            "firstChangedLine": .number(7),
            "additions": .number(4),
            "deletions": .number(2),
            "occurredAt": .string("2026-08-14T10:00:00.000Z"),
            "source": .string("structured-tool-v1"),
        ])))

        XCTAssertEqual(model.sessionChangeSummary?.fileCount, 1)
        XCTAssertEqual(model.sessionChangeSummary?.additions, 4)
        model.handle(HostEvent(name: "session.changeRecorded", data: .object([
            "recordId": .string("session-a:run-a:tool-a"),
            "sessionId": .string("session-a"),
            "runId": .string("run-a"),
            "toolCallId": .string("tool-a"),
            "operation": .string("edit"),
            "filePath": .string("/work/A.swift"),
            "additions": .number(4),
            "deletions": .number(2),
            "occurredAt": .string("2026-08-14T10:00:00.000Z"),
            "source": .string("structured-tool-v1"),
        ])))
        XCTAssertEqual(model.sessionChangeSummary?.records.count, 1)

        model.handle(HostEvent(name: "session.changeRecorded", data: .object([
            "recordId": .string("session-a:run-a:tool-invalid"),
            "sessionId": .string("session-a"),
            "runId": .string("run-a"),
            "toolCallId": .string("tool-invalid"),
            "operation": .string("edit"),
            "filePath": .string("/work/unsafe\npath.swift"),
            "additions": .number(1),
            "deletions": .number(0),
            "occurredAt": .string("2026-08-14T10:01:00.000Z"),
            "source": .string("structured-tool-v1"),
        ])))
        XCTAssertEqual(model.sessionChangeSummary?.records.count, 1)

        await model.shutdown()
        let persisted = try await changeStore.load()
        XCTAssertEqual(persisted.records.count, 1)
    }

    private func mutation(
        recordID: String,
        sessionID: String,
        runID: String,
        toolID: String,
        path: String,
        line: Int,
        additions: Int,
        deletions: Int,
        occurredAt: String
    ) -> SessionMutationRecord {
        SessionMutationRecord(
            recordId: recordID,
            sessionId: sessionID,
            runId: runID,
            pathEntryId: "user-entry",
            toolCallId: toolID,
            operation: .edit,
            filePath: path,
            firstChangedLine: line,
            additions: additions,
            deletions: deletions,
            occurredAt: occurredAt,
            source: "structured-tool-v1"
        )
    }

    private func temporaryDirectory(_ name: String) -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "dcode-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
