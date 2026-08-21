import SwiftUI
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

    func testHostStderrIsLoggedNotNoticedWhileOutputErrorStillNotifies() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()

        await harness.client.emit(HostEvent(
            name: "host.stderr",
            data: .object(["message": .string("lang:简体（think:开启，跟随 /lang）")])
        ))

        XCTAssertNil(harness.model.notice, "扩展自身的 stderr 输出不应弹出通知")
        XCTAssertEqual(harness.model.hostDiagnosticLog.count, 1)
        XCTAssertEqual(harness.model.hostDiagnosticLog.first?.message, "lang:简体（think:开启，跟随 /lang）")

        await harness.client.emit(HostEvent(
            name: "host.outputError",
            data: .object(["message": .string("无法解析 Host 输出")])
        ))
        XCTAssertEqual(harness.model.notice?.message, "无法解析 Host 输出")
        XCTAssertEqual(harness.model.notice?.level, "error")
    }

    func testExtensionLanguageFooterHintIsLoggedNotNoticedWhileRealNotificationsStillBanner() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()

        await harness.client.emit(HostEvent(
            name: "extension.notification",
            data: .object([
                "message": .string("lang:简体中文（think:开启，跟随 /lang）"),
                "level": .string("info"),
            ])
        ))

        XCTAssertNil(harness.model.notice, "pi-di18n 的 TUI 状态栏提示不应弹横幅")
        XCTAssertEqual(harness.model.hostDiagnosticLog.last?.message, "扩展状态提示：lang:简体中文（think:开启，跟随 /lang）")

        await harness.client.emit(HostEvent(
            name: "extension.notification",
            data: .object([
                "message": .string("i18n: slash command localization is running in fallback mode (pi-core alignment needed)"),
                "level": .string("warning"),
            ])
        ))

        XCTAssertNil(harness.model.notice, "pi-di18n 的 i18n 状态提示即使 warning 级别也不弹横幅")
        XCTAssertEqual(
            harness.model.hostDiagnosticLog.last?.message,
            "扩展状态提示：i18n: slash command localization is running in fallback mode (pi-core alignment needed)"
        )

        await harness.client.emit(HostEvent(
            name: "extension.notification",
            data: .object([
                "message": .string("提醒：站会 10 分钟后开始"),
                "level": .string("info"),
            ])
        ))
        XCTAssertEqual(harness.model.notice?.message, "提醒：站会 10 分钟后开始", "普通扩展通知仍然弹横幅")
    }

    func testHostDiagnosticLogCapsAtTwoHundredEntries() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()

        for index in 0..<205 {
            await harness.client.emit(HostEvent(
                name: "host.stderr",
                data: .object(["message": .string("line-\(index)")])
            ))
        }

        XCTAssertEqual(harness.model.hostDiagnosticLog.count, 200)
        XCTAssertEqual(harness.model.hostDiagnosticLog.first?.message, "line-5")
        XCTAssertEqual(harness.model.hostDiagnosticLog.last?.message, "line-204")
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

// MARK: - 打开即接管与冲突重接

@MainActor
final class SessionTakeoverIntegrationTests: XCTestCase {
    func testConflictStopsWritesShowsCardAndRetakeReopens() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        harness.model.selectedSessionID = "session-a"
        harness.model.updateComposerText("保留的草稿")

        await harness.client.emit(HostEvent(name: "session.conflict", data: .object([
            "sessionId": .string("session-a"),
            "code": .string("EXTERNAL_WRITE_DETECTED"),
            "message": .string("Session changed outside the current lease"),
        ])))

        XCTAssertEqual(harness.model.sessionConflict?.sessionID, "session-a")
        XCTAssertFalse(harness.model.isStreaming)
        XCTAssertEqual(harness.model.composerText, "保留的草稿", "冲突必须保留草稿")

        await harness.model.retakeSessionOwnership()

