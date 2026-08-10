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
    }

    func testRequestEncodingIsOneJSONLine() throws {
        let data = try HostProtocolCodec.encodeRequest(
            id: "mac-1",
            method: "session.prompt",
            params: ["message": .string("hello\nworld")]
        )
        XCTAssertEqual(data.last, 0x0A)
        XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["method"] as? String, "session.prompt")
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

    func testDirectTakeoverNeedsNoExternalToken() async {
        let model = AppModel()
        model.selectedSessionID = "session-id"

        await model.takeOverCurrentSession()

        XCTAssertNil(model.issue)
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

    func testWorkspaceGroupsPreserveRecencyWhileGroupingByDirectory() {
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

        let groups = SessionWorkspaceGroup.ordered(from: [
            session("a-new", cwd: "/work/a", title: "A new"),
            session("b-new", cwd: "/work/b", title: "B new"),
            session("a-old", cwd: "/work/a", title: "A old"),
        ])

        XCTAssertEqual(groups.map(\.cwd), ["/work/a", "/work/b"])
        XCTAssertEqual(groups[0].sessions.map(\.id), ["a-new", "a-old"])
        XCTAssertEqual(groups[1].sessions.map(\.id), ["b-new"])
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

}
