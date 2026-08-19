import SwiftUI
import XCTest
import ViewInspector
@testable import PiDCode

/// 关键界面组件的真实宿主渲染冒烟 + 环境无关视图的结构断言。
/// 状态断言由 Fake-host 集成测试负责，这里验证“关键状态可渲染、不崩”。
@MainActor
final class ConversationRenderTests: XCTestCase {
    func testConversationRoundRailRendersNavigationItems() {
        let items = [
            ConversationNavigationItem(
                id: "round-1",
                anchorID: "anchor-1",
                questionPreview: "第一轮问题",
                answerPreview: "第一轮回答",
                hasError: false
            ),
            ConversationNavigationItem(
                id: "round-2",
                anchorID: "anchor-2",
                questionPreview: "第二轮问题",
                answerPreview: "第二轮回答",
                hasError: true
            ),
        ]
        let sut = ConversationRoundRail(items: items, currentID: "round-1") { _ in }

        let host = NSHostingView(rootView: sut.frame(width: 64, height: 480))
        host.layoutSubtreeIfNeeded()

        XCTAssertFalse(host.fittingSize == .zero)
    }

    func testConversationViewRendersRoundsAndStreamingState() {
        let model = AppModel()
        model.selectedSessionID = "session-render"
        model.conversationRounds = [
            ConversationRound(
                id: "round-1",
                user: TranscriptItem(
                    id: "user-1",
                    role: .user,
                    timestamp: Date(timeIntervalSince1970: 1_800_000_000),
                    blocks: [.text(id: "user-text", value: "渲染问题")]
                ),
                processItems: [],
                finalAssistant: TranscriptItem(
                    id: "assistant-1",
                    role: .assistant,
                    timestamp: Date(timeIntervalSince1970: 1_800_000_010),
                    blocks: [.text(id: "assistant-text", value: "渲染回答")]
                ),
                startedAt: Date(timeIntervalSince1970: 1_800_000_000),
                completedAt: Date(timeIntervalSince1970: 1_800_000_010),
                toolCount: 0,
                hasError: false,
                totalTokens: 1_280,
                entryIDs: ["user-1", "assistant-1"],
                processEntryIDs: []
            ),
        ]
        model.isStreaming = true
        model.streamingText = "正在生成的回答……"
        model.streamingThinking = "思考中……"

        let host = NSHostingView(
            rootView: ConversationView().environment(model).frame(width: 900, height: 640)
        )
        host.layoutSubtreeIfNeeded()

        XCTAssertFalse(host.fittingSize == .zero)
    }

    func testComposerViewRendersWithActiveRunAndQueueMode() {
        let model = AppModel()
        model.selectedSessionID = "session-render"
        model.composerText = "运行中输入的新消息"
        model.activity.currentRunState = SessionRunState(
            sessionID: "session-render",
            runID: "run-render",
            phase: .running,
            waitingFor: nil,
            startedAt: "2026-08-18T08:00:00.000Z",
            updatedAt: "2026-08-18T08:00:01.000Z",
            completionID: nil,
            completionEntryID: nil,
            completedAt: nil,
            inputPersisted: true,
            retryable: false
        )
        model.isStreaming = true
        XCTAssertTrue(model.shouldQueueComposerText, "运行中应进入排队提交模式")

        let host = NSHostingView(
            rootView: ComposerView().environment(model).frame(width: 900, height: 200)
        )
        host.layoutSubtreeIfNeeded()

        XCTAssertFalse(host.fittingSize == .zero)
    }

    func testModelSettingsViewRendersWithSnapshot() throws {
        let model = AppModel()
        model.modelSettings.snapshot = try JSONDecoder().decode(
            ModelSettingsSnapshot.self,
            from: Data("""
            {"cwd":"/tmp/render","providers":[],
             "global":{"enabledModels":[],"unrestricted":false,
                       "defaultProvider":null,"defaultModelId":null,
                       "defaultInScope":null,"diagnostics":[]},
             "effective":{"enabledModels":[],"unrestricted":false,
                          "defaultProvider":null,"defaultModelId":null,
                          "defaultInScope":null,"diagnostics":[]},
             "projectOverrides":{"enabledModels":false,"defaultModel":false},
             "settingsErrors":[],"cacheInvalid":false,
             "refresh":{"attempted":false,"aborted":false,"failed":false,"networkDisabled":false}}
            """.utf8)
        )

        let host = NSHostingView(
            rootView: ModelSettingsView().environment(model).frame(width: 760, height: 560)
        )
        host.layoutSubtreeIfNeeded()

        XCTAssertFalse(host.fittingSize == .zero)
    }
}