        XCTAssertNil(harness.model.sessionConflict, "重接后清除冲突呈现")
        let methods = await harness.client.recordedMethods()
        XCTAssertEqual(methods.filter { $0 == "session.open" }.count, 1, "重新接管即重新以可写打开")
    }

    func testTakeoverConflictMessageDistinguishesStolenLease() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        harness.model.selectedSessionID = "session-a"

        await harness.client.emit(HostEvent(name: "session.conflict", data: .object([
            "sessionId": .string("session-a"),
            "code": .string("LEASE_STOLEN"),
            "message": .string("Lease was taken over by another D Code instance"),
        ])))

        XCTAssertEqual(harness.model.sessionConflict?.isTakeover, true)
    }
}

// MARK: - 主页草稿模型补载

@MainActor
final class HomeDraftModelRecoveryTests: XCTestCase {
    /// 0.0.14 实机回归：主页 .task(id:) 曾把 isNewSessionDraftActive 计入 key，
    /// 草稿激活会取消自身任务，把 session.getModels 掐成 CancellationError。
    /// key 修复之外，本用例锁定恢复路径：草稿在、模型从未载入、无错误时，
    /// ensureHomeDraft 必须补载而不是静默返回。
    func testEnsureHomeDraftReloadsModelsWhenDraftActiveButModelsMissing() async throws {
        let harness = HostTestHarness()
        await harness.client.script { method, _ in
            switch method {
            case "host.hello":
                HostTestHarness.helloValue()
            case "session.list":
                .object(["sessions": .array([])])
            case "session.getModels":
                .object([
                    "models": .array([
                        .object([
                            "provider": .string("openai-codex"),
                            "id": .string("gpt-5.3-codex-spark"),
                            "name": .string("GPT-5.3 Codex Spark"),
                            "reasoning": .bool(true),
                            "contextWindow": .number(400_000),
                            "maxTokens": .number(64_000),
                            "thinkingLevels": .array([
                                .string("off"), .string("low"), .string("medium"), .string("high"),
                            ]),
                            "fastModeSupported": .bool(true),
                        ]),
                    ]),
                    "defaultThinkingLevel": .string("medium"),
                ])
            default:
                .object([:])
            }
        }
        await harness.model.start()

        await harness.model.ensureHomeDraft()
        XCTAssertTrue(harness.model.isNewSessionDraftActive, "主页自动激活草稿")
        XCTAssertFalse(harness.model.modelSettings.models.isEmpty, "首次激活即载入模型")
        XCTAssertEqual(harness.model.modelSettings.models.first?.displayName, "GPT-5.3 Codex Spark")

        // 模拟取消后的残留状态：草稿在、模型被清空、无错误、不在加载中。
        harness.model.modelSettings.models = []
        await harness.model.ensureHomeDraft()
        XCTAssertEqual(
            harness.model.modelSettings.models.first?.displayName,
            "GPT-5.3 Codex Spark",
            "草稿已在但模型缺失时必须补载"
        )
        XCTAssertNil(harness.model.modelSettings.modelIssue)
    }
}

// MARK: - 界面即上下文预填

@MainActor
final class ComposerPrefillTests: XCTestCase {
    func testInsertComposerReferenceAppendsWithoutOverwriting() {
        let model = AppModel()

        model.insertComposerReference("  /abs/path/文件.swift 第 12–30 行（未暂存）  ")
        XCTAssertEqual(model.composerText, "/abs/path/文件.swift 第 12–30 行（未暂存）", "空草稿直接写入并去掉首尾空白")

        model.insertComposerReference("/abs/other.md（已暂存 +1 −1）")
        XCTAssertTrue(
            model.composerText.hasSuffix("/abs/other.md（已暂存 +1 −1）"),
            "已有内容以分隔追加，不覆盖"
        )
        XCTAssertTrue(model.composerText.contains("\n\n"))

        let before = model.composerText
        model.insertComposerReference("   ")
        XCTAssertEqual(model.composerText, before, "空白引用被忽略")

        model.insertComposerReference("验证证据：npm test（成功，revision 待补）")
        XCTAssertEqual(model.workbenchDestination, .workspace, "预填把工作台带回对话页")
        XCTAssertEqual(model.workspaceTabSelection, .conversation)
    }
}
