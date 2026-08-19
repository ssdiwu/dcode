import Foundation
import XCTest
@testable import PiDCode

/// Fake-host 集成测试：覆盖 AppModel 与宿主协议交互的核心状态机。
@MainActor
final class AppModelHostIntegrationTests: XCTestCase {
    func testStartPerformsHandshakeAndEntersReady() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()

        await harness.model.start()

        XCTAssertEqual(harness.model.connectionState, .ready)
        XCTAssertEqual(harness.model.hostHello?.protocolVersion, 1)
        let methods = await harness.client.recordedMethods()
        XCTAssertEqual(methods.first, "host.hello")
        XCTAssertTrue(methods.contains("session.list"))
    }

    func testStartFailsCleanlyWhenHandshakeVersionMismatches() async throws {
        let harness = HostTestHarness()
        await harness.client.script { method, _ in
            switch method {
            case "host.hello":
                .object([
                    "protocolVersion": .number(2),
                    "hostVersion": .string("mismatched"),
                    "piVersion": .string("0.84.1-test"),
                    "nodeVersion": .string("v22.22.3-test"),
                    "capabilities": .object([:]),
                ])
            default:
                .object([:])
            }
        }

        await harness.model.start()

        XCTAssertEqual(harness.model.connectionState, .failed)
        XCTAssertNotNil(harness.model.issue)
        let shutdownCount = await harness.client.shutdownCount
        XCTAssertEqual(shutdownCount, 1, "失败路径必须关闭宿主并清理引用")
        let methods = await harness.client.recordedMethods()
        XCTAssertEqual(methods, ["host.hello"], "握手失败后不应继续发会话请求")
    }

    // MARK: - 生命周期事件

    func testUnexpectedProcessEndedFailsConnectionAndMarksRunUnknown() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        harness.model.selectedSessionID = "session-a"
        harness.model.activity.currentRunState = runState(
            sessionID: "session-a",
            runID: "run-a",
            phase: "running"
        )

        await harness.client.emit(HostEvent(name: "host.processEnded", data: .object([
            "status": .number(1),
            "expected": .bool(false),
        ])))

        XCTAssertEqual(harness.model.connectionState, .failed)
        XCTAssertEqual(harness.model.activity.currentRunState?.phase, .unknown)
        XCTAssertNotNil(harness.model.issue, "意外退出必须向用户呈现问题")
    }

    func testExpectedProcessEndedReturnsToIdleWithoutIssue() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()

        await harness.client.emit(HostEvent(name: "host.processEnded", data: .object([
            "status": .number(0),
            "expected": .bool(true),
        ])))

        XCTAssertEqual(harness.model.connectionState, .idle)
        XCTAssertNil(harness.model.issue)
    }

    // MARK: - Run 状态与活动注意力

    func testRunStateChangedAppliesStateAndRecordsCompletedAttention() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        harness.model.selectedSessionID = "session-a"
        harness.model.recentSessions = [
            SessionSummary(
                path: "/tmp/harness/session-a.jsonl",
                id: "session-a",
                cwd: "/tmp/harness",
                name: nil,
                parentSessionPath: nil,
                created: "2026-08-18T07:00:00.000Z",
                modified: "2026-08-18T08:00:00.000Z",
                messageCount: 2,
                firstMessage: "integration"
            )
        ]

        await harness.client.emit(HostEvent(
            name: "session.runStateChanged",
            data: try JSONValue.jsonString("""
            {"sessionId":"session-a","runId":"run-1","phase":"running",
             "startedAt":"2026-08-18T08:00:00.000Z","updatedAt":"2026-08-18T08:00:01.000Z",
             "inputPersisted":true,"retryable":false}
            """)
        ))
        XCTAssertEqual(harness.model.activity.currentRunState?.phase, .running)
        XCTAssertTrue(harness.model.isStreaming)

        await harness.client.emit(HostEvent(
            name: "session.runStateChanged",
            data: try JSONValue.jsonString("""
            {"sessionId":"session-a","runId":"run-1","phase":"completed",
             "startedAt":"2026-08-18T08:00:00.000Z","updatedAt":"2026-08-18T08:00:02.000Z",
             "completionId":"completion-1","completionEntryId":"assistant-1",
             "completedAt":"2026-08-18T08:00:02.000Z",
             "inputPersisted":true,"retryable":false}
            """)
        ))
        XCTAssertEqual(harness.model.activity.currentRunState?.phase, .completed)
        XCTAssertFalse(harness.model.isStreaming)
        XCTAssertEqual(harness.model.activity.attentionRecords.first?.sessionID, "session-a")
        XCTAssertTrue(harness.model.hasUnseenActivity, "完成轮次必须留下未读注意力记录")
    }

    // MARK: - 搜索索引状态

    func testSearchIndexChangedUpdatesDomainStatus() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()

        await harness.client.emit(HostEvent(
            name: "session.searchIndexChanged",
            data: try JSONValue.jsonString("""
            {"state":"ready","complete":true}
            """)
        ))

        XCTAssertEqual(harness.model.search.indexStatus.state, .ready)
    }

    // MARK: - 模型认证事件流

    func testModelAuthEventsUpdateAuthFlowPresentation() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        harness.model.modelSettings.authFlow = ModelAuthFlow(
            id: "flow-1",
            providerID: "openai",
            providerName: "OpenAI",
            method: ModelSettingsAuthMethod(
                type: "apiKey",
                label: "API Key",
                interactive: true
            ),
            prompt: nil,
            events: [],
            error: nil
        )

        await harness.client.emit(HostEvent(name: "modelAuth.request", data: .object([
            "requestId": .string("req-1"),
            "flowId": .string("flow-1"),
            "prompt": .object([
                "type": .string("secret"),
                "message": .string("请输入 API Key"),
                "placeholder": .string("sk-…"),
                "options": .array([]),
            ]),
        ])))
        XCTAssertEqual(harness.model.modelSettings.authFlow?.prompt?.id, "req-1")

        await harness.client.emit(HostEvent(name: "modelAuth.event", data: .object([
            "flowId": .string("flow-1"),
            "event": .object([
                "type": .string("progress"),
                "message": .string("正在打开浏览器…"),
            ]),
        ])))
        XCTAssertEqual(harness.model.modelSettings.authFlow?.events.first?.message, "正在打开浏览器…")

        await harness.client.emit(HostEvent(name: "modelAuth.completed", data: .object([
            "flowId": .string("flow-1"),
        ])))
        XCTAssertNil(harness.model.modelSettings.authFlow?.prompt, "完成后必须清除挂起的提示")
        XCTAssertEqual(harness.model.modelSettings.authFlow?.events.last?.message, "认证完成，正在刷新模型目录…")
    }

    // MARK: - 重启要求

    func testRestartRequiredKeepsObservationButInterruptsRun() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        harness.model.selectedSessionID = "session-a"
        harness.model.activity.currentRunState = runState(
            sessionID: "session-a",
            runID: "run-a",
            phase: "running"
        )

        await harness.client.emit(HostEvent(name: "host.restartRequired", data: nil))

        XCTAssertEqual(harness.model.activity.currentRunState?.phase, .unknown)
        XCTAssertEqual(harness.model.connectionState, .ready, "重启要求保留观察连接")
        XCTAssertNotNil(harness.model.notice)
    }

    // MARK: - 辅助

    private func runState(sessionID: String, runID: String, phase: String) -> SessionRunState {
        SessionRunState(
            sessionID: sessionID,
            runID: runID,
            phase: SessionRunPhase(rawValue: phase) ?? .unknown,
            waitingFor: nil,
            startedAt: "2026-08-18T08:00:00.000Z",
            updatedAt: "2026-08-18T08:00:00.000Z",
            completionID: nil,
            completionEntryID: nil,
            completedAt: nil,
            inputPersisted: true,
            retryable: false
        )
    }
}

private extension JSONValue {
    static func jsonString(_ text: String) throws -> JSONValue {
        let decoder = JSONDecoder()
        return try decoder.decode(JSONValue.self, from: Data(text.utf8))
    }
}
