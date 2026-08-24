import XCTest
import UserNotifications
@testable import PiDCode

@MainActor
final class CompletionNotificationTests: XCTestCase {
    func testCompletedRunSchedulesOnceWithoutClearingActivityAttention() async throws {
        let provider = MockCompletionNotificationProvider()
        let model = makeModel(provider: provider)
        model.completionNotificationsEnabled = true
        model.selectedSessionID = "session-a"
        let event = completedRunEvent()

        model.handle(event)
        await waitUntil { provider.requests.count == 1 }
        model.handle(event)
        await Task.yield()

        XCTAssertEqual(provider.requests.count, 1)
        let request = try XCTUnwrap(provider.requests.first)
        XCTAssertEqual(request.identifier, "completion-1")
        XCTAssertEqual(request.content.title, "D Code 已完成")
        XCTAssertEqual(request.content.body, "任务已经完成，点击查看结果")
        XCTAssertEqual(request.content.userInfo["sessionID"] as? String, "session-a")
        XCTAssertEqual(request.content.userInfo["entryID"] as? String, "assistant-1")
        XCTAssertEqual(model.activity.attentionRecords.count, 1)
        XCTAssertNil(model.activity.attentionRecords[0].presentedAt)
        XCTAssertNotNil(model.activity.attentionRecords[0].notifiedAt)
    }

    func testNonCompletedRunsAndDisabledPreferenceDoNotSchedule() async {
        let provider = MockCompletionNotificationProvider()
        let model = makeModel(provider: provider)
        model.completionNotificationsEnabled = false

        for phase in [SessionRunPhase.failed, .aborted, .unknown, .stopRequested] {
            model.handle(HostEvent(name: "session.runStateChanged", data: .object([
                "sessionId": .string("session-a"),
                "runId": .string("run-\(phase.rawValue)"),
                "phase": .string(phase.rawValue),
                "startedAt": .string(timestamp),
                "updatedAt": .string(timestamp),
                "completedAt": .string(timestamp),
                "completionId": .string("completion-\(phase.rawValue)"),
                "completionEntryId": .string("entry-\(phase.rawValue)"),
                "inputPersisted": .bool(true),
                "retryable": .bool(false),
            ])))
        }
        await Task.yield()
        XCTAssertTrue(provider.requests.isEmpty)
    }

    func testDeniedAuthorizationDoesNotPretendToggleIsEnabled() async {
        let provider = MockCompletionNotificationProvider(state: .denied)
        let model = makeModel(provider: provider)

        await model.setCompletionNotificationsEnabled(true)

        XCTAssertFalse(model.completionNotificationsEnabled)
        XCTAssertEqual(model.completionNotificationAuthorizationState, .denied)
        XCTAssertEqual(provider.authorizationRequests, 0)
    }

    func testNotificationResponseTargetsTheCorrectConversationEntry() async {
        let provider = MockCompletionNotificationProvider()
        let model = makeModel(provider: provider)
        model.selectedSessionID = "session-a"
        model.inspection = makeInspection(sessionID: "session-a")
        model.transcript = [TranscriptItem(
            id: "assistant-1",
            role: .assistant,
            timestamp: nil,
            blocks: [.text(id: "assistant-1-text", value: "done")]
        )]

        await model.handleCompletionNotificationResponse([
            AnyHashable("completionID"): "completion-1",
            AnyHashable("sessionID"): "session-a",
            AnyHashable("entryID"): "assistant-1",
        ])

        XCTAssertEqual(model.workbenchDestination, .workspace)
        XCTAssertEqual(model.workspaceTabSelection, .conversation)
        XCTAssertEqual(model.conversationTarget?.sessionID, "session-a")
        XCTAssertEqual(model.conversationTarget?.entryID, "assistant-1")
    }

    func testColdLaunchNotificationResponseWaitsForTheModel() async {
        PiDCodeAppDelegate.resetCompletionNotificationRoutingForTests()
        defer { PiDCodeAppDelegate.resetCompletionNotificationRoutingForTests() }
        let userInfo: [AnyHashable: Any] = [
            "completionID": "completion-cold",
            "sessionID": "session-a",
            "entryID": "assistant-1",
        ]
        await PiDCodeAppDelegate.routeCompletionNotificationResponse(userInfo)

        let model = makeModel(provider: MockCompletionNotificationProvider())
        model.selectedSessionID = "session-a"
        model.inspection = makeInspection(sessionID: "session-a")
        model.transcript = [TranscriptItem(
            id: "assistant-1",
            role: .assistant,
            timestamp: nil,
            blocks: [.text(id: "assistant-1-text", value: "done")]
        )]
        PiDCodeAppDelegate.installModel(model)
        await waitUntil { model.conversationTarget?.entryID == "assistant-1" }

        XCTAssertEqual(model.conversationTarget?.sessionID, "session-a")
        XCTAssertEqual(model.conversationTarget?.entryID, "assistant-1")
    }

