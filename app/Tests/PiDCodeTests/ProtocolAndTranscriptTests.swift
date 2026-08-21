import AppKit
import Foundation
import XCTest
@testable import PiDCode

@MainActor
final class ProtocolAndTranscriptTests: XCTestCase {
    func testProtocolCodecDecodesResponseAndEvent() throws {
        let response = try HostProtocolCodec.decode(line: #"{"version":1,"type":"response","id":"r1","method":"host.hello","ok":true,"result":{"protocolVersion":1}}"#)
        XCTAssertEqual(response, .response(
            id: "r1",
            method: "host.hello",
            result: .object(["protocolVersion": .number(1)])
        ))

        let event = try HostProtocolCodec.decode(line: #"{"version":1,"type":"event","event":"session.event","data":{"type":"agent_start"}}"#)
        XCTAssertEqual(event, .event(HostEvent(
            name: "session.event",
            data: .object(["type": .string("agent_start")])
        )))
    }

    func testProtocolCodecRetainsStructuredHostFailure() throws {
        let message = try HostProtocolCodec.decode(line: #"{"version":1,"type":"response","id":"r2","method":"session.open","ok":false,"error":{"code":"SESSION_IN_USE","message":"session already has a lease","details":{"sessionId":"s1"}}}"#)
        XCTAssertEqual(message, .failure(
            id: "r2",
            method: "session.open",
            error: HostErrorPayload(
                code: "SESSION_IN_USE",
                message: "session already has a lease",
                details: .object(["sessionId": .string("s1")])
            )
        ))
    }

    func testSessionLeaseFailuresHaveActionableLocalizedDescriptions() {
        let inUse = PiHostClientError.hostFailure(HostErrorPayload(
            code: "SESSION_IN_USE",
            message: "Session already has a lease",
            details: nil
        ))
        XCTAssertEqual(
            inUse.localizedDescription,
            "这个会话正在另一个 D Code 进程中使用。请关闭那个窗口，稍候再试。"
        )

        let externalWrite = PiHostClientError.hostFailure(HostErrorPayload(
            code: "EXTERNAL_WRITE_DETECTED",
            message: "Session changed",
            details: nil
        ))
        XCTAssertTrue(externalWrite.localizedDescription.contains("已停止写入以保护会话"))

        let restartRequired = PiHostClientError.hostFailure(HostErrorPayload(
            code: "HOST_RESTART_REQUIRED",
            message: "Runtime did not stop cleanly",
            details: nil
        ))
        XCTAssertTrue(restartRequired.localizedDescription.contains("重新打开 D Code"))

        let identityChanged = PiHostClientError.hostFailure(HostErrorPayload(
            code: "SESSION_IDENTITY_CHANGED",
            message: "Session identity changed",
            details: nil
        ))
        XCTAssertTrue(identityChanged.localizedDescription.contains("保留上一次完整历史"))

        let staleSearchResult = PiHostClientError.hostFailure(HostErrorPayload(
            code: "SEARCH_TARGET_STALE",
            message: "The search result is stale",
            details: nil
        ))
        XCTAssertEqual(
            staleSearchResult.localizedDescription,
            "这条搜索结果已不在当前会话路径中。搜索窗口已保留，请刷新结果后重试。"
        )

        let hasDescendants = PiHostClientError.hostFailure(HostErrorPayload(
            code: "SESSION_HAS_DESCENDANTS",
            message: "The session has descendants",
            details: nil
        ))
        XCTAssertTrue(hasDescendants.localizedDescription.contains("请改用归档"))

        let restoreFailed = PiHostClientError.hostFailure(HostErrorPayload(
            code: "SESSION_TRASH_RESTORE_FAILED",
            message: "The preserved session could not be restored",
            details: nil
        ))
        XCTAssertTrue(restoreFailed.localizedDescription.contains("仍被完整保留"))
    }

    func testRequestEncodingIsOneJSONLine() throws {
        let data = try HostProtocolCodec.encodeRequest(
            id: "mac-1",
            method: "session.prompt",
            params: ["message": .string("hello\nworld"), "promptId": .string("prompt-1")]
        )
        XCTAssertEqual(data.last, 0x0A)
        XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["method"] as? String, "session.prompt")
    }

    func testPromptCompletionAndFailureStayScopedToTheMatchingSessionDraft() {
        let model = AppModel()
        model.pendingPrompt = PendingPromptDraft(sessionID: "session-a", promptID: "prompt-a", draft: "已发送内容")
        model.selectedSessionID = "session-b"
        model.composerText = "B 的新草稿"

        model.handle(HostEvent(
            name: "session.conflict",
            data: .object(["sessionId": .string("session-b")])
        ))
        XCTAssertEqual(model.composerText, "B 的新草稿")
        XCTAssertEqual(model.pendingPrompt, PendingPromptDraft(
            sessionID: "session-a",
            promptID: "prompt-a",
            draft: "已发送内容"
        ))

        model.handle(HostEvent(
            name: "session.promptCompleted",
            data: .object([
                "sessionId": .string("session-a"),
                "promptId": .string("prompt-a"),
            ])
        ))
        XCTAssertNil(model.pendingPrompt)

        model.pendingPrompt = PendingPromptDraft(sessionID: "session-b", promptID: "prompt-b", draft: "未完成输入")
        model.handle(HostEvent(
            name: "session.promptFailed",
            data: .object([
                "sessionId": .string("session-b"),
                "promptId": .string("prompt-b"),
                "message": .string("运行失败"),
            ])
        ))
        XCTAssertEqual(model.composerText, "未完成输入\n\nB 的新草稿")
        XCTAssertNil(model.pendingPrompt)

        model.handle(HostEvent(
            name: "session.conflict",
            data: .object(["sessionId": .string("session-b")])
        ))
        XCTAssertEqual(model.composerText, "未完成输入\n\nB 的新草稿")
    }

    func testTranscriptParserPreservesThinkingToolsAndErrors() throws {
        let source = #"""
        [
          {"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"Run tests","timestamp":1000}},
          {"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Need inspect"},{"type":"text","text":"I will run them."},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"npm test"}}],"timestamp":2000,"errorMessage":"provider warning"}},
          {"type":"message","id":"t2","parentId":"a1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"32 passed"}],"details":{"exitCode":0},"isError":false,"timestamp":3000}}
        ]
        """#
        let entries = try JSONDecoder().decode([JSONValue].self, from: Data(source.utf8))
        let transcript = TranscriptParser.parse(entries: entries)
        XCTAssertEqual(transcript.map(\.role), [.user, .assistant, .tool])
        XCTAssertEqual(transcript[1].blocks.count, 4)
        guard case let .toolCall(_, call) = transcript[1].blocks[2] else {
            return XCTFail("Expected tool call block")
        }
        XCTAssertEqual(call.name, "bash")
        XCTAssertTrue(call.arguments.contains("npm test"))
        guard case let .toolResult(_, result) = transcript[2].blocks[0] else {
            return XCTFail("Expected tool result block")
        }
        XCTAssertEqual(result.content, "32 passed")
        XCTAssertFalse(result.isError)
        XCTAssertEqual(
            transcript[0].persistedAt,
            try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse("2026-01-01T00:00:00.000Z")
        )
        XCTAssertEqual(transcript[0].timestamp, Date(timeIntervalSince1970: 1))
    }

    func testTranscriptParserPromotesSupportedPiImageBlocksWithoutCopyingThem() throws {
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        let entry: JSONValue = .object([
            "type": .string("message"),
            "id": .string("assistant-image"),
            "timestamp": .string("2026-01-01T00:00:00.000Z"),
            "message": .object([
                "role": .string("assistant"),
                "content": .array([
                    .object([
                        "type": .string("image"),
                        "data": .string(encoded),
                        "mimeType": .string("image/png"),
                    ]),
                ]),
                "timestamp": .number(1_000),
            ]),
        ])

        let blocks = try XCTUnwrap(TranscriptParser.parse(entries: [entry]).first?.blocks)
        XCTAssertEqual(blocks.count, 1)
        guard case let .image(_, image) = blocks[0] else {
            return XCTFail("Expected a Pi image block")
        }
        XCTAssertEqual(image.mimeType, "image/png")
        XCTAssertEqual(image.pixelWidth, 1)
        XCTAssertEqual(image.pixelHeight, 1)
        XCTAssertEqual(image.data.base64EncodedString(), encoded)
    }

    func testTranscriptParserKeepsToolResultTextAndPromotesItsImage() throws {
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        let entry: JSONValue = .object([
            "type": .string("message"),
            "id": .string("tool-image"),
            "timestamp": .string("2026-01-01T00:00:00.000Z"),
            "message": .object([
                "role": .string("toolResult"),
                "toolCallId": .string("call-image"),
                "toolName": .string("view_image"),
                "content": .array([
                    .object(["type": .string("text"), "text": .string("已查看图片")]),
                    .object([
                        "type": .string("image"),
                        "data": .string(encoded),
                        "mimeType": .string("image/png"),
                    ]),
                ]),
                "isError": .bool(false),
                "timestamp": .number(1_000),
            ]),
        ])

        let blocks = try XCTUnwrap(TranscriptParser.parse(entries: [entry]).first?.blocks)
        XCTAssertEqual(blocks.count, 2)
        guard case let .toolResult(_, result) = blocks[0] else {
            return XCTFail("Expected the tool result summary first")
        }
        XCTAssertEqual(result.content, "已查看图片")
        guard case .image = blocks[1] else {
            return XCTFail("Expected the structured image after the tool result")
        }
    }

    func testTranscriptParserFallsBackSafelyForInvalidOrUnsupportedPiImages() throws {
        let content: JSONValue = .array([
            .object([
                "type": .string("image"),
                "data": .string("not-base64"),
                "mimeType": .string("image/png"),
            ]),
            .object([
                "type": .string("image"),
                "data": .string("aGVsbG8="),
                "mimeType": .string("image/svg+xml"),
            ]),
        ])
        let entry: JSONValue = .object([
            "type": .string("message"),
            "id": .string("assistant-invalid-images"),
            "timestamp": .string("2026-01-01T00:00:00.000Z"),
            "message": .object([
                "role": .string("assistant"),
                "content": content,
                "timestamp": .number(1_000),
            ]),
        ])

        let blocks = try XCTUnwrap(TranscriptParser.parse(entries: [entry]).first?.blocks)
        XCTAssertEqual(blocks.count, 2)
        for block in blocks {
            guard case let .attachment(_, label) = block else {
                return XCTFail("Invalid image data must remain a safe placeholder")
            }
            XCTAssertEqual(label, "无法显示图片")
        }
    }

    func testAboutMetadataUsesBundleVersionAndCanonicalGitHubLinks() {
        XCTAssertEqual(
            AboutAppMetadata.versionText(infoDictionary: [
                "CFBundleShortVersionString": "0.0.13",
                "CFBundleVersion": "7",
            ]),
            "版本 0.0.13（7）"
        )
        XCTAssertEqual(AboutAppMetadata.versionText(infoDictionary: [:]), "版本未知")
        XCTAssertEqual(AboutAppMetadata.authorURL.absoluteString, "https://github.com/ssdiwu")
        XCTAssertEqual(AboutAppMetadata.projectURL.absoluteString, "https://github.com/ssdiwu/dcode")
    }

    func testModelSettingsSnapshotKeepsCatalogScopeAndRuleIdentitySeparate() throws {
        let source = #"""
        {
          "cwd":"/tmp/project",
          "providers":[{
            "id":"openai",
            "name":"OpenAI",
            "auth":{"configured":true,"source":"auth.json","methods":[{"type":"api_key","label":"OpenAI API key","interactive":true}]},
            "catalog":{"kind":"cached","checkedAt":"2026-08-16T10:00:00.000Z","lastModified":null,"refreshFailed":false},
            "models":[{
              "model":{"provider":"openai","id":"gpt-test","name":"GPT Test","contextWindow":128000},
              "globalEnabled":true,
              "enabled":false,
              "globalMatchedPatterns":["openai/gpt-*"],
              "matchedPatterns":[]
            }]
          }],
          "global":{"enabledModels":["openai/gpt-*"],"unrestricted":false,"defaultProvider":"openai","defaultModelId":"gpt-test","defaultInScope":true,"diagnostics":[]},
          "effective":{"enabledModels":["xai/*"],"unrestricted":false,"defaultProvider":"openai","defaultModelId":"gpt-test","defaultInScope":false,"diagnostics":[]},
          "projectOverrides":{"enabledModels":true,"defaultModel":false},
          "settingsErrors":[],
          "cacheInvalid":false,
          "refresh":{"attempted":false,"aborted":false,"failed":false,"networkDisabled":false}
        }
        """#
        let snapshot = try JSONDecoder().decode(ModelSettingsSnapshot.self, from: Data(source.utf8))

        XCTAssertEqual(snapshot.globalDefaultModel?.model.qualifiedName, "openai/gpt-test")
        XCTAssertEqual(snapshot.selectableDefaultModels.map(\.id), ["openai/gpt-test"])
        XCTAssertTrue(snapshot.projectOverrides.isActive)
        XCTAssertTrue(snapshot.providers[0].models[0].globalEnabled)
        XCTAssertEqual(snapshot.providers[0].auth.availableMethods.map(\.type), ["api_key"])
        XCTAssertFalse(snapshot.providers[0].models[0].enabled)
        XCTAssertFalse(snapshot.providers[0].models[0].isExactlyEnabled)
        XCTAssertFalse(snapshot.providers[0].models[0].canRemoveExactRule)

        let hostModel = snapshot.providers[0].models[0].model
        let exactOnly = ModelSettingsModel(
            model: hostModel,
            globalEnabled: true,
            enabled: true,
            globalMatchedPatterns: [hostModel.qualifiedName],
            matchedPatterns: [hostModel.qualifiedName]
        )
        let overlapping = ModelSettingsModel(
            model: hostModel,
            globalEnabled: true,
            enabled: true,
            globalMatchedPatterns: [hostModel.qualifiedName, "openai/gpt-*"],
            matchedPatterns: [hostModel.qualifiedName, "openai/gpt-*"]
        )
        XCTAssertTrue(exactOnly.canRemoveExactRule)
        XCTAssertFalse(overlapping.canRemoveExactRule)

        let exact = ModelSettingsRulePolicy.addingExactModel(
            snapshot.providers[0].models[0],
            to: [" openai/gpt-* ", "openai/gpt-*"]
        )
        XCTAssertEqual(exact, ["openai/gpt-*", "openai/gpt-test"])
        XCTAssertEqual(
            ModelSettingsRulePolicy.removingExactModel(snapshot.providers[0].models[0], from: exact),
            ["openai/gpt-*"]
        )

        XCTAssertEqual(
            ModelSettingsRefreshState(
                attempted: true,
                aborted: true,
                failed: false,
                networkDisabled: false
            ).statusMessage,
            "目录刷新超时或已中止，已保留刷新前目录。"
        )
        XCTAssertEqual(
            ModelSettingsRefreshState(
                attempted: true,
                aborted: false,
                failed: true,
                networkDisabled: false
            ).statusMessage,
            "目录刷新失败，已保留刷新前目录；可稍后重试。"
        )

        let authPrompt = ModelAuthPrompt(data: .object([
            "flowId": .string("flow-1"),
            "requestId": .string("request-1"),
            "prompt": .object([
                "type": .string("secret"),
                "message": .string("输入 API Key"),
                "placeholder": .string("sk-…"),
            ]),
        ]))
        XCTAssertEqual(authPrompt?.type, "secret")
        XCTAssertEqual(authPrompt?.placeholder, "sk-…")
        let authEvent = ModelAuthEventPresentation(data: .object([
            "event": .object([
                "type": .string("auth_url"),
                "url": .string("https://example.com/login"),
                "instructions": .string("在浏览器中继续"),
            ]),
        ]))
        XCTAssertEqual(authEvent?.url, "https://example.com/login")
        XCTAssertEqual(authEvent?.message, "在浏览器中继续")
        let unsafeAuthPrompt = ModelAuthPrompt(data: .object([
            "flowId": .string("flow-unsafe"),
            "requestId": .string("request-unsafe"),
            "prompt": .object([
                "type": .string("text"),
                "message": .string("authorization: Bearer abc.def"),
                "placeholder": .string("api_key=topsecret"),
            ]),
        ]))
        XCTAssertFalse(unsafeAuthPrompt?.message.contains("abc.def") == true)
        XCTAssertFalse(unsafeAuthPrompt?.placeholder?.contains("topsecret") == true)
        let unsafeAuthEvent = ModelAuthEventPresentation(data: .object([
            "event": .object([
                "type": .string("progress"),
                "message": .string("access_token=secret-value"),
            ]),
        ]))
        XCTAssertFalse(unsafeAuthEvent?.message?.contains("secret-value") == true)
    }

    func testConversationRoundHidesIntermediateWorkAndKeepsFinalAnswer() throws {
        let source = #"""
        [
          {"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T10:00:00.000Z","message":{"role":"user","content":"检查项目","timestamp":1767261600000}},
          {"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先读取"},{"type":"text","text":"我先检查。"},{"type":"toolCall","id":"call-read","name":"read","arguments":{"path":"README.md"}}],"stopReason":"toolUse","usage":{"input":1000,"output":50,"totalTokens":1050},"timestamp":1767261601000}},
          {"type":"message","id":"r1","parentId":"a1","timestamp":"2026-01-01T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"call-read","toolName":"read","content":[{"type":"text","text":"[README.md#A1B2C3D4]\\n1:# D Code"}],"isError":false,"timestamp":1767261603000}},
          {"type":"message","id":"a2","parentId":"r1","timestamp":"2026-01-01T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"已经确认"},{"type":"text","text":"项目状态正常。"}],"stopReason":"stop","usage":{"input":1200,"output":80,"totalTokens":1280},"timestamp":1767261604000}}
        ]
        """#
        let entries = try JSONDecoder().decode([JSONValue].self, from: Data(source.utf8))
        let rounds = ConversationRoundProjector.project(TranscriptParser.parse(entries: entries))

        let round = try XCTUnwrap(rounds.first)
        XCTAssertEqual(round.user?.id, "u1")
        XCTAssertEqual(round.finalAssistant?.id, "a2")
        XCTAssertEqual(round.finalAssistant?.plainText, "项目状态正常。")
        XCTAssertEqual(round.processItems.map(\.id), ["a1", "r1", "a2-process"])
        XCTAssertFalse(round.entryIDs.contains("a2-process"))
        XCTAssertEqual(round.toolCount, 1)
        XCTAssertEqual(round.totalTokens, 2_330)
        XCTAssertEqual(try XCTUnwrap(round.duration), 5, accuracy: 0.001)
        XCTAssertEqual(ConversationTimingFormatter.durationText(round.duration), "5 秒")
    }

    func testConversationRoundRejectsInvalidUsageAndDoesNotTreatRecoveredToolErrorsAsFinalFailure() {
        let user = TranscriptItem(
            id: "user",
            role: .user,
            timestamp: Date(timeIntervalSince1970: 0),
            blocks: [.text(id: "user-text", value: "run")]
        )
        let invalidUsage = AssistantUsage.parse(.object([
            "input": .number(-1),
            "totalTokens": .number(-20),
        ]))
        XCTAssertNil(invalidUsage)
        XCTAssertNil(AssistantUsage.parse(.object([
            "totalTokens": .number(1e100),
        ])))

        let toolFailure = TranscriptItem(
            id: "tool",
            role: .tool,
            timestamp: Date(timeIntervalSince1970: 1),
            blocks: [.toolResult(
                id: "tool-result",
                value: ToolResultPresentation(
                    id: "call",
                    name: "read",
                    content: "temporary failure",
                    details: nil,
                    isError: true
                )
            )]
        )
        let intermediate = TranscriptItem(
            id: "assistant-intermediate",
            role: .assistant,
            timestamp: Date(timeIntervalSince1970: 2),
            blocks: [.toolCall(
                id: "call",
                value: ToolCallPresentation(id: "call", name: "read", arguments: "{}")
            )],
            assistantStopReason: "toolUse",
            assistantUsage: AssistantUsage(
                input: nil,
                output: nil,
                cacheRead: nil,
                cacheWrite: nil,
                totalTokens: Int.max
            )
        )
        let final = TranscriptItem(
            id: "assistant-final",
            role: .assistant,
            timestamp: Date(timeIntervalSince1970: 3),
            blocks: [.text(id: "answer", value: "recovered")],
            assistantStopReason: "stop",
            assistantUsage: AssistantUsage(
                input: nil,
                output: nil,
                cacheRead: nil,
                cacheWrite: nil,
                totalTokens: 1
            )
        )

        let round = ConversationRoundProjector.project([user, toolFailure, intermediate, final]).first
        XCTAssertTrue(round?.hasError == true)
        XCTAssertFalse(round?.finalAssistantFailed == true)
        XCTAssertNil(round?.totalTokens)
    }

    func testMarkdownPresentationPreservesParagraphsAndListMarkers() {
        let source = """
        第一段。

        **链接已重建：**
        - 第一项
        - 第二项

        **两点提示：**
        1. 甲
        2. 乙
        """

        let presented = MarkdownPresentation.attributedString(for: source)
        let characters = String(presented.characters)

        XCTAssertTrue(characters.contains("第一段。\n\n链接已重建：\n- 第一项\n- 第二项"))
        XCTAssertTrue(characters.contains("\n\n两点提示：\n1. 甲\n2. 乙"))

        let inline = MarkdownPresentation.attributedString(
            for: "**粗体** [链接](https://example.com) `代码`"
        )
        let runs = inline.runs.map { run in
            (
                text: String(inline[run.range].characters),
                intent: run.inlinePresentationIntent,
                link: run.link
            )
        }
        XCTAssertNotNil(runs.first(where: { $0.text == "粗体" })?.intent)
        XCTAssertEqual(runs.first(where: { $0.text == "链接" })?.link?.absoluteString, "https://example.com")
        XCTAssertNotNil(runs.first(where: { $0.text == "代码" })?.intent)
    }

    func testMarkdownDocumentBuildsNativeBlocksAndSanitizesLinks() throws {
        let source = """
        # 调查结论

        第一段包含 **粗体**、[网页](https://example.com)、[本地文件](file:///tmp/secret#L7) 和 [危险链接](javascript:alert(1))。

        - 第一项
          - 第二层

        1. 第一步
        2. 第二步

        > 注意事项

        ---

        | 名称 | 状态 |
        | :--- | ---: |
        | D Code | 完成 |
        """

        let document = MarkdownDocument.parse(source)
        XCTAssertFalse(document.usesPlainTextFallback)
        XCTAssertEqual(document.rawSource, source)

        let textBlocks = document.blocks.compactMap { block -> MarkdownTextBlock? in
            guard case let .text(text) = block else { return nil }
            return text
        }
        XCTAssertEqual(textBlocks.first?.style, .heading(level: 1))
        XCTAssertEqual(textBlocks.first?.plainText, "调查结论")
        XCTAssertTrue(textBlocks.contains(where: { $0.marker == "•" && $0.plainText == "第一项" }))
        XCTAssertTrue(textBlocks.contains(where: {
            $0.marker == "•" && $0.listDepth == 2 && $0.plainText == "第二层"
        }))
        XCTAssertTrue(textBlocks.contains(where: { $0.marker == "1." && $0.plainText == "第一步" }))
        XCTAssertTrue(textBlocks.contains(where: { $0.marker == "2." && $0.plainText == "第二步" }))
        XCTAssertTrue(textBlocks.contains(where: { $0.quoteDepth == 1 && $0.plainText == "注意事项" }))
        XCTAssertTrue(document.blocks.contains(where: { if case .rule = $0 { return true }; return false }))

        let paragraph = try XCTUnwrap(textBlocks.first(where: { $0.plainText.contains("第一段") }))
        let links = paragraph.content.runs.compactMap(\.link)
        XCTAssertEqual(links.first?.absoluteString, "https://example.com")
        let localTarget = try XCTUnwrap(links.dropFirst().first.flatMap(WorkspaceFileLink.decode))
        XCTAssertEqual(localTarget, WorkspaceFileLink.Target(path: "/tmp/secret", line: 7))
        XCTAssertEqual(links.count, 2)

        let adjacentChinese = MarkdownDocument.parse(
            "**API 模拟提交（form-submit）**对中文表单有字段映射限制"
        )
        let adjacentParagraph = try XCTUnwrap(adjacentChinese.blocks.compactMap { block -> MarkdownTextBlock? in
            guard case let .text(text) = block else { return nil }
            return text
        }.first)
        XCTAssertEqual(
            adjacentParagraph.plainText,
            "API 模拟提交（form-submit）对中文表单有字段映射限制"
        )
        XCTAssertTrue(adjacentParagraph.content.runs.contains(where: { run in
            String(adjacentParagraph.content[run.range].characters) == "API 模拟提交（form-submit）"
                && run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        }))

        let table = try XCTUnwrap(document.blocks.compactMap { block -> MarkdownTableBlock? in
            guard case let .table(table) = block else { return nil }
            return table
        }.first)
        XCTAssertEqual(table.rows.map { $0.cells.map { String($0.characters) } }, [
            ["名称", "状态"],
            ["D Code", "完成"],
        ])
        XCTAssertEqual(table.alignments, [.leading, .trailing])
        XCTAssertTrue(table.rows[0].isHeader)
    }

    func testMarkdownDocumentFallsBackWithoutDroppingUnsupportedOrOversizedSource() {
        let imageSource = "前文\n\n![预览](https://example.com/image.png)\n\n后文"
        let imageDocument = MarkdownDocument.parse(imageSource)
        XCTAssertTrue(imageDocument.usesPlainTextFallback)
        XCTAssertEqual(imageDocument.blocks, [.fallback(id: 0, source: imageSource)])

        let oversized = String(repeating: "a", count: MarkdownDocument.maximumRichTextBytes + 1)
        let oversizedDocument = MarkdownDocument.parse(oversized)
        XCTAssertTrue(oversizedDocument.usesPlainTextFallback)
        XCTAssertEqual(oversizedDocument.rawSource, oversized)
    }

    func testMarkdownDocumentNormalizesOnlyTheCJKStrongBoundaryOutsideInlineCode() throws {
        func paragraph(in source: String) throws -> MarkdownTextBlock {
            try XCTUnwrap(MarkdownDocument.parse(source).blocks.compactMap { block -> MarkdownTextBlock? in
                guard case let .text(text) = block else { return nil }
                return text
            }.first)
        }

        let cjkAdjacent = try paragraph(in: "**粗体（说明）**紧接中文")
        XCTAssertEqual(cjkAdjacent.plainText, "粗体（说明）紧接中文")
        XCTAssertTrue(cjkAdjacent.content.runs.contains(where: { run in
            String(cjkAdjacent.content[run.range].characters) == "粗体（说明）"
                && run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        }))

        let commonMarkControl = try paragraph(in: "**粗体（说明）** 紧接中文")
        XCTAssertEqual(commonMarkControl.plainText, "粗体（说明） 紧接中文")
        XCTAssertTrue(commonMarkControl.content.runs.contains(where: { run in
            run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        }))

        let inlineCode = try paragraph(in: "`**粗体（说明）**紧接中文`")
        XCTAssertEqual(inlineCode.plainText, "**粗体（说明）**紧接中文")
        XCTAssertFalse(inlineCode.content.runs.contains(where: { run in
            run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        }))

        let asciiAdjacent = try paragraph(in: "**bold!**next")
        XCTAssertEqual(asciiAdjacent.plainText, "**bold!**next")
        XCTAssertFalse(asciiAdjacent.content.runs.contains(where: { run in
            run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        }))

        let linked = try paragraph(in: "[链接](https://example.com/**foo（x）**中文)")
        XCTAssertEqual(linked.content.runs.compactMap(\.link).map(\.absoluteString), [
            "https://example.com/**foo%EF%BC%88x%EF%BC%89**%E4%B8%AD%E6%96%87",
        ])

        let validCommonMark = try paragraph(in: "a**! x!**中文**")
        XCTAssertEqual(validCommonMark.plainText, "a**! x!中文")
        XCTAssertTrue(validCommonMark.content.runs.contains(where: { run in
            String(validCommonMark.content[run.range].characters) == "中文"
                && run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        }))

        for source in [
            "**[链接](https://example.com)（说明）**中文",
            "**<https://example.com>（说明）**中文",
        ] {
            let linkedStrong = try paragraph(in: source)
            XCTAssertFalse(linkedStrong.plainText.contains("**"))
            XCTAssertTrue(linkedStrong.content.runs.contains(where: { run in
                run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
            }))
            XCTAssertEqual(linkedStrong.content.runs.compactMap(\.link).first?.absoluteString, "https://example.com")
            XCTAssertEqual(MarkdownDocument.parse(source).rawSource, source)
        }
    }

    func testConversationRoundDoesNotPromoteToolUseNarrationToFinalAnswer() {
        let user = TranscriptItem(
            id: "user",
            role: .user,
            timestamp: Date(timeIntervalSince1970: 0),
            persistedAt: Date(timeIntervalSince1970: 0),
            blocks: [.text(id: "user-text", value: "run")]
        )
        let intermediate = TranscriptItem(
            id: "assistant",
            role: .assistant,
            timestamp: Date(timeIntervalSince1970: 1),
            persistedAt: Date(timeIntervalSince1970: 1),
            blocks: [
                .text(id: "narration", value: "I will inspect."),
                .toolCall(id: "call", value: ToolCallPresentation(id: "call", name: "read", arguments: "{}")),
            ],
            assistantStopReason: "toolUse"
        )

        let round = ConversationRoundProjector.project([user, intermediate]).first
        XCTAssertNil(round?.finalAssistant)
        XCTAssertEqual(round?.processItems.map(\.id), ["assistant"])
        XCTAssertNil(round?.completedAt)
    }

    func testConversationNavigationUsesRoundQuestionAndFinalAnswerPreviews() throws {
        let transcript = [
            TranscriptItem(
                id: "user-1",
                role: .user,
                timestamp: nil,
                blocks: [.text(id: "user-text", value: "  为什么\n会卡住？  ")]
            ),
            TranscriptItem(
                id: "assistant-1",
                role: .assistant,
                timestamp: nil,
                blocks: [.text(id: "assistant-text", value: "已经定位并修复。")],
                assistantStopReason: "stop"
            ),
        ]
        let round = try XCTUnwrap(ConversationRoundProjector.project(transcript).first)
        let item = try XCTUnwrap(ConversationNavigation.items(from: [round]).first)

        XCTAssertEqual(item.id, "user-1")
        XCTAssertEqual(item.anchorID, "round-nav:user-1")
        XCTAssertEqual(item.questionPreview, "为什么 会卡住？")
        XCTAssertEqual(item.answerPreview, "已经定位并修复。")
        XCTAssertFalse(item.hasError)
    }

    func testConversationNavigationMapsPointerPositionToNearestRound() {
        XCTAssertNil(ConversationNavigation.index(at: 10, height: 100, count: 0))
        XCTAssertEqual(ConversationNavigation.index(at: 0, height: 100, count: 5), 0)
        XCTAssertEqual(ConversationNavigation.index(at: 50, height: 100, count: 5), 2)
        XCTAssertEqual(ConversationNavigation.index(at: 100, height: 100, count: 5), 4)
        XCTAssertEqual(ConversationNavigation.yPosition(for: 2, height: 100, count: 5), 50, accuracy: 0.001)
        XCTAssertEqual(ConversationNavigation.yPosition(for: 1, height: 600, count: 2), 34, accuracy: 0.001)
        XCTAssertEqual(ConversationNavigation.index(at: 34, height: 600, count: 2), 1)
    }

    func testConversationNavigationSamplesDenseRailsAndKeepsBothEnds() {
        let indices = ConversationNavigation.renderedIndices(count: 1_000, height: 300)
        XCTAssertEqual(indices.first, 0)
        XCTAssertEqual(indices.last, 999)
        XCTAssertLessThan(indices.count, 1_000)
        XCTAssertFalse(ConversationNavigation.shouldShowPersistentRail(width: 639, roundCount: 2))
        XCTAssertFalse(ConversationNavigation.shouldShowPersistentRail(width: 640, roundCount: 1))
        XCTAssertTrue(ConversationNavigation.shouldShowPersistentRail(width: 640, roundCount: 2))
    }

    func testConversationNavigationIdentityChangesWithSessionOrPath() {
        XCTAssertEqual(
            ConversationNavigation.presentationIdentity(sessionID: "session-a", pathID: "leaf:one"),
            "session-a:leaf:one"
        )
        XCTAssertNotEqual(
            ConversationNavigation.presentationIdentity(sessionID: "session-a", pathID: "leaf:one"),
            ConversationNavigation.presentationIdentity(sessionID: "session-a", pathID: "leaf:two")
        )
        XCTAssertNotEqual(
            ConversationNavigation.presentationIdentity(sessionID: "session-a", pathID: "leaf:one"),
            ConversationNavigation.presentationIdentity(sessionID: "session-b", pathID: "leaf:one")
        )
    }

    func testConversationNavigationBoundsPreviewWorkForLargeMessageBodies() {
        let source = String(repeating: "a", count: 1_000_000)
        let preview = ConversationNavigation.compactPreview(source, fallback: "fallback")
        XCTAssertEqual(preview.count, 181)
        XCTAssertTrue(preview.hasSuffix("…"))
    }

    func testCompletedLongUserMessageUsesCompactPreviewUntilExpanded() {
        let longMessage = TranscriptItem(
            id: "user-long",
            role: .user,
            timestamp: nil,
            blocks: [.text(
                id: "user-long-text",
                value: "基于 ../../Workspace/Codes/Githubs/pi-dusage 帮我做一个 xai grok 的查询？可以怎么做，而不是直接做"
            )]
        )
        let shortMessage = TranscriptItem(
            id: "user-short",
            role: .user,
            timestamp: nil,
            blocks: [.text(id: "user-short-text", value: "hi")]
        )
        let multilineMessage = TranscriptItem(
            id: "user-multiline",
            role: .user,
            timestamp: nil,
            blocks: [.text(id: "user-multiline-text", value: "第一段\n第二段\n第三段")]
        )

        XCTAssertTrue(UserMessagePresentation.shouldCollapse(longMessage, roundIsInactive: true))
        XCTAssertFalse(UserMessagePresentation.shouldCollapse(longMessage, roundIsInactive: false))
        XCTAssertFalse(UserMessagePresentation.shouldCollapse(shortMessage, roundIsInactive: true))
        XCTAssertTrue(UserMessagePresentation.shouldCollapse(multilineMessage, roundIsInactive: true))
        XCTAssertEqual(
            UserMessagePresentation.preview(for: multilineMessage),
            "第一段 第二段 第三段"
        )
    }

    func testEarlierSteeringMessageBecomesInactiveWithoutAStandaloneFinalAnswer() {
        let firstRound = ConversationRound(
            id: "user-first",
            user: nil,
            processItems: [],
            finalAssistant: nil,
            startedAt: nil,
            completedAt: nil,
            toolCount: 1,
            hasError: false,
            totalTokens: nil,
            entryIDs: [],
            processEntryIDs: []
        )

        XCTAssertTrue(
            UserMessagePresentation.roundIsInactive(
                firstRound,
                latestRoundID: "user-follow-up"
            )
        )
        XCTAssertFalse(
            UserMessagePresentation.roundIsInactive(
                firstRound,
                latestRoundID: firstRound.id
            )
        )
    }

    func testConversationTimingFormatterUsesReadableChineseUnits() {
        XCTAssertEqual(ConversationTimingFormatter.durationText(0), "0 秒")
        XCTAssertEqual(ConversationTimingFormatter.durationText(83), "1 分钟 23 秒")
        XCTAssertEqual(ConversationTimingFormatter.durationText(3_720), "1 小时 2 分钟")
        XCTAssertNil(ConversationTimingFormatter.durationText(nil))

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try! XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let reference = Date(timeIntervalSince1970: 1_786_233_600) // 2026-08-09 00:00 UTC
        let sameYear = Date(timeIntervalSince1970: 1_786_297_260) // 2026-08-09 17:41 UTC
        let priorYear = Date(timeIntervalSince1970: 1_767_225_540) // 2025-12-31 23:59 UTC

        XCTAssertEqual(
            ConversationTimingFormatter.completionText(
                duration: 635,
                completedAt: sameYear,
                totalTokens: 67_800,
                relativeTo: reference,
                calendar: calendar
            ),
            "8月9日 17:41 · 耗时 10 分钟 35 秒 · 67.8k token"
        )
        XCTAssertEqual(
            ConversationTimingFormatter.completionText(
                duration: nil,
                completedAt: priorYear,
                relativeTo: reference,
                calendar: calendar
            ),
            "2025年12月31日 23:59"
        )
        XCTAssertEqual(
            ConversationTimingFormatter.completionText(
                duration: 12,
                completedAt: sameYear,
                relativeTo: reference,
                calendar: calendar
            ),
            "8月9日 17:41 · 耗时 12 秒"
        )
        XCTAssertEqual(
            ConversationTimingFormatter.completionText(
                duration: 12,
                completedAt: nil,
                totalTokens: 1_250,
                relativeTo: reference,
                calendar: calendar
            ),
            "耗时 12 秒 · 1.2k token"
        )
        XCTAssertNil(ConversationTimingFormatter.completionText(
            duration: nil,
            completedAt: nil,
            totalTokens: 0,
            relativeTo: reference,
            calendar: calendar
        ))
        XCTAssertNil(ConversationTimingFormatter.completionText(
            duration: nil,
            completedAt: nil,
            relativeTo: reference,
            calendar: calendar
        ))
    }

    func testDHashlineToolPresentationUsesSafeNativeSummaries() throws {
        let write = ToolCallPresentation(
            id: "write",
            name: "write",
            arguments: #"{"path":"Sources/Secret.swift","content":"let token = \"secret-value\"\n"}"#
        )
        let writeDescriptor = ToolPresentationFormatter.callDescriptor(write)
        XCTAssertEqual(writeDescriptor.title, "创建 Sources/Secret.swift")
        XCTAssertEqual(writeDescriptor.subtitle, "1 行")
        let expanded = ToolPresentationFormatter.expandedCallDetails(write)
        XCTAssertFalse(expanded.contains("secret-value"))
        XCTAssertTrue(expanded.contains("正文默认隐藏"))

        let edit = ToolCallPresentation(
            id: "edit",
            name: "edit",
            arguments: #"{"input":"[Sources/Secret.swift#A1B2C3D4]\nSWAP 1:\n+let token = \"secret-value\""}"#
        )
        let expandedEdit = ToolPresentationFormatter.expandedCallDetails(edit)
        XCTAssertTrue(expandedEdit.contains("替换第 1 行"))
        XCTAssertTrue(expandedEdit.contains("修改正文默认隐藏"))
        XCTAssertFalse(expandedEdit.contains("secret-value"))

        let read = ToolResultPresentation(
            id: "read",
            name: "read",
            content: "[Sources/App.swift#a1b2c3d4]\n1:import SwiftUI\n2:struct App {}",
            details: nil,
            isError: false
        )
        let descriptor = ToolPresentationFormatter.resultDescriptor(read)
        XCTAssertEqual(descriptor.title, "已读取 Sources/App.swift")
        XCTAssertEqual(descriptor.subtitle, "2 行 · tag A1B2C3D4")
        let section = try XCTUnwrap(ToolPresentationFormatter.anchorSections(from: read.content).first)
        XCTAssertEqual(section.path, "Sources/App.swift")
        XCTAssertEqual(section.lines.map(\.number), [1, 2])

        let longRead = ToolPresentationFormatter.anchorSections(from: """
        [Sources/App.swift#A1B2C3D4]
        1:first
        2:secret middle
        3:last
        """).first
        let visibleReadLines = ToolPresentationFormatter.visibleAnchorLines(
            toolName: "read",
            section: try XCTUnwrap(longRead)
        )
        XCTAssertEqual(visibleReadLines.map(\.number), [1, 3])
        XCTAssertFalse(visibleReadLines.map(\.text).contains("secret middle"))
    }

    func testDHashlineSearchPresentationCountsOnlyMarkedMatches() {
        let content = """
        [a.swift#A1B2C3D4]
        *4:needle
         5:context

        [b.swift#11223344]
        *8:needle
        """
        let result = ToolResultPresentation(
            id: "search",
            name: "search",
            content: content,
            details: nil,
            isError: false
        )
        let descriptor = ToolPresentationFormatter.resultDescriptor(result)
        XCTAssertEqual(descriptor.subtitle, "2 个文件 · 2 处匹配")
    }

    func testTranscriptParserPromotesFencedMermaidAndCodeBlocks() throws {
        let text = """
        Before
        ```mermaid
        flowchart LR
          A --> B
        ```
        ```swift
        print("hello")
        ```
        After
        """
        let entry: JSONValue = .object([
            "type": .string("message"),
            "id": .string("assistant"),
            "timestamp": .string("2026-01-01T00:00:00.000Z"),
            "message": .object([
                "role": .string("assistant"),
                "content": .array([.object(["type": .string("text"), "text": .string(text)])]),
                "timestamp": .number(1_000),
            ]),
        ])
        let blocks = try XCTUnwrap(TranscriptParser.parse(entries: [entry]).first?.blocks)
        XCTAssertEqual(blocks.count, 4)
        guard case let .mermaid(_, source) = blocks[1] else { return XCTFail("Expected Mermaid block") }
        XCTAssertTrue(source.contains("flowchart LR"))
        guard case let .code(_, language, source) = blocks[2] else { return XCTFail("Expected code block") }
        XCTAssertEqual(language, "swift")
        XCTAssertTrue(source.contains("print"))
    }

    func testExtensionUIStateDoesNotSurviveSessionOrHostLifecycleChanges() throws {
        let model = AppModel()
        let dialog = try XCTUnwrap(ExtensionDialog(data: .object([
            "requestId": .string("dialog"),
            "method": .string("input"),
            "title": .string("Native input"),
        ])))

        model.extensionDialogs = [dialog]
        model.extensionStatuses = ["git": "main"]
        model.workingMessage = "working"
        model.handle(HostEvent(name: "session.closed", data: nil))
        XCTAssertTrue(model.extensionDialogs.isEmpty)
        XCTAssertTrue(model.extensionStatuses.isEmpty)
        XCTAssertNil(model.workingMessage)

        model.extensionDialogs = [dialog]
        model.extensionStatuses = ["git": "main"]
        model.workingMessage = "working"
        model.handle(HostEvent(name: "host.processEnded", data: .object(["expected": .bool(false)])))
        XCTAssertTrue(model.extensionDialogs.isEmpty)
        XCTAssertTrue(model.extensionStatuses.isEmpty)
        XCTAssertNil(model.workingMessage)
    }

    func testIgnoredExtensionPresentationHintDoesNotShowGlobalNotice() {
        let model = AppModel()
        model.handle(HostEvent(name: "extension.unsupported", data: .object([
            "capability": .string("setWidget"),
            "behavior": .string("ignored"),
        ])))
        XCTAssertNil(model.notice)
        XCTAssertNil(model.issue)

        model.handle(HostEvent(name: "extension.unsupported", data: .object([
            "capability": .string("custom"),
            "behavior": .string("blocked"),
        ])))
        XCTAssertNil(model.notice)
        XCTAssertEqual(model.issue?.title, "当前交互无法完成")
        XCTAssertTrue(model.issue?.message.contains("custom") == true)
    }

    func testSessionListWindowShowsTenThenTwentyWithoutRegrouping() {
        func session(_ id: String, cwd: String, title: String) -> SessionSummary {
            SessionSummary(
                path: "/tmp/\(id).jsonl",
                id: id,
                cwd: cwd,
                name: title,
                parentSessionPath: nil,
                created: "2026-01-01T00:00:00.000Z",
                modified: "2026-01-01T00:00:00.000Z",
                messageCount: 2,
                firstMessage: title
            )
        }

        let sessions = (0..<21).map { index in
            session("session-\(index)", cwd: index.isMultiple(of: 2) ? "/work/a" : "/work/b", title: "Session \(index)")
        }
        var window = SessionListWindow()
        XCTAssertEqual(window.requestLimit, 11)
        var page = window.page(from: sessions)
        XCTAssertEqual(page.items.map(\.id), (0..<10).map { "session-\($0)" })
        XCTAssertTrue(page.hasMore)

        window.loadMore()
        XCTAssertEqual(window.requestLimit, 21)
        page = window.page(from: sessions)
        XCTAssertEqual(page.items.count, 20)
        XCTAssertEqual(page.items.map(\.cwd).prefix(4), ["/work/a", "/work/b", "/work/a", "/work/b"])
        XCTAssertTrue(page.hasMore)
    }

    func testRecentSessionListParametersAlwaysRequireDCodeOrigin() {
        let params = AppModel.recentSessionListParameters(limit: 11)
        XCTAssertEqual(params["limit"], .number(11))
        XCTAssertEqual(params["origin"], .string("dcode"))
        XCTAssertNil(params["cwdScope"])
    }

    func testSessionCreateResultKeepsPersistenceSeparateFromActivation() throws {
        let data = Data("""
        {
          "created": true,
          "session": {
            "path": "/tmp/session.jsonl",
            "id": "created-session",
            "cwd": "/tmp",
            "created": "2026-08-11T00:00:00.000Z",
            "modified": "2026-08-11T00:00:00.000Z",
            "messageCount": 0,
            "firstMessage": ""
          },
          "activation": {
            "status": "unavailable",
            "error": {"code": "SESSION_ACTIVATION_FAILED", "message": "activation failed"},
            "observationError": {"code": "SESSION_OBSERVATION_FAILED", "message": "observation failed"}
          }
        }
        """.utf8)
        let result = try JSONDecoder().decode(SessionCreateResult.self, from: data)
        XCTAssertTrue(result.created)
        XCTAssertEqual(result.session.id, "created-session")
        XCTAssertEqual(result.activation.status, "unavailable")
        XCTAssertNil(result.activation.open)
        XCTAssertEqual(result.activation.error?.code, "SESSION_ACTIVATION_FAILED")
        XCTAssertEqual(result.activation.observationError?.code, "SESSION_OBSERVATION_FAILED")
    }

    func testWorkbenchWidthBoundariesMatchTheProductContract() {
        XCTAssertEqual(WorkbenchWidthClass.classify(1_280), .wide)
        XCTAssertEqual(WorkbenchWidthClass.classify(1_279), .medium)
        XCTAssertEqual(WorkbenchWidthClass.classify(880), .medium)
        XCTAssertEqual(WorkbenchWidthClass.classify(879), .compact)
    }

    func testWorkbenchLayoutKeepsInspectorInlineWithoutShrinkingConversationBelowMinimum() {
        func policy(_ width: CGFloat) -> WorkbenchLayoutPolicy {
            WorkbenchLayoutPolicy(
                width: width,
                sidebarUserHidden: false,
                inspectorUserHidden: false,
                hasInspectorScope: true,
                sidebarOverlayRequested: false,
                inspectorOverlayRequested: false
            )
        }

        XCTAssertTrue(policy(1_280).inlineSidebar)
        XCTAssertTrue(policy(1_280).inlineInspector)
        XCTAssertEqual(policy(1_280).conversationWidth, 480)
        XCTAssertFalse(policy(1_279).inlineSidebar)
        XCTAssertTrue(policy(1_279).inlineInspector)
        XCTAssertEqual(policy(1_279).conversationWidth, 879)
        XCTAssertFalse(policy(880).inlineSidebar)
        XCTAssertTrue(policy(880).inlineInspector)
        XCTAssertEqual(policy(880).conversationWidth, 480)
        XCTAssertFalse(policy(879).inlineSidebar)
        XCTAssertFalse(policy(879).inlineInspector)
    }

    func testWorkbenchLayoutClampsAndUsesPersistedPanelWidths() {
        XCTAssertEqual(WorkbenchLayoutPolicy.defaultSidebarWidth, 400)
        XCTAssertEqual(WorkbenchLayoutPolicy.clampSidebarWidth(120), 280)
        XCTAssertEqual(WorkbenchLayoutPolicy.clampSidebarWidth(320), 320)
        XCTAssertEqual(WorkbenchLayoutPolicy.clampSidebarWidth(900), 520)
        XCTAssertEqual(WorkbenchLayoutPolicy.defaultInspectorWidth, 400)
        XCTAssertEqual(WorkbenchLayoutPolicy.clampInspectorWidth(120), 400)
        XCTAssertEqual(WorkbenchLayoutPolicy.clampInspectorWidth(900), 520)

        let formerlyNarrow = WorkbenchLayoutPolicy(
            width: 1_400,
            preferredInspectorWidth: 340,
            sidebarUserHidden: true,
            inspectorUserHidden: false,
            hasInspectorScope: true,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: false
        )
        XCTAssertEqual(formerlyNarrow.inspectorWidth, 400)

        let roomy = WorkbenchLayoutPolicy(
            width: 1_400,
            preferredSidebarWidth: 400,
            preferredInspectorWidth: 500,
            sidebarUserHidden: false,
            inspectorUserHidden: false,
            hasInspectorScope: true,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: false
        )
        XCTAssertEqual(roomy.sidebarWidth, 400)
        XCTAssertEqual(roomy.inspectorWidth, 500)
        XCTAssertTrue(roomy.inlineSidebar)
        XCTAssertTrue(roomy.inlineInspector)
        XCTAssertEqual(roomy.conversationWidth, 500)

        let constrained = WorkbenchLayoutPolicy(
            width: 1_300,
            preferredSidebarWidth: 400,
            preferredInspectorWidth: 500,
            sidebarUserHidden: false,
            inspectorUserHidden: false,
            hasInspectorScope: true,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: false
        )
        XCTAssertFalse(constrained.inlineSidebar)
        XCTAssertTrue(constrained.inlineInspector)
        XCTAssertEqual(constrained.conversationWidth, 800)
    }

    func testInlineInspectorNeverDimsSiblingColumns() {
        let policy = WorkbenchLayoutPolicy(
            width: 1_000,
            sidebarUserHidden: false,
            inspectorUserHidden: false,
            hasInspectorScope: true,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: true
        )
        XCTAssertTrue(policy.inlineInspector)
        XCTAssertFalse(policy.inspectorOverlay)
        XCTAssertFalse(policy.dimsBackground)
    }

    func testTopBarNewSessionAppearsOnlyWhenTheSessionSidebarIsAbsent() {
        let inline = WorkbenchLayoutPolicy(
            width: 1_400,
            sidebarUserHidden: false,
            inspectorUserHidden: true,
            hasInspectorScope: false,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: false
        )
        let hidden = WorkbenchLayoutPolicy(
            width: 1_400,
            sidebarUserHidden: true,
            inspectorUserHidden: true,
            hasInspectorScope: false,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: false
        )
        let compactClosed = WorkbenchLayoutPolicy(
            width: 879,
            sidebarUserHidden: false,
            inspectorUserHidden: true,
            hasInspectorScope: false,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: false
        )
        let compactOpen = WorkbenchLayoutPolicy(
            width: 879,
            sidebarUserHidden: false,
            inspectorUserHidden: true,
            hasInspectorScope: false,
            sidebarOverlayRequested: true,
            inspectorOverlayRequested: false
        )

        XCTAssertFalse(inline.showsTopBarNewSession)
        XCTAssertTrue(hidden.showsTopBarNewSession)
        XCTAssertTrue(compactClosed.showsTopBarNewSession)
        XCTAssertFalse(compactOpen.showsTopBarNewSession)
    }

    func testWorkbenchChromeAndInspectorRailShareTheCanvasSurface() {
        XCTAssertEqual(DCodeWorkbenchSurfacePolicy.windowChrome, .canvas)
        XCTAssertEqual(DCodeWorkbenchSurfacePolicy.centralCanvas, .canvas)
        XCTAssertEqual(DCodeWorkbenchSurfacePolicy.inspectorRail, .canvas)
        XCTAssertEqual(DCodeWorkbenchSurfacePolicy.sidebar, .navigation)
        XCTAssertEqual(DCodeWorkbenchSurfacePolicy.floatingSurface, .raised)
    }

    func testTopLevelPagesInheritOnePersistedNavigationWidth() {
        let layout = WorkbenchLayoutPolicy(
            width: 1_400,
            preferredSidebarWidth: 436,
            preferredInspectorWidth: 468,
            sidebarUserHidden: false,
            inspectorUserHidden: false,
            hasInspectorScope: true,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: false
        )
        let workspace = WorkbenchSurfaceLayout(destination: .workspace, layout: layout)
        let settings = WorkbenchSurfaceLayout(destination: .settings(.workbench), layout: layout)

        XCTAssertEqual(workspace.navigationWidth, 436)
        XCTAssertEqual(settings.navigationWidth, 436)
        XCTAssertEqual(workspace.contentLeadingInset, 436)
        XCTAssertEqual(settings.contentLeadingInset, 0)
        XCTAssertTrue(workspace.canResizeNavigation)
        XCTAssertTrue(settings.canResizeNavigation)
        XCTAssertEqual(layout.inspectorWidth, 468)
    }

    func testHiddenWorkspaceStillHandsItsPersistedWidthToSettingsNavigation() {
        let layout = WorkbenchLayoutPolicy(
            width: 1_200,
            preferredSidebarWidth: 432,
            sidebarUserHidden: true,
            inspectorUserHidden: true,
            hasInspectorScope: false,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: false
        )
        let workspace = WorkbenchSurfaceLayout(destination: .workspace, layout: layout)
        let settings = WorkbenchSurfaceLayout(destination: .settings(.appearance), layout: layout)

        XCTAssertEqual(workspace.navigationWidth, 0)
        XCTAssertFalse(workspace.mainWorkspaceIsWrappedByNavigation)
        XCTAssertEqual(settings.navigationWidth, 432)
        XCTAssertTrue(settings.mainWorkspaceIsWrappedByNavigation)
        XCTAssertTrue(settings.canResizeNavigation)
    }

    func testCompactPanelsRemainModalOverlays() {
        let sidebar = WorkbenchLayoutPolicy(
            width: 879,
            sidebarUserHidden: false,
            inspectorUserHidden: false,
            hasInspectorScope: true,
            sidebarOverlayRequested: true,
            inspectorOverlayRequested: false
        )
        let inspector = WorkbenchLayoutPolicy(
            width: 879,
            sidebarUserHidden: false,
            inspectorUserHidden: false,
            hasInspectorScope: true,
            sidebarOverlayRequested: false,
            inspectorOverlayRequested: true
        )
        XCTAssertTrue(sidebar.sidebarOverlay)
        XCTAssertTrue(sidebar.dimsBackground)
        XCTAssertTrue(inspector.inspectorOverlay)
        XCTAssertTrue(inspector.dimsBackground)
    }

    func testProjectSelectionPreservesCurrentSessionTranscriptAndDraft() async {
        let model = AppModel(projectStore: ProjectStore(fileURL: temporaryURL("projects.json")))
        let project = DCodeProject(name: "D Code", sourceFolders: [])
        let transcript = TranscriptItem(id: "a", role: .assistant, timestamp: nil, blocks: [.text(id: "t", value: "keep")])
        model.projects = [project]
        model.selectedSessionID = "session"
        model.transcript = [transcript]
        model.composerText = "未发送草稿"

        await model.selectProject(project.id)

        XCTAssertEqual(model.selectedSessionID, "session")
        XCTAssertEqual(model.transcript, [transcript])
        XCTAssertEqual(model.composerText, "未发送草稿")
        XCTAssertEqual(model.inspectorScope, .project(project.id))
    }

    func testLoadingSavedProjectsKeepsThemCollapsedAndDoesNotPreloadSessionCaches() async throws {
        let root = temporaryURL("project-load-policy")
        let source = root.appending(path: "source", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ProjectStore(fileURL: root.appending(path: "projects.json"))
        let project = DCodeProject(name: "D Code", sourceFolders: [SourceFolder(path: source.path)])
        try await store.save([project])

        let model = AppModel(projectStore: store)
        await model.loadProjects()

        XCTAssertEqual(model.projects, [project])
        XCTAssertTrue(model.expandedProjectIDs.isEmpty)
        XCTAssertTrue(model.projectSessions.isEmpty)
        XCTAssertTrue(model.projectHasMore.isEmpty)
    }

    func testProjectEditingStaysDisabledUntilTheStoreLoadsSafely() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "dcode-project-gate-\(UUID().uuidString)", directoryHint: .isDirectory)
        let storeURL = root.appending(path: "projects.json", directoryHint: .notDirectory)
        defer { try? FileManager.default.removeItem(at: root) }

        let model = AppModel(projectStore: ProjectStore(fileURL: storeURL))
        XCTAssertFalse(model.canEditProjects)

        await model.loadProjects()

        XCTAssertTrue(model.canEditProjects)
    }

    func testHostStateDecodesContextFastModeAndUnifiedReadOnlyModel() throws {
        let source = #"{"mode":"readOnly","sessionId":"s","sessionFile":"/tmp/s.jsonl","cwd":"/tmp","model":{"provider":"openai","id":"gpt-4o-mini"},"thinkingLevel":"high","activePlan":null,"isStreaming":false,"contextUsage":null,"fastMode":null,"writable":false,"conflict":null}"#
        let state = try JSONDecoder().decode(HostState.self, from: Data(source.utf8))
        XCTAssertEqual(state.model?.provider, "openai")
        XCTAssertEqual(state.model?.id, "gpt-4o-mini")
        XCTAssertNil(state.contextUsage)
        XCTAssertNil(state.fastMode)
    }

    func testSessionOpenDecodesUnknownModelAsNull() throws {
        let source = #"{"mode":"readOnly","snapshot":{"summary":{"path":"/tmp/s.jsonl","id":"s","cwd":"/tmp","created":"2026-01-01T00:00:00.000Z","modified":"2026-01-01T00:00:01.000Z","messageCount":0,"firstMessage":""},"header":{"type":"session","version":3,"id":"s","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"},"leafId":null,"currentPathId":"root","selectedPathId":"root","paths":[],"entries":[],"context":{"messageCount":0,"model":null,"thinkingLevel":"off"},"activePlan":null},"state":{"mode":"readOnly","sessionId":"s","sessionFile":"/tmp/s.jsonl","cwd":"/tmp","model":null,"thinkingLevel":"off","activePlan":null,"isStreaming":false,"contextUsage":null,"fastMode":null,"writable":false,"conflict":null}}"#

        let opened = try JSONDecoder().decode(SessionOpenResult.self, from: Data(source.utf8))

        XCTAssertNil(opened.snapshot.context.model)
        XCTAssertNil(opened.state?.model)
        XCTAssertNil(opened.state?.contextUsage)
    }

    func testHostStateDecodesRealContextUsageAndFastModeShape() throws {
        let source = #"{"mode":"writable","sessionId":"s","sessionFile":"/tmp/s.jsonl","sessionName":"Demo","cwd":"/tmp","model":{"provider":"openai-codex","id":"gpt-5.6-sol","name":"GPT-5.6 Sol","reasoning":true,"contextWindow":256000,"maxTokens":128000},"thinkingLevel":"xhigh","activePlan":null,"isStreaming":false,"pendingMessageCount":0,"contextUsage":{"tokens":128000,"contextWindow":256000,"percent":50},"fastMode":{"enabled":true,"active":true,"provider":"openai-codex","model":"gpt-5.6-sol","requestedServiceTier":"priority","reason":"supported"},"writable":true,"conflict":null}"#
        let state = try JSONDecoder().decode(HostState.self, from: Data(source.utf8))

        XCTAssertEqual(state.contextUsage, ContextUsage(tokens: 128_000, contextWindow: 256_000, percent: 50))
        XCTAssertEqual(state.contextUsage?.remainingPercent, 50)
        XCTAssertEqual(state.contextUsage?.usedFraction, 0.5)
        XCTAssertEqual(ContextUsage(tokens: 300, contextWindow: 256, percent: 117).remainingPercent, 0)
        XCTAssertEqual(ContextUsage(tokens: 300, contextWindow: 256, percent: 117).usedFraction, 1)
        XCTAssertEqual(ContextUsage(tokens: nil, contextWindow: 256, percent: nil).remainingPercent, nil)
        XCTAssertNil(ContextUsage(tokens: nil, contextWindow: 256, percent: nil).usedFraction)
        XCTAssertFalse(SessionRunPhase.completed.requiresInteractionDock)
        XCTAssertTrue(SessionRunPhase.running.requiresInteractionDock)
        XCTAssertTrue(SessionRunPhase.failed.requiresInteractionDock)
        XCTAssertTrue(SessionRunPhase.unknown.requiresInteractionDock)
        XCTAssertEqual(RunningMessageDeliveryMode.steer.label, "立即介入")
        XCTAssertEqual(RunningMessageDeliveryMode.queue.label, "排队等待")
        XCTAssertTrue(ComposerKeyPolicy.shouldSubmit(keyCode: 36, modifiers: []))
        XCTAssertTrue(ComposerKeyPolicy.shouldSubmit(keyCode: 36, modifiers: [.command]))
        XCTAssertFalse(ComposerKeyPolicy.shouldSubmit(keyCode: 36, modifiers: [.shift]))
        XCTAssertFalse(ComposerKeyPolicy.shouldSubmit(keyCode: 36, modifiers: [.option]))
        XCTAssertFalse(ComposerKeyPolicy.shouldSubmit(keyCode: 0, modifiers: []))
        XCTAssertEqual(
            state.fastMode,
            FastModeState(
                enabled: true,
                active: true,
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                requestedServiceTier: "priority",
                reason: "supported"
            )
        )
    }

    func testHostCompatibilityRejectsOldOrIncompleteHostBeforeSessionQueries() throws {
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionExternalSync"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("dcodeSessionOrigin"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionSearch"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionPaths"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionCopy"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionTrash"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionVisibilityExclusions"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionRename"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionRunCorrelation"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionRunState"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("preSessionModelSelection"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("modelSettings"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("sessionSteer"))
        XCTAssertTrue(HostCompatibility.requiredCapabilities.contains("modelAuthentication"))
        let capabilities = Dictionary(
            uniqueKeysWithValues: HostCompatibility.requiredCapabilities.map { ($0, JSONValue.bool(true)) }
        )
        let compatible = HostHello(
            protocolVersion: 1,
            hostVersion: "0.0.14",
            piVersion: "0.84.1",
            nodeVersion: "22.19.0",
            capabilities: capabilities
        )
        XCTAssertNoThrow(try HostCompatibility.validate(compatible))

        XCTAssertThrowsError(try HostCompatibility.validate(HostHello(
            protocolVersion: 1,
            hostVersion: nil,
            piVersion: "0.84.1",
            nodeVersion: "22.19.0",
            capabilities: capabilities
        ))) { error in
            XCTAssertEqual(error as? HostCompatibilityError, .incompatibleHostVersion(nil))
        }

        var incomplete = capabilities
        incomplete["projectCwdScope"] = .bool(false)
        XCTAssertThrowsError(try HostCompatibility.validate(HostHello(
            protocolVersion: 1,
            hostVersion: "0.0.14",
            piVersion: "0.84.1",
            nodeVersion: "22.19.0",
            capabilities: incomplete
        ))) { error in
            XCTAssertEqual(error as? HostCompatibilityError, .missingCapabilities(["projectCwdScope"]))
        }
    }

    func testSettledTranscriptRefreshClearsOnlyFinishedStreamingPresentation() {
        let model = AppModel()
        let persisted = TranscriptItem(
            id: "assistant",
            role: .assistant,
            timestamp: nil,
            blocks: [.text(id: "assistant-text", value: "done")]
        )
        model.optimisticUserMessage = "hi"
        model.streamingText = "done"
        model.streamingThinking = "thinking"
        model.streamingTools = [StreamingTool(
            id: "tool",
            name: "bash",
            details: "{}",
            isRunning: false,
            isError: false
        )]
        model.isStreaming = false

        model.applyRefreshedTranscript([persisted])

        XCTAssertEqual(model.transcript, [persisted])
        XCTAssertNil(model.optimisticUserMessage)
        XCTAssertEqual(model.streamingText, "")
        XCTAssertEqual(model.streamingThinking, "")
        XCTAssertTrue(model.streamingTools.isEmpty)

        model.streamingText = "next partial"
        model.isStreaming = true
        model.applyRefreshedTranscript([persisted])
        XCTAssertEqual(model.streamingText, "next partial")

        model.streamingThinking = "next thought"
        model.streamingTools = [
            StreamingTool(id: "completed", name: "bash", details: "done", isRunning: false, isError: false),
            StreamingTool(id: "running", name: "read", details: "working", isRunning: true, isError: false),
        ]
        model.markStreamingAssistantMessageEnded()
        model.applyRefreshedTranscript([persisted])
        XCTAssertTrue(model.isStreaming)
        XCTAssertEqual(model.streamingText, "")
        XCTAssertEqual(model.streamingThinking, "next thought")
        XCTAssertEqual(model.streamingTools.map(\.id), ["running"])
    }

    func testStreamingThinkingSurvivesToolAndAssistantBoundariesUntilTheRunSettles() {
        let model = AppModel()
        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("agent_start"),
            "runId": .string("run-thinking"),
        ])))
        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("message_start"),
            "message": .object(["role": .string("assistant")]),
        ])))
        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("message_update"),
            "assistantMessageEvent": .object([
                "type": .string("thinking_delta"),
                "delta": .string("先检查配置。"),
            ]),
        ])))
        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("tool_execution_start"),
            "toolCallId": .string("tool-1"),
            "toolName": .string("read"),
            "args": .object(["path": .string("README.md")]),
        ])))
        XCTAssertEqual(model.streamingThinking, "先检查配置。")

        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("message_start"),
            "message": .object(["role": .string("assistant")]),
        ])))
        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("message_update"),
            "assistantMessageEvent": .object([
                "type": .string("thinking_delta"),
                "delta": .string("再核对结果。"),
            ]),
        ])))
        XCTAssertEqual(model.streamingThinking, "先检查配置。\n\n再核对结果。")

        let oversized = String(repeating: "界", count: AppModel.maximumStreamingThinkingUTF16Count + 5_000)
        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("message_update"),
            "assistantMessageEvent": .object([
                "type": .string("thinking_delta"),
                "delta": .string(oversized),
            ]),
        ])))
        XCTAssertLessThanOrEqual(
            model.streamingThinking.utf16.count,
            AppModel.maximumStreamingThinkingUTF16Count
        )
        XCTAssertTrue(model.streamingThinking.hasPrefix("…较早的实时思考已省略…\n\n"))
        XCTAssertTrue(model.streamingThinking.hasSuffix(String(repeating: "界", count: 1_000)))
    }

    func testRetryingAgentEndDoesNotHideTheCurrentActivityBeforeSettled() {
        let model = AppModel()
        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("agent_start"),
        ])))
        XCTAssertTrue(model.isStreaming)

        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("agent_end"),
            "willRetry": .bool(true),
        ])))
        XCTAssertTrue(model.isStreaming)

        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("agent_settled"),
        ])))
        XCTAssertFalse(model.isStreaming)
    }

    func testHostLocatorHonorsExplicitOverrides() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let host = root.appending(path: "host.js")
        FileManager.default.createFile(atPath: host.path, contents: Data())
        let configuration = try HostLocator.resolve(
            arguments: ["PiDCode", "--node-bin", "/bin/cat", "--host-entry", host.path, "--agent-dir", root.path],
            environment: [:],
            homeDirectory: root
        )
        XCTAssertEqual(configuration.nodeURL.path, "/bin/cat")
        XCTAssertEqual(configuration.hostEntryURL.path, host.path)
        XCTAssertEqual(configuration.agentDirectoryURL.path, root.path)
    }

    func testHostLocatorPrefersEmbeddedRuntimeAndHost() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let bundleRoot = root.appending(path: "Fixture.bundle")
        let contents = bundleRoot.appending(path: "Contents")
        let resources = contents.appending(path: "Resources")
        let node = resources.appending(path: "runtime/node")
        let host = resources.appending(path: "host/dist/src/index.js")
        try FileManager.default.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: host.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\n".write(to: node, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        try "export {}\n".write(to: host, atomically: true, encoding: .utf8)
        try """
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict>
        <key>CFBundleIdentifier</key><string>com.diwu.pidcode.fixture</string>
        <key>CFBundlePackageType</key><string>BNDL</string>
        </dict></plist>
        """.write(to: contents.appending(path: "Info.plist"), atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: root) }

        let bundle = try XCTUnwrap(Bundle(url: bundleRoot))
        let configuration = try HostLocator.resolve(
            arguments: ["PiDCode"],
            environment: [:],
            bundle: bundle,
            homeDirectory: root.appending(path: "home")
        )
        XCTAssertEqual(configuration.nodeURL.path, node.path)
        XCTAssertEqual(configuration.hostEntryURL.path, host.path)
    }

    func testHostProcessEnvironmentPreservesInheritedPathAndAddsFinderFallbacks() {
        let home = URL(fileURLWithPath: "/Users/fixture")
        let agent = home.appending(path: ".pi/agent")
        let environment = HostProcessEnvironment.make(
            base: ["PATH": "/usr/bin:/custom/bin:/usr/bin", "KEEP": "yes"],
            homeDirectory: home,
            agentDirectoryURL: agent
        )
        let paths = environment["PATH", default: ""].split(separator: ":").map(String.init)
        XCTAssertEqual(Array(paths.prefix(2)), ["/usr/bin", "/custom/bin"])
        XCTAssertTrue(paths.contains("/opt/homebrew/bin"))
        XCTAssertTrue(paths.contains("/Users/fixture/.local/bin"))
        XCTAssertEqual(paths.filter { $0 == "/usr/bin" }.count, 1)
        XCTAssertEqual(environment["HOME"], home.path)
        XCTAssertEqual(environment["PI_CODING_AGENT_DIR"], agent.path)
        XCTAssertEqual(environment["NO_COLOR"], "1")
        XCTAssertEqual(environment["KEEP"], "yes")
    }

    func testPiHostClientReceivesMoreThanOneResponseFromAQuietStderrProcess() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let script = root.appending(path: "fake-host.py")
        let source = #"""
        import json, sys
        print(json.dumps({"version": 1, "type": "event", "event": "host.ready"}), flush=True)
        for line in sys.stdin:
            request = json.loads(line)
            method = request["method"]
            if method == "host.hello":
                result = {"protocolVersion": 1, "piVersion": "test", "nodeVersion": "test", "capabilities": {}}
            elif method == "session.list":
                result = {"sessions": []}
            else:
                result = {"shuttingDown": True}
            print(json.dumps({"version": 1, "type": "response", "id": request["id"], "method": method, "ok": True, "result": result}), flush=True)
            if method == "host.shutdown":
                break
        """#
        try source.write(to: script, atomically: true, encoding: .utf8)
        let client = PiHostClient(
            configuration: HostLaunchConfiguration(
                nodeURL: URL(fileURLWithPath: "/usr/bin/python3"),
                hostEntryURL: script,
                agentDirectoryURL: root
            ),
            eventSink: { _ in }
        )
        try await client.start()
        let hello: HostHello = try await client.request("host.hello")
        XCTAssertEqual(hello.protocolVersion, 1)
        let listed: SessionListResult = try await client.request("session.list", params: ["limit": .number(1)])
        XCTAssertTrue(listed.sessions.isEmpty)
        await client.shutdown()
    }

    func testProjectSessionLoadCancellationIsSilentAndPreservesCachedSessions() async throws {
        let root = temporaryURL("project-session-cancellation")
        let sourceFolder = root.appending(path: "source", directoryHint: .isDirectory)
        let agentDirectory = root.appending(path: "agent", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: sourceFolder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: agentDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let project = DCodeProject(
            name: "Cancellation",
            sourceFolders: [SourceFolder(path: sourceFolder.path)]
        )
        let projectStore = ProjectStore(fileURL: root.appending(path: "projects.json"))
        try await projectStore.save([project])

        let script = root.appending(path: "delayed-host.py")
        let source = #"""
        import json, os, sys, time

        capabilities = {
            "sessionLease": True,
            "onDemandWrite": True,
            "structuredPlan": True,
            "mermaidUnicode": True,
            "projectCwdScope": True,
            "contextUsage": True, "contextBreakdown": True, "permissionGate": True,
            "fastMode": True,
            "sessionExternalSync": True,
            "dcodeSessionOrigin": True,
            "sessionSearch": True,
            "sessionPaths": True,
            "sessionCopy": True,
            "sessionTrash": True,
            "sessionVisibilityExclusions": True,
            "sessionChangeLedger": True,
            "sessionRename": True,
            "sessionRunCorrelation": True,
            "sessionRunState": True,
            "preSessionModelSelection": True,
            "modelSettings": True,
            "sessionSteer": True,
            "modelAuthentication": True,
        }
        marker = os.path.join(sys.argv[2], "project-list-started")

        for line in sys.stdin:
            request = json.loads(line)
            method = request["method"]
            params = request.get("params", {})
            if method == "host.hello":
                result = {
                    "protocolVersion": 1,
                    "hostVersion": "0.0.14",
                    "piVersion": "0.84.1",
                    "nodeVersion": "test",
                    "capabilities": capabilities,
                }
            elif method == "session.list":
                if params.get("origin") != "dcode":
                    open(marker, "w").close()
                    time.sleep(0.4)
                result = {"sessions": []}
            else:
                result = {"shuttingDown": True}
            print(json.dumps({
                "version": 1,
                "type": "response",
                "id": request["id"],
                "method": method,
                "ok": True,
                "result": result,
            }), flush=True)
            if method == "host.shutdown":
                break
        """#
        try source.write(to: script, atomically: true, encoding: .utf8)

        let model = AppModel(
            projectStore: projectStore,
            sessionDraftStore: SessionDraftStore(fileURL: root.appending(path: "drafts.json")),
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json")),
            hostConfiguration: HostLaunchConfiguration(
                nodeURL: URL(fileURLWithPath: "/usr/bin/python3"),
                hostEntryURL: script,
                agentDirectoryURL: agentDirectory
            )
        )
        await model.start()
        XCTAssertEqual(model.connectionState, .ready)

        let cached = SessionSummary(
            path: root.appending(path: "cached.jsonl").path,
            id: "cached-session",
            cwd: sourceFolder.path,
            name: "Cached",
            parentSessionPath: nil,
            created: "2026-08-12T00:00:00.000Z",
            modified: "2026-08-12T00:00:00.000Z",
            messageCount: 1,
            firstMessage: "Cached"
        )
        model.projectSessions[project.id] = [cached]

        let loadTask = Task { await model.reloadProjectSessions(project.id) }
        let marker = agentDirectory.appending(path: "project-list-started")
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: marker.path) {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
        XCTAssertTrue(model.loadingProjectIDs.contains(project.id))

        loadTask.cancel()
        await loadTask.value

        XCTAssertNil(model.projectSessionErrors[project.id])
        XCTAssertNil(model.issue)
        XCTAssertFalse(model.loadingProjectIDs.contains(project.id))
        XCTAssertEqual(model.projectSessions[project.id], [cached])
        await model.shutdown()
    }

    func testNewSessionStaysLocalUntilTheFirstPromptIsSubmitted() async throws {
        let root = temporaryURL("lazy-session-create")
        let workspace = root.appending(path: "workspace", directoryHint: .isDirectory)
        let agentDirectory = root.appending(path: "agent", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: agentDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let script = root.appending(path: "create-host.py")
        let source = #"""
        import json, os, sys, threading, time

        capabilities = {
            "sessionLease": True,
            "onDemandWrite": True,
            "structuredPlan": True,
            "mermaidUnicode": True,
            "projectCwdScope": True,
            "contextUsage": True, "contextBreakdown": True, "permissionGate": True,
            "fastMode": True,
            "sessionExternalSync": True,
            "dcodeSessionOrigin": True,
            "sessionSearch": True,
            "sessionPaths": True,
            "sessionCopy": True,
            "sessionTrash": True,
            "sessionVisibilityExclusions": True,
            "sessionChangeLedger": True,
            "sessionRename": True,
            "sessionRunCorrelation": True,
            "sessionRunState": True,
            "preSessionModelSelection": True,
            "modelSettings": True,
            "sessionSteer": True,
            "modelAuthentication": True,
        }
        agent_dir = sys.argv[2]
        create_marker = os.path.join(agent_dir, "create-requested")
        models_marker = os.path.join(agent_dir, "draft-models-requested")
        set_model_marker = os.path.join(agent_dir, "initial-model-set")
        set_thinking_marker = os.path.join(agent_dir, "initial-thinking-set")
        set_fast_marker = os.path.join(agent_dir, "initial-fast-set")
        runtime_order = os.path.join(agent_dir, "initial-runtime-order")
        prompt_marker = os.path.join(agent_dir, "prompt-requested")
        open_marker = os.path.join(agent_dir, "open-started")
        open_gate = os.path.join(agent_dir, "allow-open")
        stale_list_marker = os.path.join(agent_dir, "stale-list-started")
        stale_list_gate = os.path.join(agent_dir, "allow-stale-list")
        created = None
        selected_model = None
        thinking_level = "off"
        dcode_list_count = 0
        output_lock = threading.Lock()

        def emit(request, result):
            with output_lock:
                print(json.dumps({
                    "version": 1,
                    "type": "response",
                    "id": request["id"],
                    "method": request["method"],
                    "ok": True,
                    "result": result,
                }), flush=True)

        def emit_event(event, data):
            with output_lock:
                print(json.dumps({
                    "version": 1,
                    "type": "event",
                    "event": event,
                    "data": data,
                }), flush=True)

        def emit_stale_list(request):
            deadline = time.time() + 2.0
            while not os.path.exists(stale_list_gate) and time.time() < deadline:
                time.sleep(0.01)
            emit(request, {"sessions": []})

        def summary(cwd):
            return {
                "path": os.path.join(cwd, "created-session.jsonl"),
                "id": "created-session",
                "cwd": cwd,
                "created": "2026-08-12T00:00:00.000Z",
                "modified": "2026-08-12T00:00:00.000Z",
                "messageCount": 0,
                "firstMessage": "",
            }

        for line in sys.stdin:
            request = json.loads(line)
            method = request["method"]
            params = request.get("params", {})
            if method == "host.hello":
                result = {
                    "protocolVersion": 1,
                    "hostVersion": "0.0.14",
                    "piVersion": "0.84.1",
                    "nodeVersion": "test",
                    "capabilities": capabilities,
                }
            elif method == "session.list":
                dcode_list_count += 1
                if dcode_list_count == 2:
                    open(stale_list_marker, "w").close()
                    threading.Thread(target=emit_stale_list, args=(request,), daemon=True).start()
                    continue
                result = {"sessions": [] if created is None else [created]}
            elif method == "session.create":
                open(create_marker, "w").close()
                created = summary(params["cwd"])
                result = {"created": True, "session": created, "activation": {"status": "created"}}
            elif method == "session.open":
                open(open_marker, "w").close()
                deadline = time.time() + 2.0
                while not os.path.exists(open_gate) and time.time() < deadline:
                    time.sleep(0.01)
                writable = params.get("mode") == "writable"
                result = {
                    "mode": "writable" if writable else "readOnly",
                    "snapshot": {
                        "summary": created,
                        "header": {"type": "session", "version": 3, "id": created["id"], "cwd": created["cwd"]},
                        "parentSessionId": None,
                        "leafId": None,
                        "currentPathId": "root",
                        "selectedPathId": "root",
                        "paths": [],
                        "entries": [],
                        "context": {"messageCount": 0, "model": None, "thinkingLevel": "off"},
                        "activePlan": None,
                    },
                    "state": {
                        "mode": "writable" if writable else "readOnly",
                        "sessionId": created["id"],
                        "sessionFile": created["path"],
                        "sessionName": None,
                        "cwd": created["cwd"],
                        "model": None,
                        "thinkingLevel": "off",
                        "activePlan": None,
                        "isStreaming": False,
                        "pendingMessageCount": 0,
                        "contextUsage": None,
                        "fastMode": None,
                        "writable": writable,
                        "conflict": None,
                    },
                    "extensions": None,
                }
            elif method == "session.trash":
                trashed = created
                created = None
                result = {
                    "trashed": True,
                    "sessionId": trashed["id"],
                    "originalPath": trashed["path"],
                    "trashPath": os.path.join(agent_dir, "Trash", "created-session.jsonl"),
                }
            elif method == "session.getModels":
                model = {
                    "provider": "openai",
                    "id": "gpt-4o-mini",
                    "name": "GPT-4o mini",
                    "reasoning": True,
                    "contextWindow": 128000,
                    "maxTokens": 16384,
                    "thinkingLevels": ["off", "high"],
                    "fastModeSupported": True,
                }
                if "cwd" in params:
                    open(models_marker, "w").close()
                result = {"models": [model], "defaultModel": None, "defaultThinkingLevel": "high"}
            elif method == "session.getThinkingLevels":
                result = {"levels": ["off"]}
            elif method == "session.getCommands":
                result = {"commands": []}
            elif method == "session.setModel":
                selected_model = {
                    "provider": params["provider"],
                    "id": params["modelId"],
                    "name": "GPT-4o mini",
                    "reasoning": True,
                    "contextWindow": 128000,
                    "maxTokens": 16384,
                    "thinkingLevels": ["off", "high"],
                    "fastModeSupported": True,
                }
                open(set_model_marker, "w").close()
                with open(runtime_order, "a") as output:
                    output.write("model\n")
                result = {"model": selected_model}
            elif method == "session.setThinking":
                thinking_level = params["level"]
                open(set_thinking_marker, "w").close()
                with open(runtime_order, "a") as output:
                    output.write("thinking\n")
                result = {"level": thinking_level}
            elif method == "session.setFastMode":
                open(set_fast_marker, "w").close()
                with open(runtime_order, "a") as output:
                    output.write("fast\n")
                result = {
                    "enabled": params["enabled"],
                    "active": params["enabled"],
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "requestedServiceTier": "priority",
                    "reason": "supported" if params["enabled"] else "disabled",
                }
            elif method == "session.getState":
                result = {
                    "mode": "writable",
                    "sessionId": created["id"],
                    "sessionFile": created["path"],
                    "sessionName": None,
                    "cwd": created["cwd"],
                    "model": selected_model,
                    "thinkingLevel": thinking_level,
                    "activePlan": None,
                    "isStreaming": False,
                    "pendingMessageCount": 0,
                    "contextUsage": None,
                    "fastMode": None,
                    "writable": True,
                    "conflict": None,
                }
            elif method == "session.prompt":
                open(prompt_marker, "w").close()
                with open(runtime_order, "a") as output:
                    output.write("prompt\n")
                prompt_id = params["promptId"]
                emit_event("session.promptCompleted", {
                    "sessionId": created["id"],
                    "promptId": prompt_id,
                    "outcome": "persisted",
                    "entryId": "user-first",
                })
                result = {"accepted": True, "completed": False}
            else:
                result = {"shuttingDown": True}
            emit(request, result)
            if method == "host.shutdown":
                break
        """#
        try source.write(to: script, atomically: true, encoding: .utf8)

        let draftStore = SessionDraftStore(fileURL: root.appending(path: "drafts.json"))
        let model = AppModel(
            projectStore: ProjectStore(fileURL: root.appending(path: "projects.json")),
            sessionDraftStore: draftStore,
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json")),
            hostConfiguration: HostLaunchConfiguration(
                nodeURL: URL(fileURLWithPath: "/usr/bin/python3"),
                hostEntryURL: script,
                agentDirectoryURL: agentDirectory
            )
        )
        await model.start()
        XCTAssertEqual(model.connectionState, .ready)

        await model.createSession(at: workspace)
        XCTAssertTrue(model.isNewSessionDraftActive)
        XCTAssertEqual(model.modelSettings.models.map(\.qualifiedName), ["openai/gpt-4o-mini"])
        XCTAssertNil(model.selectedNewSessionModel)
        XCTAssertNil(model.composerThinkingLevel)
        XCTAssertTrue(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "draft-models-requested").path))
        XCTAssertNil(model.selectedSessionID)
        XCTAssertTrue(model.recentSessions.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "create-requested").path))

        await model.selectProject(UUID())
        XCTAssertFalse(model.isNewSessionDraftActive)
        XCTAssertFalse(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "create-requested").path))

        await model.createSession(at: workspace)
        model.updateComposerText("第一条真实消息")
        XCTAssertFalse(model.canSubmitComposerText)
        model.selectNewSessionModel(try XCTUnwrap(model.modelSettings.models.first))
        XCTAssertEqual(model.selectedNewSessionModel?.qualifiedName, "openai/gpt-4o-mini")
        XCTAssertEqual(model.composerThinkingLevel, "high")
        await model.setComposerThinkingLevel("high")
        XCTAssertFalse(model.composerFastModeEnabled)
        await model.setComposerFastModeEnabled(true)
        XCTAssertTrue(model.composerFastModeEnabled)
        XCTAssertTrue(model.canSubmitComposerText)
        await model.selectProject(UUID())
        try await Task.sleep(for: .milliseconds(250))
        let parkedDrafts = try await draftStore.load()
        XCTAssertEqual(
            parkedDrafts.newSessionDraft,
            NewSessionDraft(
                directoryPath: workspace.path,
                text: "第一条真实消息",
                selectedModel: NewSessionModelSelection(provider: "openai", modelID: "gpt-4o-mini"),
                selectedThinkingLevel: "high",
                fastModeEnabled: true
            )
        )
        let restoredModel = AppModel(
            projectStore: ProjectStore(fileURL: root.appending(path: "restored-projects.json")),
            sessionDraftStore: draftStore,
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "restored-archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "restored-pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "restored-changes.json")),
            followUpQueueStore: FollowUpQueueStore(fileURL: root.appending(path: "restored-queues.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "restored-activity.json"))
        )
        let restoredMetadataLoaded = await restoredModel.loadSessionMetadata()
        XCTAssertTrue(restoredMetadataLoaded)
        XCTAssertEqual(
            restoredModel.newSessionDraft,
            parkedDrafts.newSessionDraft
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "create-requested").path))

        await model.createSession(at: workspace)
        XCTAssertTrue(model.isNewSessionDraftActive)
        XCTAssertEqual(model.composerText, "第一条真实消息")

        let staleReloadTask = Task { await model.reloadRecentSessions() }
        let staleListMarker = agentDirectory.appending(path: "stale-list-started")
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: staleListMarker.path) {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: staleListMarker.path))

        let sendTask = Task { await model.sendPrompt() }
        let marker = agentDirectory.appending(path: "open-started")
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: marker.path) {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "create-requested").path))
        XCTAssertTrue(model.recentSessions.contains(where: { $0.id == "created-session" }))
        XCTAssertTrue(model.isCreatingSession)
        XCTAssertTrue(model.isOpeningSession)

        try Data().write(to: agentDirectory.appending(path: "allow-stale-list"))
        await staleReloadTask.value
        XCTAssertTrue(model.recentSessions.contains(where: { $0.id == "created-session" }))

        try Data().write(to: agentDirectory.appending(path: "allow-open"))
        await sendTask.value
        XCTAssertEqual(model.selectedSessionID, "created-session")
        XCTAssertFalse(model.isNewSessionDraftActive)
        XCTAssertFalse(model.isCreatingSession)
        XCTAssertTrue(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "initial-model-set").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "initial-thinking-set").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "initial-fast-set").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "prompt-requested").path))
        XCTAssertEqual(
            try String(contentsOf: agentDirectory.appending(path: "initial-runtime-order"), encoding: .utf8),
            "model\nthinking\nfast\nprompt\n"
        )
        XCTAssertEqual(model.hostState?.model?.qualifiedName, "openai/gpt-4o-mini")
        XCTAssertEqual(model.hostState?.thinkingLevel, "high")
        XCTAssertNil(model.issue)

        await model.shutdown()
        let savedDrafts = try await draftStore.load()
        XCTAssertNil(savedDrafts.newSessionDraft)
        XCTAssertFalse(savedDrafts.records.contains(where: { $0.target.sessionID == "created-session" }))
    }

    func testNewSessionDoesNotOpenWhenDraftOwnershipTransferCannotPersist() async throws {
        let root = temporaryURL("lazy-session-transfer-failure")
        let workspace = root.appending(path: "workspace", directoryHint: .isDirectory)
        let agentDirectory = root.appending(path: "agent", directoryHint: .isDirectory)
        let draftDirectory = root.appending(path: "draft-store", directoryHint: .isDirectory)
        let draftFile = draftDirectory.appending(path: "drafts.json")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: agentDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let script = root.appending(path: "transfer-failure-host.py")
        let source = #"""
        import json, os, sys

        capabilities = {
            "sessionLease": True, "onDemandWrite": True, "structuredPlan": True,
            "mermaidUnicode": True, "projectCwdScope": True, "contextUsage": True, "contextBreakdown": True, "permissionGate": True,
            "fastMode": True, "sessionExternalSync": True, "dcodeSessionOrigin": True,
            "sessionSearch": True, "sessionPaths": True, "sessionCopy": True,
            "sessionTrash": True, "sessionVisibilityExclusions": True,
            "sessionChangeLedger": True, "sessionRename": True,
            "sessionRunCorrelation": True,
            "sessionRunState": True,
            "preSessionModelSelection": True,
            "modelSettings": True,
            "sessionSteer": True,
            "modelAuthentication": True,
        }
        agent_dir = sys.argv[2]
        created = None

        def respond(request, result=None, error=None):
            envelope = {
                "version": 1, "type": "response", "id": request["id"],
                "method": request["method"], "ok": error is None,
            }
            if error is None:
                envelope["result"] = result
            else:
                envelope["error"] = {"code": "TEST_OPENED", "message": error}
            print(json.dumps(envelope), flush=True)

        for line in sys.stdin:
            request = json.loads(line)
            method = request["method"]
            params = request.get("params", {})
            if method == "host.hello":
                respond(request, {
                    "protocolVersion": 1, "hostVersion": "0.0.14", "piVersion": "0.84.1",
                    "nodeVersion": "test", "capabilities": capabilities,
                })
            elif method == "session.list":
                respond(request, {"sessions": [] if created is None else [created]})
            elif method == "session.create":
                created = {
                    "path": os.path.join(params["cwd"], "created-session.jsonl"),
                    "id": "created-session", "cwd": params["cwd"],
                    "created": "2026-08-15T09:00:00Z", "modified": "2026-08-15T09:00:00Z",
                    "messageCount": 0, "firstMessage": "",
                }
                open(os.path.join(agent_dir, "create-requested"), "w").close()
                respond(request, {"created": True, "session": created, "activation": {"status": "created"}})
            elif method == "session.getModels":
                model = {
                    "provider": "openai", "id": "gpt-4o-mini", "name": "GPT-4o mini",
                    "reasoning": False, "contextWindow": 128000, "maxTokens": 16384,
                }
                respond(request, {"models": [model], "defaultModel": model})
            elif method == "session.open":
                open(os.path.join(agent_dir, "open-requested"), "w").close()
                respond(request, error="Draft transfer should have stopped before session.open")
            else:
                respond(request, {"shuttingDown": True})
            if method == "host.shutdown":
                break
        """#
        try source.write(to: script, atomically: true, encoding: .utf8)

        let draftStore = SessionDraftStore(fileURL: draftFile)
        let model = AppModel(
            projectStore: ProjectStore(fileURL: root.appending(path: "projects.json")),
            sessionDraftStore: draftStore,
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json")),
            followUpQueueStore: FollowUpQueueStore(fileURL: root.appending(path: "queues.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json")),
            hostConfiguration: HostLaunchConfiguration(
                nodeURL: URL(fileURLWithPath: "/usr/bin/python3"),
                hostEntryURL: script,
                agentDirectoryURL: agentDirectory
            )
        )
        await model.start()
        XCTAssertEqual(model.connectionState, .ready)
        await model.createSession(at: workspace)
        XCTAssertEqual(model.selectedNewSessionModel?.qualifiedName, "openai/gpt-4o-mini")
        XCTAssertTrue(model.isPiDefaultNewSessionModel(try XCTUnwrap(model.selectedNewSessionModel)))
        XCTAssertFalse(model.composerFastModeEnabled)
        model.updateComposerText("必须保留的第一条消息")
        try await Task.sleep(for: .milliseconds(250))
        let storedBeforeFailure = try await draftStore.load()
        XCTAssertEqual(storedBeforeFailure.newSessionDraft?.text, "必须保留的第一条消息")

        try FileManager.default.removeItem(at: draftDirectory)
        XCTAssertTrue(FileManager.default.createFile(atPath: draftDirectory.path, contents: Data()))

        await model.sendPrompt()

        XCTAssertTrue(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "create-requested").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: agentDirectory.appending(path: "open-requested").path))
        XCTAssertTrue(model.recentSessions.contains(where: { $0.id == "created-session" }))
        XCTAssertEqual(model.issue?.title, "会话已创建，但首次消息尚未发送")
        XCTAssertEqual(model.composerText, "必须保留的第一条消息")
        await model.shutdown()
    }

    func testDiagnosticSanitizerRedactsCommonCredentialShapes() {
        let source = "Authorization: Bearer abc.def api_key=topsecret password: hunter2 sk-abcdefgh123456"
        let redacted = DiagnosticSanitizer.redact(source)
        XCTAssertFalse(redacted.contains("abc.def"))
        XCTAssertFalse(redacted.contains("topsecret"))
        XCTAssertFalse(redacted.contains("hunter2"))
        XCTAssertFalse(redacted.contains("sk-abcdefgh123456"))
        XCTAssertTrue(redacted.contains("[REDACTED]"))
    }

    func testActivePlanParserFindsProgressAndCurrentItem() throws {
        let source = #"""
        {
          "id": "goal-1",
          "objective": "Ship native app",
          "status": "active",
          "workList": {
            "items": [],
            "phases": [
              {
                "id": 1,
                "subject": "Build",
                "status": "in_progress",
                "items": [
                  {"id": 1, "subject": "Host", "status": "done"},
                  {"id": 2, "subject": "Plan", "status": "active", "blockedBy": [1]},
                  {"id": 3, "subject": "Package", "status": "pending", "blockedBy": [2]}
                ]
              }
            ]
          }
        }
        """#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(source.utf8))
        let plan = try XCTUnwrap(ActivePlanParser.parse(value))
        XCTAssertEqual(plan.totalCount, 3)
        XCTAssertEqual(plan.completedCount, 1)
        XCTAssertEqual(plan.currentItem?.subject, "Plan")
        XCTAssertEqual(plan.currentPhase?.subject, "Build")
        XCTAssertEqual(plan.progress, 1.0 / 3.0, accuracy: 0.0001)

        let completed = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"id":"goal-1","objective":"Done","status":"done","workList":{"items":[],"phases":[]}}"#.utf8)
        )
        XCTAssertNil(ActivePlanParser.parse(completed))
    }

    func testProjectStorePersistsOrderAndCanonicalizesSymlinkAliases() async throws {
        let root = temporaryURL("project-store")
        let sourceA = root.appending(path: "a", directoryHint: .isDirectory)
        let sourceB = root.appending(path: "b", directoryHint: .isDirectory)
        let aliasA = root.appending(path: "alias-a", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: sourceA, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sourceB, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: aliasA, withDestinationURL: sourceA)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = ProjectStore(fileURL: root.appending(path: "projects.json"))
        let first = try ProjectStore.applying(
            projectID: nil,
            name: "D Code",
            folderURLs: [aliasA, sourceB],
            to: [],
            moveConflicts: false
        )
        try await store.save(first.projects)
        let restored = try await store.load()

        XCTAssertEqual(restored.map(\.name), ["D Code"])
        XCTAssertEqual(restored[0].sourceFolders.map(\.path), [sourceA.path, sourceB.path])
        XCTAssertEqual(restored[0].sourceFolders.map(\.id), [sourceA.path, sourceB.path])
    }

    func testProjectMoveRequiresConfirmationAndDoesNotTouchDirectories() async throws {
        let root = temporaryURL("project-move")
        let sourceA = root.appending(path: "a", directoryHint: .isDirectory)
        let sourceB = root.appending(path: "b", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: sourceA, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sourceB, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let projectA = DCodeProject(name: "A", sourceFolders: [SourceFolder(path: sourceA.path)])
        let projectB = DCodeProject(name: "B", sourceFolders: [SourceFolder(path: sourceB.path)])
        let storeURL = root.appending(path: "projects.json")
        let store = ProjectStore(fileURL: storeURL)
        try await store.save([projectA, projectB])
        let before = try Data(contentsOf: storeURL)

        XCTAssertThrowsError(try ProjectStore.applying(
            projectID: projectB.id,
            name: projectB.name,
            folderURLs: [sourceB, sourceA],
            to: [projectA, projectB],
            moveConflicts: false
        )) { error in
            guard case ProjectStoreError.missingMoveConfirmation = error else {
                return XCTFail("Expected explicit move confirmation")
            }
        }
        XCTAssertEqual(try Data(contentsOf: storeURL), before)
        XCTAssertTrue(FileManager.default.fileExists(atPath: sourceA.path))

        let moved = try ProjectStore.applying(
            projectID: projectB.id,
            name: projectB.name,
            folderURLs: [sourceB, sourceA],
            to: [projectA, projectB],
            moveConflicts: true
        )
        try await store.save(moved.projects)
        XCTAssertTrue(moved.projects.first(where: { $0.id == projectA.id })?.sourceFolders.isEmpty == true)
        XCTAssertEqual(moved.projects.first(where: { $0.id == projectB.id })?.sourceFolders.map(\.path), [sourceB.path, sourceA.path])
        XCTAssertTrue(FileManager.default.fileExists(atPath: sourceA.path))
    }

    func testProjectStoreLeavesMalformedDocumentUntouched() async throws {
        let root = temporaryURL("project-corrupt")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let storeURL = root.appending(path: "projects.json")
        let original = Data("{not-json\n".utf8)
        try original.write(to: storeURL)
        let store = ProjectStore(fileURL: storeURL)

        do {
            _ = try await store.load()
            XCTFail("Expected malformed document to fail")
        } catch {
            XCTAssertEqual(try Data(contentsOf: storeURL), original)
        }
    }

    func testProjectStoreRejectsUnsupportedVersionAndDuplicateProjectIDsWithoutChangingBytes() async throws {
        let root = temporaryURL("project-invalid-documents")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let storeURL = root.appending(path: "projects.json")
        let store = ProjectStore(fileURL: storeURL)

        let unsupported = Data(#"{"projects":[],"version":2}"#.utf8)
        try unsupported.write(to: storeURL)
        do {
            _ = try await store.load()
            XCTFail("Expected unsupported version to fail")
        } catch ProjectStoreError.invalidDocumentVersion(2) {
            XCTAssertEqual(try Data(contentsOf: storeURL), unsupported)
        }

        let duplicateID = UUID()
        let duplicate = Data(#"{"projects":[{"id":"\#(duplicateID.uuidString)","name":"A","sourceFolders":[]},{"id":"\#(duplicateID.uuidString)","name":"B","sourceFolders":[]}],"version":1}"#.utf8)
        try duplicate.write(to: storeURL)
        do {
            _ = try await store.load()
            XCTFail("Expected duplicate project IDs to fail")
        } catch ProjectStoreError.duplicateProjectID(duplicateID) {
            XCTAssertEqual(try Data(contentsOf: storeURL), duplicate)
        }
    }

    func testProjectOwnershipFollowsAStoredFolderThatBecomesASymbolicLink() throws {
        let root = temporaryURL("project-rewired-link")
        let original = root.appending(path: "original", directoryHint: .isDirectory)
        let target = root.appending(path: "target", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: original, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let project = DCodeProject(name: "A", sourceFolders: [SourceFolder(path: original.path)])

        try FileManager.default.removeItem(at: original)
        try FileManager.default.createSymbolicLink(at: original, withDestinationURL: target)

        let conflicts = ProjectStore.conflicts(paths: [target.path], in: [project], excluding: nil)
        XCTAssertEqual(conflicts.map(\.projectID), [project.id])
    }

    func testProjectSessionOwnershipUsesTheExactCanonicalSourceFolder() throws {
        let root = temporaryURL("project-session-ownership")
        let source = root.appending(path: "source", directoryHint: .isDirectory)
        let nested = source.appending(path: "nested", directoryHint: .isDirectory)
        let alias = root.appending(path: "alias", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: source)
        defer { try? FileManager.default.removeItem(at: root) }

        let project = DCodeProject(name: "D Code", sourceFolders: [SourceFolder(path: source.path)])
        let ownership = try XCTUnwrap(ProjectSessionOwnershipResolver.resolve(
            cwd: alias.path,
            projects: [project]
        ))

        XCTAssertEqual(ownership.project.id, project.id)
        XCTAssertEqual(ownership.sourceFolder.path, source.path)
        XCTAssertNil(ProjectSessionOwnershipResolver.resolve(cwd: nested.path, projects: [project]))
    }

    func testProjectFileTreeLayoutFlattensOnlyOneSourceFolder() {
        let first = SourceFolder(path: "/workspace/first")
        let second = SourceFolder(path: "/workspace/second")

        XCTAssertEqual(
            ProjectFileTreeLayout.resolve(for: DCodeProject(name: "Empty", sourceFolders: [])),
            .empty
        )
        XCTAssertEqual(
            ProjectFileTreeLayout.resolve(for: DCodeProject(name: "One", sourceFolders: [first])),
            .flattened(first)
        )
        XCTAssertEqual(
            ProjectFileTreeLayout.resolve(for: DCodeProject(name: "Many", sourceFolders: [first, second])),
            .grouped([first, second])
        )
    }

    func testProjectSessionCreationRouteSkipsChooserForOneSourceFolder() {
        let first = SourceFolder(path: "/workspace/first")
        let second = SourceFolder(path: "/workspace/second")

        XCTAssertEqual(
            ProjectSessionCreationRoute.resolve(for: DCodeProject(name: "Empty", sourceFolders: [])),
            .unavailable
        )
        XCTAssertEqual(
            ProjectSessionCreationRoute.resolve(for: DCodeProject(name: "One", sourceFolders: [first])),
            .direct(first)
        )
        XCTAssertEqual(
            ProjectSessionCreationRoute.resolve(for: DCodeProject(name: "Many", sourceFolders: [first, second])),
            .choose([first, second])
        )
    }

    func testFileTreeReadsOneLevelAndNeverExpandsSymbolicLinks() async throws {
        let root = temporaryURL("file-tree")
        let child = root.appending(path: "child", directoryHint: .isDirectory)
        let file = root.appending(path: "note.md")
        let link = root.appending(path: "child-link")
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
        try "hello".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: child)
        defer { try? FileManager.default.removeItem(at: root) }

        let children = try await FileTreeReader.children(rootPath: root.path, directoryPath: root.path)
        XCTAssertEqual(children.first?.name, "child")
        XCTAssertEqual(children.first(where: { $0.name == "note.md" })?.kind, .file)
        XCTAssertEqual(children.first(where: { $0.name == "child-link" })?.kind, .symbolicLink)
        do {
            _ = try await FileTreeReader.children(rootPath: root.path, directoryPath: link.path)
            XCTFail("Expected symbolic links to remain unexpanded")
        } catch let error as FileTreeReaderError {
            XCTAssertEqual(error, .symbolicLinkNotExpandable)
        }

        let sibling = root.deletingLastPathComponent().appending(path: "outside-(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sibling) }
        do {
            _ = try await FileTreeReader.children(rootPath: root.path, directoryPath: sibling.path)
            XCTFail("Expected an outside directory to be rejected")
        } catch let error as FileTreeReaderError {
            XCTAssertEqual(error, .outsideSourceFolder)
        }
    }

    func testGitPorcelainParserPreservesSpacesAndRenameSource() {
        let data = Data(" M file with space.md\0R  new name.md\0old name.md\0?? new file.txt\0".utf8)
        let changes = GitChangesReader.parsePorcelainV1(data)
        XCTAssertEqual(changes.count, 3)
        XCTAssertEqual(changes[0], GitChange(status: " M", path: "file with space.md", originalPath: nil))
        XCTAssertEqual(changes[1], GitChange(status: "R ", path: "new name.md", originalPath: "old name.md"))
        XCTAssertEqual(changes[2], GitChange(status: "??", path: "new file.txt", originalPath: nil))
    }

    func testGitChangesReaderDeduplicatesRepositoryRootsAndDoesNotChangeWorkspaceState() async throws {
        let root = temporaryURL("git-read-only")
        let nested = root.appending(path: "nested", directoryHint: .isDirectory)
        let nonRepository = temporaryURL("not-git")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: nonRepository, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: nonRepository)
        }

        try runGit(["init", "-b", "main"], at: root)
        try "base\n".write(to: root.appending(path: "base.txt"), atomically: true, encoding: .utf8)
        try "rename\n".write(to: root.appending(path: "old name.txt"), atomically: true, encoding: .utf8)
        try runGit(["add", "base.txt", "old name.txt"], at: root)
        try runGit(["-c", "user.name=D Code Test", "-c", "user.email=dcode@example.invalid", "commit", "-m", "baseline"], at: root)

        try "changed\n".write(to: root.appending(path: "base.txt"), atomically: true, encoding: .utf8)
        try "staged\n".write(to: root.appending(path: "staged.txt"), atomically: true, encoding: .utf8)
        try "untracked\n".write(to: root.appending(path: "untracked.txt"), atomically: true, encoding: .utf8)
        try FileManager.default.moveItem(
            at: root.appending(path: "old name.txt"),
            to: root.appending(path: "new name.txt")
        )
        try runGit(["add", "-A", "staged.txt", "old name.txt", "new name.txt"], at: root)

        let headBefore = try runGit(["rev-parse", "HEAD"], at: root)
        let indexBefore = try runGit(["write-tree"], at: root)
        let statusBefore = try runGitData(["status", "--porcelain=v1", "-z", "--untracked-files=all"], at: root)
        let snapshots = await GitChangesReader.read(sourceFolders: [
            SourceFolder(path: root.path),
            SourceFolder(path: nested.path),
            SourceFolder(path: nonRepository.path),
        ])

        let ready = try XCTUnwrap(snapshots.first(where: { $0.rootPath == root.path }))
        XCTAssertEqual(ready.sourceFolderNames.count, 2)
        guard case let .ready(branch, changes) = ready.state else {
            return XCTFail("Expected a ready Git repository")
        }
        XCTAssertEqual(branch, "main")
        XCTAssertTrue(changes.contains(where: { $0.path == "base.txt" && $0.status == " M" }))
        XCTAssertTrue(changes.contains(where: { $0.path == "staged.txt" && $0.status == "A " }))
        XCTAssertTrue(changes.contains(where: { $0.path == "untracked.txt" && $0.status == "??" }))
        XCTAssertTrue(changes.contains(where: { $0.path == "new name.txt" && $0.originalPath == "old name.txt" }))
        XCTAssertTrue(snapshots.contains(where: {
            $0.rootPath == nonRepository.path && $0.state == .notRepository
        }))
        XCTAssertEqual(try runGit(["rev-parse", "HEAD"], at: root), headBefore)
        XCTAssertEqual(try runGit(["write-tree"], at: root), indexBefore)
        XCTAssertEqual(try runGitData(["status", "--porcelain=v1", "-z", "--untracked-files=all"], at: root), statusBefore)
    }

    func testAppearancePreferenceMapsSystemLightAndDark() {
        XCTAssertEqual(AppAppearance.resolve("system"), .system)
        XCTAssertEqual(AppAppearance.resolve("light"), .light)
        XCTAssertEqual(AppAppearance.resolve("dark"), .dark)
        XCTAssertEqual(AppAppearance.resolve("unexpected"), .system)
        XCTAssertNil(AppAppearance.system.appearanceName)
        XCTAssertEqual(AppAppearance.light.appearanceName, .aqua)
        XCTAssertEqual(AppAppearance.dark.appearanceName, .darkAqua)
    }

    func testAppearancePreferenceUsesOneApplicationWideAppearanceAuthority() {
        let previous = NSApplication.shared.appearance
        defer { NSApplication.shared.appearance = previous }

        AppAppearance.light.apply()
        XCTAssertEqual(NSApplication.shared.appearance?.name, .aqua)
        AppAppearance.dark.apply()
        XCTAssertEqual(NSApplication.shared.appearance?.name, .darkAqua)
        AppAppearance.system.apply()
        XCTAssertNil(NSApplication.shared.appearance)
    }

    func testTitleBarDoubleClickActionRespectsTheMacOSPreference() {
        XCTAssertEqual(WindowTitleBarDoubleClickAction.resolve("Maximize"), .zoom)
        XCTAssertEqual(WindowTitleBarDoubleClickAction.resolve("Minimize"), .minimize)
        XCTAssertEqual(WindowTitleBarDoubleClickAction.resolve("None"), .none)
        XCTAssertEqual(WindowTitleBarDoubleClickAction.resolve(nil), .zoom)
        XCTAssertEqual(WindowTitleBarDoubleClickAction.resolve("unexpected"), .zoom)
    }

    func testCompactIconActionsShareOneNavigationRowRhythm() {
        XCTAssertEqual(PiDCodeMetrics.actionGlyphPointSize, 13)
        XCTAssertEqual(PiDCodeMetrics.actionGlyphBox, 18)
        XCTAssertEqual(PiDCodeMetrics.iconActionSurface, 28)
        XCTAssertEqual(PiDCodeMetrics.iconActionTarget, 32)
        XCTAssertEqual(PiDCodeMetrics.compactControlHeight, 32)
        XCTAssertEqual(PiDCodeMetrics.navigationRowHeight, 36)
        XCTAssertEqual(PiDCodeMetrics.toolbarIconTarget, 28)
        XCTAssertEqual(PiDCodeMetrics.windowTopBarHeight, PiDCodeMetrics.navigationRowHeight)
        XCTAssertEqual(PiDCodeMetrics.windowControlsReservedWidth, 88)
        XCTAssertLessThan(PiDCodeMetrics.actionGlyphBox, PiDCodeMetrics.iconActionSurface)
        XCTAssertLessThan(PiDCodeMetrics.iconActionSurface, PiDCodeMetrics.iconActionTarget)
        XCTAssertLessThan(PiDCodeMetrics.iconActionTarget, PiDCodeMetrics.navigationRowHeight)
        XCTAssertLessThan(PiDCodeMetrics.iconActionTarget, PiDCodeMetrics.minimumTarget)
    }

    func testInterfaceFontScaleOffsetsSystemDynamicTypeSize() {
        XCTAssertNil(
            DCodeInterfaceFontScale.standard.dynamicTypeSizeOverride(basedOn: .large),
            "标准档不覆盖系统设置"
        )
        XCTAssertEqual(
            DCodeInterfaceFontScale.compact.dynamicTypeSizeOverride(basedOn: .large),
            .medium
        )
        XCTAssertEqual(
            DCodeInterfaceFontScale.large.dynamicTypeSizeOverride(basedOn: .large),
            .xLarge
        )
        XCTAssertEqual(
            DCodeInterfaceFontScale.compact.dynamicTypeSizeOverride(basedOn: .xSmall),
            .xSmall,
            "紧凑档不越过常规下限"
        )
        XCTAssertEqual(
            DCodeInterfaceFontScale.large.dynamicTypeSizeOverride(basedOn: .xxxLarge),
            .xxxLarge,
            "大档不越过常规上限"
        )
        XCTAssertEqual(
            DCodeInterfaceFontScale.large.dynamicTypeSizeOverride(basedOn: .accessibility2),
            .xxxLarge,
            "无障碍特大档回退常规上限参与换算"
        )
        XCTAssertEqual(DCodeInterfaceFontScale.resolve("compact"), .compact)
        XCTAssertEqual(DCodeInterfaceFontScale.resolve("unexpected"), .standard)
    }

    private func temporaryURL(_ name: String) -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: "dcode-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    @discardableResult
    private func runGit(_ arguments: [String], at directory: URL) throws -> String {
        String(decoding: try runGitData(arguments, at: directory), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func runGitData(_ arguments: [String], at directory: URL) throws -> Data {
        let process = Process()
        let output = Pipe()
        let error = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", directory.path] + arguments
        process.standardOutput = output
        process.standardError = error
        try process.run()
        let outputData = output.fileHandleForReading.readDataToEndOfFile()
        let errorData = error.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(
                domain: "DCodeGitTest",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: String(decoding: errorData, as: UTF8.self)]
            )
        }
        return outputData
    }

}

@MainActor
private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected error", file: file, line: line)
    } catch {
        // Expected.
    }
}
