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

    func testHostStateDecodesRealContextUsageAndFastModeShape() throws {
        let source = #"{"mode":"writable","sessionId":"s","sessionFile":"/tmp/s.jsonl","sessionName":"Demo","cwd":"/tmp","model":{"provider":"openai-codex","id":"gpt-5.6-sol","name":"GPT-5.6 Sol","reasoning":true,"contextWindow":256000,"maxTokens":128000},"thinkingLevel":"xhigh","activePlan":null,"isStreaming":false,"pendingMessageCount":0,"contextUsage":{"tokens":128000,"contextWindow":256000,"percent":50},"fastMode":{"enabled":true,"active":true,"provider":"openai-codex","model":"gpt-5.6-sol","requestedServiceTier":"priority","reason":"supported"},"writable":true,"conflict":null}"#
        let state = try JSONDecoder().decode(HostState.self, from: Data(source.utf8))

        XCTAssertEqual(state.contextUsage, ContextUsage(tokens: 128_000, contextWindow: 256_000, percent: 50))
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
        let capabilities = Dictionary(
            uniqueKeysWithValues: HostCompatibility.requiredCapabilities.map { ($0, JSONValue.bool(true)) }
        )
        let compatible = HostHello(
            protocolVersion: 1,
            hostVersion: "0.0.1",
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
            hostVersion: "0.0.1",
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
        XCTAssertEqual(model.streamingThinking, "")
        XCTAssertEqual(model.streamingTools.map(\.id), ["running"])
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