    func testLegacyAttentionDataDecodesWithoutNotificationEvidence() throws {
        let data = Data("""
        {"sessionID":"session-a","runID":"run-a","completionID":"completion-a","entryID":"entry-a","completedAt":"2026-08-24T01:00:00Z","presentedAt":null}
        """.utf8)
        let record = try JSONDecoder().decode(ActivityAttentionRecord.self, from: data)
        XCTAssertNil(record.notifiedAt)
    }

    func testRefreshingRevokedSystemPermissionTurnsOffTheAppPreference() async {
        let provider = MockCompletionNotificationProvider(state: .authorized)
        let model = makeModel(provider: provider)
        model.selectedSessionID = "session-a"
        model.completionNotificationsEnabled = true
        provider.state = .denied

        await model.refreshCompletionNotificationAuthorizationState()

        XCTAssertEqual(model.completionNotificationAuthorizationState, .denied)
        XCTAssertFalse(model.completionNotificationsEnabled)
    }

    func testCompletionEventAlsoTurnsOffPreferenceWhenSystemPermissionWasRevoked() async {
        let provider = MockCompletionNotificationProvider(state: .authorized)
        let model = makeModel(provider: provider)
        model.selectedSessionID = "session-a"
        model.completionNotificationsEnabled = true
        UserDefaults.standard.set(true, forKey: CompletionNotificationSettings.enabledStorageKey)
        addTeardownBlock {
            UserDefaults.standard.removeObject(forKey: CompletionNotificationSettings.enabledStorageKey)
        }
        provider.state = .denied

        model.handle(completedRunEvent(
            runID: "run-revoked",
            completionID: "completion-revoked",
            entryID: "assistant-revoked"
        ))
        await waitUntil { !model.completionNotificationsEnabled }

        XCTAssertEqual(model.completionNotificationAuthorizationState, .denied)
        XCTAssertFalse(UserDefaults.standard.bool(forKey: CompletionNotificationSettings.enabledStorageKey))
        XCTAssertTrue(provider.requests.isEmpty)
    }

    func testSystemAuthorizationSourceResumesItsContinuationOnce() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "Sources/PiDCode/Models/CompletionNotifications.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        XCTAssertEqual(
            source.components(separatedBy: "continuation.resume(returning: state)").count - 1,
            1,
            "系统权限回调不得重复恢复同一个 checked continuation"
        )
    }

    private func makeModel(provider: MockCompletionNotificationProvider) -> AppModel {
        AppModel(completionNotificationService: CompletionNotificationService(provider: provider))
    }

    private func completedRunEvent(
        runID: String = "run-a",
        completionID: String = "completion-1",
        entryID: String = "assistant-1"
    ) -> HostEvent {
        HostEvent(name: "session.runStateChanged", data: .object([
            "sessionId": .string("session-a"),
            "runId": .string(runID),
            "phase": .string("completed"),
            "startedAt": .string(timestamp),
            "updatedAt": .string(timestamp),
            "completionId": .string(completionID),
            "completionEntryId": .string(entryID),
            "completedAt": .string(timestamp),
            "inputPersisted": .bool(true),
            "retryable": .bool(false),
        ]))
    }

    private var timestamp: String { "2026-08-24T01:00:00Z" }

    private func makeInspection(sessionID: String) -> SessionInspection {
        SessionInspection(
            summary: SessionSummary(
                path: "/tmp/\(sessionID).jsonl",
                id: sessionID,
                cwd: "/tmp",
                name: "问候对话",
                parentSessionPath: nil,
                created: timestamp,
                modified: timestamp,
                messageCount: 1,
                firstMessage: "hello"
            ),
            header: .object(["id": .string(sessionID)]),
            parentSessionId: nil,
            leafId: "assistant-1",
            currentPathId: "leaf:assistant-1",
            selectedPathId: "leaf:assistant-1",
            paths: [],
            entries: [.object(["id": .string("assistant-1")])],
            context: SessionContextSnapshot(messageCount: 1, model: nil, thinkingLevel: "off"),
            activePlan: nil,
            activeProposal: nil
        )
    }

    private func waitUntil(
        timeout: Duration = .seconds(1),
        _ predicate: @escaping @MainActor () -> Bool
    ) async {
        let deadline = ContinuousClock.now + timeout
        while !predicate(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }
}

@MainActor
private final class MockCompletionNotificationProvider: CompletionNotificationProviding {
    var state: CompletionNotificationAuthorizationState
    var requests: [UNNotificationRequest] = []
    var authorizationRequests = 0

    init(state: CompletionNotificationAuthorizationState = .authorized) {
        self.state = state
    }

    func authorizationState() async -> CompletionNotificationAuthorizationState { state }

    func requestAuthorization() async throws -> Bool {
        authorizationRequests += 1
        return state == .authorized
    }

    func add(_ request: UNNotificationRequest) async throws {
        requests.append(request)
    }
}
