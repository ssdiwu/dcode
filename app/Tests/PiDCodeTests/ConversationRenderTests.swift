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

    // MARK: - 轮次折叠态逐步摘要

    private func thinkingItem(
        id: String,
        started: Date,
        duration: TimeInterval
    ) -> TranscriptItem {
        TranscriptItem(
            id: id,
            role: .assistant,
            timestamp: started,
            persistedAt: started.addingTimeInterval(duration),
            blocks: [.thinking(id: "\(id)-thinking", value: "…")]
        )
    }

    private func toolItems(
        id: String,
        name: String,
        argumentsJSON: String,
        resultContent: String = "",
        resultDetails: String? = nil,
        isError: Bool = false,
        at date: Date = Date(timeIntervalSince1970: 1_800_000_000)
    ) -> [TranscriptItem] {
        [
            TranscriptItem(
                id: "\(id)-call",
                role: .assistant,
                timestamp: date,
                blocks: [.toolCall(id: id, value: ToolCallPresentation(
                    id: id,
                    name: name,
                    arguments: argumentsJSON
                ))]
            ),
            TranscriptItem(
                id: "\(id)-result",
                role: .tool,
                timestamp: date,
                blocks: [.toolResult(id: id, value: ToolResultPresentation(
                    id: id,
                    name: name,
                    content: resultContent,
                    details: resultDetails,
                    isError: isError
                ))]
            ),
        ]
    }

    func testStepSummariesMergeAdjacentExploreAndShowEditDiff() {
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        var items: [TranscriptItem] = []
        items.append(thinkingItem(id: "t1", started: base, duration: 4))
        items += toolItems(id: "r1", name: "read", argumentsJSON: #"{"path":"/repo/a.swift"}"#)
        items += toolItems(id: "r2", name: "ls", argumentsJSON: #"{"path":"/repo"}"#)
        items += toolItems(id: "r3", name: "read", argumentsJSON: #"{"path":"/repo/b.swift"}"#)
        items += toolItems(
            id: "e1",
            name: "edit",
            argumentsJSON: #"{"input":"[/repo/doc/决策档案/0019.md#ABCD1234]\nINS.HEAD:\n…"}"#,
            resultContent: "Updated /repo/doc/决策档案/0019.md",
            resultDetails: #"{"diff":"+1 line\n-1 line"}"#
        )

        let summaries = ConversationStepSummarizer.summaries(for: items)

        XCTAssertEqual(summaries.count, 3)
        XCTAssertEqual(summaries[0].text, "思考过程")
        XCTAssertEqual(summaries[0].detail, "持续了 4 秒")
        XCTAssertEqual(summaries[0].systemImage, "brain")
        XCTAssertEqual(summaries[1].text, "探索 · 3 文件", "相邻读取合并并按去重路径计数")
        XCTAssertEqual(summaries[2].text, "已编辑 0019.md")
        XCTAssertEqual(summaries[2].detail, "决策档案 +1 −1")
        XCTAssertFalse(summaries[2].isError)
    }

    func testStepSummariesSeparateDifferentEditTargetsAndMarkFailure() {
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        var items: [TranscriptItem] = []
        items += toolItems(
            id: "e1",
            name: "edit",
            argumentsJSON: #"{"input":"[/repo/a.md#ABCD1234]\nINS.HEAD:\n…"}"#,
            resultContent: "Updated /repo/a.md"
        )
        items += toolItems(
            id: "e2",
            name: "edit",
            argumentsJSON: #"{"input":"[/repo/b.md#ABCD1234]\nINS.HEAD:\n…"}"#,
            resultContent: "Updated /repo/b.md",
            isError: true
        )

        let summaries = ConversationStepSummarizer.summaries(for: items)

        XCTAssertEqual(summaries.count, 2, "不同目标文件的编辑不合并")
        XCTAssertFalse(summaries[0].isError)
        XCTAssertTrue(summaries[1].isError)
        XCTAssertEqual(summaries[1].text, "已编辑 b.md（失败）")
    }

    func testStepSummariesPreserveThinkingBetweenToolGroupsAndCapLines() {
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        var items: [TranscriptItem] = []
        items += toolItems(id: "r1", name: "read", argumentsJSON: #"{"path":"/repo/a.swift"}"#)
        items.append(thinkingItem(id: "t1", started: base, duration: 1))
        items += toolItems(id: "b1", name: "bash", argumentsJSON: #"{"command":"npm test"}"#)
        for index in 0..<10 {
            items += toolItems(
                id: "w\(index)",
                name: "write",
                argumentsJSON: #"{"path":"/repo/file\#(index).md"}"#,
                resultDetails: #"{"lines":12}"#
            )
        }

        let summaries = ConversationStepSummarizer.summaries(for: items)

        XCTAssertEqual(summaries.count, ConversationStepSummarizer.maximumVisibleLines, "超过上限时截断并给出剩余步数")
        XCTAssertEqual(summaries.first?.text, "探索 · 1 文件")
        XCTAssertEqual(summaries[1].text, "思考过程")
        XCTAssertEqual(summaries[1].detail, "持续了 1 秒")
        XCTAssertEqual(summaries[2].text, "运行命令")
        XCTAssertEqual(summaries[2].detail, "npm test")
        XCTAssertEqual(summaries[3].text, "已创建 file0.md · 12 行")
        XCTAssertEqual(summaries.last?.text, "另有 6 步")
        XCTAssertEqual(summaries.last?.systemImage, "ellipsis")
    }
}

@MainActor
final class ResourcesSettingsRenderTests: XCTestCase {
    /// 0.0.17：Prompt 模板的 argumentHint 随 commands 合同进入 Composer 预填
    /// （0.0.16 审计 P1——此前 hint 在 Host 投影时丢失，只剩 `/<name> `）。
    func testResourceCommandEntryCarriesArgumentHintIntoComposerPrefill() throws {
        let decoder = JSONDecoder()
        let promptCommand = try decoder.decode(ResourceCommandEntry.self, from: Data("""
        {"name":"review","description":"代码评审","source":"prompt","argumentHint":"目标"}
        """.utf8))
        XCTAssertEqual(promptCommand.composerInvocationText, "/review <目标>")

        let plainCommand = try decoder.decode(ResourceCommandEntry.self, from: Data("""
        {"name":"dgoal","description":null,"source":"extension","argumentHint":null}
        """.utf8))
        XCTAssertEqual(plainCommand.composerInvocationText, "/dgoal ")

        let legacyCommand = try decoder.decode(ResourceCommandEntry.self, from: Data("""
        {"name":"dgoal","description":null,"source":"extension"}
        """.utf8))
        XCTAssertEqual(legacyCommand.composerInvocationText, "/dgoal ", "缺 argumentHint 的旧快照按无提示解码")
    }

    func testResourcesSettingsPageRendersSnapshotStates() {
        let model = AppModel()
        model.resources.snapshot = ResourcesListResult(
            packages: [
                ResourcePackageEntry(source: "npm:pi-mcp-adapter", kind: "npm", enabled: true),
                ResourcePackageEntry(source: "../../pi-dgoal", kind: "path", enabled: false),
            ],
            extensions: [
                ResourceExtensionEntry(
                    name: "pi-dgoal",
                    path: "/tmp/pi-dgoal/index.ts",
                    source: "package",
                    toolCount: 1,
                    commandCount: 2
                ),
            ],
            skills: [
                ResourceSkillEntry(
                    name: "llm-wiki",
                    description: "知识库",
                    source: "package",
                    filePath: "/tmp/skills/llm-wiki/SKILL.md",
                    disableModelInvocation: false
                ),
            ],
            prompts: [],
            commands: [],
            diagnostics: [ResourceDiagnosticEntry(message: "/tmp/broken.ts: syntax error")]
        )

        let host = NSHostingView(
            rootView: ResourcesSettingsView().environment(model).frame(width: 640, height: 720)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero, "快照态必须完成布局")
    }

    func testResourcesSettingsPageRendersLoadingState() {
        let model = AppModel()
        model.resources.isLoading = true

        let host = NSHostingView(
            rootView: ResourcesSettingsView().environment(model).frame(width: 640, height: 480)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero, "加载态必须完成布局")
    }
}

@MainActor
final class CustomProvidersRenderTests: XCTestCase {
    func testProviderResultDecodesOkAndFieldErrors() throws {
        let ok = try JSONDecoder().decode(ModelProviderSaveResult.self, from: Data("""
        {"ok":true,"providers":[],"parseError":null}
        """.utf8))
        XCTAssertEqual(ok.ok, true)
        XCTAssertEqual(ok.providers?.count, 0)

        let rejected = try JSONDecoder().decode(ModelProviderSaveResult.self, from: Data("""
        {"ok":false,"providers":null,"parseError":null,
         "errors":[{"field":"baseUrl","message":"baseUrl 必须是 http(s) URL"},
                   {"field":"models[0].id","message":"模型 id 不能为空或包含空白"}]}
        """.utf8))
        XCTAssertEqual(rejected.ok, false)
        XCTAssertEqual(rejected.errors?.count, 2)
        XCTAssertEqual(rejected.errors?.first?.field, "baseUrl")
    }

    func testCustomProvidersPageRendersSnapshotAndParseError() {
        let model = AppModel()
        model.modelProviders.snapshot = ModelProviderListResult(
            path: "/tmp/agent/models.json",
            parseError: nil,
            providers: [
                ModelProviderView(
                    id: "my-relay",
                    name: "Relay",
                    baseUrl: "https://relay.example/v1",
                    api: nil,
                    authMode: "apiKey",
                    authConfigured: true,
                    headerKeys: ["X-Org"],
                    models: [
                        ModelProviderModelView(
                            id: "m1", name: "M1", api: nil, baseUrl: nil,
                            reasoning: true, contextWindow: 128_000, maxTokens: 16_384
                        ),
                    ],
                    compatJson: nil
                ),
            ]
        )

        let host = NSHostingView(
            rootView: CustomProvidersSettingsView().environment(model).frame(width: 640, height: 560)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero)

        model.modelProviders.snapshot = ModelProviderListResult(
            path: "/tmp/agent/models.json",
            parseError: "Invalid models.json schema",
            providers: []
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero, "解析错误态必须完成布局")
    }
}

@MainActor
final class ContextPopoverRenderTests: XCTestCase {
    func testCompactionInfoDecodesAndPopoverStatesRender() throws {
        let info = try JSONDecoder().decode(CompactionInfoResult.self, from: Data("""
        {"enabled":true,"reserveTokens":16384,"keepRecentTokens":20000}
        """.utf8))
        XCTAssertEqual(info.reserveTokens, 16384)

        let model = AppModel()
        model.selectedSessionID = "session-render"
        model.hostState = HostState(
            mode: "writable",
            sessionId: "session-render",
            sessionFile: "/tmp/s.jsonl",
            sessionName: nil,
            cwd: "/tmp",
            model: nil,
            thinkingLevel: "medium",
            activePlan: nil,
            isStreaming: false,
            runState: nil,
            pendingMessageCount: 0,
            contextUsage: ContextUsage(
                tokens: 307_200,
                contextWindow: 400_000,
                percent: 77
            ),
            fastMode: nil,
            writable: true,
            conflict: nil,
            isCompacting: nil
        )
        model.compactionInfo = info

        let host = NSHostingView(
            rootView: ComposerView().environment(model).frame(width: 760, height: 300)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero, "上下文弹层改版后 Composer 必须完成布局")
    }
}
